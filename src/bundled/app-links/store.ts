import { readRoster } from "../../features/communities/roster";
import {
  browserSelfCipher,
  type SelfCipher,
} from "../../features/identity/browser";
import type { EventData } from "../../features/relay/events";
import type { Outbox } from "../../features/relay/outbox";
import type { RelayData } from "../../features/relay/service";
import {
  type AppLink,
  COMMUNITY_D,
  PERSONAL_D,
  parseLinks,
  serializeLinks,
} from "./model";

export type AppLinksSnapshot = Readonly<{
  status: "offline" | "loading" | "ready";
  /** A list that could not be read; the other list may still be shown. */
  error?: string;
  community: readonly AppLink[];
  personal: readonly AppLink[];
  /** The viewer is a community owner and may edit the community list. */
  owner: boolean;
  /** Personal links are encrypted to the viewer's key, which needs NIP-44. */
  personalAvailable: boolean;
}>;
export type AppLinks = Readonly<{
  snapshot(): AppLinksSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  save(
    list: "community" | "personal",
    links: readonly AppLink[],
  ): Promise<void>;
  dispose(): void;
}>;

const OFFLINE: AppLinksSnapshot = Object.freeze({
  status: "offline",
  community: [],
  personal: [],
  owner: false,
  personalAvailable: false,
});
const RETRIES = 3;
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function newest(events: readonly EventData[], authors: string[], d: string) {
  return events
    .filter(
      (event) =>
        event.kind === 30078 &&
        authors.includes(event.pubkey) &&
        event.tags.some(([name, value]) => name === "d" && value === d),
    )
    .sort((a, b) => b.created_at - a.created_at)[0];
}

/** Resolve once the relay accepts the event; reject on a failed or unknown outcome. */
function delivered(outbox: Outbox, id: string) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const check = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      if (!item || item.delivery === "accepted" || item.delivery === "seen") {
        stop();
        resolve();
      } else if (item.delivery === "failed" || item.delivery === "unknown") {
        stop();
        reject(
          new Error(
            item.error ||
              "The relay did not confirm the change; refresh to check it",
          ),
        );
      }
    };
    stop = outbox.subscribe(check);
    check();
  });
}

/** The community's app list (by its owner) and the viewer's own, per relay session. */
export function createAppLinks(
  relay: RelayData,
  cipher: () => SelfCipher | undefined = browserSelfCipher,
): AppLinks {
  let state = OFFLINE;
  let key = "";
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  const set = (next: AppLinksSnapshot) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  // Reads can be cancelled while a community is joined or reconnects: retry
  // those a few times before reporting them.
  const retry = (signal: AbortSignal, attempt: number) => {
    if (attempt >= RETRIES || signal.aborted) return false;
    const timer = setTimeout(
      () => void load(signal, attempt + 1),
      1000 * 2 ** attempt,
    );
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return true;
  };
  async function load(signal: AbortSignal, attempt = 0) {
    const { session } = relay.snapshot();
    const viewer = session.viewer;
    if (!viewer) return;
    const self = cipher();
    if (attempt === 0)
      set({ ...state, status: "loading", personalAvailable: !!self });
    const errors: string[] = [];
    let rosterFailed = false;
    try {
      const roster = await readRoster(session, signal).catch((reason) => {
        if (signal.aborted) throw reason;
        rosterFailed = true;
        errors.push(`Community apps unavailable: ${message(reason)}`);
        return null;
      });
      const owners = (roster ?? [])
        .filter((member) => member.role === "owner")
        .map((member) => member.pubkey);
      const events = await session.read(
        [
          ...(owners.length
            ? [
                {
                  kinds: [30078],
                  authors: owners,
                  "#d": [COMMUNITY_D],
                  limit: 2 * owners.length,
                },
              ]
            : []),
          { kinds: [30078], authors: [viewer], "#d": [PERSONAL_D], limit: 2 },
        ],
        { fresh: true, signal },
      );
      let community: AppLink[] = [];
      let personal: AppLink[] = [];
      const shared = newest(events, owners, COMMUNITY_D);
      try {
        if (shared) community = parseLinks(shared.content);
      } catch (reason) {
        errors.push(`Community apps: ${message(reason)}`);
      }
      const own = newest(events, [viewer], PERSONAL_D);
      try {
        if (own && self) personal = parseLinks(await self.decrypt(own.content));
      } catch (reason) {
        errors.push(`Your apps: ${message(reason)}`);
      }
      if (signal.aborted || (rosterFailed && retry(signal, attempt))) return;
      set({
        status: "ready",
        ...(errors.length ? { error: errors.join(" ") } : {}),
        community,
        personal,
        owner: owners.includes(viewer),
        personalAvailable: !!self,
      });
    } catch (reason) {
      if (signal.aborted || retry(signal, attempt)) return;
      set({
        ...OFFLINE,
        status: "ready",
        personalAvailable: !!self,
        error: message(reason),
      });
    }
  }
  const sync = (force = false) => {
    const snapshot = relay.snapshot();
    const next =
      snapshot.status === "ready" && snapshot.session.viewer
        ? `${snapshot.scope}:${snapshot.generation}`
        : "";
    if (next === key && !force) return;
    key = next;
    controller?.abort();
    controller = undefined;
    if (!next) return set(OFFLINE);
    controller = new AbortController();
    void load(controller.signal);
  };
  const stop = relay.subscribe(() => sync());
  sync();
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => sync(true),
    async save(list, links) {
      const snapshot = relay.snapshot();
      const outbox = snapshot.session.outbox;
      if (snapshot.status !== "ready" || !outbox?.supports(30078))
        throw new Error("Connect to the community to save apps");
      if (list === "community" && !state.owner)
        throw new Error("Only the community owner can change community apps");
      const text = serializeLinks(links);
      let content = text;
      if (list === "personal") {
        const self = cipher();
        if (!self)
          throw new Error(
            "Saving your own apps needs your key on this device or a NIP-44 signer",
          );
        content = await self.encrypt(text);
      }
      await outbox.ready();
      const d = list === "community" ? COMMUNITY_D : PERSONAL_D;
      await delivered(
        outbox,
        outbox.send({
          kind: 30078,
          content,
          tags: [
            ["d", d],
            ["t", d],
          ],
        }),
      );
      set({ ...state, [list]: parseLinks(text) });
    },
    dispose() {
      stop();
      controller?.abort();
      listeners.clear();
    },
  };
}
