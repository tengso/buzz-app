import { expect, it } from "vitest";
import { parseKeelReference } from "./references";

const task = "task-84450d5a33";

it("reads task and object references as Keel posts them", () => {
  expect(parseKeelReference(`keel://task/${task}`)).toEqual({
    kind: "task",
    id: task,
    url: `keel://task/${task}`,
  });
  expect(parseKeelReference("keel://cra.Counterparty/C1")).toEqual({
    kind: "object",
    type: "cra.Counterparty",
    pk: "C1",
    url: "keel://cra.Counterparty/C1",
  });
  const escaped = parseKeelReference("keel://demo.Party/a%2Fb");
  expect(escaped?.kind === "object" && escaped.pk).toBe("a/b");
});

it("reads workbench routes only under the configured origin", () => {
  const workbench = "https://keel.example/wb";
  expect(
    parseKeelReference(`https://keel.example/t/${task}`, workbench)?.kind,
  ).toBe("task");
  expect(
    parseKeelReference("https://keel.example/o/cra.Scorecard/S1", workbench),
  ).toMatchObject({ kind: "object", type: "cra.Scorecard", pk: "S1" });
  expect(parseKeelReference(`https://keel.example/t/${task}`)).toBeUndefined();
  expect(
    parseKeelReference(`https://evil.example/t/${task}`, workbench),
  ).toBeUndefined();
});

it("rejects shapes that are not a record reference", () => {
  for (const value of [
    "keel://task/nope",
    "keel://task",
    "keel://Party/P1",
    "keel://user:pw@task/task-84450d5a33",
    "https://github.com/example/project",
    "not a url",
  ])
    expect(parseKeelReference(value, "https://keel.example")).toBeUndefined();
});
