import type { ChannelSummary } from "./contracts";
import type { RelayEvent } from "./events";
import type { IdentityArchives } from "./identity-archives";
import type { RelayReader } from "./reader";

/** Starter channels Buzz desktop creates for every community. */
const STARTER_CHANNELS = new Set(["general", "welcome-everyone", "welcome"]);
/** Buzz desktop's built-in personas (`builtin:*`; Pollen was Bumble). */
const BUILT_IN_NAMES = new Set(["fizz", "honey", "pollen", "bumble"]);
const HEX = /^[0-9a-f]{64}$/;
const PAGE = 500;
const MAX_PAGES = 20;

/** The static browser build; Tauri builds never set this host. */
export const browserHidesDesktopDefaults = () =>
  import.meta.env.VITE_BUZZ_HOST === "browser";

export function isStarterChannel(
  channel: Pick<ChannelSummary, "name" | "channelType">,
) {
  return (
    channel.channelType !== "dm" &&
    STARTER_CHANNELS.has(channel.name.trim().toLowerCase())
  );
}

/** Identities registered (kind 30177) from a built-in persona. */
export function builtInAgentKeys(events: readonly RelayEvent[]): string[] {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.kind !== 30177) continue;
    const key = event.tags.find(([name]) => name === "d")?.[1];
    if (!key || !HEX.test(key)) continue;
    let body: { persona_id?: unknown; name?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(event.content);
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {}
    const persona =
      typeof body.persona_id === "string" &&
      body.persona_id.startsWith("builtin:");
    const name =
      typeof body.name === "string" &&
      BUILT_IN_NAMES.has(body.name.trim().toLowerCase());
    if (persona || name) keys.add(key);
  }
  return [...keys];
}

/** Community-wide set of built-in persona agents; lazy, refreshed on demand. */
export function createBuiltInAgents(
  reader: RelayReader | undefined,
  notify = (listener: () => void) => listener(),
) {
  const listeners = new Set<() => void>();
  let keys: ReadonlySet<string> = new Set();
  let status: "unavailable" | "idle" | "loading" | "ready" | "error" = reader
    ? "idle"
    : "unavailable";
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  function publish() {
    for (const listener of listeners) notify(listener);
  }
  function refresh(): Promise<void> {
    if (closed || !reader) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    status = "loading";
    pending = (async () => {
      try {
        const events: RelayEvent[] = [];
        let until: number | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const batch = await reader.read(
            [
              {
                kinds: [30177],
                limit: PAGE,
                ...(until === undefined ? {} : { until }),
              },
            ],
            { signal: owned.signal, priority: "background", fresh: true },
          );
          events.push(...batch);
          if (batch.length < PAGE) break;
          const oldest = Math.min(...batch.map((event) => event.created_at));
          if (oldest === until) break;
          until = oldest;
        }
        if (owned.signal.aborted) return;
        keys = new Set(builtInAgentKeys(events));
        status = "ready";
      } catch {
        if (!owned.signal.aborted) status = "error";
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
        if (!owned.signal.aborted && !closed) publish();
      }
    })();
    return pending;
  }
  return {
    queries: Object.freeze({
      keys: () => keys,
      status: () => status,
      has: (pubkey: string) => keys.has(pubkey),
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: () =>
        status === "idle" ? refresh() : (pending ?? Promise.resolve()),
      refresh,
    }),
    clear() {
      controller?.abort();
      controller = undefined;
      pending = undefined;
      keys = new Set();
      status = reader && !closed ? "idle" : "unavailable";
      publish();
    },
    dispose() {
      closed = true;
      controller?.abort();
      listeners.clear();
    },
  };
}
export type BuiltInAgents = ReturnType<typeof createBuiltInAgents>["queries"];

/** Archive queries that also hide built-in agents (browser host only). */
export function hidingBuiltInAgents(
  archives: IdentityArchives,
  builtIn: BuiltInAgents,
): IdentityArchives {
  let source = archives.snapshot();
  let keys = builtIn.keys();
  let merged = source;
  return Object.freeze({
    ...archives,
    hidden: (pubkey: string) => builtIn.has(pubkey),
    snapshot() {
      const next = archives.snapshot();
      if (next !== source || builtIn.keys() !== keys) {
        source = next;
        keys = builtIn.keys();
        merged = Object.freeze({ ...next });
      }
      return merged;
    },
    subscribe(listener: () => void) {
      const offArchives = archives.subscribe(listener);
      const offBuiltIn = builtIn.subscribe(listener);
      return () => {
        offArchives();
        offBuiltIn();
      };
    },
    ensure: () =>
      Promise.all([archives.ensure(), builtIn.ensure()]).then(() => {}),
    refresh: () =>
      Promise.all([archives.refresh(), builtIn.refresh()]).then(() => {}),
  });
}
