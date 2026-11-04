import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { DomainStore, DomainConflictError } from "../../src/core/domain.js";
import {
  ProjectArchivedError,
  ProjectArchiveBlockedError,
  archiveBlockers,
  projectLifecycle,
  projectLifecycleMatches,
} from "../../src/core/project-lifecycle.js";
import { transaction } from "../../src/core/store.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { ProjectWrites } from "../../src/standalone/project-writes.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

async function world(t: TestContext) {
  const fixture = await createOperatorFixture();
  await fixture.service.stop();
  const db = new DatabaseSync(
    join(fixture.directory, "data", "standalone.sqlite"),
  );
  db.exec("PRAGMA foreign_keys = ON");
  t.after(async () => {
    db.close();
    await fixture.close();
  });
  const writes = new ProjectWrites(db);
  // Fixture-only authority: no provider callbacks exist in these paused disposable projects.
  const domain = new DomainStore(db, undefined, undefined, (id) =>
    writes.blockers(id),
  );
  const projectId = randomUUID(),
    taskId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Lifecycle",
    leadProfileId: null,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Unfinished but drained",
    outcome: "Still open",
    ready: false,
  });
  const archive = (key = randomUUID()) =>
    domain.execute({
      type: "project.archive",
      actor: "operator",
      key,
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
    });
  const restore = () =>
    domain.execute({
      type: "project.restore",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
    });
  return { fixture, db, domain, writes, projectId, taskId, archive, restore };
}

test("archive preserves drained open tasks and exhaustive reads; restore remains paused", async (t) => {
  const w = await world(t),
    task = w.domain.task(w.taskId),
    before = w.domain.project(w.projectId);
  w.archive();
  assert.equal(w.domain.project(w.projectId).archived, 1);
  assert.equal(
    w.domain.project(w.projectId).version,
    Number(before.version) + 1,
  );
  assert.deepEqual(w.domain.task(w.taskId), task);
  assert.ok(w.domain.projects().some((p) => p.id === w.projectId));
  assert.equal(w.domain.admission(w.taskId).eligible, false);
  assert.ok(w.domain.admission(w.taskId).reasons.includes("project-archived"));
  w.restore();
  assert.equal(w.domain.project(w.projectId).archived, 0);
  assert.equal(w.domain.project(w.projectId).paused, 1);
  assert.deepEqual(w.domain.task(w.taskId), task);
  assert.throws(w.restore, DomainConflictError);
});

test("archive requires pause and authoritative service facts, including direct store calls", async (t) => {
  const w = await world(t);
  w.domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    expectedVersion: 1,
    paused: false,
  });
  const before = w.domain.project(w.projectId);
  assert.throws(
    w.archive,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some((b) => b.kind === "not-paused"),
  );
  assert.deepEqual(w.domain.project(w.projectId), before);
  const withoutAuthority = new DomainStore(w.db);
  assert.throws(
    () =>
      withoutAuthority.execute({
        type: "project.archive",
        actor: "operator",
        key: randomUUID(),
        projectId: w.projectId,
        expectedVersion: Number(before.version),
      }),
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some((b) => b.kind === "unavailable"),
  );
  assert.throws(
    () => archiveBlockers(w.db, w.projectId, () => []),
    /transaction/,
  );
});

test("archived projects retain their name and allow only name-only configuration", async (t) => {
  const w = await world(t);
  w.archive();
  assert.throws(() =>
    w.domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId: randomUUID(),
      name: "LIFECYCLE",
      leadProfileId: null,
    }),
  );
  w.domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    expectedVersion: 2,
    name: "Renamed",
  });
  const before = w.domain.project(w.projectId);
  for (const change of [
    { paused: false },
    { instructions: "Replacement" },
    { leadProfileId: null },
    { diagnosticCapture: "baseline" as const },
    { commandNetworkAccess: true },
    { stacking: true },
    { name: "Again", paused: true },
  ])
    assert.throws(
      () =>
        w.domain.execute({
          type: "project.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: w.projectId,
          expectedVersion: Number(before.version),
          ...change,
        }),
      ProjectArchivedError,
    );
  assert.deepEqual(w.domain.project(w.projectId), before);
  assert.throws(
    () =>
      w.domain.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId: w.projectId,
        taskId: randomUUID(),
        title: "New",
        outcome: "No",
        ready: false,
      }),
    ProjectArchivedError,
  );
  assert.throws(
    () =>
      w.domain.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: w.projectId,
        taskId: w.taskId,
        expectedVersion: 1,
        ready: true,
      }),
    ProjectArchivedError,
  );
});

test("keyed lifecycle replay is stable while fresh keys enforce lifecycle and version", async (t) => {
  const w = await world(t),
    key = randomUUID();
  const command = {
    type: "project.archive" as const,
    actor: "operator" as const,
    key,
    projectId: w.projectId,
    expectedVersion: 1,
  };
  const receipt = w.domain.execute(command);
  assert.deepEqual(w.domain.execute(command), receipt);
  assert.throws(
    () => w.domain.execute({ ...command, key: randomUUID() }),
    DomainConflictError,
  );
  assert.throws(
    () => w.domain.execute({ ...command, expectedVersion: 2 }),
    DomainConflictError,
  );
  w.restore();
  assert.deepEqual(w.domain.execute(command), receipt);
  assert.equal(w.domain.project(w.projectId).archived, 0);
  assert.throws(
    () => w.domain.execute({ ...command, key: randomUUID() }),
    DomainConflictError,
  );
});

for (const kind of ["callback", "provider-write"] as const)
  test(`archive refuses an in-flight ${kind}, including thrown/rejected completion`, async (t) => {
    const w = await world(t);
    let release!: () => void;
    const pending = w.writes.run(w.projectId, kind, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    assert.throws(
      w.archive,
      (error) =>
        error instanceof ProjectArchiveBlockedError &&
        error.blockers.some((b) => b.kind === kind),
    );
    release();
    await pending;
    await assert.rejects(
      w.writes.run(w.projectId, kind, async () => {
        throw new Error("write failed");
      }),
      /write failed/,
    );
    w.archive();
    await assert.rejects(
      w.writes.run(w.projectId, kind, async () =>
        assert.fail("must never issue"),
      ),
      ProjectArchivedError,
    );
  });

for (const [table, kind, columns] of [
  ["task_writer_holds", "writer-hold", "taskId,reason"],
  ["task_writer_ambiguity_holds", "recovery-hold", "taskId,reason"],
  ["task_archival_holds", "archival-hold", "taskId,reason"],
] as const)
  test(`archive refuses ${kind} without changing project or task`, async (t) => {
    const w = await world(t),
      before = w.domain.project(w.projectId),
      task = w.domain.task(w.taskId);
    w.db
      .prepare(`INSERT INTO ${table} (${columns}) VALUES (?, 'unreleased')`)
      .run(w.taskId);
    assert.throws(
      w.archive,
      (error) =>
        error instanceof ProjectArchiveBlockedError &&
        error.blockers.some((b) => b.kind === kind),
    );
    assert.deepEqual(w.domain.project(w.projectId), before);
    assert.deepEqual(w.domain.task(w.taskId), task);
    w.db.prepare(`DELETE FROM ${table} WHERE taskId = ?`).run(w.taskId);
    w.archive();
  });

test("new queued work cannot bypass the archived domain through the scheduler store", async (t) => {
  const w = await world(t),
    scheduler = new SchedulerStore(w.db);
  w.archive();
  assert.throws(
    () =>
      scheduler.ensure({
        requestKey: randomUUID(),
        workId: randomUUID(),
        kind: "assignment",
        projectId: w.projectId,
        taskId: w.taskId,
        assignmentId: null,
        taskVersion: 1,
        assignmentVersion: null,
        instructionsRevision: null,
        profileRevision: null,
        prompt: "New turn",
        workspace: null,
        previousWorkId: null,
      }),
    ProjectArchivedError,
  );
  assert.deepEqual(
    w.db
      .prepare("SELECT workId FROM turn_requests WHERE projectId = ?")
      .all(w.projectId),
    [],
  );
});

test("source lifecycle snapshots remain stale after archive and restore", async (t) => {
  const w = await world(t),
    snapshot = projectLifecycle(w.db, w.projectId);
  assert.ok(projectLifecycleMatches(w.db, snapshot));
  w.archive();
  assert.equal(projectLifecycleMatches(w.db, snapshot), false);
  w.restore();
  assert.equal(projectLifecycleMatches(w.db, snapshot), false);
  assert.ok(projectLifecycleMatches(w.db, projectLifecycle(w.db, w.projectId)));
});

test("legacy projects migrate active and historical command receipts retain their shape", async (t) => {
  const w = await world(t),
    key = randomUUID();
  const command = {
    type: "project.configure" as const,
    actor: "operator" as const,
    key,
    projectId: w.projectId,
    expectedVersion: 1,
    paused: true,
  };
  const receipt = w.domain.execute(command);
  const { archived: _archived, ...legacy } = receipt as {
    archived: number;
    [key: string]: unknown;
  };
  w.db
    .prepare("UPDATE command_receipts SET result = ? WHERE key = ?")
    .run(JSON.stringify(legacy), key);
  assert.deepEqual(w.domain.execute(command), legacy);
  w.db.exec("ALTER TABLE domain_projects DROP COLUMN archived");
  w.domain.migrate();
  assert.equal(w.domain.project(w.projectId).archived, 0);
  assert.deepEqual(w.domain.execute(command), legacy);
  assert.throws(() =>
    transaction(w.db, () =>
      w.db
        .prepare("UPDATE domain_projects SET archived = 2 WHERE id = ?")
        .run(w.projectId),
    ),
  );
});

for (const [kind, seed] of [
  [
    "routing",
    (w: Awaited<ReturnType<typeof world>>) =>
      w.db
        .prepare(
          "INSERT INTO routing_attempt_operations (operationId,projectId,taskId,taskVersion,snapshotHash,snapshotJson,status,attemptsUsed,createdAt,updatedAt) VALUES (?,?,?,1,'hash','{}','routing',0,1,1)",
        )
        .run(randomUUID(), w.projectId, w.taskId),
  ],
  [
    "drafting",
    (w: Awaited<ReturnType<typeof world>>) =>
      w.db
        .prepare(
          "INSERT INTO drafting_runs (runId,projectId,idea,harness,profileId,profileRevision,instructionsRevision,state,createdAt) VALUES (?,?,'idea','codex',?,1,1,'running',1)",
        )
        .run(randomUUID(), w.projectId, randomUUID()),
  ],
  [
    "delivery-action",
    (w: Awaited<ReturnType<typeof world>>) =>
      w.db
        .prepare(
          "INSERT INTO delivery_actions (operationId,taskId,materialHash,recordJson) VALUES (?,?,'hash','{\"state\":\"uncertain\"}')",
        )
        .run(randomUUID(), w.taskId),
  ],
  [
    "change-request",
    (w: Awaited<ReturnType<typeof world>>) =>
      w.db
        .prepare(
          'INSERT INTO delivery_pr_bindings (taskId,recordJson) VALUES (?,\'{"observation":{"state":"OPEN"}}\')',
        )
        .run(w.taskId),
  ],
] as const)
  test(`archive refuses baseline ${kind} until its owning operation settles`, async (t) => {
    const w = await world(t),
      before = w.domain.project(w.projectId);
    seed(w);
    assert.throws(
      w.archive,
      (error) =>
        error instanceof ProjectArchiveBlockedError &&
        error.blockers.some((b) => b.kind === kind),
    );
    assert.deepEqual(w.domain.project(w.projectId), before);
  });

test("unresolved assignment, queued request, pending effect and reserved capacity each refuse archive", async (t) => {
  const w = await world(t),
    profileId = randomUUID(),
    assignmentId = randomUUID(),
    workId = randomUUID();
  w.domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Candidate",
    instructions: "Private",
    capabilities: "Coordination",
  });
  w.domain.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    expectedVersion: 1,
    enabled: false,
    candidateProfileIds: [profileId],
  });
  w.domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    taskId: w.taskId,
    assignmentId,
    profileId,
    brief: "Brief",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const refuses = (kind: string) =>
    assert.throws(
      w.archive,
      (error) =>
        error instanceof ProjectArchiveBlockedError &&
        error.blockers.some((b) => b.kind === kind),
    );
  refuses("assignment");
  w.db
    .prepare("UPDATE domain_assignments SET state = 'completed' WHERE id = ?")
    .run(assignmentId);
  const scheduler = new SchedulerStore(w.db);
  scheduler.ensure({
    requestKey: randomUUID(),
    workId,
    kind: "assignment",
    projectId: w.projectId,
    taskId: w.taskId,
    assignmentId,
    taskVersion: 1,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    prompt: "Prompt",
    workspace: null,
    previousWorkId: null,
  });
  refuses("execution");
  w.db
    .prepare("UPDATE turn_requests SET state = 'completed' WHERE workId = ?")
    .run(workId);
  w.db
    .prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval) VALUES (?,?,'Private','/fixture','completed','chatgpt','workspaceWrite','never')",
    )
    .run(randomUUID(), workId);
  w.db
    .prepare(
      "INSERT INTO execution_pending_effects (workId,effectKey,state) VALUES (?,'effect','pending')",
    )
    .run(workId);
  refuses("pending-effect");
  w.db
    .prepare(
      "UPDATE execution_pending_effects SET state = 'settled' WHERE workId = ?",
    )
    .run(workId);
  w.db
    .prepare(
      "INSERT INTO execution_capacity_reservations (workId,projectId) VALUES (?,?)",
    )
    .run(workId, w.projectId);
  refuses("capacity");
  w.db
    .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
    .run(workId);
  w.archive();
});

test("a resolved historical held request is not an unfinished execution", async (t) => {
  const w = await world(t),
    workId = randomUUID(),
    scheduler = new SchedulerStore(w.db);
  scheduler.ensure({
    requestKey: randomUUID(),
    workId,
    kind: "assignment",
    projectId: w.projectId,
    taskId: w.taskId,
    assignmentId: null,
    taskVersion: 1,
    assignmentVersion: null,
    instructionsRevision: null,
    profileRevision: null,
    prompt: "Historical",
    workspace: null,
    previousWorkId: null,
  });
  w.db
    .prepare("UPDATE turn_requests SET state = 'held' WHERE workId = ?")
    .run(workId);
  assert.throws(w.archive, ProjectArchiveBlockedError);
  w.db
    .prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval) VALUES (?,?,'Historical','/fixture','resolved-failed','chatgpt','workspaceWrite','never')",
    )
    .run(randomUUID(), workId);
  w.archive();
  assert.equal(w.domain.project(w.projectId).archived, 1);
});

test("unacknowledged conversation archival refuses drain until its durable request is confirmed", async (t) => {
  const w = await world(t),
    workId = randomUUID(),
    threadId = randomUUID();
  new SchedulerStore(w.db).ensure({
    requestKey: randomUUID(),
    workId,
    kind: "direct",
    projectId: w.projectId,
    taskId: w.taskId,
    assignmentId: null,
    taskVersion: 1,
    assignmentVersion: null,
    instructionsRevision: null,
    profileRevision: null,
    prompt: "Historical",
    workspace: null,
    previousWorkId: null,
  });
  w.db
    .prepare("UPDATE turn_requests SET state='completed' WHERE workId=?")
    .run(workId);
  w.db
    .prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval,threadId) VALUES (?,?,'Historical','/fixture','completed','chatgpt','workspaceWrite','never',?)",
    )
    .run(randomUUID(), workId, threadId);
  w.db
    .prepare(
      "INSERT INTO conversation_archives (threadId,state) VALUES (?,'requested')",
    )
    .run(threadId);
  const before = w.domain.project(w.projectId);
  assert.throws(
    w.archive,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some(
        (b) => b.kind === "provider-write" && b.operationId === threadId,
      ),
  );
  assert.deepEqual(w.domain.project(w.projectId), before);
  w.db
    .prepare(
      "UPDATE conversation_archives SET state='archived' WHERE threadId=?",
    )
    .run(threadId);
  w.archive();
});

test("unknown change-request state and unavailable drain schema fail closed without altering the project", async (t) => {
  const w = await world(t),
    before = w.domain.project(w.projectId);
  w.db
    .prepare(
      "INSERT INTO delivery_pr_bindings (taskId,recordJson) VALUES (?,'{}')",
    )
    .run(w.taskId);
  assert.throws(
    w.archive,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some((b) => b.kind === "change-request"),
  );
  w.db.prepare("DELETE FROM delivery_pr_bindings WHERE taskId=?").run(w.taskId);
  w.db.exec("DROP TABLE conversation_archives");
  assert.throws(
    w.archive,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some((b) => b.kind === "unavailable"),
  );
  assert.deepEqual(w.domain.project(w.projectId), before);
});
