import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TaskRead } from "../../src/operator/contracts.js";
import {
  deliveryApplies,
  executionFacts,
  sourceFacts,
  taskColumnOf,
  taskIdentity,
  taskNextActor,
} from "../../web/src/task-overview.js";
import { operatorNext, taskNext } from "../../web/src/tasks.js";
import { summary } from "../fixtures/task-summary.js";

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
    attention: { codes: [], count: 0 },
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
    [{ source: { closure: "unattributed" } }, "Paused"],
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

test("taskNextActor reads the List's next actor from the same attention codes", () => {
  const cases: [string[], string, string][] = [
    [[], "idle", "No operator decision"],
    [["execution-uncertain"], "idle", "Next: you · inspect execution"],
    [[], "uncertain", "Next: you · inspect execution"],
    [["question", "approval"], "idle", "Next: you · review material & decide"],
    [["question"], "idle", "Next: you · answer question"],
    [["unresolved-result"], "idle", "Next: you · resolve result destination"],
    [["completion-rejected"], "idle", "Next: you · review rejected completion"],
    [["lead-review"], "idle", "Next: Ensemble · recording routing fallback"],
    [["question-delivery"], "idle", "Next: Ensemble · delivering answer"],
    [["question-delivery", "question"], "idle", "Next: you · answer question"],
    [
      ["lead-review", "approval"],
      "idle",
      "Next: you · review material & decide",
    ],
  ];
  for (const [codes, execution, text] of cases) {
    const read = taskNextActor(
      data({
        execution: { state: execution, holds },
        attention: { codes, count: codes.length },
      }),
    );
    const row = summary({ codes, execution });
    assert.equal(read.text, text, JSON.stringify(codes));
    assert.equal(read.text, taskNext(row));
    assert.equal(read.operator, operatorNext(row));
  }
  for (const [state, text] of [
    ["done", "Next: none · no decision"],
    ["cancelled", "Next: none · history retained"],
  ] as const) {
    const read = taskNextActor(data({ task: { state, version: 3 } }));
    assert.equal(read.text, text);
    assert.equal(read.text, taskNext(summary({ state })));
  }
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

test("delivery applies to a GitHub source, a linked repository or a bound pull request only", () => {
  const applies = (data: unknown) => deliveryApplies(data as Data);
  assert.equal(applies({ source: null }), false);
  // A read without the field counts as unlinked.
  assert.equal(applies({ source: null, delivery: { binding: null } }), false);
  assert.equal(applies({ source: null, repositoryLinked: false }), false);
  assert.equal(applies({ source: {} }), true);
  assert.equal(applies({ source: null, repositoryLinked: true }), true);
  assert.equal(
    applies({ source: null, delivery: { binding: { number: 7 } } }),
    true,
  );
});
