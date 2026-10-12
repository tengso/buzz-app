import type { RelayReader } from "../relay/reader";
import type { AgentLibrary } from "./library";
import { readRelayLibrary } from "./relay-library";

/** Agents the viewer registered (kind 30177) that register agents of their own,
 * followed by those agents: team-builder's Chief of Agents and its team. */
export async function readTeamAgents(
  reader: RelayReader,
  viewer: string,
  signal: AbortSignal,
): Promise<AgentLibrary> {
  const own = await readRelayLibrary(reader, viewer, signal);
  const teams = await Promise.all(
    own.identities.map(async (lead) => ({
      lead,
      members: (await readRelayLibrary(reader, lead.pubkey, signal)).identities,
    })),
  );
  const identities = new Map<string, AgentLibrary["identities"][number]>();
  for (const { lead, members } of teams) {
    if (!members.length) continue;
    identities.set(lead.pubkey, { pubkey: lead.pubkey, name: lead.name });
  }
  for (const { members } of teams)
    for (const member of members)
      if (member.pubkey !== viewer && !identities.has(member.pubkey))
        identities.set(member.pubkey, {
          pubkey: member.pubkey,
          name: member.name,
        });
  return { definitions: [], identities: [...identities.values()] };
}
