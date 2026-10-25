// @vitest-environment jsdom
import type { Event, EventTemplate } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayError, decisionText, keelFetch, nip98 } from "./gateway";

const signed = (template: EventTemplate): Event => ({
  ...template,
  id: "e".repeat(64),
  pubkey: "a".repeat(64),
  sig: "f".repeat(128),
});
const settings = { gateway: "https://keel.test", workbench: "", token: "" };

afterEach(() => {
  vi.unstubAllGlobals();
});

it("signs the request URL and method into a NIP-98 header", async () => {
  const sign = vi.fn(async (template: EventTemplate) => signed(template));
  const header = await nip98(
    sign,
    "https://keel.test/api/v1/tasks",
    "GET",
    1700000000,
  );
  expect(header.startsWith("Nostr ")).toBe(true);
  const event = JSON.parse(atob(header.slice(6))) as Event;
  expect(event.kind).toBe(27235);
  expect(event.created_at).toBe(1700000000);
  expect(event.tags).toEqual([
    ["u", "https://keel.test/api/v1/tasks"],
    ["method", "GET"],
  ]);
});

it("reads with the signed header, or a token when one is set", async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ items: [] })),
  );
  vi.stubGlobal("fetch", fetch);
  const sign = vi.fn(async (template: EventTemplate) => signed(template));
  await keelFetch("/api/v1/tasks?state=open", { sign, settings });
  let [url, init] = fetch.mock.calls[0] ?? ["", {}];
  expect(url).toBe("https://keel.test/api/v1/tasks?state=open");
  expect((init.headers as Record<string, string>).Authorization).toMatch(
    /^Nostr /,
  );
  expect(init.credentials).toBe("omit");
  await keelFetch("/api/v1/tasks", {
    sign,
    settings: { ...settings, token: "keel_x" },
  });
  [url, init] = fetch.mock.calls[1] ?? ["", {}];
  expect((init.headers as Record<string, string>).Authorization).toBe(
    "Bearer keel_x",
  );
  expect(sign).toHaveBeenCalledTimes(1);
});

it("explains refusals in Keel's terms", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "nope" }), { status: 401 }),
      ),
  );
  const error = await keelFetch("/api/v1/tasks", { settings }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).status).toBe(401);
  expect((error as GatewayError).message).toMatch(/link/);
});

it("writes the reply Keel reads as a decision", () => {
  expect(decisionText("approve", "task-84450d5a33", "  looks right ")).toBe(
    "approve task-84450d5a33 looks right",
  );
  expect(decisionText("pick", "task-84450d5a33", "", "2")).toBe(
    "pick task-84450d5a33 2",
  );
  expect(decisionText("reject", "task-84450d5a33", "")).toBe(
    "reject task-84450d5a33",
  );
});
