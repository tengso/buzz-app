import { useCallback, useEffect, useMemo, useState } from "react";
import {
  browserHostEnabled,
  browserSignEvent,
} from "../../features/identity/browser";
import type { PanelProps } from "../../features/panels/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ShieldIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  GatewayError,
  decisionText,
  keelFetch,
  keelSettings,
  type KeelConversation,
  type KeelObject,
  type KeelProposal,
  type KeelTask,
  type Signer,
} from "./gateway";
import { parseKeelReference, type KeelReference } from "./references";

const signer = (): Signer | undefined =>
  browserHostEnabled() ? browserSignEvent : undefined;

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** Decisions Keel takes from a chat reply; other task types are decided in the workbench. */
const DECISIONS: Record<
  string,
  readonly ("approve" | "reject" | "accept" | "pick")[]
> = {
  "approve-action": ["approve", "reject"],
  "confirm-proposal": ["accept", "reject"],
  "resolve-conflict": ["pick", "reject"],
};

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.amount === "number" &&
      typeof record.currency === "string"
    )
      return `${record.currency} ${record.amount.toLocaleString()}`;
    return JSON.stringify(value);
  }
  return String(value);
}

type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; code?: number };

function useKeel<T>(path: string | undefined): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    keelFetch<T>(path, {
      sign: signer(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
      .then((value) => {
        if (!controller.signal.aborted) setState({ status: "ready", value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: message(error),
          ...(error instanceof GatewayError ? { code: error.status } : {}),
        });
      });
    return () => controller.abort();
  }, [path]);
  return state;
}

let conversation: Promise<KeelConversation | undefined> | undefined;
/** Keel's own chat key, mentioned on decisions so Keel's follower sees replies outside its threads. */
function keelConversation() {
  conversation ??= keelFetch<KeelConversation>("/api/v1/conversation", {
    sign: signer(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  return conversation;
}
/** Read Keel's key again (settings changed, or a test). */
export function forgetKeelConversation() {
  conversation = undefined;
}

export function KeelPanel({
  relay,
  target,
  channelContext,
}: PanelProps & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const reference = useMemo(
    () => parseKeelReference(target, keelSettings().workbench),
    [target],
  );
  if (!reference)
    return <p className="p-4 text-body">Unsupported Keel link.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <KeelRecord
        key={`${reference.url}:${connection.status === "ready" ? connection.generation : 0}`}
        reference={reference}
        session={connection.status === "ready" ? connection.session : undefined}
        channelId={channelContext?.channelId}
        threadId={channelContext?.threadId}
      />
    </div>
  );
}

export function KeelRecord(props: {
  reference: KeelReference;
  session?: RelaySession | undefined;
  channelId?: string | undefined;
  threadId?: string | undefined;
}) {
  const [attempt, retry] = useState(0);
  return (
    <KeelRecordView
      key={attempt}
      {...props}
      refresh={() => retry(attempt + 1)}
    />
  );
}

function KeelRecordView({
  reference,
  session,
  channelId,
  threadId,
  refresh,
}: {
  reference: KeelReference;
  session?: RelaySession | undefined;
  channelId?: string | undefined;
  threadId?: string | undefined;
  refresh(): void;
}) {
  const path =
    reference.kind === "task"
      ? `/api/v1/tasks/${encodeURIComponent(reference.id)}`
      : `/api/v1/objects/${encodeURIComponent(reference.type)}/${encodeURIComponent(reference.pk)}?include=evidence,proposals,findings`;
  const loaded = useKeel<KeelTask | KeelObject>(path);
  if (loaded.status === "loading")
    return (
      <p className="text-body-sm text-muted" role="status">
        Reading from Keel…
      </p>
    );
  if (loaded.status === "error")
    return (
      <EmptyState
        icon={<ShieldIcon />}
        title={
          loaded.code === 401
            ? "Your key is not linked to Keel"
            : "Keel did not answer"
        }
        description={loaded.error}
        action={
          <Button size="compact" onClick={refresh}>
            Retry
          </Button>
        }
      />
    );
  return reference.kind === "task" ? (
    <TaskCard
      task={loaded.value as KeelTask}
      session={session}
      channelId={channelId}
      threadId={threadId}
      refresh={refresh}
    />
  ) : (
    <ObjectCard reference={reference} record={loaded.value as KeelObject} />
  );
}

export function TaskCard({
  task,
  session,
  channelId,
  threadId,
  refresh,
}: {
  task: KeelTask;
  session?: RelaySession | undefined;
  channelId?: string | undefined;
  threadId?: string | undefined;
  refresh(): void;
}) {
  const subject = task.subject;
  const objectPath =
    subject.object_type && subject.pk !== undefined
      ? `/api/v1/objects/${encodeURIComponent(subject.object_type)}/${encodeURIComponent(String(subject.pk))}?include=proposals,evidence`
      : undefined;
  const object = useKeel<KeelObject>(objectPath);
  const candidateIds = [
    ...(subject.proposal ? [subject.proposal] : []),
    ...(subject.proposals ?? []),
  ];
  const candidates =
    object.status === "ready"
      ? candidateIds
          .map((id) => object.value.proposals?.find((p) => p.id === id))
          .filter((p): p is KeelProposal => !!p)
      : [];
  const open = task.state === "open" || task.state === "claimed";
  const verbs = DECISIONS[task.type] ?? [];
  const destination = {
    channelId: channelId ?? task.post?.chat_channel ?? undefined,
    threadId: threadId ?? task.post?.thread ?? undefined,
  };
  return (
    <article aria-label={task.title} className="grid gap-4">
      <header className="grid gap-1">
        <p className="text-body-sm text-muted">
          {task.type} · {task.state}
          {task.due_at
            ? ` · due ${new Date(task.due_at).toLocaleString()}`
            : ""}
        </p>
        <h2 className="text-heading-sm">{task.title}</h2>
        <p className="text-body-sm text-muted">
          Assigned to {task.assignee}
          {task.claimed_by ? `, claimed by ${task.claimed_by}` : ""}
        </p>
      </header>
      {subject.action_type && (
        <dl className="grid gap-1 text-body-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Action</dt>
            <dd>{subject.action_type}</dd>
          </div>
          {Object.entries(subject.params ?? {}).map(([name, value]) => (
            <div key={name} className="flex gap-2">
              <dt className="text-muted">{name}</dt>
              <dd>{formatParam(value)}</dd>
            </div>
          ))}
          {subject.quorum !== undefined && (
            <div className="flex gap-2">
              <dt className="text-muted">Approvals needed</dt>
              <dd>{String(subject.quorum)}</dd>
            </div>
          )}
        </dl>
      )}
      {subject.object_type && (
        <p className="text-body-sm">
          <span className="text-muted">On </span>
          {subject.object_type}/{String(subject.pk)}
          {subject.property ? ` · ${subject.property}` : ""}
        </p>
      )}
      {candidates.length > 0 && (
        <ol className="grid gap-2" aria-label="Candidates">
          {candidates.map((candidate, index) => (
            <li key={candidate.id} className="grid gap-0.5 text-body-sm">
              <span>
                <span className="text-muted">{index + 1}. </span>
                {formatValue(candidate.value)}
                {candidate.confidence != null && (
                  <span className="text-muted">
                    {" "}
                    · confidence {candidate.confidence}
                  </span>
                )}
              </span>
              {candidate.evidence?.source?.excerpt && (
                <q className="text-muted">
                  {candidate.evidence.source.excerpt}
                  {candidate.evidence.source.page
                    ? ` (p. ${candidate.evidence.source.page})`
                    : ""}
                </q>
              )}
            </li>
          ))}
        </ol>
      )}
      {task.resolution && (
        <p className="text-body-sm">
          <span className="text-muted">Resolution </span>
          {formatValue(task.resolution.decision)}
          {task.resolution.by ? ` by ${String(task.resolution.by)}` : ""}
        </p>
      )}
      {open && verbs.length > 0 && (
        <Decide
          task={task}
          verbs={verbs}
          candidates={candidates}
          session={session}
          destination={destination}
          refresh={refresh}
        />
      )}
      {open && verbs.length === 0 && (
        <p className="text-body-sm text-muted">
          This task is decided in the Keel workbench.
        </p>
      )}
    </article>
  );
}

function formatParam(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "objectType" in value &&
    "pk" in value
  ) {
    const ref = value as { objectType: string; pk: unknown };
    return `${ref.objectType}/${String(ref.pk)}`;
  }
  return formatValue(value);
}

/** A decision is a signed reply in the task's thread: Keel's follower verifies and applies it. */
function Decide({
  task,
  verbs,
  candidates,
  session,
  destination,
  refresh,
}: {
  task: KeelTask;
  verbs: readonly ("approve" | "reject" | "accept" | "pick")[];
  candidates: KeelProposal[];
  session?: RelaySession | undefined;
  destination: {
    channelId?: string | undefined;
    threadId?: string | undefined;
  };
  refresh(): void;
}) {
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<{
    kind: "sent" | "error";
    text: string;
  }>();
  const outbox = session?.outbox;
  const ready = !!outbox?.supports(9) && !!destination.channelId;
  const send = useCallback(
    async (verb: (typeof verbs)[number], choice?: string) => {
      if (!outbox || !destination.channelId) return;
      const content = decisionText(verb, task.id, reason, choice);
      const keel = await keelConversation();
      const tags: string[][] = [["h", destination.channelId]];
      if (destination.threadId)
        tags.push(["e", destination.threadId, "", "reply"]);
      const mention = keel?.pubkey ? [["p", keel.pubkey]] : [];
      try {
        try {
          outbox.send({ kind: 9, content, tags: [...tags, ...mention] });
        } catch (error) {
          if (!mention.length) throw error;
          outbox.send({ kind: 9, content, tags }); // Keel is not a member here: reply without the mention
        }
        setStatus({
          kind: "sent",
          text: `Sent “${content}”. Keel applies it once it reads your reply.`,
        });
      } catch (error) {
        setStatus({ kind: "error", text: message(error) });
      }
    },
    [outbox, destination.channelId, destination.threadId, task.id, reason],
  );
  if (status?.kind === "sent")
    return (
      <div className="grid gap-2">
        <p role="status" className="text-body-sm">
          {status.text}
        </p>
        <Button size="compact" onClick={refresh}>
          Refresh
        </Button>
      </div>
    );
  return (
    <form
      className="grid gap-3"
      aria-label="Decide"
      onSubmit={(event) => event.preventDefault()}
    >
      <Field label="Reason">
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why (recorded in Keel's audit)"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {verbs.includes("pick") ? (
          candidates.map((candidate, index) => (
            <Button
              key={candidate.id}
              variant="primary"
              size="compact"
              disabled={!ready}
              onClick={() => void send("pick", String(index + 1))}
            >
              Pick {index + 1}
            </Button>
          ))
        ) : (
          <Button
            variant="primary"
            size="compact"
            disabled={!ready}
            onClick={() => void send(verbs[0] ?? "approve")}
          >
            {verbs[0] === "approve" ? "Approve" : "Accept"}
          </Button>
        )}
        <Button
          size="compact"
          disabled={!ready}
          onClick={() => void send("reject")}
        >
          Reject
        </Button>
      </div>
      {!ready && (
        <p className="text-body-sm text-muted">
          {destination.channelId
            ? "Connect to the community to decide from here."
            : "Keel has not posted this task to a channel; decide from its thread or the workbench."}
        </p>
      )}
      {status?.kind === "error" && (
        <p role="alert" className="error">
          {status.text}
        </p>
      )}
    </form>
  );
}

export function ObjectCard({
  reference,
  record,
}: {
  reference: Extract<KeelReference, { kind: "object" }>;
  record: KeelObject;
}) {
  const evidenceKind = new Map(
    (record.evidence ?? []).map((row) => [row.property, row.kind]),
  );
  const masked = new Set(record.context?.masked ?? []);
  const fields = Object.entries(record.object).filter(
    ([name]) => !name.startsWith("_"),
  );
  const proposals = (record.proposals ?? []).filter(
    (p) => p.state === "proposed",
  );
  return (
    <article
      aria-label={`${reference.type} ${reference.pk}`}
      className="grid gap-4"
    >
      <header className="grid gap-1">
        <p className="text-body-sm text-muted">
          {reference.type} · version {record.object._version}
        </p>
        <h2 className="text-heading-sm">{reference.pk}</h2>
      </header>
      <dl className="grid gap-1 text-body-sm">
        {fields.map(([name, value]) => (
          <div key={name} className="flex flex-wrap gap-2">
            <dt className="text-muted">{name}</dt>
            <dd>
              {masked.has(name) ? (
                <span className="text-muted">hidden from you</span>
              ) : (
                formatValue(value)
              )}
              {evidenceKind.has(name) && !masked.has(name) && (
                <span className="text-muted"> · {evidenceKind.get(name)}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {proposals.length > 0 && (
        <section className="grid gap-1 text-body-sm">
          <h3 className="text-muted">Open proposals</h3>
          {proposals.map((p) => (
            <p key={p.id}>
              {p.property}: {formatValue(p.value)}
              {p.producer?.name ? ` · ${p.producer.name}` : ""}
            </p>
          ))}
        </section>
      )}
      {record.findings && record.findings.length > 0 && (
        <section className="grid gap-1 text-body-sm">
          <h3 className="text-muted">Findings</h3>
          {record.findings.map((f) => (
            <p key={f.id}>
              {f.severity}: {f.message}
            </p>
          ))}
        </section>
      )}
    </article>
  );
}
