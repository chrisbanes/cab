import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TaskRead } from "../../src/operator/contracts.js";
import {
  executionFacts,
  sourceFacts,
  taskColumnOf,
  taskIdentity,
  taskNextActor,
} from "../../web/src/task-overview.js";

type Data = TaskRead["data"];
const holds = {
  stop: false,
  writer: false,
  capacity: false,
  uncertainty: false,
  task: false,
};
const data = (patch: Record<string, unknown> = {}) =>
  ({
    task: { state: "open", ready: true, version: 3 },
    execution: { state: "idle", holds },
    admission: { eligible: true, reasons: [] },
    waits: [],
    source: null,
    questions: [],
    approvals: [],
    unresolvedResults: [],
    completionRequests: [],
    ...patch,
  }) as unknown as Data;

test("taskColumnOf follows the Board's precedence from the task read", () => {
  for (const [patch, column] of [
    [
      { execution: { state: "running", holds: { ...holds, stop: true } } },
      "Stopping",
    ],
    [{ execution: { state: "stopping", holds } }, "Stopping"],
    [{ execution: { state: "uncertain", holds } }, "Uncertain"],
    [
      { execution: { state: "idle", holds: { ...holds, uncertainty: true } } },
      "Uncertain",
    ],
    [{ execution: { state: "running", holds } }, "Running"],
    [{ execution: { state: "starting", holds } }, "Running"],
    [{ task: { state: "done", ready: true } }, "Done"],
    [{ task: { state: "cancelled", ready: true } }, "Cancelled"],
    [{ source: { closure: "held" } }, "Paused"],
    [{ admission: { eligible: false, reasons: ["project-paused"] } }, "Paused"],
    [{ execution: { state: "paused", holds } }, "Paused"],
    [{ task: { state: "open", ready: false } }, "Draft"],
    [
      { admission: { eligible: false, reasons: ["local-dependency"] } },
      "Waiting",
    ],
    [
      { execution: { state: "idle", holds: { ...holds, task: true } } },
      "Waiting",
    ],
    [{}, "Ready"],
  ] as const)
    assert.equal(taskColumnOf(data(patch)), column, JSON.stringify(patch));
});

test("taskNextActor names only recorded operator decisions", () => {
  const open = { status: "open" };
  assert.deepEqual(
    taskNextActor(
      data({
        execution: { state: "uncertain", holds },
        approvals: [open],
        questions: [open],
      }),
    ),
    {
      kind: "uncertain",
      text: "Next: you · inspect execution",
      operator: true,
    },
  );
  assert.equal(
    taskNextActor(data({ approvals: [open], questions: [open] })).text,
    "Next: you · review material & decide",
  );
  assert.equal(
    taskNextActor(data({ questions: [open] })).text,
    "Next: you · answer question",
  );
  assert.equal(
    taskNextActor(data({ unresolvedResults: [{}] })).text,
    "Next: you · resolve result destination",
  );
  const rejected = (taskVersion: number) => ({
    completionRequests: [{ status: "rejected", taskVersion }],
  });
  assert.deepEqual(taskNextActor(data(rejected(3))), {
    kind: "rejected-completion",
    text: "Next: you · review rejected completion",
    operator: true,
  });
  // A rejection of an earlier task version is not the current decision.
  assert.deepEqual(taskNextActor(data(rejected(2))), {
    kind: "none",
    text: "No operator decision",
    operator: false,
  });
  assert.deepEqual(
    taskNextActor(data({ approvals: [{ status: "approved" }] })),
    { kind: "none", text: "No operator decision", operator: false },
  );
  assert.equal(
    taskNextActor(data({ task: { state: "done", version: 3 } })).text,
    "Next: none · no decision",
  );
  assert.equal(
    taskNextActor(data({ task: { state: "cancelled", version: 3 } })).text,
    "Next: none · history retained",
  );
});

test("taskIdentity reads repository#number or Local task, never a UUID", () => {
  const url = "https://github.com/acme/app/issues/42";
  assert.deepEqual(
    taskIdentity(
      data({ source: { repositoryName: "acme/app", number: 42, url } }),
    ),
    { label: "acme/app#42", url },
  );
  assert.deepEqual(
    taskIdentity(
      data({ source: { repositoryName: null, number: null, url: null } }),
    ),
    { label: "repository unavailable#?", url: null },
  );
  assert.deepEqual(taskIdentity(data()), { label: "Local task", url: null });
});

test("sourceFacts keeps the latest successful sync and names a sync failure", () => {
  const membership = (
    lastSuccessfulAt: string | null,
    complete: boolean | null = true,
    reasonCode: string | null = null,
  ) => ({ sync: { lastSuccessfulAt, complete, reasonCode } });
  const source = (memberships: unknown[]) =>
    ({ state: "open", memberships }) as unknown as NonNullable<Data["source"]>;
  assert.deepEqual(
    sourceFacts(
      source([
        membership("2026-10-01T10:00:00Z"),
        membership(null),
        membership("2026-10-02T09:00:00Z"),
      ]),
    ),
    { state: "open", synced: "2026-10-02T09:00:00Z", problem: null },
  );
  assert.deepEqual(sourceFacts(source([membership(null)])), {
    state: "open",
    synced: null,
    problem: null,
  });
  const problem = (memberships: unknown[]) =>
    sourceFacts(source(memberships)).problem;
  assert.equal(
    problem([membership("t", false, "partial-sync"), membership("t")]),
    "partial sync",
  );
  assert.equal(
    problem([
      membership("t", false, "partial-sync"),
      membership(null, null, "sync-unavailable"),
    ]),
    "sync unavailable",
  );
  assert.equal(problem([membership("t", null)]), "sync incomplete");
  assert.equal(problem([]), "sync incomplete");
});

test("executionFacts counts running assignments and states delivery", () => {
  const lead = randomUUID();
  const assignment = (assignmentId: string, state: string) => ({
    assignmentId,
    state,
    runtime: { harness: "codex" },
    executionGeneration: null,
  });
  const base = {
    leadAssignmentId: lead,
    assignments: [
      assignment(lead, "running"),
      assignment(randomUUID(), "running"),
      assignment(randomUUID(), "completed"),
    ],
  };
  const facts = (delivery?: unknown) =>
    executionFacts({ ...base, delivery } as unknown as Data);
  assert.deepEqual(facts({ mode: "reviewable-pr", binding: null }), {
    running: 2,
    lead: "Codex",
    delivery: "Reviewable PR · no PR yet",
  });
  assert.equal(
    facts({
      mode: "through-merge",
      binding: { repositoryName: "acme/app", number: 7, state: "OPEN" },
    }).delivery,
    "Through merge · acme/app#7 · open",
  );
  assert.equal(facts().delivery, "Delivery not recorded");
  assert.equal(
    executionFacts({
      assignments: [],
      leadAssignmentId: null,
    } as unknown as Data).lead,
    null,
  );
});
