import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useIdentityNames } from "../../features/identity-names/react";
import { archiveHides } from "../../features/relay/identity-archives";
import type { RelaySession } from "../../features/relay/session";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";

/** Browser host: the agent team of this community (team-builder's Chief of
 * Agents and the agents it registered), instead of the old saved library. */
export function TeamAgents({
  session,
  headerActions,
}: {
  session: RelaySession;
  headerActions: HTMLElement | null;
}) {
  const resolveName = useIdentityNames(session.names);
  const team = session.teamAgents;
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    team.subscribe,
    team.snapshot,
    team.snapshot,
  );
  useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const refresh = () => {
    void team.refresh();
    void archives.refresh();
  };
  useEffect(() => {
    void team.refresh();
    void archives.refresh();
  }, [team, archives]);
  const identities = snapshot.identities.filter(
    (identity) => !archiveHides(archives, identity.pubkey, session.viewer),
  );
  const candidates = identities.map((identity) => identity.pubkey);
  const label = (identity: { pubkey: string; name: string }) =>
    resolveName(identity.pubkey, identity.name, candidates);
  const [lead, ...members] = identities;
  members.sort(
    (a, b) =>
      label(a).localeCompare(label(b), undefined, { sensitivity: "base" }) ||
      a.pubkey.localeCompare(b.pubkey),
  );
  const loading = snapshot.status === "loading";
  return (
    <div className="space-y-section-gap">
      {headerActions &&
        createPortal(
          <Button
            variant="quiet"
            size="compact"
            disabled={loading || snapshot.status === "unavailable"}
            onClick={refresh}
          >
            <ArrowsClockwiseIcon size={16} aria-hidden="true" />
            {snapshot.status === "error" ? "Retry" : "Refresh agents"}
          </Button>,
          headerActions,
        )}
      {loading && (
        <p className="text-body" role="status">
          Reading team agents…
        </p>
      )}
      {snapshot.error && (
        <p className="text-body" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.status === "ready" && (
        <section aria-label="Team agents" className="flex flex-col gap-4">
          <h2 className="m-0 text-heading">
            Team agents ({identities.length})
          </h2>
          {lead ? (
            <div className="overflow-hidden rounded-xl border border-primary">
              {[lead, ...members].map((identity) => (
                <AgentCard
                  layout="row"
                  key={identity.pubkey}
                  name={label(identity)}
                  identities={[identity]}
                  session={session}
                />
              ))}
            </div>
          ) : (
            <p>No agent team is registered to you in this community.</p>
          )}
          <p className="m-0 text-body-sm text-secondary">
            Ask {lead ? label(lead) : "the team lead"} in chat to create, stop
            or change agents.
          </p>
        </section>
      )}
    </div>
  );
}
