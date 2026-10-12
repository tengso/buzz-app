import { relayOrigin } from "../communities/destination";

/** Browser builds served behind a path-prefixed reverse proxy (e.g. a corporate
 * login gateway): the relay keeps its advertised origin for NIP-42/NIP-98/Blossom
 * signatures, while traffic goes to the page's own base URL and carries the
 * gateway's cookies. Empty for ordinary same-origin builds. */
export function proxiedRelayOrigin(
  value = import.meta.env?.VITE_BUZZ_PROXIED_RELAY ?? "",
): string {
  return value ? relayOrigin(value) : "";
}

const appBase = () => new URL(".", location.href);

function proxied(origin: string, configured = proxiedRelayOrigin()) {
  if (!configured) return false;
  try {
    return relayOrigin(origin) === configured;
  } catch {
    return false;
  }
}

/** HTTP URL to fetch for `path` (absolute, e.g. "/query") on `origin`. */
export function relayFetchUrl(
  origin: string,
  path: string,
  configured = proxiedRelayOrigin(),
): string {
  return proxied(origin, configured)
    ? new URL(path.replace(/^\/+/, ""), appBase()).href
    : `${origin}${path}`;
}

/** WebSocket URL to open for `origin` (http(s) or ws(s)); the NIP-42 relay tag stays `origin`. */
export function relaySocketUrl(
  origin: string,
  configured = proxiedRelayOrigin(),
): string {
  if (!proxied(origin, configured)) return origin.replace(/^http/, "ws");
  const url = appBase();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** The gateway authenticates by cookie; ordinary builds send none. */
export function relayCredentials(
  configured = proxiedRelayOrigin(),
): RequestCredentials {
  return configured ? "same-origin" : "omit";
}

/** Relay `/media/` links name the advertised origin; load them through the proxy. */
export function relayMediaUrl(url: string, configured = proxiedRelayOrigin()) {
  if (!configured || !url.startsWith(`${configured}/media/`)) return url;
  return relayFetchUrl(configured, url.slice(configured.length), configured);
}

/** Blossom `server` scope: the relay's advertised host, not the proxy's. */
export function relayMediaServer(configured = proxiedRelayOrigin()) {
  return configured ? new URL(configured).host : location.host;
}
