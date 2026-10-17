import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  InboxItem,
  QuestionRead,
  Workspace,
} from "../../src/operator/contracts.js";
import {
  completedWork,
  furtherRequests,
  inlineAnswerable,
  interventionEvidence,
  orderAttention,
  overviewStats,
  projectRows,
} from "../../web/src/overview-model.js";
import { summary } from "../fixtures/task-summary.js";

function item(o: Partial<InboxItem> = {}): InboxItem {
  return {
    id: randomUUID(),
    kind: "question",
    urgency: 1,
    createdAt: 0,
    taskId: randomUUID(),
    projectId: randomUUID(),
    projectName: "Project",
    taskTitle: "Task",
    requestingAssignmentId: null,
    requesterName: null,
    interactionId: null,
    revision: null,
    headline: null,
    reason: null,
    attentionCode: null,
    destination: "/",
    evidence: "/",
    conversation: null,
    ...o,
  };
}
const read = (
  items: InboxItem[],
  o: { complete?: boolean; error?: string } = {},
) => ({
  data: { items, complete: o.complete ?? true, unavailable: false },
  error: o.error ?? null,
});

test("the stat strip counts installation-wide facts and shows nothing it cannot support", () => {
  const tasks = [
    summary({ execution: "running", globalUsage: 3 }),
    summary({ execution: "uncertain" }),
    summary({ state: "done" }),
    summary({ ready: false }),
  ];
  const five = Array.from({ length: 5 }, () => item());
  assert.deepEqual(overviewStats(tasks, read(five)), {
    needsYou: 5,
    uncertain: 1,
    active: 3,
    running: { used: 3, limit: 10 },
  });
  assert.equal(
    overviewStats(tasks, read(five, { complete: false })).needsYou,
    null,
  );
  assert.equal(
    overviewStats(tasks, read(five, { error: "unavailable" })).needsYou,
    null,
  );
  assert.deepEqual(overviewStats(undefined, read([])), {
    needsYou: 0,
    uncertain: null,
    active: null,
    running: null,
  });
  // A loaded empty list has truly no work; only capacity has nothing to read it from.
  assert.deepEqual(overviewStats([], read([])), {
    needsYou: 0,
    uncertain: 0,
    active: 0,
    running: null,
  });
});

test("attention puts uncertain interventions first, then other interventions, then oldest", () => {
  const uncertain = summary({ execution: "uncertain" }),
    calm = summary({ execution: "running" });
  const question = item({ createdAt: 20 }),
    other = item({ kind: "intervention", createdAt: null, taskId: calm.id }),
    approval = item({ kind: "approval", createdAt: 10 }),
    held = item({
      kind: "intervention",
      createdAt: null,
      taskId: uncertain.id,
    });
  assert.deepEqual(
    orderAttention([question, other, approval, held], [uncertain, calm]),
    [held, other, approval, question],
  );
  // Without the task list, interventions keep their relative order.
  assert.deepEqual(
    orderAttention([question, other, approval, held], undefined),
    [other, held, approval, question],
  );
});

test("the dashed row names the next two requests beyond the cards", () => {
  const items = [1, 2, 3, 4, 5].map((n) =>
    item({ projectName: `P${n}`, taskTitle: `T${n}` }),
  );
  assert.deepEqual(furtherRequests(items, 3), {
    count: 2,
    names: ["P4 / T4", "P5 / T5"],
  });
  assert.equal(furtherRequests(items.slice(0, 3), 3), null);
  assert.equal(
    furtherRequests([item(), item(), item(), item({ projectName: null })], 3)
      ?.names[0],
    "Unavailable project / Task",
  );
});

test("intervention evidence is the lead, recorded reasons and the ownership hold", () => {
  const held = interventionEvidence(
    summary({
      execution: "uncertain",
      lead: "Jonas",
      codes: ["execution-uncertain"],
    }),
  );
  assert.equal(held.lead, "Jonas · lead");
  assert.ok(held.reasons.includes("Execution ownership is uncertain"));
  assert.equal(held.ownershipHeld, true);
  const calm = interventionEvidence(summary({ codes: ["lead-review"] }));
  assert.equal(calm.lead, "No lead configured");
  assert.deepEqual(calm.reasons, ["Routing fell back to the project lead"]);
  assert.equal(calm.ownershipHeld, false);
});

test("project rows give lead, active work uncertain first and imported tasks", () => {
  const a = randomUUID(),
    b = randomUUID(),
    lead = randomUUID();
  const project = (id: string, paused: boolean, leadProfileId: string | null) =>
    ({
      id,
      name: id === a ? "Atlas" : "Relay",
      version: 1,
      paused,
      leadProfileId,
    }) as const;
  const workspace = {
    projects: [project(a, false, lead), project(b, true, null)],
    profiles: [{ id: lead, name: "Mira" }],
  } as unknown as Workspace["data"];
  const tasks = [
    summary({ projectId: a, execution: "running" }),
    summary({ projectId: a, execution: "running" }),
    summary({ projectId: a, execution: "uncertain" }),
    summary({ projectId: a, state: "done", closure: null }),
    summary({ projectId: b, paused: true }),
  ];
  const [atlas, relay] = projectRows(workspace, tasks);
  assert.deepEqual(atlas, {
    id: a,
    label: { name: "Atlas", suffix: null, text: "Atlas" },
    paused: false,
    lead: "Mira",
    activity: ["1 uncertain", "2 running"],
    imported: 1,
  });
  assert.deepEqual(relay, {
    id: b,
    label: { name: "Relay", suffix: null, text: "Relay" },
    paused: true,
    lead: null,
    activity: ["1 paused"],
    imported: 0,
  });
  assert.deepEqual(projectRows(null, tasks), []);
});

test("completed work counts Done tasks in the filtered project and lists three", () => {
  const p = randomUUID();
  const done = [1, 2, 3, 4].map(() => summary({ projectId: p, state: "done" }));
  const tasks = [...done, summary({ state: "done" }), summary()];
  const all = completedWork(tasks, "");
  assert.equal(all.count, 5);
  assert.deepEqual(all.tasks, done.slice(0, 3));
  assert.equal(completedWork(tasks, p).count, 4);
  assert.equal(completedWork(tasks, randomUUID()).count, 0);
});

test("only a pending single-choice question is answered in its card", () => {
  const choice = {
    id: "c",
    kind: "single-choice",
    label: "Pick",
    required: true,
    options: [{ id: "a", label: "A" }],
  };
  const q = (
    questions: object[] | null,
    status: QuestionRead["data"]["status"] = "pending",
  ) =>
    ({
      status,
      form: questions ? { version: 1, questions } : null,
    }) as QuestionRead["data"];
  assert.equal(inlineAnswerable(q([choice])), true);
  assert.equal(inlineAnswerable(q([choice, { ...choice, id: "d" }])), false);
  assert.equal(
    inlineAnswerable(q([{ ...choice, kind: "multiple-choice" }])),
    false,
  );
  assert.equal(
    inlineAnswerable(q([{ id: "t", kind: "free-text", label: "Say" }])),
    false,
  );
  assert.equal(inlineAnswerable(q([choice], "stale")), false);
  assert.equal(inlineAnswerable(q(null)), false);
});
