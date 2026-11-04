// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { KeelTask } from "./gateway";
import { forgetKeelConversation, KeelRecord, TaskCard } from "./KeelPanel";

const KEEL = "b".repeat(64);
const task: KeelTask = {
  id: "task-84450d5a33",
  type: "approve-action",
  title: "Approve demo.approve_party by rita",
  state: "open",
  assignee: "group:committee",
  version: 1,
  subject: {
    action: "act-1",
    action_type: "demo.approve_party",
    params: { party: { objectType: "demo.Party", pk: "P1" }, rating: "A" },
    quorum: 2,
  },
  post: {
    channel: "risk",
    chat_channel: "chan-1",
    thread: "c".repeat(64),
    message_id: "d".repeat(64),
  },
};

function answers(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([path]) => url.includes(path));
    return hit
      ? new Response(JSON.stringify(hit[1]))
      : new Response(JSON.stringify({ error: "missing" }), { status: 404 });
  });
}

function session(
  sent: { kind: number; content: string; tags: string[][] }[],
  supports = true,
) {
  return {
    outbox: {
      supports: () => supports,
      send(input: { kind: number; content: string; tags: string[][] }) {
        sent.push(input);
        return "op-1";
      },
    },
  } as unknown as RelaySession;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetKeelConversation();
});

it("approves by posting a signed reply in the task's thread, mentioning Keel", async () => {
  vi.stubGlobal(
    "fetch",
    answers({
      "/api/v1/conversation": { adapter: "buzz", pubkey: KEEL, channels: {} },
    }),
  );
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  render(<TaskCard task={task} session={session(sent)} refresh={() => {}} />);
  expect(screen.getByRole("heading", { name: task.title })).toBeInTheDocument();
  expect(screen.getByText("demo.Party/P1")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Reason"), "looks right");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await screen.findByRole("status");
  expect(sent).toEqual([
    {
      kind: 9,
      content: "approve task-84450d5a33 looks right",
      tags: [
        ["h", "chan-1"],
        ["e", "c".repeat(64), "", "reply"],
        ["p", KEEL],
      ],
    },
  ]);
  expect(screen.getByRole("status")).toHaveTextContent("Keel applies it");
});

it("replies in the open channel context and without a mention Keel cannot receive", async () => {
  vi.stubGlobal(
    "fetch",
    answers({
      "/api/v1/conversation": { adapter: "buzz", pubkey: KEEL, channels: {} },
    }),
  );
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  const picky = {
    outbox: {
      supports: () => true,
      send(input: { kind: number; content: string; tags: string[][] }) {
        if (input.tags.some(([name]) => name === "p"))
          throw new Error("not a member");
        sent.push(input);
        return "op-2";
      },
    },
  } as unknown as RelaySession;
  render(
    <TaskCard
      task={task}
      session={picky}
      channelId="chan-9"
      threadId={"9".repeat(64)}
      refresh={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await screen.findByRole("status");
  expect(sent).toEqual([
    {
      kind: 9,
      content: "reject task-84450d5a33",
      tags: [
        ["h", "chan-9"],
        ["e", "9".repeat(64), "", "reply"],
      ],
    },
  ]);
});

it("offers Pick n from the candidates of a conflict and disables deciding when it cannot post", async () => {
  vi.stubGlobal(
    "fetch",
    answers({
      "/api/v1/objects/demo.Party/P1": {
        object: {
          _version: 3,
          party_id: "P1",
          nav: { amount: 5, currency: "USD" },
        },
        proposals: [
          {
            id: "prop-1",
            property: "nav",
            value: { amount: 412_300_000, currency: "USD" },
            confidence: 1,
            state: "proposed",
            evidence: {
              source: {
                document: "d1",
                page: 12,
                excerpt: "Net assets USD 412.3m",
              },
            },
          },
          {
            id: "prop-2",
            property: "nav",
            value: { amount: 398_000_000, currency: "USD" },
            confidence: 0.8,
            state: "proposed",
          },
        ],
      },
      "/api/v1/conversation": { adapter: "buzz", channels: {} },
    }),
  );
  const conflict: KeelTask = {
    ...task,
    type: "resolve-conflict",
    title: "Resolve demo.Party/P1 nav: 2 candidates",
    subject: {
      object_type: "demo.Party",
      pk: "P1",
      property: "nav",
      proposals: ["prop-1", "prop-2"],
    },
    post: null,
  };
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  render(
    <TaskCard task={conflict} session={session(sent)} refresh={() => {}} />,
  );
  await screen.findByText("Net assets USD 412.3m (p. 12)");
  expect(screen.getByText("USD 412,300,000")).toBeInTheDocument();
  const pick = screen.getByRole("button", { name: "Pick 2" });
  expect(pick).toBeDisabled(); // no channel: Keel has not posted this task
  expect(
    screen.getByText(/decide from its thread or the workbench/),
  ).toBeInTheDocument();
  cleanup();
  render(
    <TaskCard
      task={conflict}
      session={session(sent)}
      channelId="chan-1"
      refresh={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Pick 2" }));
  await screen.findByRole("status");
  expect(sent[0]?.content).toBe("pick task-84450d5a33 2");
  expect(sent[0]?.tags).toEqual([["h", "chan-1"]]);
});

it("tells an unlinked viewer what to do and lets them retry", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unknown" }), { status: 401 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ...task, state: "done" })),
    );
  vi.stubGlobal("fetch", fetch);
  render(
    <KeelRecord
      reference={{ kind: "task", id: task.id, url: `keel://task/${task.id}` }}
    />,
  );
  await screen.findByRole("heading", {
    name: "Your key is not linked to Keel",
  });
  expect(screen.getByText(/keel member link/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await screen.findByRole("heading", { name: task.title });
  expect(
    screen.queryByRole("button", { name: "Approve" }),
  ).not.toBeInTheDocument();
});

it("reads the task again when Keel says in the thread that it changed", async () => {
  let state = "open";
  const reads: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    reads.push(url);
    return new Response(
      JSON.stringify(
        url.includes("/conversation")
          ? { adapter: "buzz", pubkey: "keel-key", channels: {} }
          : { ...task, state },
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  let live:
    | ((batch: {
        events: { kind: number; pubkey: string; content: string }[];
      }) => void)
    | undefined;
  const watching = {
    subscribeLive(listener: typeof live) {
      live = listener;
      return () => {
        live = undefined;
      };
    },
  } as unknown as RelaySession;
  const url = `keel://task/${task.id}`;
  const taskReads = () =>
    reads.filter((read) => read.includes("/tasks/")).length;
  render(
    <KeelRecord
      reference={{ kind: "task", id: task.id, url }}
      session={watching}
    />,
  );
  await screen.findByRole("heading", { name: task.title });
  await waitFor(() =>
    expect(reads.some((read) => read.includes("/conversation"))).toBe(true),
  );
  expect(taskReads()).toBe(1);
  // someone else quoting the link is not Keel speaking
  live?.({ events: [{ kind: 9, pubkey: "carl", content: `see ${url}` }] });
  state = "done";
  live?.({
    events: [
      {
        kind: 9,
        pubkey: "keel-key",
        content: `Resolved by hanna: approve → ${url}`,
      },
    ],
  });
  await waitFor(() => expect(taskReads()).toBe(2));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument(),
  );
});

it("submits an action from an object's card as a message to Keel, with fields from its parameters", async () => {
  vi.stubGlobal(
    "fetch",
    answers({
      "/api/v1/conversation": {
        adapter: "buzz",
        pubkey: "keel-key",
        channels: {},
      },
      "/api/v1/ontology": {
        actionTypes: {
          "cra.approve_limit": {
            name: "cra.approve_limit",
            label: { en: "Approve limit" },
            riskTier: "T2",
            parameters: [
              { name: "limit", objectType: "cra.CreditLimit", required: true },
              {
                name: "effective_date",
                type: "date",
                required: true,
                label: { en: "Effective date" },
              },
              {
                name: "comment",
                type: "string",
                required: false,
                label: { en: "Comment" },
              },
            ],
          },
          "cra.ignore_document": {
            name: "cra.ignore_document",
            parameters: [
              {
                name: "document",
                objectType: "cra.SourceDocument",
                required: true,
              },
            ],
          },
        },
      },
      "/api/v1/objects/cra.CreditLimit/L-1": {
        object: { limit_id: "L-1", status: "proposed", _version: 2 },
      },
    }),
  );
  const sent: { kind: number; content: string; tags: string[][] }[] = [];
  render(
    <KeelRecord
      reference={{
        kind: "object",
        type: "cra.CreditLimit",
        pk: "L-1",
        url: "keel://cra.CreditLimit/L-1",
      }}
      session={session(sent)}
      channelId="chan-1"
      threadId={"c".repeat(64)}
    />,
  );
  // only actions on this object type are offered
  fireEvent.click(await screen.findByRole("button", { name: "Approve limit" }));
  expect(
    screen.queryByRole("button", { name: "cra.ignore_document" }),
  ).not.toBeInTheDocument();
  const submit = screen.getByRole("button", {
    name: "Submit for approval (T2)",
  });
  expect(submit).toBeDisabled(); // the effective date is required
  fireEvent.change(screen.getByLabelText("Effective date"), {
    target: { value: "2026-11-05" },
  });
  fireEvent.click(submit);
  await screen.findByRole("status");
  expect(sent).toEqual([
    {
      kind: 9,
      content:
        'submit cra.approve_limit {"limit":"L-1","effective_date":"2026-11-05"}',
      tags: [
        ["h", "chan-1"],
        ["e", "c".repeat(64), "", "reply"],
        ["p", "keel-key"],
      ],
    },
  ]);
});
