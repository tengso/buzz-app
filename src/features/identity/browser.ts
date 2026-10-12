import { isTauri } from "@tauri-apps/api/core";
import type { Event, EventTemplate } from "nostr-tools";
import {
  forgetLocalKey,
  localExportKey,
  localSelfDecrypt,
  localSelfEncrypt,
  localSignEvent,
  localViewer,
  lockLocalKey,
  resumeLocalKey,
  saveLocalKey,
  storedLocalKey,
  unlockLocalKey,
} from "./local-key";
import type { IdentitySnapshot } from "./service";

/** NIP-07 provider. The private key stays inside the extension. */
export type Nip07 = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
};

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

/** Static web build served beside a relay: browser signing and direct relay I/O. */
export const browserHostEnabled = () =>
  !isTauri() && import.meta.env.VITE_BUZZ_HOST === "browser";

const MISSING_SIGNER =
  "Install a Nostr signer extension (NIP-07), such as Alby or nos2x, then retry.";
const MODE = "buzz.browser.signer";

/** "local": NIP-49 key held by this page; "extension": NIP-07. */
const signerMode = (): "local" | "extension" | undefined =>
  storedLocalKey()
    ? "local"
    : globalThis.localStorage?.getItem(MODE) === "extension"
      ? "extension"
      : undefined;

/** Extensions inject `window.nostr` asynchronously, sometimes after app start. */
export async function nip07(timeoutMs = 3000): Promise<Nip07> {
  const deadline = Date.now() + timeoutMs;
  while (!window.nostr) {
    if (Date.now() >= deadline) throw new Error(MISSING_SIGNER);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return window.nostr;
}

let extensionViewer: Promise<string> | undefined;
/** One public key per page; switching accounts requires a reload. */
export function browserViewer(): Promise<string> {
  if (signerMode() === "local") {
    const viewer = localViewer();
    return viewer
      ? Promise.resolve(viewer)
      : Promise.reject(new Error("Unlock your key first."));
  }
  extensionViewer ??= nip07()
    .then((provider) => provider.getPublicKey())
    .then((pubkey) => {
      if (typeof pubkey !== "string" || !/^[a-f0-9]{64}$/.test(pubkey))
        throw new Error("The signer extension returned an invalid public key.");
      return pubkey;
    });
  extensionViewer.catch(() => {
    extensionViewer = undefined;
  });
  return extensionViewer;
}

export async function browserSignEvent(event: EventTemplate): Promise<Event> {
  if (signerMode() === "local") return localSignEvent(event);
  return (await nip07()).signEvent(event);
}

/** NIP-44 to the viewer's own key, for private sidebar, read-state and recipe records. */
export type SelfCipher = {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
};

export function browserSelfCipher(): SelfCipher | undefined {
  if (signerMode() === "local")
    return {
      encrypt: async (plaintext) => localSelfEncrypt(plaintext),
      decrypt: async (ciphertext) => localSelfDecrypt(ciphertext),
    };
  const nip44 = window.nostr?.nip44;
  if (!nip44) return undefined;
  return {
    encrypt: async (plaintext) =>
      nip44.encrypt(await browserViewer(), plaintext),
    decrypt: async (ciphertext) =>
      nip44.decrypt(await browserViewer(), ciphertext),
  };
}

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** Same surface as the native identity, plus browser sign-in choices. */
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
    const mode = signerMode();
    if (mode === "local") {
      const viewer = localViewer() ?? (await resumeLocalKey());
      update(
        viewer
          ? { status: "ready", viewer }
          : { status: "locked", busy: false },
      );
      return;
    }
    if (mode !== "extension") {
      update({ status: "missing", busy: false });
      return;
    }
    update({ status: "loading" });
    try {
      update({ status: "ready", viewer: await browserViewer() });
    } catch (reason) {
      update({ status: "error", error: message(reason) });
    }
  };
  /** NIP-49 key derivation is deliberately slow; let the busy state paint first. */
  const keyStep = (
    step: () => string,
    fallback: IdentitySnapshot["status"],
  ) => {
    if (state.status !== "missing" && state.status !== "locked") return;
    update({
      status: fallback === "locked" ? "locked" : "missing",
      busy: true,
    });
    setTimeout(() => {
      try {
        update({ status: "ready", viewer: step() });
      } catch (reason) {
        update({
          status: fallback === "locked" ? "locked" : "missing",
          busy: false,
          error: message(reason),
        });
      }
    }, 50);
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
    chooseExtension() {
      localStorage.setItem(MODE, "extension");
      return restore();
    },
    saveKey: (nsec: string, passphrase: string) =>
      keyStep(() => saveLocalKey(nsec, passphrase), "missing"),
    unlock: (passphrase: string) =>
      keyStep(() => unlockLocalKey(passphrase), "locked"),
    /** Removes the saved key; the user can then pick another sign-in method. */
    forgetKey() {
      forgetLocalKey();
      localStorage.removeItem(MODE);
      update({ status: "missing", busy: false });
    },
    importKey: (_nsec: string) =>
      Promise.reject(new Error("Choose a passphrase to save your key.")),
    create: () =>
      Promise.reject(new Error("Create identities in Buzz desktop.")),
    exportKey: async (): Promise<string> => {
      if (signerMode() !== "local")
        throw new Error(
          "Manage this key in your signer extension, not in Buzz.",
        );
      return localExportKey();
    },
    wipeRefusal: () =>
      Promise.resolve<string | null>(
        signerMode() === "local"
          ? null
          : "Sign out in your signer extension; Buzz web stores no key.",
      ),
    /** Locks the key (or forgets it with `wipe`), then reloads to the sign-in screen. */
    async signOut({ wipe }: { wipe: boolean; removeAgents: boolean }) {
      if (wipe || signerMode() !== "local") {
        forgetLocalKey();
        localStorage.removeItem(MODE);
      } else lockLocalKey();
      location.reload();
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
export type BrowserIdentity = ReturnType<typeof createBrowserIdentity>;
