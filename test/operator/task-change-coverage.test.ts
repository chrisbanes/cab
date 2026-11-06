import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import type { TaskChangeEvent } from "../../src/standalone/task-change-feed.js";
import { configure } from "../fixtures/completed-lead.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { until } from "../fixtures/until.js";

// Coverage probe for the facade change feed: each category of real mutation
// reaches the watched task through the shared database facade, and none
// reaches an unrelated task.

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await startCliService(t);
  const f = s.f;
  const api = new OperatorApi(f.service, []);
  const watch = (taskId: string) => {
    const events: TaskChangeEvent[] = [];
    const stop = f.service.taskChanges().watch(
      () => {
        try {
          return api.taskChangeIds(taskId);
        } catch {
          return undefined;
        }
      },
      (event) => events.push(event),
    );
    t.after(stop);
    return events;
  };
  const task = await seedReviewTask(f, "Coverage project");
  const d = f.service.domain();
  const siblingId = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: siblingId,
    title: "Sibling task",
    outcome: "Left alone",
    ready: false,
  });
  return { s, f, d, api, task, siblingId, watch };
}

/** Longer than the feed's coalescing delay. */
const settle = () => delay(400);

function drain(events: TaskChangeEvent[]) {
  return events.splice(0);
}

test("operator commands, executions, capture and project edits notify the task and not its sibling", async (t) => {
  const { f, d, api, task, siblingId, watch } = await setup(t);
  const events = watch(task.taskId);
  const sibling = watch(siblingId);

  // Reading the task never writes anything attributed to it.
  await api.readTask(task.taskId);
  await api.readTaskTimeline(task.taskId, new URLSearchParams());
  await settle();
  assert.deepEqual(drain(events), [], "a read notifies nothing");

  // Operator command on the task.
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(d.task(task.taskId).version),
    title: "Renamed for coverage",
  });
  await settle();
  assert.deepEqual(drain(events), ["read"], "operator command");
  assert.deepEqual(drain(sibling), [], "the sibling is not notified");

  // Execution state transitions.
  configure(f, task.projectId, false);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(d.task(task.taskId).version),
    ready: true,
  });
  await until(() => f.runtime.hasPending(1), "turn 1");
  await settle();
  assert.ok(drain(events).includes("read"), "execution started");
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  drain(sibling);

  // History capture binds the task; diagnostics capture binds only the work id.
  const binding = {
    workId: work.workId,
    taskId: task.taskId,
    assignmentId: task.assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: work.threadId,
    turnId: work.turnId,
  };
  f.service.conversationHistoryStore()?.record(
    binding,
    {
      kind: "completed",
      threadId: work.threadId,
      turnId: work.turnId,
      itemId: "coverage-item",
      text: "Captured assistant text",
    },
    [],
  );
  await settle();
  assert.deepEqual(drain(events), ["timeline"], "history capture");
  const diagnostics = f.service.executionDiagnostics();
  assert.ok(diagnostics);
  const record = (workId: string, itemId: string) =>
    diagnostics.record(
      workId,
      "runtime",
      "commandExecution/started",
      "info",
      itemId,
      { phase: "started", itemId, itemType: "commandExecution" },
      [],
    );
  record(work.workId, "coverage-tool");
  await settle();
  assert.deepEqual(drain(events), ["timeline"], "diagnostics capture");

  // A plan record is not a capture table: it refetches the task read and timeline.
  f.service.conversationHistoryStore()?.recordPlan(
    binding,
    {
      steps: [{ text: "Plan step", status: "in-progress" }],
      omittedStepCount: 0,
      done: 0,
      total: 1,
    },
    [],
  );
  await settle();
  assert.deepEqual(drain(events), ["read"], "plan record");

  // A diagnostics burst on this task's work reaches neither the idle sibling
  // nor another project's task.
  const other = await seedReviewTask(f, "Idle project");
  const idle = watch(other.taskId);
  for (let i = 0; i < 20; i += 1) record(work.workId, `burst-${i}`);
  await settle();
  assert.deepEqual(drain(sibling), [], "burst: sibling");
  assert.deepEqual(drain(idle), [], "burst: idle task in another project");
  assert.deepEqual(drain(events), ["timeline"], "burst coalesces");

  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((w) => w.state === "running"),
    "turn end",
  );
  await settle();
  assert.ok(drain(events).includes("read"), "execution ended");

  // Project edit.
  configure(f, task.projectId, true);
  await settle();
  assert.ok(drain(events).includes("read"), "project edit");
  assert.deepEqual(drain(idle), [], "another project's edit");
});

test("an imported-source sync notifies the imported task", async (t) => {
  const { d, f, watch } = await setup(t);
  const projectId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Imported coverage",
    leadProfileId: null,
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_SOURCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: {
      mode: "any",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  const sync = (title: string) =>
    f.service.githubSources().reconcileSelection(projectId, "repo", {
      complete: true,
      reason: null,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_COVERAGE",
          repositoryId: "R1",
          repositoryName: "org/repo",
          number: 1,
          title,
          body: "Body",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
    });
  sync("First title");
  const taskId = String(f.service.githubSources().issue("I_COVERAGE")?.taskId);
  const events = watch(taskId);
  sync("Second title");
  await settle();
  assert.deepEqual(events, ["read"]);
});
