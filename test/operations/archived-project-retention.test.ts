import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { archivedProjectFixture } from "../fixtures/archived-project.js";

test("age pruning and global diagnostic admission preserve archived rows without raising the global byte limit", async (t) => {
  const f = await archivedProjectFixture(t, false);
  let now = 1000;
  const store = new ExecutionDiagnosticsStore(f.db, {
    now: () => now,
    limits: { installationBytes: 512, ageMs: 100 },
  });
  const identity = {
    workId: f.workId,
    taskId: f.taskId,
    projectId: f.projectId,
    assignmentId: f.assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    harness: "codex" as const,
    mode: "enhanced" as const,
    eventSource: "supported" as const,
  };
  store.begin(identity);
  store.record(
    f.workId,
    "runtime",
    "message",
    "info",
    undefined,
    "a".repeat(300),
    [],
  );
  store.finish(f.workId);
  f.freeze();
  const snapshot = () =>
    JSON.stringify([
      f.db
        .prepare("SELECT * FROM diagnostic_executions WHERE workId=?")
        .all(f.workId),
      f.db
        .prepare("SELECT * FROM diagnostic_items WHERE workId=?")
        .all(f.workId),
      f.db
        .prepare("SELECT * FROM diagnostic_gaps WHERE workId=?")
        .all(f.workId),
    ]);
  const before = snapshot();
  const projectId = randomUUID(),
    taskId = randomUUID(),
    workId = randomUUID();
  f.domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Other diagnostics",
    leadProfileId: null,
  });
  f.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Other",
    outcome: "Other",
    ready: false,
  });
  store.begin({ ...identity, projectId, taskId, workId });
  store.record(
    workId,
    "runtime",
    "message",
    "info",
    undefined,
    "b".repeat(300),
    [],
  );
  assert.ok(
    (
      f.db
        .prepare("SELECT totalBytes FROM diagnostic_usage WHERE id=1")
        .get() as { totalBytes: number }
    ).totalBytes <= 512,
  );
  now = 2000;
  await store.prune();
  store.closeOpen();
  store.reconcile();
  store.record(
    f.workId,
    "runtime",
    "late",
    "info",
    undefined,
    "late event",
    [],
  );
  store.gap(f.workId, "capture-interrupted");
  assert.equal(snapshot(), before);
});
