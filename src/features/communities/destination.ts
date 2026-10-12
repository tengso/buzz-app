import { isLoopbackHost } from "../../shared/loopback";

const RELAY_URL_ERROR =
  "Enter a wss:// or https:// relay URL without credentials, a path, query, or fragment (ws:// or http:// only for 127.0.0.1 or localhost).";

/** A community is a secure origin, never a credential-bearing URL or an API path.
 * Plain ws/http is accepted only for loopback hosts (e.g. an SSH-tunnelled relay). */
export function relayOrigin(input: string): string {
  const value = input.trim();
  if (
    value.length > 2048 ||
    !/^(?:wss|https|ws|http):\/\/[^/?#\\\s@]+\/?$/i.test(value)
  )
    throw new Error(RELAY_URL_ERROR);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Enter a valid relay URL, such as wss://relay.example.com.",
    );
  }
  const plain = /^(?:ws|http):/i.test(value);
  if (plain && !isLoopbackHost(url.hostname)) throw new Error(RELAY_URL_ERROR);
  url.protocol = plain ? "http:" : "https:";
  // DNS treats the final dot as the same host; keep storage and routing identical too.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url.origin;
}

/** A short deployment ID is not a URL and must never acquire a session by itself. */
export function isCommunityAlias(value: string) {
  return (
    /^[a-z][a-z0-9-]{0,63}$/.test(value) &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

/** Optional deployment aliases preserve existing saved IDs without shipping a community list. */
export function parseCommunityAliases(
  raw = "",
): Readonly<Record<string, string>> {
  if (!raw.trim()) return {};
  try {
    const entries: unknown = JSON.parse(raw);
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error();
    const aliases: Record<string, string> = {};
    const origins = new Set<string>();
    for (const [id, value] of Object.entries(entries)) {
      if (!isCommunityAlias(id) || typeof value !== "string") throw new Error();
      const origin = relayOrigin(value);
      if (origins.has(origin)) throw new Error();
      origins.add(origin);
      aliases[id] = origin;
    }
    return Object.freeze(aliases);
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_COMMUNITY_ALIASES must be a JSON object of unique alias-to-secure-relay-origin mappings.",
    );
  }
}

const configuredAliases = parseCommunityAliases(
  import.meta.env?.VITE_BUZZ_COMMUNITY_ALIASES,
);

export function communityDestination(
  value: string,
  aliases = configuredAliases,
) {
  const legacy = Object.hasOwn(aliases, value) ? aliases[value] : undefined;
  const url = legacy ?? relayOrigin(value);
  const id = Object.keys(aliases).find((key) => aliases[key] === url) ?? url;
  return { id, url, name: new URL(url).host };
}
