import { verifyEvent, type EventTemplate } from "nostr-tools";
import { communityDestination } from "../communities/destination";
import { browserViewer, nip07 } from "../identity/browser";
import { eventDto, type RelayEvent } from "./events";
import { nativeWriteKinds } from "./native";
import {
  acceptPublish,
  connectSignedTransport,
  type ReadTransport,
  type RelayWriter,
  type Signer,
} from "./transport";
import { validateLifecycleTemplate } from "./channel-lifecycle-protocol";
import { validateMemberAdministrationTemplate } from "../channel-members/administration-protocol";
import { validateDetailsTemplate } from "./channel-details-protocol";
import { validateArchiveRequestTemplate } from "./identity-archive-protocol";
import { PublishRejected } from "./outbox";
import { UPLOAD_TIMEOUT_MS } from "./attachments";

const now = () => Math.floor(Date.now() / 1000);

function base64(value: unknown) {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value)))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(data: BufferSource) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sign(event: EventTemplate) {
  const viewer = await browserViewer();
  const { kind, created_at, tags, content } = event;
  const signed = await (await nip07()).signEvent({
    kind,
    created_at,
    tags,
    content,
  });
  if (!signed || signed.pubkey !== viewer || !verifyEvent({ ...signed }))
    throw new Error("The signer extension returned an invalid signature.");
  return eventDto(signed);
}

/** NIP-98 for exactly one request; the relay's replay guard rejects reuse. */
async function nip98(url: string, method: string, body?: string) {
  return `Nostr ${base64(
    await sign({
      kind: 27235,
      created_at: now(),
      content: "",
      tags: [
        ["u", url],
        ["method", method],
        ...(body === undefined
          ? []
          : [["payload", await sha256Hex(new TextEncoder().encode(body))]]),
        ["nonce", crypto.randomUUID()],
      ],
    }),
  )}`;
}

function sameCommunity(origin: string, url: string) {
  const target = new URL(url);
  if (target.origin !== origin || target.search || target.hash)
    throw new Error("Relay request changed community");
  return target;
}

const SOCKET_FILTER_KEYS = new Set([
  "ids",
  "authors",
  "kinds",
  "since",
  "until",
  "limit",
  "search",
  "before_id",
]);

/** Plain NIP-01 filters only; HTTP-only extensions (consistency, presence
 * synthesis, read-state snapshots) keep the signed HTTP bridge. */
function socketFilters(body: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(body) || body.length < 1 || body.length > 10) return;
  for (const filter of body) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) return;
    for (const key of Object.keys(filter))
      if (!SOCKET_FILTER_KEYS.has(key) && !/^#[a-zA-Z]$/.test(key)) return;
    const kinds = (filter as { kinds?: unknown }).kinds;
    if (Array.isArray(kinds) && kinds.includes(20001)) return;
  }
  return body as Record<string, unknown>[];
}

type Pending = {
  frame: (data: unknown[]) => void;
  fail: (error: Error) => void;
};

/** One NIP-42-authenticated socket per community carries reads and publishes,
 * so a session signs one AUTH instead of one NIP-98 event per request. */
function relaySocket(origin: string) {
  const url = origin.replace(/^http/, "ws");
  const pending = new Map<string, Pending>();
  let ready: Promise<WebSocket> | undefined;
  let sequence = 0;
  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.fail(error);
    pending.clear();
  };
  const open = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      let authId: string | undefined;
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error("Relay login timed out")),
        15_000,
      );
      function fail(error: Error) {
        clearTimeout(timer);
        ready = undefined;
        if (!settled) reject(error);
        settled = true;
        failAll(error);
        ws.close();
      }
      ws.onclose = () => fail(new Error("Relay connection closed"));
      ws.onerror = () => fail(new Error("Relay connection failed"));
      ws.onmessage = async (message) => {
        let data: unknown;
        try {
          data = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!Array.isArray(data)) return;
        if (data[0] === "AUTH" && typeof data[1] === "string" && !authId) {
          try {
            const auth = await sign({
              kind: 22242,
              created_at: now(),
              content: "",
              tags: [
                ["relay", url],
                ["challenge", data[1]],
              ],
            });
            authId = auth.id;
            ws.send(JSON.stringify(["AUTH", auth]));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        if (data[0] === "OK" && authId && data[1] === authId && !settled) {
          if (data[2] !== true) return fail(new Error("Relay rejected login"));
          clearTimeout(timer);
          settled = true;
          resolve(ws);
          return;
        }
        if (typeof data[1] === "string") pending.get(data[1])?.frame(data);
      };
    });

  async function exchange<T>(
    id: string,
    message: unknown[],
    signal: AbortSignal,
    frame: (data: unknown[], done: (value: T) => void) => void,
    cancel?: unknown[],
  ) {
    ready ??= open();
    const ws = await ready;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        pending.delete(id);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        finish();
        if (cancel && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify(cancel));
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        frame: (data) =>
          frame(data, (value) => {
            finish();
            resolve(value);
          }),
        fail: (error) => {
          finish();
          reject(error);
        },
      });
      ws.send(JSON.stringify(message));
    });
  }

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const refusal = (reason: unknown) =>
    json(
      {
        error:
          typeof reason === "string" ? reason : "Relay refused the request",
      },
      typeof reason === "string" && /^(auth-required|restricted)/.test(reason)
        ? 403
        : 400,
    );

  return {
    query(filters: Record<string, unknown>[], signal: AbortSignal) {
      const id = `q${++sequence}`;
      const events: unknown[] = [];
      return exchange<Response>(
        id,
        ["REQ", id, ...filters],
        signal,
        (data, done) => {
          if (data[0] === "EVENT") events.push(data[2]);
          else if (data[0] === "EOSE") {
            ready?.then((ws) => ws.send(JSON.stringify(["CLOSE", id])));
            done(json(events));
          } else if (data[0] === "CLOSED") done(refusal(data[2]));
        },
        ["CLOSE", id],
      );
    },
    count(filters: Record<string, unknown>[], signal: AbortSignal) {
      const id = `c${++sequence}`;
      return exchange<Response>(
        id,
        ["COUNT", id, ...filters],
        signal,
        (data, done) => {
          if (data[0] === "COUNT")
            done(json({ count: (data[2] as { count?: unknown })?.count }));
          else if (data[0] === "CLOSED") done(refusal(data[2]));
        },
      );
    },
    publish(event: { id: string }, signal: AbortSignal) {
      return exchange<Response>(
        event.id,
        ["EVENT", event],
        signal,
        (data, done) => {
          if (data[0] === "OK")
            done(
              json({
                event_id: data[1],
                accepted: data[2] === true,
                message: data[3] ?? "",
              }),
            );
        },
      );
    },
  };
}

const sockets = new Map<string, ReturnType<typeof relaySocket>>();
const socketFor = (origin: string) => {
  let socket = sockets.get(origin);
  if (!socket) {
    socket = relaySocket(origin);
    sockets.set(origin, socket);
  }
  return socket;
};

async function socketRequest(
  origin: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response | undefined> {
  if (typeof WebSocket === "undefined") return;
  if (path === "/events") {
    const event = body as { id?: unknown; sig?: unknown } | null;
    if (typeof event?.id !== "string" || typeof event.sig !== "string") return;
    return socketFor(origin).publish(event as { id: string }, signal);
  }
  if (path !== "/query" && path !== "/count") return;
  const filters = socketFilters(body);
  if (!filters) return;
  return path === "/query"
    ? socketFor(origin).query(filters, signal)
    : socketFor(origin).count(filters, signal);
}

/** Same contract as `relay_http`: discovery is anonymous, everything else is NIP-98. */
export async function browserRelayRequest(
  community: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const origin = communityDestination(community).url;
  const url = sameCommunity(origin, `${origin}${path}`).href;
  const bounded = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  if (path === "/" && body === undefined)
    return fetch(url, {
      headers: { Accept: "application/nostr+json" },
      // The page itself is `GET /`; never reuse its cached HTML as NIP-11.
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: bounded,
    });
  if (body !== undefined) {
    const viaSocket = await socketRequest(origin, path, body, bounded).catch(
      (error) => {
        if (bounded.aborted) throw error;
        return undefined;
      },
    );
    if (viaSocket) return viaSocket;
  }
  const method = body === undefined ? "GET" : "POST";
  const text = body === undefined ? undefined : JSON.stringify(body);
  return fetch(url, {
    method,
    headers: {
      Authorization: await nip98(url, method, text),
      "Content-Type": "application/json",
    },
    ...(text === undefined ? {} : { body: text }),
    credentials: "omit",
    redirect: "error",
    signal: bounded,
  });
}

export async function browserRelayInfo(
  community: string,
  signal?: AbortSignal,
) {
  const response = await browserRelayRequest(community, "/", undefined, signal);
  if (!response.ok) throw new Error("Community discovery failed");
  const info: unknown = await response.json();
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new Error("Invalid community information");
  return info as Record<string, unknown>;
}

async function upload(origin: string, file: File, signal: AbortSignal) {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const hash = await sha256Hex(bytes);
  const auth = await sign({
    kind: 24242,
    created_at: now(),
    content: "Upload attachment",
    tags: [
      ["t", "upload"],
      ["x", hash],
      ["server", new URL(origin).host],
      ["expiration", String(now() + Math.ceil(UPLOAD_TIMEOUT_MS / 1000) + 60)],
    ],
  });
  signal.throwIfAborted();
  return fetch(`${origin}/upload`, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-SHA-256": hash,
      Authorization: `Nostr ${base64(auth)}`,
    },
    body: bytes,
    credentials: "omit",
    redirect: "error",
    signal,
  });
}

/** Same-origin `/media/` URLs; `public/buzz-media-sw.js` adds Blossom auth. */
export const browserMediaUrl = (url: string) => url;

let mediaToken: Promise<{ token: string; expiresAt: number }> | undefined;
/** One server-scoped Blossom `get` token per hour covers every media read. */
function mediaAuthorization() {
  mediaToken ??= (async () => {
    const expiresAt = now() + 3600;
    const auth = await sign({
      kind: 24242,
      created_at: now(),
      content: "Read media",
      tags: [
        ["t", "get"],
        ["server", location.host],
        ["expiration", String(expiresAt)],
      ],
    });
    return { token: `Nostr ${base64(auth)}`, expiresAt: expiresAt * 1000 };
  })();
  const current = mediaToken;
  current.then(
    ({ expiresAt }) =>
      setTimeout(
        () => {
          if (mediaToken === current) mediaToken = undefined;
        },
        Math.max(0, expiresAt - Date.now() - 120_000),
      ),
    () => {
      if (mediaToken === current) mediaToken = undefined;
    },
  );
  return current;
}

let mediaWorkerStarted = false;
export function startBrowserMedia() {
  if (!("serviceWorker" in navigator)) return;
  if (mediaWorkerStarted) return;
  mediaWorkerStarted = true;
  void (async () => {
    navigator.serviceWorker.addEventListener("message", (message) => {
      if (message.data?.type !== "buzz-media-auth" || !message.ports[0]) return;
      const port = message.ports[0];
      mediaAuthorization().then(
        (value) => port.postMessage(value),
        () => port.postMessage(null),
      );
    });
    await navigator.serviceWorker.register("/buzz-media-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  })().catch((error) => {
    console.warn("Buzz media worker unavailable", error);
  });
}

export function browserRelaySigner(community: string): Signer {
  const origin = communityDestination(community).url;
  return {
    getPublicKey: browserViewer,
    signEvent: sign,
    async request(url, body, signal) {
      const target = sameCommunity(origin, url);
      return browserRelayRequest(
        origin,
        target.pathname,
        JSON.parse(body),
        signal,
      );
    },
    upload: (file, signal) => upload(origin, file, signal),
    media: browserMediaUrl,
  };
}

export async function connectBrowserTransport(
  community: string,
  signal?: AbortSignal,
): Promise<ReadTransport> {
  const origin = communityDestination(community).url;
  startBrowserMedia();
  const info = await browserRelayInfo(origin, signal);
  const author = info.self;
  if (typeof author !== "string" || !/^[a-f0-9]{64}$/.test(author))
    throw new Error("Relay did not advertise its identity");
  const creation =
    Array.isArray(info.supported_nips) && info.supported_nips.includes(29);
  const signer = browserRelaySigner(origin);
  const transport = await connectSignedTransport(signer, origin, author);
  signal?.throwIfAborted();
  const writer = transport.writer;
  if (!writer) throw new Error("Browser relay writer is unavailable");
  const viewer = transport.viewer;
  const publishEvent = async (event: RelayEvent, signal: AbortSignal) =>
    acceptPublish(
      await browserRelayRequest(origin, "/events", event, signal),
      event.id,
    );
  const commandWriter = (
    validate: (event: EventTemplate) => void,
  ): RelayWriter => ({
    async sign(event, signal) {
      signal.throwIfAborted();
      validate(event);
      const result = await sign(event);
      signal.throwIfAborted();
      validate(result);
      return result;
    },
    async publish(event, signal) {
      signal.throwIfAborted();
      validate(event);
      if (event.pubkey !== viewer) throw new Error("Invalid channel command");
      return publishEvent(event, signal);
    },
  });
  return {
    ...transport,
    archiveAuthority: author,
    channelLifecycle: commandWriter(validateLifecycleTemplate),
    channelDetails: commandWriter(validateDetailsTemplate),
    memberAdministration: commandWriter((event) => {
      validateMemberAdministrationTemplate(event, viewer);
      if (event.tags.some(([key, value]) => key === "p" && value === viewer))
        throw new Error("Invalid member administration command");
    }),
    identityArchive: commandWriter(validateArchiveRequestTemplate),
    async openDirectMessage(pubkeys, signal) {
      signal.throwIfAborted();
      if (
        pubkeys.length < 1 ||
        pubkeys.length > 8 ||
        new Set(pubkeys).size !== pubkeys.length ||
        pubkeys.some((p) => !/^[a-f0-9]{64}$/.test(p) || p === viewer)
      )
        throw new Error("Choose between one and eight other people.");
      const event = await sign({
        kind: 41010,
        created_at: now(),
        content: "",
        tags: [
          ...pubkeys.map((p) => ["p", p]),
          ["client", crypto.randomUUID()],
        ],
      });
      const failed = "The direct message could not be opened. Try again.";
      const response = await browserRelayRequest(
        origin,
        "/events",
        event,
        signal,
      );
      if (response.status !== 200) throw new Error(failed);
      const receipt = (await response.json()) as {
        event_id?: unknown;
        accepted?: unknown;
        message?: unknown;
      };
      if (
        receipt.event_id !== event.id ||
        receipt.accepted !== true ||
        typeof receipt.message !== "string" ||
        !receipt.message.startsWith("response:")
      )
        throw new Error(failed);
      const id = (
        JSON.parse(receipt.message.slice("response:".length)) as {
          channel_id?: unknown;
        }
      ).channel_id;
      if (
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
      )
        throw new Error("The relay returned an invalid direct message.");
      return id;
    },
    async channelActivity(channelIds, signal) {
      if (
        channelIds.length < 1 ||
        channelIds.length > 128 ||
        channelIds.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      )
        throw new Error("Activity filter rejected");
      return transport.query(
        channelIds.map((channelId) => ({
          kinds: [9, 40002, 40008, 45001, 45003],
          "#h": [channelId],
          limit: 1,
        })),
        signal,
        "channel-activity",
        "background",
      );
    },
    writer: {
      ...writer,
      kinds: creation ? [...nativeWriteKinds, 9007] : nativeWriteKinds,
      async publish(event, signal) {
        if (event.created_at < now() - 15 * 60) {
          const found = await transport.query(
            [
              {
                kinds: [event.kind],
                ids: [event.id],
                authors: [event.pubkey],
                limit: 1,
                consistency: "strong",
              },
            ],
            signal,
          );
          if (found.some((value) => value.id === event.id)) return "";
          throw new PublishRejected(
            "This event is too old to retry and was not found on the relay. Check the conversation before sending it again.",
          );
        }
        return (await writer.publish(event, signal)) ?? "";
      },
    },
  };
}
