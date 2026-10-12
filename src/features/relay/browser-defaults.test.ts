import { expect, it } from "vitest";
import {
  builtInAgentKeys,
  createBuiltInAgents,
  hidingBuiltInAgents,
  isStarterChannel,
} from "./browser-defaults";
import type { RelayEvent } from "./events";
import { archiveHides, type IdentityArchives } from "./identity-archives";
import type { RelayReader } from "./reader";

const key = (n: number) => n.toString(16).padStart(64, "0");
const identity = (d: string, content: object) =>
  ({
    id: d,
    pubkey: key(99),
    created_at: 1,
    kind: 30177,
    tags: [["d", d]],
    content: JSON.stringify(content),
    sig: "",
  }) as unknown as RelayEvent;

it("recognizes desktop's starter channels by name, never DMs", () => {
  for (const name of ["general", "Welcome", "welcome-everyone", " General "])
    expect(isStarterChannel({ name, channelType: "stream" })).toBe(true);
  expect(isStarterChannel({ name: "general", channelType: "dm" })).toBe(false);
  expect(isStarterChannel({ name: "Platform Engineering" })).toBe(false);
});

it("finds built-in persona agents by persona id or default name", () => {
  const events = [
    identity(key(1), { name: "Fizz", persona_id: "builtin:fizz" }),
    identity(key(2), { name: "Renamed", persona_id: "builtin:bumble" }),
    identity(key(3), { name: "Honey" }),
    identity(key(4), { name: "Chief of Agents" }),
    identity(key(5), { name: "Researcher", persona_id: "custom:pollen" }),
    identity("not-a-key", { name: "Pollen" }),
    { ...identity(key(6), {}), content: "not json" },
  ];
  expect(builtInAgentKeys(events).sort()).toEqual([key(1), key(2), key(3)]);
});

it("hides built-in agents through archiveHides once loaded", async () => {
  const reader = {
    read: async () => [identity(key(1), { persona_id: "builtin:fizz" })],
  } as unknown as RelayReader;
  const store = createBuiltInAgents(reader);
  const archives = {
    snapshot: () => ({ status: "ready", archived: [] }),
    subscribe: () => () => {},
    state: () => "not-archived",
    ensure: async () => {},
    refresh: async () => {},
  } as unknown as IdentityArchives;
  const visible = hidingBuiltInAgents(archives, store.queries);
  const before = visible.snapshot();
  expect(archiveHides(visible, key(1), key(9))).toBe(false);
  await visible.ensure();
  expect(archiveHides(visible, key(1), key(9))).toBe(true);
  expect(archiveHides(visible, key(4), key(9))).toBe(false);
  expect(archiveHides(visible, key(1), key(1))).toBe(false);
  expect(visible.snapshot()).not.toBe(before);
  store.dispose();
});
