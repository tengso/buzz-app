import { verifyEvent, type EventTemplate } from "nostr-tools";
import type { SelfCipher } from "../identity/browser";
import type { ChannelKitHost } from "../channel-templates/host";
import {
  parsePrivateRecord,
  privateCoordinate,
  privateTag,
  type KitRecord,
  type PayloadRecord,
} from "../channel-templates/model";
import { eventDto, type RelayEvent } from "./events";
import { readApiFailure } from "./http-admission";
import { readCoordinate, parseReadBlob } from "./read-state-model";
import type { ReadStateHost } from "./read-state-host";
import {
  parseReadSnapshot,
  readSnapshotFilter,
  readSnapshotText,
} from "./read-state-snapshot";
import type { SidebarCodec } from "./native-sidebar";
import { acceptReadStatePublish } from "./transport";

/** Mirrors the native host's checks in `src-tauri/src/identity.rs`. */
const SIDEBAR = new Set([
  "channel-sections",
  "channel-stars",
  "channel-mutes",
  "channel-sort",
]);
const READ_SLOT = /^read-state:[0-9a-f]{32}$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;

type Sign = (event: EventTemplate) => Promise<RelayEvent>;
type Request = (
  path: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<Response>;

function owned(raw: RelayEvent, viewer: string, error: string) {
  if (raw.kind !== 30078 || raw.pubkey !== viewer || !verifyEvent({ ...raw }))
    throw new Error(error);
}

const tagValues = (event: RelayEvent, key: string) =>
  event.tags.filter(([name]) => name === key).map(([, value]) => value);

async function decryptJson(
  cipher: SelfCipher,
  content: string,
  limit: number,
  error: string,
): Promise<unknown> {
  let plaintext: string;
  try {
    plaintext = await cipher.decrypt(content);
  } catch {
    throw new Error(error);
  }
  if (bytes(plaintext) > limit) throw new Error(error);
  try {
    return JSON.parse(plaintext);
  } catch {
    throw new Error(error);
  }
}

export function browserSidebarCodec(
  cipher: SelfCipher,
  viewer: string,
  sign: Sign,
): SidebarCodec {
  return {
    async decode(events) {
      const error = "Invalid sidebar record";
      if (events.length > 4 || bytes(JSON.stringify(events)) > 768 * 1024)
        throw new Error("Invalid sidebar records");
      const decoded: Record<string, unknown> = {};
      for (const event of events) {
        owned(event, viewer, error);
        const ds = tagValues(event, "d");
        const coordinate = ds[0];
        if (
          ds.length !== 1 ||
          !coordinate ||
          !SIDEBAR.has(coordinate) ||
          coordinate in decoded
        )
          throw new Error(error);
        decoded[coordinate] = await decryptJson(
          cipher,
          event.content,
          128 * 1024,
          error,
        );
      }
      return decoded;
    },
    async sign(coordinate, payload, createdAt) {
      if (!SIDEBAR.has(coordinate))
        throw new Error("Invalid sidebar coordinate");
      const plaintext = JSON.stringify(payload);
      if (bytes(plaintext) > 128 * 1024)
        throw new Error("Sidebar plaintext budget exceeded");
      return sign({
        kind: 30078,
        created_at: createdAt,
        content: await cipher.encrypt(plaintext),
        tags: [
          ["d", coordinate],
          ["t", coordinate],
        ],
      });
    },
  };
}

export function browserReadState(
  cipher: SelfCipher,
  viewer: string,
  sign: Sign,
  request: Request,
  communityId: string | undefined,
): ReadStateHost {
  const error = "Invalid read-state event";
  async function decodeOne(event: RelayEvent) {
    if (bytes(JSON.stringify(event)) > 96 * 1024) throw new Error(error);
    const ds = tagValues(event, "d");
    const ts = tagValues(event, "t").filter((value) => value === "read-state");
    if (ds.length !== 1 || ts.length !== 1 || !READ_SLOT.test(ds[0] ?? ""))
      throw new Error(error);
    owned(event, viewer, error);
    const blob = await decryptJson(cipher, event.content, 128 * 1024, error);
    parseReadBlob(blob);
    return { eventId: event.id, blob };
  }
  return {
    ...(communityId ? { communityId } : {}),
    async decode(events, signal) {
      signal.throwIfAborted();
      if (events.length > 16 || bytes(JSON.stringify(events)) > 512 * 1024)
        throw new Error("Read-state decode capacity exceeded");
      const decoded = [];
      for (const event of events) decoded.push(await decodeOne(event));
      signal.throwIfAborted();
      return decoded;
    },
    async sign(intent, signal) {
      signal.throwIfAborted();
      parseReadBlob(intent.blob);
      const slot = `read-state:${intent.slot}`;
      if (
        !READ_SLOT.test(slot) ||
        Math.abs(Math.floor(Date.now() / 1000) - intent.createdAt) > 60
      )
        throw new Error("Invalid read-state signing intent");
      const plaintext = JSON.stringify(intent.blob);
      if (bytes(plaintext) > 40 * 1024)
        throw new Error("Read-state publication capacity exceeded");
      const event = await sign({
        kind: 30078,
        created_at: intent.createdAt,
        content: await cipher.encrypt(plaintext),
        tags: [
          ["d", slot],
          ["t", "read-state"],
        ],
      });
      signal.throwIfAborted();
      if (event.pubkey !== viewer || !readCoordinate(event))
        throw new Error(error);
      return event;
    },
    async publish(event, signal) {
      signal.throwIfAborted();
      if (event.pubkey !== viewer || !readCoordinate(event))
        throw new Error(error);
      await decodeOne(event);
      const response = await request("/events", event, signal);
      signal.throwIfAborted();
      await acceptReadStatePublish(response, event.id);
    },
  };
}

export async function browserReadSnapshot(
  request: Request,
  viewer: string,
  communityId: string,
  signal: AbortSignal,
) {
  const response = await request("/query", readSnapshotFilter(viewer), signal);
  signal.throwIfAborted();
  if (!response.ok) throw new Error((await readApiFailure(response)).error);
  return parseReadSnapshot(
    JSON.parse(await readSnapshotText(response)),
    viewer,
    communityId,
    signal,
  );
}

export function browserChannelKit(
  cipher: SelfCipher,
  viewer: string,
  origin: string,
): ChannelKitHost {
  const error = "Invalid channel recipe";
  return {
    async prepare(record: KitRecord | PayloadRecord, signal) {
      signal.throwIfAborted();
      const content = await cipher.encrypt(
        JSON.stringify(parsePrivateRecord(record, origin)),
      );
      signal.throwIfAborted();
      if (content.length > 64 * 1024)
        throw new Error("Invalid encrypted recipe");
      return content;
    },
    async decode(events, signal) {
      signal.throwIfAborted();
      if (events.length > 16)
        throw new Error("Recipe decode capacity exceeded");
      const decoded = [];
      for (const raw of events) {
        const event = eventDto(raw);
        owned(event, viewer, error);
        if (
          event.content.length > 64 * 1024 ||
          tagValues(event, "d").length !== 1 ||
          tagValues(event, "t").length !== 1 ||
          event.tags.some(
            ([key]) => !["d", "t", "client-id"].includes(key ?? ""),
          )
        )
          throw new Error("Recipe decode mismatch");
        const value = (await decryptJson(
          cipher,
          event.content,
          48 * 1024,
          error,
        )) as { version?: unknown; value?: Record<string, unknown> };
        const portable = value?.value?.portable as
          | Record<string, unknown>
          | undefined;
        const owner =
          value?.version === 2 ? portable?.owner : value?.value?.owner;
        if (
          (value?.version === 2 || value?.value?.type === "team-payload") &&
          owner !== viewer
        )
          throw new Error("Portable team belongs to another viewer");
        const record = parsePrivateRecord(value, origin);
        if (
          !event.tags.some(
            ([key, v]) => key === "d" && v === privateCoordinate(record),
          ) ||
          !event.tags.some(
            ([key, v]) => key === "t" && v === privateTag(record),
          )
        )
          throw new Error("Recipe decode mismatch");
        decoded.push({ eventId: event.id, record });
      }
      signal.throwIfAborted();
      return decoded;
    },
  };
}
