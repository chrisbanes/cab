import assert from "node:assert/strict";
import { test } from "node:test";
import type { StatusMapping } from "../../src/core/status-mapping-contracts.js";
import {
  statusFieldNodeId,
  statusMappingPlan,
} from "../../web/src/status-mapping-draft.js";

const saved: StatusMapping = {
  selectionId: "S-1",
  projectNodeId: "PVT_one",
  fieldNodeId: "F_one",
  events: { turnStarted: "O_prog", handedBack: null, held: null, done: null },
};
const other = { id: "S-2", projectNodeId: "PVT_two" } as never;
const values = { turnStarted: "O_prog", handedBack: "", held: "", done: "" };
const names = {
  optionName: (id: string) => id,
  selectionName: (id: string) => id,
};

test("a newly chosen Project whose Status field is not known yet cannot be saved, and is not a clear", () => {
  const plan = statusMappingPlan({
    saved,
    clearing: false,
    values,
    selection: other,
    fieldNodeId: undefined,
    ...names,
  });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.lines, []);
});

test("a mapping is cleared only on purpose: every event set to Nothing, or the saved Project gone", () => {
  const nothing = statusMappingPlan({
    saved,
    clearing: false,
    values: { ...values, turnStarted: "" },
    selection: { id: "S-1", projectNodeId: "PVT_one" } as never,
    fieldNodeId: "F_one",
    ...names,
  });
  assert.deepEqual(
    [nothing.mapping, nothing.lines, nothing.ready],
    [null, ["Clears the status mapping."], true],
  );
  const gone = statusMappingPlan({
    saved,
    clearing: true,
    values,
    selection: undefined,
    fieldNodeId: undefined,
    ...names,
  });
  assert.deepEqual(
    [gone.mapping, gone.lines, gone.ready],
    [null, ["Clears the status mapping."], true],
  );
});

test("a resolved Project saves its mapping and names the changes", () => {
  const plan = statusMappingPlan({
    saved,
    clearing: false,
    values: { ...values, done: "O_done" },
    selection: { id: "S-1", projectNodeId: "PVT_one" } as never,
    fieldNodeId: "F_one",
    ...names,
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.mapping?.events.done, "O_done");
  assert.equal(plan.lines.length, 1);
});

test("another Project's Status field is unknown while loading, unreadable, unavailable or absent, and only the saved Project keeps its field", () => {
  const listed = { fieldNodeId: "F_two", name: "Status", options: [] };
  for (const read of [
    { state: "loading" },
    { state: "unavailable" },
    { state: "ready", status: null },
  ] as const) {
    assert.equal(statusFieldNodeId(read, saved, "PVT_two"), undefined);
    assert.equal(statusFieldNodeId(read, null, "PVT_one"), undefined);
    // The saved Project keeps its field while GitHub cannot list it.
    assert.equal(statusFieldNodeId(read, saved, "PVT_one"), "F_one");
  }
  assert.equal(
    statusFieldNodeId({ state: "ready", status: listed }, saved, "PVT_two"),
    "F_two",
  );
});

test("another Project with nothing chosen is not a clear of the saved mapping, even once its field is listed", () => {
  const plan = statusMappingPlan({
    saved,
    clearing: false,
    values: { turnStarted: "", handedBack: "", held: "", done: "" },
    selection: other,
    fieldNodeId: "F_two",
    ...names,
  });
  assert.deepEqual([plan.mapping, plan.lines, plan.ready], [null, [], false]);
});
