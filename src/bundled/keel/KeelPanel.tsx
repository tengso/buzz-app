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
  context,
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
        // A link opened from a message supplies its channel through `context`, not `channelContext`.
        channelId={channelContext?.channelId ?? context?.channelId}
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
  const { session, reference } = props;
  // Keel says in the task's thread when the task changes (decided, escalated, expired): read it again then.
  useEffect(() => {
    if (!session?.subscribeLive || reference.kind !== "task") return;
    let keel: string | null | undefined;
    void keelConversation().then((found) => {
      keel = found?.pubkey ?? null;
    });
    return session.subscribeLive(({ events }) => {
      if (
        events.some(
          (event) =>
            event.kind === 9 &&
            (keel ? event.pubkey === keel : true) &&
            event.content.includes(reference.url),
        )
      )
        retry((count) => count + 1);
    });
  }, [session, reference.kind, reference.url]);
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
    <>
      <ObjectCard reference={reference} record={loaded.value as KeelObject} />
      <Actions
        reference={reference}
        session={session}
        destination={{ channelId, threadId }}
      />
    </>
  );
}

type KeelParameter = {
  name: string;
  type?: string | null;
  objectType?: string | null;
  required?: boolean;
  choices?: string[] | null;
  label?: Record<string, string> | null;
};
type KeelActionType = {
  name: string;
  label?: Record<string, string> | null;
  description?: Record<string, string> | null;
  riskTier?: string;
  parameters: KeelParameter[];
};

/** Governed actions the viewer may execute on this object, as forms generated from each action's parameters.
 * Submitting sends `submit <action> {json}` to Keel in this thread; Keel applies it as the viewer (policy,
 * criteria, approvals) and answers there. Nothing is written over HTTP. */
function Actions({
  reference,
  session,
  destination,
}: {
  reference: Extract<KeelReference, { kind: "object" }>;
  session?: RelaySession | undefined;
  destination: {
    channelId?: string | undefined;
    threadId?: string | undefined;
  };
}) {
  const loaded = useKeel<{ actionTypes: Record<string, KeelActionType> }>(
    "/api/v1/ontology",
  );
  const [open, setOpen] = useState<string>();
  if (loaded.status !== "ready") return null;
  const actions = Object.values(loaded.value.actionTypes).filter((action) =>
    action.parameters.some((p) => p.objectType === reference.type),
  );
  if (!actions.length) return null;
  const current = actions.find((action) => action.name === open);
  return (
    <section className="grid gap-2 border-t pt-3" aria-label="Actions">
      <h3 className="text-body-sm text-muted">Actions</h3>
      {current ? (
        <ActionForm
          key={current.name}
          action={current}
          reference={reference}
          session={session}
          destination={destination}
          close={() => setOpen(undefined)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action.name}
              size="compact"
              onClick={() => setOpen(action.name)}
            >
              {action.label?.en ?? action.name}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function ActionForm({
  action,
  reference,
  session,
  destination,
  close,
}: {
  action: KeelActionType;
  reference: Extract<KeelReference, { kind: "object" }>;
  session?: RelaySession | undefined;
  destination: {
    channelId?: string | undefined;
    threadId?: string | undefined;
  };
  close(): void;
}) {
  const target = action.parameters.find((p) => p.objectType === reference.type);
  const fields = action.parameters.filter((p) => p !== target);
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{
    kind: "sent" | "error";
    text: string;
  }>();
  const outbox = session?.outbox;
  const ready = !!outbox?.supports(9) && !!destination.channelId;
  const set = (name: string, value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  const submit = async () => {
    if (!outbox || !destination.channelId || !target) return;
    const params: Record<string, unknown> = { [target.name]: reference.pk };
    for (const p of fields) {
      const value = values[p.name]?.trim();
      if (!value) continue;
      params[p.name] =
        p.type === "money"
          ? {
              amount: Number(value),
              currency: values[`${p.name}.currency`]?.trim() || "USD",
            }
          : p.type === "integer" || p.type === "decimal" || p.type === "number"
            ? Number(value)
            : value;
    }
    const content = `submit ${action.name} ${JSON.stringify(params)}`;
    try {
      await sendToKeel(
        outbox,
        destination.channelId,
        destination.threadId,
        content,
      );
      setStatus({
        kind: "sent",
        text: `Sent “${content}”. Keel answers in this thread.`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: message(error) });
    }
  };
  if (status?.kind === "sent")
    return (
      <div className="grid gap-2">
        <p role="status" className="text-body-sm">
          {status.text}
        </p>
        <Button size="compact" onClick={close}>
          Done
        </Button>
      </div>
    );
  const missing = fields.filter((p) => p.required && !values[p.name]?.trim());
  // Say why Submit is disabled rather than leave the viewer guessing.
  const why = [
    missing.length
      ? `Fill in ${missing.map((p) => p.label?.en ?? p.name).join(", ")}.`
      : "",
    !destination.channelId
      ? "Open this card from a link in a channel conversation: Keel answers there."
      : !outbox?.supports(9)
        ? "Buzz cannot post here yet: wait for it to connect, or reload."
        : "",
  ].filter(Boolean);
  return (
    <form
      className="grid gap-3"
      aria-label={action.label?.en ?? action.name}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {action.description?.en && (
        <p className="text-body-sm text-muted">{action.description.en}</p>
      )}
      {fields.map((p) => {
        const label = `${p.label?.en ?? p.name}${p.required ? "" : " (optional)"}`;
        if (p.choices?.length)
          return (
            <Field key={p.name} label={label}>
              <select
                aria-label={label}
                value={values[p.name] ?? ""}
                onChange={(event) => set(p.name, event.target.value)}
              >
                <option value="">Choose…</option>
                {p.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </Field>
          );
        return (
          <Field key={p.name} label={label}>
            <div className="flex gap-2">
              <Input
                aria-label={label}
                type={
                  p.type === "date"
                    ? "date"
                    : p.type === "money" ||
                        p.type === "decimal" ||
                        p.type === "integer"
                      ? "number"
                      : "text"
                }
                value={values[p.name] ?? ""}
                onChange={(event) => set(p.name, event.target.value)}
              />
              {p.type === "money" && (
                <Input
                  aria-label={`${p.label?.en ?? p.name} currency`}
                  value={values[`${p.name}.currency`] ?? "USD"}
                  onChange={(event) =>
                    set(`${p.name}.currency`, event.target.value)
                  }
                />
              )}
            </div>
          </Field>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          size="compact"
          disabled={!ready || missing.length > 0}
        >
          Submit
          {action.riskTier && action.riskTier !== "T0"
            ? ` for approval (${action.riskTier})`
            : ""}
        </Button>
        <Button size="compact" onClick={close}>
          Cancel
        </Button>
      </div>
      {why.length > 0 && (
        <p className="text-body-sm text-muted">{why.join(" ")}</p>
      )}
      {status?.kind === "error" && (
        <p role="alert" className="error">
          {status.text}
        </p>
      )}
    </form>
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
              {(candidate.reviews ?? []).map((review) => (
                <span
                  key={review.reviewer}
                  className="text-body-sm"
                  aria-label={`${review.reviewer} ${review.verdict}`}
                >
                  <span
                    className={
                      review.verdict === "object" ? "error" : "text-muted"
                    }
                  >
                    {review.verdict === "object" ? "Objects" : "Concurs"}
                  </span>{" "}
                  <span className="text-muted">{review.reviewer}:</span>{" "}
                  {review.reason}
                  {review.evidence?.source?.excerpt && (
                    <q className="text-muted">
                      {" "}
                      {review.evidence.source.excerpt}
                      {review.evidence.source.page
                        ? ` (p. ${review.evidence.source.page})`
                        : ""}
                    </q>
                  )}
                </span>
              ))}
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
      {open && task.can_decide === false && (
        <p className="text-body-sm text-muted">
          Read-only: this task is for {task.assignee}.
        </p>
      )}
      {open && task.can_decide !== false && verbs.length > 0 && (
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

/** A signed kind-9 message to Keel in the channel (and thread), mentioning Keel's key when Keel can receive it. */
async function sendToKeel(
  outbox: NonNullable<RelaySession["outbox"]>,
  channelId: string,
  threadId: string | undefined,
  content: string,
) {
  const keel = await keelConversation();
  const tags: string[][] = [["h", channelId]];
  if (threadId) tags.push(["e", threadId, "", "reply"]);
  const mention = keel?.pubkey ? [["p", keel.pubkey]] : [];
  try {
    outbox.send({ kind: 9, content, tags: [...tags, ...mention] });
  } catch (error) {
    if (!mention.length) throw error;
    outbox.send({ kind: 9, content, tags }); // Keel is not a member here: send without the mention
  }
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
      try {
        await sendToKeel(
          outbox,
          destination.channelId,
          destination.threadId,
          content,
        );
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
