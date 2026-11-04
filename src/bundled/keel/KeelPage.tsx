import { useEffect, useState } from "react";
import {
  browserHostEnabled,
  browserSignEvent,
} from "../../features/identity/browser";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { ListChecksIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { keelFetch, type KeelTask } from "./gateway";
import { TaskCard } from "./KeelPanel";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export async function loadOpenTasks(signal?: AbortSignal) {
  const { items } = await keelFetch<{ items: KeelTask[] }>(
    "/api/v1/tasks?state=open",
    { sign: browserHostEnabled() ? browserSignEvent : undefined, signal },
  );
  return items;
}

/** The viewer's Keel inbox: what waits on them or their groups, decided from the task's thread. */
export function KeelPage({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const [attempt, retry] = useState(0);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Keel">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title="Keel"
            actions={
              <Button size="compact" onClick={() => retry(attempt + 1)}>
                Refresh
              </Button>
            }
          />
          <KeelInbox
            key={attempt}
            relay={relay}
            navigator={navigator}
            refresh={() => retry(attempt + 1)}
          />
        </div>
      </FullPageSurface>
    </div>
  );
}

function KeelInbox({
  relay,
  navigator,
  refresh,
}: {
  relay: RelayData;
  navigator: Navigation;
  refresh(): void;
}) {
  const connection = useRelayConnection(relay);
  const [tasks, setTasks] = useState<KeelTask[] | string>();
  const [selected, select] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    loadOpenTasks(
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    )
      .then((items) => {
        if (!controller.signal.aborted) setTasks(items);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setTasks(message(error));
      });
    return () => controller.abort();
  }, []);
  const session =
    connection.status === "ready" ? connection.session : undefined;
  const { viewer, scope } = connection;
  const current =
    Array.isArray(tasks) && selected
      ? tasks.find((task) => task.id === selected)
      : undefined;
  const openThread = (task: KeelTask) => {
    const post = task.post;
    if (!post?.chat_channel || !viewer || !scope?.endsWith(`:${viewer}`))
      return;
    void navigator.open({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
      channelId: post.chat_channel,
      ...(post.message_id ? { messageId: post.message_id } : {}),
      ...(post.thread ? { threadRootId: post.thread } : {}),
    });
  };
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,1fr)_2fr] gap-4 overflow-hidden p-4">
      <nav aria-label="My tasks" className="min-h-0 overflow-y-auto">
        {tasks === undefined && (
          <p className="text-body-sm text-muted" role="status">
            Reading your tasks from Keel…
          </p>
        )}
        {typeof tasks === "string" && (
          <EmptyState
            icon={<ListChecksIcon />}
            title="Keel did not answer"
            description={tasks}
            action={
              <Button size="compact" onClick={refresh}>
                Retry
              </Button>
            }
          />
        )}
        {Array.isArray(tasks) && tasks.length === 0 && (
          <p className="text-body-sm text-muted">Nothing waits on you.</p>
        )}
        {Array.isArray(tasks) && tasks.length > 0 && (
          <ul className="grid gap-1">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  aria-pressed={task.id === selected}
                  className="grid w-full gap-0.5 rounded p-2 text-left hover:bg-surface-raised aria-pressed:bg-surface-raised"
                  onClick={() => select(task.id)}
                >
                  <span className="text-body">{task.title}</span>
                  <span className="text-body-sm text-muted">
                    {task.type}
                    {task.due_at
                      ? ` · due ${new Date(task.due_at).toLocaleDateString()}`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <section className="min-h-0 overflow-y-auto">
        {current ? (
          <div className="grid gap-4">
            <TaskCard
              key={current.id}
              task={current}
              session={session}
              refresh={refresh}
            />
            {current.post?.chat_channel && (
              <Button size="compact" onClick={() => openThread(current)}>
                Open its thread
              </Button>
            )}
          </div>
        ) : (
          <p className="text-body-sm text-muted">
            Choose a task to see it and decide from here.
          </p>
        )}
      </section>
    </div>
  );
}
