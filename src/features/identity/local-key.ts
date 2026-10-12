import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import * as nip49 from "nostr-tools/nip49";

/** NIP-49 encrypted key. The decrypted key lives only in module memory. */
const STORED = "buzz.browser.ncryptsec";
const MIN_PASSPHRASE = 8;

function hexToBytes(hex: string) {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Invalid key");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

let secret: Uint8Array | undefined;
let conversation: Uint8Array | undefined;
let pubkey: string | undefined;

export const storedLocalKey = () =>
  globalThis.localStorage?.getItem(STORED) != null;

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
  return hold(key);
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
  return hold(key);
}

export function lockLocalKey() {
  secret = undefined;
  pubkey = undefined;
  conversation = undefined;
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
