import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import * as nip49 from "nostr-tools/nip49";

/** NIP-49 encrypted key; needs the passphrase. */
const STORED = "buzz.browser.ncryptsec";
/** Unlocked key wrapped with a non-extractable device key, so one passphrase
 * entry lasts across reloads and tabs until lock or sign-out. Page scripts can
 * still unwrap it; it only keeps the raw key out of storage. */
const UNLOCKED = "buzz.browser.unlocked";
const MIN_PASSPHRASE = 8;

function hexToBytes(hex: string) {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Invalid key");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export type DeviceKeyStore = {
  get(): Promise<CryptoKey | undefined>;
  put(key: CryptoKey): Promise<void>;
  clear(): Promise<void>;
};

function idbRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("buzz-browser", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction("keys", mode).objectStore("keys"));
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    };
  });
}

const indexedDbDeviceKeys: DeviceKeyStore = {
  get: () => idbRequest("readonly", (store) => store.get("device")),
  put: (key) =>
    idbRequest("readwrite", (store) => store.put(key, "device")).then(
      () => undefined,
    ),
  clear: () =>
    idbRequest("readwrite", (store) => store.delete("device")).then(
      () => undefined,
    ),
};
let deviceKeys = indexedDbDeviceKeys;
/** Tests replace IndexedDB with an in-memory store. */
export const setDeviceKeyStore = (store: DeviceKeyStore) => {
  deviceKeys = store;
};

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function remember(key: Uint8Array) {
  const device = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      device,
      new Uint8Array(key),
    ),
  );
  await deviceKeys.put(device);
  localStorage.setItem(UNLOCKED, toBase64(new Uint8Array([...iv, ...sealed])));
}

let remembering: Promise<void> = Promise.resolve();
/** Settles once the latest unlock has been persisted (or failed to). */
export const localKeyRemembered = () => remembering;

/** Restores an unlock remembered by an earlier page load, if any. */
export async function resumeLocalKey(): Promise<string | undefined> {
  const sealed = globalThis.localStorage?.getItem(UNLOCKED);
  if (!sealed || !storedLocalKey()) return undefined;
  try {
    const device = await deviceKeys.get();
    if (!device) throw new Error("Missing device key");
    const bytes = fromBase64(sealed);
    const key = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        device,
        bytes.slice(12),
      ),
    );
    return secret ? pubkey : hold(key);
  } catch {
    localStorage.removeItem(UNLOCKED);
    return undefined;
  }
}

let secret: Uint8Array | undefined;
let conversation: Uint8Array | undefined;
let pubkey: string | undefined;

export const storedLocalKey = () =>
  globalThis.localStorage?.getItem(STORED) != null;

function unlockWith(key: Uint8Array) {
  const viewer = hold(key);
  remembering = remember(key).catch(() => {
    localStorage.removeItem(UNLOCKED);
  });
  return viewer;
}

function hold(key: Uint8Array) {
  const viewer = getPublicKey(key);
  secret = key;
  pubkey = viewer;
  conversation = nip44.getConversationKey(key, viewer);
  return viewer;
}

export const localViewer = () => pubkey;

export function parseNsec(input: string): Uint8Array {
  const value = input.trim();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return decoded.data;
  } catch {
    if (/^[0-9a-f]{64}$/i.test(value)) return hexToBytes(value.toLowerCase());
  }
  throw new Error("Enter a valid nsec private key.");
}

export function npubOf(input: string): string {
  return nip19.npubEncode(getPublicKey(parseNsec(input)));
}

/** Encrypts and stores the key, then keeps it unlocked for this page. */
export function saveLocalKey(nsec: string, passphrase: string) {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new Error(
      `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`,
    );
  const key = parseNsec(nsec);
  localStorage.setItem(STORED, nip49.encrypt(key, passphrase));
  return unlockWith(key);
}

export function unlockLocalKey(passphrase: string) {
  const stored = localStorage.getItem(STORED);
  if (!stored) throw new Error("No key is saved in this browser.");
  let key: Uint8Array;
  try {
    key = nip49.decrypt(stored, passphrase);
  } catch {
    throw new Error("Wrong passphrase.");
  }
  return unlockWith(key);
}

export function lockLocalKey() {
  secret = undefined;
  pubkey = undefined;
  conversation = undefined;
  globalThis.localStorage?.removeItem(UNLOCKED);
  remembering = remembering.then(() => deviceKeys.clear()).catch(() => {});
}

export function forgetLocalKey() {
  lockLocalKey();
  localStorage.removeItem(STORED);
}

function unlocked() {
  if (!secret || !conversation) throw new Error("Unlock your key first.");
  return { secret, conversation };
}

export const localSignEvent = (event: EventTemplate) =>
  finalizeEvent(event, unlocked().secret);

export const localSelfEncrypt = (plaintext: string) =>
  nip44.encrypt(plaintext, unlocked().conversation);

export const localSelfDecrypt = (payload: string) =>
  nip44.decrypt(payload, unlocked().conversation);

export const localExportKey = () => nip19.nsecEncode(unlocked().secret);
