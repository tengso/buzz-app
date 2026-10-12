import { beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import * as nip19 from "nostr-tools/nip19";
import { eventDto } from "./events";
import { browserReadState, browserSidebarCodec } from "./browser-private";
import {
  forgetLocalKey,
  localSelfDecrypt,
  localSelfEncrypt,
  localSignEvent,
  lockLocalKey,
  saveLocalKey,
  storedLocalKey,
  unlockLocalKey,
} from "../identity/local-key";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values: () => values.values(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  forgetLocalKey();
});

const secret = generateSecretKey();
const nsec = nip19.nsecEncode(secret);
const viewer = getPublicKey(secret);

it("stores only an ncryptsec and unlocks with the passphrase", () => {
  expect(saveLocalKey(nsec, "correct horse")).toBe(viewer);
  const stored = localStorage.getItem("buzz.browser.ncryptsec") ?? "";
  expect(stored.startsWith("ncryptsec1")).toBe(true);
  expect(stored).not.toContain(nsec);
  lockLocalKey();
  expect(() =>
    localSignEvent({ kind: 1, created_at: 1, tags: [], content: "" }),
  ).toThrow("Unlock");
  expect(() => unlockLocalKey("wrong passphrase")).toThrow("Wrong passphrase");
  expect(unlockLocalKey("correct horse")).toBe(viewer);
  const hex = Array.from(secret, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  for (const store of [localStorage, sessionStorage] as unknown as ReturnType<
    typeof storage
  >[])
    for (const value of store.values()) {
      expect(value).not.toContain(nsec);
      expect(value).not.toContain(hex);
    }
  forgetLocalKey();
  expect(storedLocalKey()).toBe(false);
}, 30_000);

it("rejects short passphrases and invalid keys", () => {
  expect(() => saveLocalKey(nsec, "short")).toThrow("at least 8");
  expect(() => saveLocalKey("nsec1nope", "correct horse")).toThrow(
    "valid nsec",
  );
});

it("round-trips self-encrypted sidebar records and rejects foreign ones", async () => {
  saveLocalKey(nsec, "correct horse");
  const cipher = {
    encrypt: async (text: string) => localSelfEncrypt(text),
    decrypt: async (text: string) => localSelfDecrypt(text),
  };
  const codec = browserSidebarCodec(cipher, viewer, async (template) =>
    eventDto(localSignEvent(template)),
  );
  const payload = {
    version: 1,
    channels: { a: { starred: true, updatedAt: 1 } },
  };
  const event = eventDto(await codec.sign("channel-stars", payload, 10));
  expect(event.tags).toEqual([
    ["d", "channel-stars"],
    ["t", "channel-stars"],
  ]);
  expect(await codec.decode([event])).toEqual({ "channel-stars": payload });
  const foreign = eventDto(
    finalizeEvent(
      { kind: 30078, created_at: 10, tags: event.tags, content: event.content },
      generateSecretKey(),
    ),
  );
  await expect(codec.decode([foreign])).rejects.toThrow(
    "Invalid sidebar record",
  );
  await expect(codec.decode([event, event])).rejects.toThrow();
  await expect(codec.sign("other", payload, 10)).rejects.toThrow();
}, 30_000);

it("round-trips read state with the desktop coordinates", async () => {
  saveLocalKey(nsec, "correct horse");
  const cipher = {
    encrypt: async (text: string) => localSelfEncrypt(text),
    decrypt: async (text: string) => localSelfDecrypt(text),
  };
  const sign = async (template: Parameters<typeof localSignEvent>[0]) =>
    eventDto(localSignEvent(template));
  const host = browserReadState(cipher, viewer, sign, vi.fn(), undefined);
  const signal = new AbortController().signal;
  const blob = { v: 1 as const, client_id: "web", contexts: {} };
  const slot = "0123456789abcdef0123456789abcdef";
  const createdAt = Math.floor(Date.now() / 1000);
  const event = await host.sign?.({ slot, createdAt, blob }, signal);
  if (!event) throw new Error("missing sign");
  expect(event.tags).toEqual([
    ["d", `read-state:${slot}`],
    ["t", "read-state"],
  ]);
  expect(await host.decode?.([event], signal)).toEqual([
    { eventId: event.id, blob },
  ]);
  await expect(
    host.sign?.({ slot: "nothex", createdAt, blob }, signal),
  ).rejects.toThrow();
  await expect(
    host.sign?.({ slot, createdAt: createdAt - 600, blob }, signal),
  ).rejects.toThrow();
  const forged = await sign({
    kind: 30078,
    created_at: createdAt,
    content: event.content,
    tags: [["d", `read-state:${slot}`]],
  });
  await expect(host.decode?.([forged], signal)).rejects.toThrow();
}, 30_000);
