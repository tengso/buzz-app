import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proxiedRelayOrigin,
  relayCredentials,
  relayFetchUrl,
  relayMediaServer,
  relayMediaUrl,
  relaySocketUrl,
} from "./browser-proxy";

const relay = "http://127.0.0.1:3102";
const page = "https://et2.example/HaiChat/team/";

describe("browser relay behind a path-prefixed proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps ordinary same-origin builds unchanged", () => {
    expect(proxiedRelayOrigin("")).toBe("");
    expect(relayFetchUrl(relay, "/query", "")).toBe(`${relay}/query`);
    expect(relaySocketUrl(relay, "")).toBe("ws://127.0.0.1:3102");
    expect(relaySocketUrl("wss://relay.example", "")).toBe(
      "wss://relay.example",
    );
    expect(relayCredentials("")).toBe("omit");
    expect(relayMediaUrl(`${relay}/media/abc`, "")).toBe(`${relay}/media/abc`);
  });

  it("sends the advertised relay's traffic to the page's base path", () => {
    vi.stubGlobal("location", new URL(`${page}#/channel`));
    const configured = proxiedRelayOrigin("ws://127.0.0.1:3102");
    expect(configured).toBe(relay);
    expect(relayFetchUrl(relay, "/", configured)).toBe(page);
    expect(relayFetchUrl(relay, "/query", configured)).toBe(`${page}query`);
    expect(relaySocketUrl(relay, configured)).toBe(
      "wss://et2.example/HaiChat/team/",
    );
    expect(relaySocketUrl("ws://127.0.0.1:3102", configured)).toBe(
      "wss://et2.example/HaiChat/team/",
    );
    expect(relayCredentials(configured)).toBe("same-origin");
    expect(
      relayMediaUrl(`${relay}/media/${"a".repeat(64)}.png`, configured),
    ).toBe(`${page}media/${"a".repeat(64)}.png`);
    expect(relayMediaServer(configured)).toBe("127.0.0.1:3102");
  });

  it("never routes another community or third-party media through the proxy", () => {
    vi.stubGlobal("location", new URL(page));
    const other = "https://other.example";
    expect(relayFetchUrl(other, "/query", relay)).toBe(`${other}/query`);
    expect(relaySocketUrl(other, relay)).toBe("wss://other.example");
    expect(relayMediaUrl("https://cdn.example/media/x.png", relay)).toBe(
      "https://cdn.example/media/x.png",
    );
  });
});
