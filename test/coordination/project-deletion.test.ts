import { prepareDeletionPrivateInputs } from "../../src/standalone/project-deletion-private.js";
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

// Atomic service deletion is exercised independently of the cleanup runner (T4).
import {
  projectDeletionFaultPhases,
  deleteCapturedProjectRowsWithinTransaction,
} from "../../src/standalone/project-deletion.js";
import {
  assertProjectRowsRemoved,
  deletionQuery,
} from "../../src/standalone/project-deletion-ownership.js";
import {
  assertProjectDeletionInventory,
  projectDeletionInventory,
} from "../../src/standalone/project-deletion-inventory.js";
import { projectDeletionStatements } from "../../src/standalone/project-deletion-sql.js";
import {
  projectDeletionFixture,
  databaseSnapshot,
  capture,
  preservedSnapshot,
  assertNoDeletedReferences,
  deletionCanary,
} from "../fixtures/project-deletion.js";
import { DeletedProjectRedactionStore } from "../../src/core/deleted-project-redaction.js";
import { materialDigest } from "../../src/core/delivery.js";
import { databaseOf } from "../fixtures/service-internals.js";

test("archived exact-name deletion returns only a stable tombstone and permits fresh-ID name reuse", async (t) => {
  const f = await projectDeletionFixture(t),
    command = await f.command();
  const owner = capture(f.db, f.projectId),
    beforeB = preservedSnapshot(f.db, capture(f.db, f.projectB));
  const result = await f.service.deleteProject(command);
  assert.equal(result.kind, "project-deleted");
  assert.equal(
    f.db.prepare("SELECT 1 FROM domain_projects WHERE id=?").get(f.projectId),
    undefined,
  );
  assert.equal(
    f.db.prepare("SELECT 1 FROM projects WHERE id=?").get(f.projectId),
    undefined,
  );
  assertProjectRowsRemoved(f.db, owner);
  assertNoDeletedReferences(f.db, owner);
  assert.equal(preservedSnapshot(f.db, capture(f.db, f.projectB)), beforeB);
  assert.ok(
    new DeletedProjectRedactionStore(f.db, false)
      .exclusions([])
      .includes(deletionCanary),
  );
  assert.equal(
    JSON.stringify(f.service.deletedProject(f.projectId)).includes(
      deletionCanary,
    ),
    false,
  );
  assert.deepEqual(await f.service.deleteProject(command), result);
  await assert.rejects(
    f.service.deleteProject({ ...command, key: randomUUID() }),
    /conflict/,
  );
  await assert.rejects(
    f.service.deleteProject({
      ...command,
      confirmationName: command.confirmationName.toUpperCase(),
    }),
    /conflict/,
  );
  f.domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: randomUUID(),
    name: command.confirmationName,
    leadProfileId: null,
  });
  assert.throws(
    () =>
      f.domain.execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId: f.projectId,
        name: "Different name",
        leadProfileId: null,
      }),
    /Deleted project IDs/,
  );
  await f.service.stop();
  await f.service.start();
  assert.deepEqual(await f.service.deleteProject(command), result);
  assert.equal(f.fixture.runtime.turns, 0);
});

test("preview and confirmation reject active projects, case changes and stale version/digest without mutation", async (t) => {
  const f = await projectDeletionFixture(t, false);
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /Archive/,
  );
  f.freeze();
  const command = await f.command(),
    before = databaseSnapshot(f.db);
  for (const changed of [
    { confirmationName: command.confirmationName.toUpperCase() },
    { expectedVersion: command.expectedVersion + 1 },
    { previewDigest: "f".repeat(64) },
  ])
    await assert.rejects(f.service.deleteProject({ ...command, ...changed }));
  assert.equal(databaseSnapshot(f.db), before);
  f.domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: command.expectedVersion,
    name: "Renamed",
  });
  await assert.rejects(f.service.deleteProject(command), /stale/);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM project_tombstones").get()?.n,
    0,
  );
});

test("a new owned row or receipt invalidates preview even without a project version change", async (t) => {
  const f = await projectDeletionFixture(t),
    command = await f.command();
  f.db
    .prepare(
      "INSERT INTO task_review_view_receipts (key,material) VALUES (?,?)",
    )
    .run(
      randomUUID(),
      JSON.stringify({ taskId: f.taskId, sourceId: null, resultIds: [] }),
    );
  await assert.rejects(f.service.deleteProject(command), /preview changed/);
  assert.equal(f.domain.project(f.projectId).archived, 1);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM project_tombstones").get()?.n,
    0,
  );
});

test("private input rotation and an ownership/lifecycle race are rechecked inside the transaction", async (t) => {
  const f = await projectDeletionFixture(t),
    command = await f.command();
  let revision = 1;
  const value = { live: ["original"], retiring: [deletionCanary] };
  const deletion = f.deletion({
    privateInputs: async () => ({
      ...value,
      fingerprint: materialDigest({ revision }),
      fence: () => materialDigest({ revision }),
    }),
    beforeCommit: async () => {
      revision++;
    },
  });
  const before = databaseSnapshot(f.db);
  await assert.rejects(deletion.delete(command), /private inputs changed/);
  assert.equal(databaseSnapshot(f.db), before);
  const restore = f.deletion({
    beforeCommit: async () => {
      f.restore();
    },
  });
  await assert.rejects(restore.delete(command), /Archive|stale/);
  assert.equal(f.domain.project(f.projectId).archived, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM project_tombstones").get()?.n,
    0,
  );
});

for (const phase of projectDeletionFaultPhases)
  test(`delete fault at ${phase} rolls back ledger/accounting/tombstone and all owned rows`, async (t) => {
    const f = await projectDeletionFixture(t),
      command = await f.command(),
      before = databaseSnapshot(f.db);
    let faults = 0;
    const deletion = f.deletion({
      phase: (at) => {
        if (at === phase) {
          faults++;
          throw new Error("Injected delete phase failure");
        }
      },
    });
    await assert.rejects(deletion.delete(command), /Injected/);
    assert.equal(faults, 1);
    assert.equal(databaseSnapshot(f.db), before);
    assert.equal(f.fixture.runtime.turns, 0);
  });

test("the inventory classifies every fresh table and column and refuses new unclassified schema", async (t) => {
  const f = await projectDeletionFixture(t);
  assert.equal(Object.keys(projectDeletionInventory).length, 178);
  assertProjectDeletionInventory(f.db);
  f.db.exec("ALTER TABLE tasks ADD COLUMN unclassifiedOwner TEXT");
  assert.throws(() => assertProjectDeletionInventory(f.db), /column inventory/);
  await assert.rejects(f.service.projectDeletionPreview(f.projectId));
  f.db.exec("ALTER TABLE tasks DROP COLUMN unclassifiedOwner");
  f.db.exec("CREATE TABLE unclassified_project_data (owner TEXT)");
  assert.throws(() => assertProjectDeletionInventory(f.db), /schema inventory/);
});

test("shared thread or cross-project execution lineage refuses instead of expanding ownership", async (t) => {
  const f = await projectDeletionFixture(t);
  f.db
    .prepare(
      "UPDATE execution_intents SET threadId='shared-thread' WHERE workId IN (?,?)",
    )
    .run(f.workId, f.workB);
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /unavailable/,
  );
  f.db
    .prepare("UPDATE execution_intents SET threadId=NULL WHERE workId IN (?,?)")
    .run(f.workId, f.workB);
  f.db
    .prepare(
      "INSERT OR REPLACE INTO execution_request_predecessors (workId,previousWorkId,predecessorKnown) VALUES (?,?,1)",
    )
    .run(f.workId, f.workB);
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /unavailable/,
  );
  assert.ok(
    f.db.prepare("SELECT 1 FROM domain_projects WHERE id=?").get(f.projectB),
  );
});

test("drain is checked again after preparation and no unknown effect is resolved to permit deletion", async (t) => {
  const f = await projectDeletionFixture(t),
    command = await f.command();
  const deletion = f.deletion({
    beforeCommit: async () => {
      f.db
        .prepare(
          "INSERT INTO execution_pending_effects (workId,effectKey,state) VALUES (?,'late-effect','pending')",
        )
        .run(f.workId);
    },
  });
  await assert.rejects(deletion.delete(command), /stale|not drained/);
  assert.ok(
    f.db
      .prepare("SELECT 1 FROM execution_pending_effects WHERE workId=?")
      .get(f.workId),
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM project_tombstones").get()?.n,
    0,
  );
});

test("omitted child and detached receipt calibrations make the independent reference walk fail", async (t) => {
  for (const omitted of [
    "conversation_history_turn_omissions",
    "task_review_view_receipts",
  ] as const) {
    const f = await projectDeletionFixture(t),
      key = randomUUID();
    if (omitted === "task_review_view_receipts")
      f.db
        .prepare("INSERT INTO task_review_view_receipts VALUES (?,?)")
        .run(
          key,
          JSON.stringify({ taskId: f.taskId, sourceId: null, resultIds: [] }),
        );
    else
      f.db
        .prepare(`INSERT INTO conversation_history_turn_omissions
      (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,reason,createdAt)
      VALUES (?,?,?,1,1,1,1,1,'owned-thread','owned-turn','early-buffer-limit',1)`)
        .run(f.workId, f.taskId, f.assignmentId);
    const owner = capture(f.db, f.projectId);
    assert.throws(
      () =>
        transaction(f.db, () => {
          for (const statement of projectDeletionStatements)
            if (statement.table !== omitted) {
              const query = deletionQuery(statement.sql, owner.parameters);
              f.db.prepare(query.sql).run(...query.parameters);
            }
          assert.throws(
            () => assertProjectRowsRemoved(f.db, owner),
            /retained owned rows/,
          );
          assert.throws(() => assertNoDeletedReferences(f.db, owner));
          // Abort calibration so fixture teardown sees its original intact state.
          throw new Error("Calibration rollback");
        }),
      /Calibration rollback/,
    );
  }
});

import {
  deletionSeedIdentity,
  seedAllDeletionOwnedRows,
} from "../fixtures/project-deletion-rows.js";
import {
  deletionOperatorReceiptScopes,
  deletionPreTurnScopes,
} from "../fixtures/project-deletion-receipts.js";

async function exhaustiveStorageFixture(t: import("node:test").TestContext) {
  const f = await projectDeletionFixture(t),
    seqA = f.components.schedulerStore.sequence(f.workId),
    seqB = f.components.schedulerStore.sequence(f.workB);
  await f.service.stop();
  const db = new DatabaseSync(
    join(f.fixture.directory, "data", "standalone.sqlite"),
  );
  db.exec("PRAGMA foreign_keys=ON");
  const a = deletionSeedIdentity({
    projectId: f.projectId,
    taskId: f.taskId,
    blockerTaskId: f.blockerTaskId,
    assignmentId: f.assignmentId,
    profileId: f.profileId,
    workId: f.workId,
    intentId: f.intent.id,
    requestSequence: seqA,
    n: 100001,
    workspacePath: join(f.fixture.directory, "storage-a"),
  });
  const b = deletionSeedIdentity({
    projectId: f.projectB,
    taskId: f.taskB,
    blockerTaskId: f.blockerB,
    assignmentId: f.assignmentB,
    profileId: f.profileId,
    workId: f.workB,
    intentId: f.intentB.id,
    requestSequence: seqB,
    n: 100002,
    workspacePath: join(f.fixture.directory, "storage-b"),
  });
  try {
    seedAllDeletionOwnedRows(db, a);
    seedAllDeletionOwnedRows(db, b);
    // Both endpoints are independently exercised; B's task and provider blocker remain.
    db.prepare(
      "INSERT INTO local_dependencies (taskId,blockerTaskId) VALUES (?,?)",
    ).run(b.taskId, a.taskId);
    db.prepare(
      "INSERT INTO local_dependencies (taskId,blockerTaskId) VALUES (?,?)",
    ).run(a.taskId, b.taskId);
    db.prepare(
      "UPDATE source_native_blockers SET blockerExternalId=? WHERE externalId=?",
    ).run(a.externalId, b.externalId);
    // Terminal evidence may retain only its owned thread after workId was lost.
    db.prepare(
      "INSERT INTO runtime_terminal_evidence (threadId,turnId,firstStatus,conflicted,workId,firstRuntimeGeneration,lastRuntimeGeneration,firstObservedAt,lastObservedAt,failureEvidence,harness) VALUES (?,?,'completed',0,NULL,1,1,1,1,NULL,'codex')",
    ).run(a.threadId, a.uuid("terminal-null-work"));
    return { f, db, a, b };
  } catch (error) {
    db.close();
    throw error;
  }
}

test("explicit traversal removes distinguishing A rows in every owned table with FKs ON and preserves B/shared bytes", async (t) => {
  const { f, db, a, b } = await exhaustiveStorageFixture(t);
  try {
    assertProjectDeletionInventory(db);
    const ownerA = capture(db, a.projectId),
      ownerB = capture(db, b.projectId);
    assert.deepEqual(
      projectDeletionStatements
        .filter((statement) => !ownerA.rows[statement.table]!.length)
        .map((statement) => statement.table),
      [],
      "Every owned table requires a distinguishing A seed",
    );
    for (const [table] of Object.entries(projectDeletionInventory))
      assert.ok(
        db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(),
        `missing shared/owned inventory row for ${table}`,
      );
    assert.deepEqual(
      new Set(
        (
          ownerA.parameters.operatorReceipts as { scope: string; key: string }[]
        ).map((r) => r.scope),
      ),
      new Set(deletionOperatorReceiptScopes),
    );
    assert.equal(
      (ownerA.parameters.preTurnKeys as string[]).length,
      deletionPreTurnScopes.length,
    );
    assert.ok(
      (ownerA.parameters.work as string[]).includes(`drafting:${a.draftId}`),
    );
    assert.ok((ownerA.parameters.threads as string[]).includes(a.threadId));
    assert.ok(
      (ownerA.rows.runtime_terminal_evidence ?? []).some(
        (row) => row.workId === null,
      ),
    );
    const normalizedB = () => {
      const rows = capture(db, b.projectId).rows;
      return {
        ...rows,
        local_dependencies: rows.local_dependencies!.filter(
          (row) => row.taskId !== a.taskId && row.blockerTaskId !== a.taskId,
        ),
      };
    };
    const before = preservedSnapshot(db, { ...ownerB, rows: normalizedB() }),
      bytes = (ownerA.rows.diagnostic_items ?? []).reduce(
        (n, row) => n + Number(row.payloadBytes),
        0,
      ),
      usage = Number(
        db.prepare("SELECT totalBytes FROM diagnostic_usage WHERE id=1").get()!
          .totalBytes,
      );
    assert.ok(bytes > 0);
    transaction(db, () =>
      deleteCapturedProjectRowsWithinTransaction(db, ownerA),
    );
    assertProjectRowsRemoved(db, ownerA);
    assertNoDeletedReferences(db, ownerA);
    assert.equal(
      preservedSnapshot(db, { ...ownerB, rows: normalizedB() }),
      before,
    );
    assert.equal(
      db.prepare("SELECT totalBytes FROM diagnostic_usage WHERE id=1").get()
        ?.totalBytes,
      usage - bytes,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM source_native_blockers WHERE externalId=? AND blockerExternalId=?",
        )
        .get(b.externalId, a.externalId),
      "the unrelated blocker owner remains, despite a retained external identity match",
    );
    assert.equal(f.fixture.runtime.turns, 0);
  } finally {
    db.close();
  }
});

test("captured receipt keys remain available after parents vanish; a deliberately omitted old receipt fails the audit", async (t) => {
  const { db, a } = await exhaustiveStorageFixture(t);
  try {
    const owner = capture(db, a.projectId);
    assert.throws(
      () =>
        transaction(db, () => {
          for (const statement of projectDeletionStatements)
            if (statement.table !== "execution_pre_turn_commands") {
              const query = deletionQuery(statement.sql, owner.parameters);
              db.prepare(query.sql).run(...query.parameters);
            }
          assert.throws(
            () => assertNoDeletedReferences(db, owner),
            /unapproved JSON owner/,
          );
          assert.throws(
            () => assertProjectRowsRemoved(db, owner),
            /execution_pre_turn_commands/,
          );
          throw new Error("Calibration rollback");
        }),
      /Calibration rollback/,
    );
    assert.ok(
      db.prepare("SELECT 1 FROM domain_projects WHERE id=?").get(a.projectId),
    );
  } finally {
    db.close();
  }
});

test("delete retains historical global exclusions as sanitization-only strings across restart", async (t) => {
  const f = await projectDeletionFixture(t),
    command = await f.command(),
    oldResolved = "old-resolved-disposable-token";
  const value = { live: [oldResolved], retiring: [deletionCanary] };
  const deletion = f.deletion({
    privateInputs: async () => ({
      ...value,
      fingerprint: materialDigest(value),
      fence: () => materialDigest(value),
    }),
  });
  await deletion.delete(command);
  await f.service.stop();
  await f.service.start();
  const restarted = databaseOf(f.service),
    ledger = new DeletedProjectRedactionStore(restarted, false);
  assert.ok(ledger.exclusions([]).includes(oldResolved));
  assert.ok(ledger.exclusions([]).includes(deletionCanary));
  assert.equal(
    JSON.stringify(f.service.deletedProject(f.projectId)).includes(oldResolved),
    false,
  );
  assert.deepEqual(
    restarted
      .prepare("PRAGMA table_info(deleted_project_redaction_values)")
      .all()
      .map((row) => row.name),
    ["value"],
  );
});

test("missing ledger and private overflow refuse atomically before any deletion or cleanup", async (t) => {
  const f = await projectDeletionFixture(t),
    command = await f.command();
  const before = databaseSnapshot(f.db),
    value = { live: [], retiring: ["x".repeat(64 * 1024 + 1)] };
  await assert.rejects(
    f
      .deletion({
        privateInputs: async () => ({
          ...value,
          fingerprint: materialDigest(value),
          fence: () => materialDigest(value),
        }),
      })
      .delete(command),
    /redaction/i,
  );
  assert.equal(databaseSnapshot(f.db), before);
  f.db.exec("DROP TABLE deleted_project_redaction_values");
  const missing = databaseSnapshot(f.db);
  await assert.rejects(f.service.deleteProject(command), /unavailable/);
  assert.equal(databaseSnapshot(f.db), missing);
  assert.equal(f.fixture.runtime.turns, 0);
});

test("unknown detached receipt scopes and contradictory receipt parents fail closed", async (t) => {
  const f = await projectDeletionFixture(t),
    before = databaseSnapshot(f.db);
  f.db
    .prepare(
      "INSERT INTO coordination_operator_receipts (scope,commandKey,payloadHash,result) VALUES (?,?,?,?)",
    )
    .run(
      "unclassified",
      randomUUID(),
      "a".repeat(64),
      JSON.stringify({ eventId: randomUUID() }),
    );
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /unavailable/,
  );
  f.db
    .prepare(
      "DELETE FROM coordination_operator_receipts WHERE scope='unclassified'",
    )
    .run();
  assert.equal(databaseSnapshot(f.db), before);
  f.db
    .prepare(
      "INSERT INTO task_review_view_receipts (key,material) VALUES (?,?)",
    )
    .run(
      randomUUID(),
      JSON.stringify({
        taskId: f.taskId,
        sourceId: randomUUID(),
        resultIds: [],
      }),
    );
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /unavailable/,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM project_tombstones").get()?.n,
    0,
  );
});

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeTemporaryBase } from "../../src/standalone/claude.js";
const deletionFixtureExec = promisify(execFile);

test("preview observes dirty/unknown Git state and captures identities without removing worktrees", async (t) => {
  const f = await projectDeletionFixture(t),
    workspaceId = randomUUID(),
    path = join(f.roots.task, workspaceId),
    repo = join(path, "repo"),
    file = join(repo, "untracked.txt");
  await mkdir(repo, { recursive: true });
  await deletionFixtureExec("git", ["init", "--initial-branch=main", repo]);
  await writeFile(file, "Disposable unsaved work");
  const stamp = new Date().toISOString();
  f.db
    .prepare(
      "INSERT INTO task_workspace_bindings (taskId,workspaceId,path,repositories,state,reason,gitUncertain,createdAt,updatedAt) VALUES (?,?,?,?,'ready',NULL,0,?,?)",
    )
    .run(
      f.taskId,
      workspaceId,
      path,
      JSON.stringify([
        {
          repositoryId: "R_disposable",
          sourcePath: f.fixture.directory,
          workspacePath: repo,
          ref: "main",
          gitCommonDir: join(repo, ".git"),
          commit: null,
        },
      ]),
      stamp,
      stamp,
    );
  const deletion = f.deletion(),
    preview = await deletion.preview(f.projectId);
  assert.deepEqual(preview.worktrees, [
    {
      workspaceId,
      kind: "task",
      dirty: "yes",
      unpushed: "unknown",
      inspection: "available",
    },
  ]);
  assert.equal(preview.forceDiscard, true);
  assert.equal(preview.outsideDiscovery, "recorded-identities-only");
  for (const args of [
    [
      "-c",
      "user.name=Disposable fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Baseline",
    ],
    ["branch", "baseline"],
    ["branch", "--set-upstream-to=baseline", "main"],
    [
      "-c",
      "user.name=Disposable fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Unpushed local work",
    ],
  ])
    await deletionFixtureExec("git", ["-C", repo, ...args]);
  const ahead = await deletion.preview(f.projectId);
  assert.equal(ahead.worktrees[0]?.unpushed, "yes");
  assert.equal(ahead.worktrees[0]?.dirty, "yes");
  assert.equal(
    ahead.previewDigest,
    preview.previewDigest,
    "confirmation accepts current discard, without reserving Git contents",
  );
  const unavailable = await f
    .deletion({ gitExecutable: join(f.fixture.directory, "missing-git") })
    .preview(f.projectId);
  assert.equal(unavailable.worktrees[0]?.dirty, "unknown");
  assert.equal(unavailable.worktrees[0]?.unpushed, "unknown");
  await deletion.delete({
    type: "project.delete",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: preview.version,
    confirmationName: preview.name,
    previewDigest: preview.previewDigest,
  });
  assert.equal(await readFile(file, "utf8"), "Disposable unsaved work");
  const stored = JSON.parse(
    String(
      f.db
        .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId=?")
        .get(f.projectId)?.cleanupJson,
    ),
  ) as {
    items: {
      kind: string;
      state: string;
      captured?: { binding?: { workspaceId: string } };
    }[];
  };
  assert.ok(
    stored.items.some(
      (item) =>
        item.kind === "workspace" &&
        item.state === "pending" &&
        item.captured?.binding?.workspaceId === workspaceId,
    ),
  );
  assert.equal(
    f.db
      .prepare("SELECT 1 FROM task_workspace_bindings WHERE taskId=?")
      .get(f.taskId),
    undefined,
  );
  assert.equal(f.fixture.runtime.turns, 0);
});

test("an extant historical Claude directory without a binding refuses unprovable cleanup ownership", async (t) => {
  const f = await projectDeletionFixture(t),
    temp = claudeTemporaryBase(f.fixture.directory);
  // The fixture directory is unique; no installed runtime or provider identity is touched.
  await mkdir(temp, { mode: 0o700 });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = join(temp, "disposable"),
    before = databaseSnapshot(f.db);
  await writeFile(file, "Keep until ownership is known");
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /unavailable/,
  );
  assert.equal(databaseSnapshot(f.db), before);
  assert.equal(await readFile(file, "utf8"), "Keep until ownership is known");
});

test("a retiring unresolved credential refuses deletion without retaining configuration or removing rows", async (t) => {
  const f = await projectDeletionFixture(t);
  f.db
    .prepare(
      "INSERT OR REPLACE INTO project_routing (projectId,version,enabled,guidance,credentialRef,candidateProfileIds) VALUES (?,1,0,'','gh:github.com','[]')",
    )
    .run(f.projectId);
  const command = await f.command(),
    before = databaseSnapshot(f.db);
  await assert.rejects(f.deletion().delete(command), /unavailable/);
  assert.equal(databaseSnapshot(f.db), before);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM project_tombstones").get()?.n,
    0,
  );
  assert.equal(f.fixture.runtime.turns, 0);
});

test("each explicit traversal phase restores the full populated ownership graph including rebase proofs, Cancel receipts and Unstack journals on failure", async (t) => {
  const { f, db, a } = await exhaustiveStorageFixture(t);
  try {
    const owner = capture(db, a.projectId),
      before = databaseSnapshot(db);
    assert.ok(
      JSON.stringify(
        db.prepare("SELECT recordJson FROM delivery_pr_bindings").all(),
      ).includes("rebaseProofs"),
    );
    assert.ok(
      JSON.stringify(
        db.prepare("SELECT receiptJson FROM task_control_receipts").all(),
      ).includes("task-cancel"),
    );
    assert.ok((owner.rows.delivery_unstack_operations ?? []).length > 0);
    for (const phase of projectDeletionFaultPhases.filter(
      (at) =>
        at === "diagnostic-accounting" ||
        at.startsWith("delete:") ||
        at === "postcondition",
    )) {
      let injected = 0;
      assert.throws(
        () =>
          transaction(db, () =>
            deleteCapturedProjectRowsWithinTransaction(db, owner, (at) => {
              if (at === phase) {
                injected++;
                throw new Error("Populated graph fault");
              }
            }),
          ),
        /Populated graph fault/,
      );
      assert.equal(injected, 1, phase);
      assert.equal(databaseSnapshot(db), before, phase);
    }
    assert.equal(f.fixture.runtime.turns, 0);
  } finally {
    db.close();
  }
});

import { receiptMaterials } from "../fixtures/project-deletion-receipts.js";

test("preview reports exact owned counts and retains recorded branch/PR identities without guessing a host", async (t) => {
  const f = await projectDeletionFixture(t);
  const i = deletionSeedIdentity({
    projectId: f.projectId,
    taskId: f.taskId,
    blockerTaskId: f.blockerTaskId,
    assignmentId: f.assignmentId,
    profileId: f.profileId,
    workId: f.workId,
    intentId: f.intent.id,
    requestSequence: f.components.schedulerStore.sequence(f.workId),
    n: 100001,
    workspacePath: f.fixture.directory,
  });
  const { pr } = receiptMaterials(i),
    branch = pr.observation.headRef;
  f.db
    .prepare(
      "INSERT OR REPLACE INTO project_repository_links (projectId,version,links) VALUES (?,1,?)",
    )
    .run(
      f.projectId,
      JSON.stringify([
        {
          repositoryId: "R_shared",
          path: f.fixture.directory,
          ref: "main",
          gitCommonDirectory: join(f.fixture.directory, ".git"),
          codeHost: "github",
          host: "github.com",
        },
      ]),
    );
  f.db
    .prepare(
      "INSERT INTO delivery_task_branches (taskId,repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt) VALUES (?,'R_shared',?,NULL,NULL,1)",
    )
    .run(f.taskId, branch);
  f.db
    .prepare(
      "INSERT INTO delivery_pr_bindings (taskId,recordJson) VALUES (?,?)",
    )
    .run(f.taskId, JSON.stringify(pr));
  const preview = await f.service.projectDeletionPreview(f.projectId);
  assert.deepEqual(preview.counts, { tasks: 2, assignments: 1, worktrees: 0 });
  assert.deepEqual(preview.externalRemnants, [
    {
      codeHost: "github",
      host: "github.com",
      repositoryId: "R_shared",
      branch,
      changeRequestId: pr.observation.nodeId,
    },
  ]);
  assert.equal(f.fixture.runtime.turns, 0);
  f.db
    .prepare("UPDATE project_repository_links SET links='[]' WHERE projectId=?")
    .run(f.projectId);
  await assert.rejects(
    f.service.projectDeletionPreview(f.projectId),
    /unavailable/,
  );
});

import {
  UnstackStore,
  unstackPhases,
  unstackPrivateValues,
} from "../../src/core/unstack.js";
import {
  unstackFixtureRecord,
  unstackFixtureRow,
} from "../fixtures/unstack-journal.js";

test("every unfinished Unstack phase and malformed/no-effect claim blocks the actual archive drain", async (t) => {
  const f = await projectDeletionFixture(t, false);
  f.domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: Number(f.domain.project(f.projectId).version),
    paused: true,
  });
  for (const phase of unstackPhases) {
    f.db.prepare("DELETE FROM delivery_unstack_operations").run();
    const r = unstackFixtureRecord(
        {
          projectId: f.projectId,
          taskId: f.taskId,
          blockerTaskId: f.blockerTaskId,
          operationId: randomUUID(),
          seq: 1,
        },
        phase,
      ),
      row = unstackFixtureRow(r);
    f.db
      .prepare(
        "INSERT INTO delivery_unstack_operations VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(...Object.values(row));
    const blockers = transaction(f.db, () =>
      f.domain.projectArchiveBlockersWithinTransaction(f.projectId),
    );
    if (["confirmed", "failed"].includes(phase)) {
      assert.deepEqual(new UnstackStore(f.db).projectBlockers(f.projectId), []);
    } else {
      assert.ok(
        blockers.some((b) => b.kind === "delivery-action"),
        phase,
      );
      assert.throws(
        () =>
          f.domain.execute({
            type: "project.archive",
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            expectedVersion: Number(f.domain.project(f.projectId).version),
          }),
        /drained/,
      );
    }
    const forged = {
      ...r,
      phase: "failed",
      reason: "unstack-refused",
      noEffect: null,
    };
    f.db
      .prepare(
        "UPDATE delivery_unstack_operations SET phase='failed',recordJson=?",
      )
      .run(JSON.stringify(forged));
    assert.equal(
      new UnstackStore(f.db).projectBlockers(f.projectId)[0]?.kind,
      "unavailable",
    );
  }
});

test("captured Unstack private material traverses the ledger inputs and project B remains byte-for-byte isolated", async (t) => {
  const { db, a, b } = await exhaustiveStorageFixture(t);
  try {
    const ownerA = capture(db, a.projectId),
      ownerB = capture(db, b.projectId);
    const record = new UnstackStore(db).records(a.taskId)[0]!;
    const inputs = await prepareDeletionPrivateInputs(db, ownerA, [], {
      extra: () => [],
      resolveReference: async () => {
        throw new Error("No credential resolution in this fixture");
      },
    });
    for (const value of unstackPrivateValues(record))
      assert.ok(inputs.retiring.includes(value), value);
    const beforeB = JSON.stringify(ownerB.rows.delivery_unstack_operations);
    transaction(db, () =>
      deleteCapturedProjectRowsWithinTransaction(db, ownerA),
    );
    assert.equal(
      JSON.stringify(capture(db, b.projectId).rows.delivery_unstack_operations),
      beforeB,
    );
    assert.equal(new UnstackStore(db).records(a.taskId).length, 0);
  } finally {
    db.close();
  }
});

test("an archived project with an injected unfinished Unstack cannot delete owned rows or release unknown effects", async (t) => {
  const f = await projectDeletionFixture(t);
  const record = unstackFixtureRecord(
    {
      projectId: f.projectId,
      taskId: f.taskId,
      blockerTaskId: f.blockerTaskId,
      operationId: randomUUID(),
      seq: 1,
    },
    "unstack-attempting",
  );
  f.db
    .prepare(
      "INSERT INTO delivery_unstack_operations VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(...Object.values(unstackFixtureRow(record)));
  const command = await f.command(),
    before = databaseSnapshot(f.db);
  await assert.rejects(f.deletion().delete(command), /drained/);
  assert.equal(databaseSnapshot(f.db), before);
});
