import { readRoster } from "../communities/roster";
import type { RelayReader } from "../relay/reader";
import type { AgentLibrary } from "./library";
import { readRelayLibrary } from "./relay-library";

/** The community's agent team: agents a community owner (or the viewer)
 * registered (kind 30177) that register agents of their own, such as
 * team-builder's Chief of Agents, followed by the agents they registered. */
export async function readTeamAgents(
  reader: RelayReader,
  viewer: string,
  relayAuthor: string | undefined,
  signal: AbortSignal,
): Promise<AgentLibrary> {
  const roster = relayAuthor
    ? await readRoster(
        {
          relayAuthor,
          read: (filters, settings) => reader.read(filters, settings),
        },
        signal,
      )
    : null;
  const owners = new Set([
    ...(roster ?? [])
      .filter((member) => member.role === "owner")
      .map((member) => member.pubkey),
    viewer,
  ]);
  const registered = await Promise.all(
    [...owners].map((owner) => readRelayLibrary(reader, owner, signal)),
  );
  const leads = [
    ...new Map(
      registered
        .flatMap((library) => library.identities)
        .map((lead) => [lead.pubkey, lead]),
    ).values(),
  ];
  const teams = await Promise.all(
    leads.map(async (lead) => ({
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
      if (!owners.has(member.pubkey) && !identities.has(member.pubkey))
        identities.set(member.pubkey, {
          pubkey: member.pubkey,
          name: member.name,
        });
  return { definitions: [], identities: [...identities.values()] };
}
