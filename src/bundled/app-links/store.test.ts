// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ReadFilter } from "../../features/relay/events";
import type { OutgoingEvent } from "../../features/relay/outbox";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { COMMUNITY_D, PERSONAL_D } from "./model";
import { createAppLinks } from "./store";

const RELAY = "a".repeat(64);
const OWNER = "b".repeat(64);
const MEMBER = "c".repeat(64);
const list = (title: string) =>
  JSON.stringify({
    version: 1,
    links: [{ id: "x1", title, url: "/HaiChat/admin/", trusted: false }],
  });
const event = (
  pubkey: string,
  d: string,
  content: string,
  created_at = 10,
) => ({
  id: `${pubkey.slice(0, 4)}${d}${created_at}`,
  pubkey,
  created_at,
  kind: 30078,
  tags: [["d", d]],
  content,
});
const cipher = {
  encrypt: async (text: string) => `enc:${text}`,
  decrypt: async (text: string) => {
    if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
    return text.slice(4);
  },
};

function setup(viewer: string, stored: ReturnType<typeof event>[]) {
  let outgoing: OutgoingEvent[] = [];
  const outboxListeners = new Set<() => void>();
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  let outcome: OutgoingEvent["delivery"] = "accepted";
  const outbox = {
    supports: (kind: number) => kind === 30078,
    ready: async () => {},
    snapshot: () => outgoing,
    subscribe(listener: () => void) {
      outboxListeners.add(listener);
      return () => outboxListeners.delete(listener);
    },
    send(input: { kind: number; content: string; tags: string[][] }) {
      sent.push(input);
      const id = `sent${sent.length}`;
      const pending: OutgoingEvent = {
        event: { ...input, id, pubkey: viewer, created_at: 20 },
        delivery: "sending",
      };
      outgoing = [pending];
      queueMicrotask(() => {
        outgoing = [
          {
            ...pending,
            delivery: outcome,
            error: outcome === "failed" ? "rejected: blocked" : undefined,
          },
        ];
        for (const listener of outboxListeners) listener();
      });
      return id;
    },
  };
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (filters[0]?.kinds?.[0] === 13534)
      return [
        {
          id: "roster",
          pubkey: RELAY,
          created_at: 1,
          kind: 13534,
          tags: [
            ["member", OWNER, "owner"],
            ["member", MEMBER, "member"],
          ],
          content: "",
        },
      ];
    return stored;
  });
  const session = { viewer, relayAuthor: RELAY, read, outbox };
  const snapshot = {
    status: "ready",
    generation: 1,
    scope: `https://gw.example:${viewer}`,
    session,
  } as unknown as RelaySnapshot;
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  return {
    links: createAppLinks(relay, () => cipher),
    read,
    sent,
    fail: () => {
      outcome = "failed";
    },
  };
}

const ready = async (links: ReturnType<typeof createAppLinks>) =>
  vi.waitFor(() => expect(links.snapshot().status).toBe("ready"));

describe("app links store", () => {
  it("reads the owner's community list and the viewer's encrypted list", async () => {
    const { links, read } = setup(MEMBER, [
      event(OWNER, COMMUNITY_D, list("Old"), 5),
      event(OWNER, COMMUNITY_D, list("Admin"), 9),
      event(MEMBER, COMMUNITY_D, list("Not the owner"), 30),
      event(MEMBER, PERSONAL_D, `enc:${list("Mine")}`),
    ]);
    await ready(links);
    expect(links.snapshot()).toMatchObject({
      owner: false,
      personalAvailable: true,
      community: [{ title: "Admin" }],
      personal: [{ title: "Mine" }],
    });
    expect(read.mock.calls[1]?.[0]).toEqual([
      { kinds: [30078], authors: [OWNER], "#d": [COMMUNITY_D], limit: 2 },
      { kinds: [30078], authors: [MEMBER], "#d": [PERSONAL_D], limit: 2 },
    ]);
  });

  it("keeps one list when the other cannot be read", async () => {
    const { links } = setup(MEMBER, [
      event(OWNER, COMMUNITY_D, list("Admin")),
      event(MEMBER, PERSONAL_D, "garbled"),
    ]);
    await ready(links);
    expect(links.snapshot().community).toHaveLength(1);
    expect(links.snapshot().error).toMatch(/Your apps: cannot decrypt/);
  });

  it("saves the viewer's list encrypted and the community list only as owner", async () => {
    const member = setup(MEMBER, []);
    await ready(member.links);
    const app = {
      id: "n1",
      title: "Risk",
      url: "/HaiChat/risk/",
      trusted: true,
    };
    await member.links.save("personal", [app]);
    expect(member.sent[0]).toEqual({
      kind: 30078,
      content: `enc:${JSON.stringify({ version: 1, links: [app] })}`,
      tags: [
        ["d", PERSONAL_D],
        ["t", PERSONAL_D],
      ],
    });
    expect(member.links.snapshot().personal).toEqual([app]);
    await expect(member.links.save("community", [app])).rejects.toThrow(
      /Only the community owner/,
    );

    const owner = setup(OWNER, []);
    await ready(owner.links);
    expect(owner.links.snapshot().owner).toBe(true);
    await owner.links.save("community", [app]);
    expect(owner.sent[0]?.content).toBe(
      JSON.stringify({ version: 1, links: [app] }),
    );
    expect(owner.sent[0]?.tags[0]).toEqual(["d", COMMUNITY_D]);
  });

  it("retries reads cancelled while the community is joined", async () => {
    vi.useFakeTimers();
    try {
      const { links, read } = setup(MEMBER, [
        event(OWNER, COMMUNITY_D, list("Admin")),
      ]);
      read.mockRejectedValueOnce(
        new DOMException("Relay read cancelled", "AbortError"),
      );
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(links.snapshot().status).toBe("loading");
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(links.snapshot().status).toBe("ready"));
      expect(links.snapshot()).toMatchObject({
        community: [{ title: "Admin" }],
        personalAvailable: true,
      });
      expect(links.snapshot().error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a change the relay refused and keeps the old list", async () => {
    const { links, fail } = setup(MEMBER, []);
    await ready(links);
    fail();
    await expect(
      links.save("personal", [
        { id: "n1", title: "Risk", url: "/HaiChat/risk/", trusted: false },
      ]),
    ).rejects.toThrow("rejected: blocked");
    expect(links.snapshot().personal).toEqual([]);
  });
});
