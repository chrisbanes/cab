import assert from "node:assert/strict";
import { test } from "node:test";
import type { Execution, TaskRead } from "../../src/operator/contracts.js";
import {
  admissionLine,
  evidenceNotice,
  executionHoldLines,
  executionStatus,
  recordLine,
  staleRevisions,
} from "../../web/src/task-execution-model.js";

type Recovery = NonNullable<TaskRead["data"]["executionRecovery"]>;
const none = {
  stop: false,
  writer: false,
  capacity: false,
  uncertainty: false,
  task: false,
};
const execution = (
  state: Execution["state"],
  holds: Partial<Execution["holds"]> = {},
  reasonCodes: Execution["reasonCodes"] = [],
): Execution => ({ state, reasonCodes, holds: { ...none, ...holds } });
const recovery = (
  holds: Partial<Recovery["holds"]> = {},
  records: Recovery["records"] = [],
  omittedCount = 0,
): Recovery => ({
  holds: { ...none, ...holds },
  evidenceAvailable: records.length + omittedCount > 0,
  omittedCount,
  records,
});
const record: Recovery["records"][number] = {
  workId: "work-1",
  generation: { workRevision: 1, requestSequence: 1 },
  binding: null,
  intentState: "held",
  requestState: null,
  holds: { ...none, writer: true },
  observations: [],
  pendingEffectCount: 1,
  receiptRecorded: false,
  workspace: "unknown",
};

test("every execution state has a status, and stopping and uncertain always need recovery", () => {
  const states: Execution["state"][] = [
    "idle",
    "selected",
    "queued",
    "starting",
    "running",
    "waiting",
    "paused",
    "stopping",
    "uncertain",
    "not-started",
    "completed",
    "cancelled",
  ];
  for (const state of states) {
    const status = executionStatus(execution(state), recovery());
    assert.ok(status.label, state);
    assert.equal(
      status.held,
      state === "stopping" || state === "uncertain",
      state,
    );
  }
  assert.equal(
    executionStatus(execution("stopping", { stop: true })).label,
    "Stopping; effects may continue",
  );
  assert.equal(
    executionStatus(execution("uncertain", {}, ["runtime-unconfirmed"])).label,
    "Admitted; runtime state is not confirmed",
  );
  assert.equal(
    executionStatus(execution("waiting", {}, ["admission-blocked"])).label,
    "Waiting; blocked from admission",
  );
});

test("a hold only a record keeps marks an idle or paused status as held", () => {
  for (const state of ["idle", "queued", "paused", "not-started"] as const) {
    const status = executionStatus(
      execution(state),
      recovery({ writer: true }),
    );
    assert.equal(status.held, true);
    assert.match(status.note ?? "", /holds are still recorded/);
  }
  // A running execution's own writer and capacity are not leftovers.
  assert.deepEqual(
    executionStatus(
      execution("running", { writer: true, capacity: true }),
      recovery(),
    ),
    { label: "Running", held: false, note: null },
  );
  assert.equal(
    executionStatus(execution("running", { uncertainty: true }), recovery())
      .held,
    true,
  );
  assert.equal(executionStatus(execution("idle"), recovery()).held, false);
});

test("hold lines combine the task read's holds with the records', Stop first", () => {
  assert.deepEqual(
    executionHoldLines(
      execution("stopping", { stop: true }),
      null,
      recovery({ writer: true, capacity: true }),
    ).map((l) => l.kind),
    ["stop", "writer", "capacity"],
  );
  assert.deepEqual(
    executionHoldLines(execution("uncertain", { task: true }), {
      reason: "Held for review",
    }).map((l) => [l.kind, l.clears]),
    [["task", "Held for review. Recovery stays blocked while it remains."]],
  );
  assert.deepEqual(executionHoldLines(execution("idle"), null), []);
});

test("evidence notices distinguish unavailable, none and omitted records", () => {
  assert.match(evidenceNotice(undefined) ?? "", /withheld/);
  assert.match(evidenceNotice(recovery()) ?? "", /not evidence of release/);
  assert.equal(evidenceNotice(recovery({}, [record])), null);
  assert.equal(
    evidenceNotice(recovery({}, Array(20).fill(record), 4)),
    "Showing the newest 20 of 24 recorded recovery records; 4 older records are omitted.",
  );
  assert.match(
    evidenceNotice(recovery({}, Array(20).fill(record), 1)) ?? "",
    /1 older record is omitted/,
  );
  assert.equal(
    recordLine(record),
    "Intent held · request not recorded · holds: writer · no receipt · 1 pending effect",
  );
});

test("admission and revision staleness wording", () => {
  assert.equal(
    admissionLine({ eligible: true, reasons: [] }),
    "Task admission gates are clear",
  );
  assert.equal(
    admissionLine({
      eligible: false,
      reasons: ["project-paused", "local-dependency"],
    }),
    "Task admission blocked: Project paused, Waiting on a task dependency",
  );
  const row = {
    instructionsRevision: 1,
    currentInstructionsRevision: 1,
    profileRevision: 2,
    currentProfileRevision: 2,
  } as TaskRead["data"]["assignments"][number];
  assert.deepEqual(staleRevisions(row), []);
  assert.deepEqual(staleRevisions({ ...row, currentProfileRevision: 3 }), [
    "profile 2 → 3",
  ]);
  assert.deepEqual(staleRevisions({ ...row, currentInstructionsRevision: 2 }), [
    "instructions 1 → 2",
  ]);
  assert.equal(
    staleRevisions({
      ...row,
      currentInstructionsRevision: 2,
      currentProfileRevision: 3,
    }).length,
    2,
  );
});

test("without the task-wide recovery read a quiet status still says older holds are unknown", () => {
  const status = executionStatus(execution("paused", {}, ["project-paused"]));
  assert.equal(status.label, "Paused; no new admission");
  assert.equal(status.held, true);
  assert.equal(
    status.note,
    "Holds from older records can't be read here; open each assignment's recovery.",
  );
  assert.match(evidenceNotice(undefined) ?? "", /withheld for this task/);
  // A leftover hold the task read itself reports keeps both sentences.
  assert.match(
    executionStatus(execution("idle", { writer: true })).note ?? "",
    /still recorded.*can't be read here/,
  );
});

test("a never-started assignment has nothing to apply: its first turn takes the current revisions", () => {
  const row = {
    instructionsRevision: 1,
    currentInstructionsRevision: 2,
    profileRevision: 1,
    currentProfileRevision: 2,
  } as TaskRead["data"]["assignments"][number];
  assert.deepEqual(staleRevisions({ ...row, started: false }), []);
  assert.equal(staleRevisions({ ...row, started: true }).length, 2);
  assert.equal(staleRevisions(row).length, 2);
});
