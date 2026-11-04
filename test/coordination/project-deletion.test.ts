import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import { transaction } from "../../src/core/store.js";
import {
  captureProjectOwnership,
  ProjectTombstones,
  projectCleanupSchema,
  type ProjectTombstone,
} from "../../src/standalone/project-deletion.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

const now = "2026-11-04T00:00:00.000Z";
function tombstone(
  projectId: string = randomUUID(),
  commandKey: string = randomUUID(),
): ProjectTombstone {
  return {
    projectId,
    commandKey,
    name: "Deleted",
    deletedAt: now,
    actor: "operator",
    payloadHash: "a".repeat(64),
    counts: { tasks: 1, assignments: 1, worktrees: 1 },
    externalRemnants: [],
    result: { kind: "project-deleted", projectId, deletedAt: now },
    cleanup: {
      version: 1,
      items: [
        {
          id: randomUUID(),
          kind: "claude-temp",
          state: "pending",
          reason: "not-attempted",
          captured: {
            kind: "claude-temp",
            path: "/disposable/private/temp",
            taskId: randomUUID(),
            workspaceId: randomUUID(),
            filesystem: { device: "1", inode: "2" },
          },
        },
      ],
    },
  };
}

test("delete receipt and captured cleanup are durable, atomic and independently replayable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ProjectTombstones(db),
      value = tombstone();
    assert.throws(() => store.recordWithinTransaction(value), /transaction/);
    assert.throws(
      () =>
        transaction(db, () => {
          store.recordWithinTransaction(value);
          throw new Error("delete phase failed");
        }),
      /delete phase failed/,
    );
    assert.equal(
      store.replay(value.projectId, value.commandKey, value.payloadHash),
      undefined,
    );
    transaction(db, () => store.recordWithinTransaction(value));
    assert.deepEqual(
      store.replay(value.projectId, value.commandKey, value.payloadHash),
      value.result,
    );
    assert.throws(
      () => store.replay(value.projectId, value.commandKey, "b".repeat(64)),
      /conflict/,
    );
    assert.deepEqual(new ProjectTombstones(db).pendingCleanup(), [
      { projectId: value.projectId, cleanup: value.cleanup },
    ]);
    assert.equal(
      JSON.stringify(
        store.replay(value.projectId, value.commandKey, value.payloadHash),
      ).includes("/disposable/private/temp"),
      false,
    );
    transaction(db, () =>
      store.completeCleanupWithinTransaction(
        value.projectId,
        value.cleanup.items[0]!.id,
      ),
    );
    assert.deepEqual(store.pendingCleanup(), []);
    const stored = db
      .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId = ?")
      .get(value.projectId) as { cleanupJson: string };
    assert.equal(
      stored.cleanupJson.includes("/disposable/private/temp"),
      false,
    );
    assert.equal(stored.cleanupJson.includes("filesystem"), false);
    assert.deepEqual(
      store.replay(value.projectId, value.commandKey, value.payloadHash),
      value.result,
    );
    transaction(db, () =>
      store.completeCleanupWithinTransaction(
        value.projectId,
        value.cleanup.items[0]!.id,
      ),
    );
    assert.deepEqual(store.pendingCleanup(), [], "completion is idempotent");
  } finally {
    db.close();
  }
});

test("delete keys remain project scoped and completed cleanup carries no retained payload", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ProjectTombstones(db),
      first = tombstone(),
      second = tombstone(randomUUID(), first.commandKey);
    transaction(db, () => {
      store.recordWithinTransaction(first);
      store.recordWithinTransaction(second);
    });
    assert.deepEqual(
      store.replay(first.projectId, first.commandKey, first.payloadHash),
      first.result,
    );
    assert.deepEqual(
      store.replay(second.projectId, second.commandKey, second.payloadHash),
      second.result,
    );
    const complete = {
      id: randomUUID(),
      kind: "workspace",
      state: "complete",
      captured: { path: "/must-not-survive" },
    };
    assert.equal(
      projectCleanupSchema.safeParse({ version: 1, items: [complete] }).success,
      false,
    );
    assert.equal(
      projectCleanupSchema.safeParse({ version: 2, items: [] }).success,
      false,
    );
    const item = first.cleanup.items[0]!;
    assert.equal(
      projectCleanupSchema.safeParse({ version: 1, items: [item, item] })
        .success,
      false,
    );
    assert.equal(
      projectCleanupSchema.safeParse({
        version: 1,
        items: [{ ...item, kind: "workspace" }],
      }).success,
      false,
    );
    assert.equal(
      projectCleanupSchema.safeParse({
        version: 1,
        items: [
          {
            ...item,
            captured: {
              kind: "codex-thread",
              threadId: "user-thread",
              harness: "codex",
              codexHome: "user",
            },
          },
        ],
      }).success,
      false,
    );
  } finally {
    db.close();
  }
});

test("ownership captures tasks, assignments, task and drafting-only work without a shared-profile expansion", async (t) => {
  const f = await createOperatorFixture();
  await f.service.stop();
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  t.after(async () => {
    db.close();
    await f.close();
  });
  const domain = new DomainStore(db),
    scheduler = new SchedulerStore(db),
    profileId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Shared",
    instructions: "Private",
    capabilities: "Coordination",
  });
  const seed = (name: string) => {
    const projectId = randomUUID(),
      taskId = randomUUID(),
      assignmentId = randomUUID(),
      workId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name,
      leadProfileId: null,
      candidateProfileIds: [profileId],
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: name,
      outcome: "Outcome",
      ready: false,
    });
    domain.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Brief",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    scheduler.ensure({
      requestKey: randomUUID(),
      workId,
      kind: "assignment",
      projectId,
      taskId,
      assignmentId,
      taskVersion: 1,
      assignmentVersion: 1,
      profileRevision: 1,
      instructionsRevision: 1,
      prompt: "Private prompt",
      workspace: null,
      previousWorkId: null,
    });
    return { projectId, taskId, assignmentId, workId };
  };
  const a = seed("A"),
    b = seed("B"),
    draftId = randomUUID(),
    draftWork = randomUUID();
  db.prepare(
    "INSERT INTO drafting_runs (runId,projectId,idea,harness,profileId,profileRevision,instructionsRevision,state,createdAt) VALUES (?,?,'Draft','codex',?,1,1,'failed',1)",
  ).run(draftId, a.projectId, profileId);
  scheduler.ensure({
    requestKey: randomUUID(),
    workId: draftWork,
    kind: "drafting",
    projectId: a.projectId,
    taskId: draftId,
    assignmentId: null,
    taskVersion: null,
    assignmentVersion: null,
    profileRevision: 1,
    instructionsRevision: 1,
    prompt: "Draft prompt",
    workspace: null,
    previousWorkId: null,
  });
  const beforeB = domain.task(b.taskId),
    profile = domain.profile(profileId);
  const owned = transaction(db, () => captureProjectOwnership(db, a.projectId));
  assert.deepEqual(owned.tasks, [a.taskId]);
  assert.deepEqual(owned.assignments, [a.assignmentId]);
  assert.deepEqual(owned.drafts, [draftId]);
  assert.deepEqual(owned.work, [a.workId, draftWork].sort());
  assert.deepEqual(owned.external, []);
  assert.equal(JSON.stringify(owned).includes(b.workId), false);
  assert.deepEqual(domain.task(b.taskId), beforeB);
  assert.deepEqual(domain.profile(profileId), profile);
  assert.throws(() => captureProjectOwnership(db, a.projectId), /transaction/);
});
