import { runtimeSafetyFixture } from "../fixtures/runtime-safety.js";
import { coordinationFixture } from "../fixtures/coordination.js";
import { SqliteWorkspaceBindingStore } from "../../src/standalone/workspaces.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  WorkspaceLifecycleStore,
  type WorkspaceGenerationInput,
} from "../../src/core/workspace-lifecycle.js";

const sha = "a".repeat(40);
const pushedSha = "b".repeat(40);
function generation(): WorkspaceGenerationInput {
  return {
    taskId: randomUUID(),
    workspaceId: randomUUID(),
    path: "/disposable/workspace",
    createdAt: null,
    repositories: ["one", "two"].map((repositoryId) => ({
      repositoryId,
      sourcePath: `/source/${repositoryId}`,
      workspacePath: `/disposable/workspace/${repositoryId}`,
      ref: `task/${repositoryId}`,
      gitCommonDir: null,
      commit: repositoryId === "one" ? sha : null,
      legacyFact: { unknownOwnership: true },
    })),
  };
}
function database(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS domain_tasks(id TEXT PRIMARY KEY)",
  );
  return db;
}
function fixture() {
  const db = database();
  const store = new WorkspaceLifecycleStore(db);
  store.migrate();
  const input = generation();
  db.prepare("INSERT INTO domain_tasks VALUES (?)").run(input.taskId);
  store.retain(input);
  return { db, store, input };
}
function removal(operationId: string = randomUUID()) {
  return {
    operationId,
    kind: "remove" as const,
    trigger: "manual" as const,
    startedAt: 100,
  };
}
function proofs(input: WorkspaceGenerationInput) {
  return input.repositories.map((r) => ({
    kind: "pushed" as const,
    repositoryId: r.repositoryId,
    branch: r.ref,
    commit: pushedSha,
  }));
}

test("schema preparation leaves migration version and legacy bindings untouched across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "cab-lifecycle-"));
  const file = join(directory, "store.sqlite");
  let db = database(file);
  try {
    db.exec(
      "PRAGMA user_version=36; CREATE TABLE task_workspace_bindings(taskId TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
    const input = generation();
    const legacy = JSON.stringify({
      ...input,
      state: "held",
      reason: "unknown legacy ownership",
      updatedAt: "2026-11-14T00:00:00Z",
    });
    db.prepare("INSERT INTO domain_tasks VALUES (?)").run(input.taskId);
    db.prepare("INSERT INTO task_workspace_bindings VALUES (?,?)").run(
      input.taskId,
      legacy,
    );
    let store = new WorkspaceLifecycleStore(db);
    store.migrate();
    assert.deepEqual(store.forTask(input.taskId), []);
    const retained = store.retain(input);
    assert.equal(retained.createdAt, null);
    assert.equal(retained.terminal, null);
    assert.equal(retained.lastTurnEndedAt, null);
    assert.equal(retained.lastPushAt, null);
    assert.equal(retained.allMergedAt, null);
    assert.equal(retained.repositories[1]?.commit, null);
    assert.deepEqual(retained.repositories[0]?.legacyFact, {
      unknownOwnership: true,
    });
    assert.deepEqual(store.retain(input), retained);
    db.close();
    db = database(file);
    store = new WorkspaceLifecycleStore(db);
    store.migrate();
    assert.deepEqual(store.get(input.workspaceId), retained);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      36,
    );
    assert.equal(
      (
        db.prepare("SELECT data FROM task_workspace_bindings").get() as {
          data: string;
        }
      ).data,
      legacy,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clock events preserve episode anchors, clamp backward time, and reject changed replay", () => {
  const { db, store, input } = fixture();
  try {
    const ended = {
      kind: "turn-ended" as const,
      eventId: "turn-1",
      at: 200,
      workId: "work-1",
      turnId: "turn-1",
    };
    store.observe(input, ended);
    store.observe(input, {
      kind: "terminal",
      eventId: "done-1",
      at: 190,
      status: "done",
    });
    let current = store.observe(input, {
      kind: "terminal",
      eventId: "duplicate-poll",
      at: 300,
      status: "done",
    });
    assert.equal(current.terminal?.at, 200);
    assert.equal(current.lastTurnEndedAt, 200);
    const revision = current.revision;
    current = store.observe(input, ended);
    assert.equal(current.revision, revision);
    assert.throws(
      () => store.observe(input, { ...ended, at: 201 }),
      /identity reused/,
    );
    current = store.observe(input, {
      kind: "terminal",
      eventId: "cancelled-1",
      at: 300,
      status: "cancelled",
    });
    assert.deepEqual(current.terminal, {
      episodeId: "cancelled-1",
      status: "cancelled",
      at: 300,
    });
    current = store.observe(input, {
      kind: "terminal",
      eventId: "reopen",
      at: 250,
      status: null,
    });
    assert.equal(current.terminal, null);
    store.observe(input, {
      kind: "terminal",
      eventId: "done-2",
      at: 300,
      status: "done",
    });
    current = store.observe(input, {
      ...ended,
      eventId: "turn-2",
      turnId: "turn-2",
      at: 300,
    });
    assert.equal(current.terminal?.episodeId, "done-2");
    assert.equal(current.lastTurnEndedAt, 300);
    assert.equal(current.lastTurnEndedEventId, "turn-2");
  } finally {
    db.close();
  }
});

test("merge clocks need every exact repository and do not advance on polling or terminal completion", () => {
  const { db, store, input } = fixture();
  try {
    const merged = {
      kind: "merge" as const,
      eventId: "merge-one",
      at: 10,
      repositoryId: "one",
      changeRequestId: "pr-1",
      merged: true,
    };
    assert.equal(store.observe(input, merged).allMergedAt, null);
    assert.equal(
      store.observe(input, {
        ...merged,
        eventId: "merge-two",
        repositoryId: "two",
        changeRequestId: "pr-2",
        at: 20,
      }).allMergedAt,
      20,
    );
    assert.equal(
      store.observe(input, { ...merged, eventId: "poll", at: 30 }).allMergedAt,
      20,
    );
    assert.equal(
      store.observe(input, {
        kind: "terminal",
        eventId: "still-open",
        at: 35,
        status: null,
      }).allMergedAt,
      20,
    );
    assert.equal(
      store.observe(input, {
        kind: "terminal",
        eventId: "done",
        at: 40,
        status: "done",
      }).allMergedAt,
      20,
    );
    assert.equal(
      store.observe(input, {
        ...merged,
        eventId: "changed-request",
        changeRequestId: "pr-3",
        at: 50,
      }).allMergedAt,
      50,
    );
    assert.equal(
      store.observe(input, {
        ...merged,
        eventId: "unmerged",
        changeRequestId: "pr-3",
        at: 60,
        merged: false,
      }).allMergedAt,
      null,
    );
    assert.equal(
      store.observe(input, {
        ...merged,
        eventId: "merged-again",
        changeRequestId: "pr-3",
        at: 60,
      }).allMergedAt,
      60,
    );
    assert.equal(
      store.observe(input, {
        kind: "terminal",
        eventId: "reopen",
        at: 70,
        status: null,
      }).allMergedAt,
      null,
    );
    assert.throws(
      () =>
        store.observe(input, {
          ...merged,
          eventId: "outside",
          repositoryId: "outside",
        }),
      /outside/,
    );
    const empty = { ...generation(), taskId: input.taskId, repositories: [] };
    assert.equal(store.retain(empty).allMergedAt, null);
  } finally {
    db.close();
  }
});

test("a removal push preserves the retention anchor and requires its exact active operation", () => {
  const { db, store, input } = fixture();
  try {
    const push = {
      kind: "push" as const,
      eventId: "push-1",
      at: 90,
      repositoryId: "one",
      commit: pushedSha,
      removalOperationId: null,
    };
    store.observe(input, push);
    const operation = store.beginOperation(input, removal());
    const cleanupPush = {
      ...push,
      eventId: "cleanup-push",
      at: 120,
      removalOperationId: operation.operationId,
    };
    const current = store.observe(input, cleanupPush);
    assert.equal(current.lastPushAt, 90);
    assert.equal(current.repositoryClocks[0]?.pushedAt, 120);
    assert.deepEqual(store.observe(input, cleanupPush), current);
    assert.throws(
      () =>
        store.observe(input, {
          ...cleanupPush,
          eventId: "wrong-op",
          removalOperationId: randomUUID(),
        }),
      /another generation/,
    );
    store.holdOperation(
      input,
      operation.operationId,
      "child settlement unknown",
    );
    assert.throws(
      () => store.observe(input, { ...cleanupPush, eventId: "held-push" }),
      /active operation/,
    );
  } finally {
    db.close();
  }
});

test("journal fences effect identities, order, settlement, stale completion and preserved generations", () => {
  const { db, store, input } = fixture();
  try {
    const operation = store.beginOperation(input, removal());
    assert.deepEqual(
      store.beginOperation(input, removal(operation.operationId)),
      operation,
    );
    assert.throws(() => store.beginOperation(input, removal()), /unfinished/);
    const wrongOwner = { ...input, taskId: randomUUID() };
    assert.throws(
      () => store.operation(wrongOwner, operation.operationId),
      /owner mismatch/,
    );
    const effect = {
      effectId: randomUUID(),
      target: { kind: "repository" as const, repositoryId: "one" },
      startedAt: 110,
    };
    assert.throws(
      () =>
        store.startEffect(input, operation.operationId, {
          ...effect,
          target: { kind: "repository", repositoryId: "outside" },
        }),
      /outside/,
    );
    store.startEffect(input, operation.operationId, effect);
    store.startEffect(input, operation.operationId, effect);
    assert.throws(
      () =>
        store.startEffect(input, operation.operationId, {
          ...effect,
          startedAt: 111,
        }),
      /identity reused/,
    );
    assert.throws(
      () =>
        store.startEffect(input, operation.operationId, {
          ...effect,
          effectId: randomUUID(),
        }),
      /not succeeded/,
    );
    assert.throws(
      () =>
        store.completeOperation(
          input,
          operation.operationId,
          1,
          120,
          proofs(input),
        ),
      /not settled/,
    );
    assert.throws(
      () =>
        store.settleEffect(
          input,
          operation.operationId,
          randomUUID(),
          "succeeded",
          120,
        ),
      /Invalid effect/,
    );
    assert.throws(
      () =>
        store.settleEffect(
          input,
          operation.operationId,
          effect.effectId,
          "succeeded",
          109,
        ),
      /Invalid effect/,
    );
    store.settleEffect(
      input,
      operation.operationId,
      effect.effectId,
      "succeeded",
      120,
    );
    store.settleEffect(
      input,
      operation.operationId,
      effect.effectId,
      "succeeded",
      120,
    );
    assert.throws(
      () =>
        store.settleEffect(
          input,
          operation.operationId,
          effect.effectId,
          "failed",
          120,
        ),
      /settlement changed/,
    );
    const current = store.observe(input, {
      kind: "turn-ended",
      eventId: "late-turn",
      at: 130,
      turnId: "late-turn",
      workId: "work",
    });
    assert.throws(
      () =>
        store.completeOperation(
          input,
          operation.operationId,
          1,
          140,
          proofs(input),
        ),
      /generation changed/,
    );
    assert.throws(
      () =>
        store.completeOperation(
          input,
          operation.operationId,
          current.revision,
          140,
          proofs(input).slice(1),
        ),
      /identities changed/,
    );
    assert.throws(
      () =>
        store.completeOperation(
          input,
          operation.operationId,
          current.revision,
          140,
          [proofs(input)[0]!, proofs(input)[0]!],
        ),
      /Duplicate/,
    );
    const completed = store.completeOperation(
      input,
      operation.operationId,
      current.revision,
      140,
      proofs(input),
    );
    assert.equal(completed.state, "completed");
    assert.throws(
      () => store.holdOperation(input, operation.operationId, "late"),
      /already completed/,
    );
    const next = {
      ...input,
      workspaceId: randomUUID(),
      path: "/disposable/new",
    };
    store.retain(next);
    assert.equal(store.forTask(input.taskId).length, 2);
    assert.deepEqual(store.operations(input), [completed]);
    assert.throws(
      () => store.operation(next, operation.operationId),
      /another generation/,
    );
    assert.equal(store.get(next.workspaceId)?.lastPushAt, null);
  } finally {
    db.close();
  }
});

test("unknown and failed destructive effects stay held across a database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "cab-journal-"));
  const file = join(directory, "store.sqlite");
  let db = database(file);
  try {
    let store = new WorkspaceLifecycleStore(db);
    store.migrate();
    const input = generation();
    db.prepare("INSERT INTO domain_tasks VALUES (?)").run(input.taskId);
    store.retain(input);
    const operation = store.beginOperation(input, removal());
    const effectId = randomUUID();
    store.startEffect(input, operation.operationId, {
      effectId,
      target: { kind: "claude-base" },
      startedAt: 110,
    });
    db.close();
    db = database(file);
    store = new WorkspaceLifecycleStore(db);
    assert.equal(
      store.operation(input, operation.operationId).effects[0]?.settledAt,
      null,
    );
    assert.throws(
      () =>
        store.completeOperation(
          input,
          operation.operationId,
          1,
          200,
          proofs(input),
        ),
      /not settled/,
    );
    store.holdOperation(
      input,
      operation.operationId,
      "positive child settlement missing",
    );
    assert.throws(
      () =>
        store.settleEffect(
          input,
          operation.operationId,
          effectId,
          "succeeded",
          200,
        ),
      /not active/,
    );
    assert.throws(() => store.beginOperation(input, removal()), /unfinished/);
    const other = { ...input, workspaceId: randomUUID() };
    store.retain(other);
    const failed = store.beginOperation(other, removal());
    store.startEffect(other, failed.operationId, {
      effectId: randomUUID(),
      target: { kind: "root" },
      startedAt: 110,
    });
    const id = store.operation(other, failed.operationId).effects[0]!.effectId;
    store.settleEffect(other, failed.operationId, id, "failed", 120);
    assert.throws(
      () =>
        store.completeOperation(
          other,
          failed.operationId,
          1,
          130,
          proofs(input),
        ),
      /not settled/,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("storage rejects malformed facts and rolls back with its owning transaction", () => {
  const { db, store, input } = fixture();
  try {
    assert.throws(
      () => store.retain({ ...input, path: "/changed" }),
      /identity changed/,
    );
    assert.throws(
      () =>
        store.retain({
          ...input,
          workspaceId: randomUUID(),
          repositories: [input.repositories[0]!, input.repositories[0]!],
        }),
      /Duplicate/,
    );
    assert.throws(() =>
      store.observe(input, {
        kind: "terminal",
        eventId: "bad-time",
        at: Number.NaN,
        status: "done",
      }),
    );
    assert.throws(() =>
      store.observe(input, {
        kind: "push",
        eventId: "bad-sha",
        at: 5,
        repositoryId: "one",
        commit: "not-a-sha",
        removalOperationId: null,
      }),
    );
    assert.throws(
      () => store.beginOperation(input, { ...removal(), trigger: "idle" }),
      /Invalid/,
    );
    db.exec("BEGIN IMMEDIATE");
    store.observe(input, {
      kind: "terminal",
      eventId: "rollback",
      at: 50,
      status: "done",
    });
    db.exec("ROLLBACK");
    assert.equal(store.get(input.workspaceId)?.terminal, null);
    const saved = store.get(input.workspaceId)!;
    db.prepare(
      "UPDATE workspace_generations SET data=? WHERE workspaceId=?",
    ).run(
      JSON.stringify({ ...saved, taskId: randomUUID() }),
      input.workspaceId,
    );
    assert.throws(() => store.get(input.workspaceId), /identity mismatch/);
  } finally {
    db.close();
  }
});

test("trim records and base-only removal records remain distinct and reject corrupt phases", () => {
  const { db, store, input } = fixture();
  try {
    const trim = store.beginOperation(input, {
      operationId: randomUUID(),
      kind: "trim",
      trigger: "idle",
      startedAt: 100,
    });
    const effectId = randomUUID();
    store.startEffect(input, trim.operationId, {
      effectId,
      target: { kind: "scratch" },
      startedAt: 110,
    });
    store.settleEffect(input, trim.operationId, effectId, "succeeded", 120);
    assert.throws(
      () =>
        store.completeOperation(input, trim.operationId, 1, 130, proofs(input)),
      /Trim cannot/,
    );
    const trimmed = store.completeOperation(
      input,
      trim.operationId,
      1,
      130,
      null,
    );
    assert.equal(trimmed.kind, "trim");
    assert.equal(trimmed.repositories, null);
    const baseOnly = {
      ...input,
      workspaceId: randomUUID(),
      repositories: [{ ...input.repositories[0]!, ref: "main" }],
    };
    store.retain(baseOnly);
    const remove = store.beginOperation(baseOnly, removal());
    const completed = store.completeOperation(
      baseOnly,
      remove.operationId,
      1,
      140,
      [
        {
          kind: "base",
          repositoryId: "one",
          branch: "task/one",
          commit: sha,
          noTaskCommits: true,
        },
      ],
    );
    assert.equal(completed.repositories?.[0]?.kind, "base");
    assert.equal(completed.repositories?.[0]?.branch, "task/one");
    assert.equal(store.get(baseOnly.workspaceId)?.repositories[0]?.ref, "main");
    assert.deepEqual(store.operations(input), [trimmed]);
    db.prepare(
      "UPDATE workspace_maintenance_operations SET data=? WHERE operationId=?",
    ).run(JSON.stringify({ ...trimmed, completedAt: null }), trim.operationId);
    assert.throws(
      () => store.operation(input, trim.operationId),
      /journal phase/,
    );
    const saved = store.get(input.workspaceId)!;
    db.prepare(
      "UPDATE workspace_generations SET data=? WHERE workspaceId=?",
    ).run(
      JSON.stringify({ ...saved, repositoryClocks: [] }),
      input.workspaceId,
    );
    assert.throws(() => store.get(input.workspaceId), /clock identities/);
  } finally {
    db.close();
  }
});

test("production domain and cancellation writes retain exact generation episodes without releasing holds", () => {
  const fixture = coordinationFixture();
  try {
    const taskId = "20000000-0000-4000-8000-000000000001";
    const bindings = new SqliteWorkspaceBindingStore(fixture.db);
    const workspaceId = randomUUID();
    bindings.createOrGet(taskId, workspaceId, "/fixture/lifecycle", []);
    bindings.update(taskId, "ready", null);
    const lifecycle = new WorkspaceLifecycleStore(fixture.db);
    assert.equal(lifecycle.get(workspaceId)?.terminal, null);
    const set = (state: "open" | "done" | "cancelled") =>
      fixture.domain.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: "10000000-0000-4000-8000-000000000001",
        taskId,
        expectedVersion: Number(fixture.domain.task(taskId).version),
        state,
      });
    set("done");
    const done = lifecycle.get(workspaceId)!.terminal!;
    fixture.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: "10000000-0000-4000-8000-000000000001",
      taskId,
      expectedVersion: Number(fixture.domain.task(taskId).version),
      title: "Changed metadata",
    });
    assert.deepEqual(lifecycle.get(workspaceId)?.terminal, done);
    set("open");
    assert.equal(lifecycle.get(workspaceId)?.terminal, null);
    fixture.db
      .prepare(
        "INSERT OR REPLACE INTO task_writer_ambiguity_holds VALUES (?,?)",
      )
      .run(taskId, "unresolved native child");
    const command = {
      type: "task.cancel" as const,
      key: randomUUID(),
      taskId,
      expectedVersion: Number(fixture.domain.task(taskId).version),
    };
    fixture.state.cancelTask(command, () => {});
    const cancelled = lifecycle.get(workspaceId)!.terminal;
    assert.equal(cancelled?.status, "cancelled");
    assert.ok(
      fixture.db
        .prepare("SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId=?")
        .get(taskId),
    );
    fixture.reopen();
    assert.deepEqual(
      new WorkspaceLifecycleStore(fixture.db).get(workspaceId)?.terminal,
      cancelled,
    );
  } finally {
    fixture.close();
  }
});

test("startup imports retained binding metadata without inventing terminal age and holds interrupted journals", () => {
  const f = coordinationFixture();
  try {
    const taskId = "20000000-0000-4000-8000-000000000001";
    const bindings = new SqliteWorkspaceBindingStore(f.db);
    const workspaceId = randomUUID();
    bindings.createOrGet(taskId, workspaceId, "/fixture/legacy", []);
    bindings.update(taskId, "held", "unproved child");
    const life = new WorkspaceLifecycleStore(f.db);
    life.importBindings();
    assert.equal(life.get(workspaceId)?.terminal, null);
    assert.equal(life.get(workspaceId)?.lastTurnEndedAt, null);
    const operation = life.beginOperation({ taskId, workspaceId }, removal());
    life.startEffect(operation, operation.operationId, {
      effectId: randomUUID(),
      target: { kind: "root" },
      startedAt: 110,
    });
    f.reopen();
    const after = new WorkspaceLifecycleStore(f.db);
    after.recoverInterruptedOperations();
    const held = after.operation(operation, operation.operationId);
    assert.equal(held.state, "held");
    assert.equal(held.effects[0]?.settledAt, null);
    assert.throws(
      () => after.beginOperation(operation, removal()),
      /unfinished/,
    );
    assert.equal(
      new SqliteWorkspaceBindingStore(f.db).get(taskId)?.state,
      "held",
    );
  } finally {
    f.close();
  }
});

test("exact bound turn-end observations preserve their first time through duplicate messages and legacy import", () => {
  const f = runtimeSafetyFixture();
  const db = new DatabaseSync(f.storagePath);
  try {
    const taskId = "20000000-0000-4000-8000-000000000001",
      workspaceId = randomUUID();
    const bindings = new SqliteWorkspaceBindingStore(db);
    bindings.createOrGet(taskId, workspaceId, "/tmp/work", []);
    bindings.update(taskId, "ready", null);
    const workId = f.bindTurn(
      "lifecycle-thread",
      "lifecycle-turn",
      "lifecycle-generation",
    );
    const input = {
      threadId: "lifecycle-thread",
      turnId: "lifecycle-turn",
      status: "completed" as const,
      runtimeGeneration: "lifecycle-generation",
    };
    const first = f.safety.recordTerminal(input);
    const life = new WorkspaceLifecycleStore(db),
      before = life.get(workspaceId)!;
    assert.equal(before.lastTurnEndedAt, first.firstObservedAt);
    assert.ok(before.lastTurnEndedEventId);
    f.safety.recordTerminal(input);
    assert.deepEqual(life.get(workspaceId), before);
    assert.equal(
      db
        .prepare("SELECT state FROM execution_intents WHERE workId=?")
        .get(workId)?.state,
      "running",
      "time facts never settle ownership",
    );
    db.exec(
      "DELETE FROM workspace_lifecycle_events; DELETE FROM workspace_generations",
    );
    life.importBindings();
    life.importLegacyFacts();
    assert.equal(life.get(workspaceId)?.lastTurnEndedAt, first.firstObservedAt);
    assert.equal(life.get(workspaceId)?.lastPushAt, null);
  } finally {
    db.close();
    f.close();
  }
});

test("ready binding and generation identity commit atomically on a rejected generation change", () => {
  const fixture = coordinationFixture();
  try {
    const taskId = "20000000-0000-4000-8000-000000000001";
    const bindings = new SqliteWorkspaceBindingStore(fixture.db);
    const workspaceId = randomUUID();
    const original = bindings.createOrGet(
      taskId,
      workspaceId,
      "/fixture/atomic",
      [],
    );
    const lifecycle = new WorkspaceLifecycleStore(fixture.db);
    lifecycle.recordBinding({
      taskId,
      workspaceId,
      path: "/fixture/different",
      repositories: [],
      createdAt: original.createdAt,
    });
    assert.throws(() => bindings.update(taskId, "ready", null));
    assert.equal(bindings.get(taskId)?.state, "provisioning");
    assert.equal(lifecycle.get(workspaceId)?.path, "/fixture/different");
  } finally {
    fixture.close();
  }
});

test("true reopen clears legacy merge facts without inventing an unknown historical terminal time", () => {
  const f = coordinationFixture();
  try {
    const taskId = "20000000-0000-4000-8000-000000000001",
      projectId = "10000000-0000-4000-8000-000000000001",
      workspaceId = randomUUID();
    f.db.prepare("UPDATE domain_tasks SET state='done' WHERE id=?").run(taskId);
    const bindings = new SqliteWorkspaceBindingStore(f.db);
    bindings.createOrGet(taskId, workspaceId, "/fixture/legacy-reopen", [
      {
        repositoryId: "repo",
        sourcePath: "/fixture/source",
        workspacePath: "/fixture/workspace",
        ref: "main",
        gitCommonDir: null,
        commit: null,
      },
    ]);
    bindings.update(taskId, "ready", null);
    const life = new WorkspaceLifecycleStore(f.db);
    life.observe(
      { taskId, workspaceId },
      {
        kind: "merge",
        eventId: "observed-merged",
        at: 100,
        repositoryId: "repo",
        changeRequestId: "pr",
        merged: true,
      },
    );
    assert.equal(life.get(workspaceId)?.terminal, null);
    f.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(f.domain.task(taskId).version),
      state: "open",
    });
    const reopened = life.get(workspaceId)!;
    assert.equal(reopened.terminal, null);
    assert.equal(reopened.allMergedAt, null);
    assert.equal(reopened.repositoryClocks[0]?.merged, null);
    assert.match(reopened.mergeEpoch!, /^task-state:/);
    life.taskStateChanged(taskId, "open", reopened.lastObservedAt! + 1);
    assert.deepEqual(life.get(workspaceId), reopened);
    assert.throws(() =>
      life.observe(reopened, {
        kind: "terminal",
        eventId: "invalid-reopen",
        at: 100,
        status: "done",
        reopened: true,
      }),
    );
  } finally {
    f.close();
  }
});
