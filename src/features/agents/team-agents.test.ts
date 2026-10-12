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
  it("lists only the agents that register a team, then their team", async () => {
    const viewer = key();
    const coa = key();
    const old = key();
    const worker = key();
    const events = [
      register(viewer.secret, coa.pubkey, "Chief of Agents"),
      register(viewer.secret, old.pubkey, "Fizz"),
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
      new AbortController().signal,
    );
    expect(team.identities).toEqual([
      { pubkey: coa.pubkey, name: "Chief of Agents" },
      { pubkey: worker.pubkey, name: "Builder" },
    ]);
    expect(team.definitions).toEqual([]);
  });
});
