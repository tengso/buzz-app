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
