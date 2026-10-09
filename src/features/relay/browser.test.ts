import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
} from "nostr-tools";

const origin = "https://relay.example";
const key = generateSecretKey();
const viewer = getPublicKey(key);

function provider(signKey = key) {
  return {
    getPublicKey: vi.fn(async () => viewer),
    signEvent: vi.fn(async (event: EventTemplate) =>
      finalizeEvent(event, signKey),
    ),
  };
}

function decode(header: string) {
  expect(header.startsWith("Nostr ")).toBe(true);
  const binary = atob(header.slice(6));
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
  );
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

describe("browser relay host", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { nostr: provider() });
    vi.stubGlobal("WebSocket", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs exact-URL NIP-98 with a body hash for relay requests", async () => {
    const { browserRelayRequest } = await import("./browser");
    const body = { filters: [{ kinds: [9], limit: 1 }] };
    await browserRelayRequest(origin, "/query", body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${origin}/query`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
    });
    const event = decode(
      (init.headers as Record<string, string>).Authorization ?? "",
    );
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(viewer);
    expect(event.kind).toBe(27235);
    const tag = (name: string) =>
      event.tags.find(([key]: string[]) => key === name)?.[1];
    expect(tag("u")).toBe(`${origin}/query`);
    expect(tag("method")).toBe("POST");
    expect(tag("payload")).toBe(await sha256(init.body as string));
    expect(tag("nonce")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends plain reads over one NIP-42 socket instead of NIP-98", async () => {
    const sent: unknown[][] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (message: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) {
        setTimeout(() => this.deliver(["AUTH", "challenge-1"]));
      }
      deliver(frame: unknown[]) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
      send(text: string) {
        const frame = JSON.parse(text) as unknown[];
        sent.push(frame);
        const [type, id] = frame as [string, string | { id: string }];
        if (type === "AUTH" && typeof id === "object")
          this.deliver(["OK", id.id, true, ""]);
        if (type === "REQ") {
          this.deliver(["EVENT", id, { id: "e1" }]);
          this.deliver(["EOSE", id]);
        }
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const { browserRelayRequest } = await import("./browser");
    const filters = [{ kinds: [9], "#h": ["general"], limit: 5 }];
    const first = await browserRelayRequest(origin, "/query", filters);
    expect(await first.json()).toEqual([{ id: "e1" }]);
    await browserRelayRequest(origin, "/query", filters);
    expect(fetchMock).not.toHaveBeenCalled();
    const auth = sent.filter(([type]) => type === "AUTH");
    expect(auth).toHaveLength(1);
    const authEvent = auth[0]?.[1] as { kind: number; tags: string[][] };
    expect(authEvent.kind).toBe(22242);
    expect(authEvent.tags).toContainEqual(["relay", "wss://relay.example"]);
    expect(authEvent.tags).toContainEqual(["challenge", "challenge-1"]);
    expect(sent.filter(([type]) => type === "REQ")[0]?.slice(2)).toEqual(
      filters,
    );
    await browserRelayRequest(origin, "/query", [
      { kinds: [9], consistency: "strong" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches NIP-11 anonymously and uncached", async () => {
    const { browserRelayRequest } = await import("./browser");
    await browserRelayRequest(origin, "/");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ Accept: "application/nostr+json" });
    expect(init.cache).toBe("no-store");
  });

  it("refuses requests that leave the community origin", async () => {
    const { browserRelaySigner } = await import("./browser");
    const signer = browserRelaySigner(origin);
    await expect(
      signer.request("https://evil.example/query", "{}"),
    ).rejects.toThrow("Relay request changed community");
    await expect(signer.request(`${origin}/query?x=1`, "{}")).rejects.toThrow(
      "Relay request changed community",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects signatures from a key other than the viewer", async () => {
    vi.stubGlobal("window", { nostr: provider(generateSecretKey()) });
    const { browserRelaySigner } = await import("./browser");
    await expect(
      browserRelaySigner(origin).signEvent({
        kind: 1,
        created_at: 1,
        tags: [],
        content: "",
      }),
    ).rejects.toThrow("invalid signature");
  });

  it("reports a missing signer extension", async () => {
    vi.stubGlobal("window", {});
    const { nip07 } = await import("../identity/browser");
    await expect(nip07(0)).rejects.toThrow("NIP-07");
  });
});
