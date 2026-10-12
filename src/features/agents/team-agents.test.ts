import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { readTeamAgents } from "./team-agents";

const key = () => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};
const register = (owner: Uint8Array, agent: string, name: string) =>
  finalizeEvent(
    {
      kind: 30177,
      created_at: 1_700_000_000,
      tags: [["d", agent]],
      content: JSON.stringify({ name }),
    },
    owner,
  ) as unknown as RelayEvent;

describe("readTeamAgents", () => {
  it("lists the owner's team to any member, without old agents", async () => {
    const relay = key();
    const owner = key();
    const viewer = key();
    const coa = key();
    const old = key();
    const worker = key();
    const events = [
      finalizeEvent(
        {
          kind: 13534,
          created_at: 1_700_000_000,
          tags: [
            ["member", owner.pubkey, "owner"],
            ["member", viewer.pubkey, "member"],
          ],
          content: "",
        },
        relay.secret,
      ) as unknown as RelayEvent,
      register(owner.secret, coa.pubkey, "Chief of Agents"),
      register(owner.secret, old.pubkey, "Fizz"),
      register(coa.secret, worker.pubkey, "Builder"),
    ];
    const reader = {
      read: async (filters: readonly ReadFilter[]) =>
        events.filter((event) =>
          filters.some((filter) => filter.authors?.includes(event.pubkey)),
        ),
    };
    const team = await readTeamAgents(
      reader,
      viewer.pubkey,
      relay.pubkey,
      new AbortController().signal,
    );
    expect(team.identities).toEqual([
      { pubkey: coa.pubkey, name: "Chief of Agents" },
      { pubkey: worker.pubkey, name: "Builder" },
    ]);
    expect(team.definitions).toEqual([]);
  });
});
