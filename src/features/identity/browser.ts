import { isTauri } from "@tauri-apps/api/core";
import type { Event, EventTemplate } from "nostr-tools";
import type { IdentitySnapshot } from "./service";

/** NIP-07 provider. The private key stays inside the extension. */
export type Nip07 = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
};

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

/** Static web build served beside a relay: NIP-07 signing and direct relay I/O. */
export const browserHostEnabled = () =>
  !isTauri() && import.meta.env.VITE_BUZZ_HOST === "browser";

const MISSING_SIGNER =
  "Install a Nostr signer extension (NIP-07), such as Alby or nos2x, then retry.";

/** Extensions inject `window.nostr` asynchronously, sometimes after app start. */
export async function nip07(timeoutMs = 3000): Promise<Nip07> {
  const deadline = Date.now() + timeoutMs;
  while (!window.nostr) {
    if (Date.now() >= deadline) throw new Error(MISSING_SIGNER);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return window.nostr;
}

let viewer: Promise<string> | undefined;
/** One public key per page; switching extension accounts requires a reload. */
export function browserViewer(): Promise<string> {
  viewer ??= nip07()
    .then((provider) => provider.getPublicKey())
    .then((pubkey) => {
      if (typeof pubkey !== "string" || !/^[a-f0-9]{64}$/.test(pubkey))
        throw new Error("The signer extension returned an invalid public key.");
      return pubkey;
    });
  viewer.catch(() => {
    viewer = undefined;
  });
  return viewer;
}

const unsupported = () =>
  Promise.reject(
    new Error("Manage this key in your signer extension, not in Buzz."),
  );

/** Same surface as the native identity, backed by the NIP-07 extension. */
export function createBrowserIdentity() {
  let state: IdentitySnapshot = { status: "loading" };
  let disposed = false;
  const listeners = new Set<() => void>();
  let resolveReady!: (viewer: string) => void;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  const update = (next: IdentitySnapshot) => {
    if (disposed) return;
    state = next;
    if (next.status === "ready") resolveReady(next.viewer);
    for (const listener of listeners) listener();
  };
  const restore = async () => {
    if (state.status === "ready") return;
    update({ status: "loading" });
    try {
      update({ status: "ready", viewer: await browserViewer() });
    } catch (reason) {
      update({
        status: "error",
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };
  void restore();
  return {
    ready,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: restore,
    importKey: (_nsec: string) => unsupported(),
    create: () => unsupported(),
    exportKey: (): Promise<string> => unsupported(),
    wipeRefusal: () =>
      Promise.resolve<string | null>(
        "Sign out in your signer extension; Buzz web stores no key.",
      ),
    signOut: (_choices: { wipe: boolean; removeAgents: boolean }) =>
      unsupported(),
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
