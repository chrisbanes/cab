import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { ClaudeRuntime } from "../../src/standalone/claude.js";
import { CodexRuntime } from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import {
  createRuntime,
  powerSupervisionEnabled,
} from "../../src/standalone/service.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { coordinationFixture } from "../fixtures/coordination.js";
import {
  closeRuntimeSafetyFixtures,
  runtimeSafetyFixture,
} from "../fixtures/runtime-safety.js";
import { tmpdir } from "../fixtures/temp.js";

test.after(closeRuntimeSafetyFixtures);

const profileId = "60000000-0000-4000-8000-000000000001";
const childB = "40000000-0000-4000-8000-000000000003";

test("runtime factory constructs the requested harness and rejects unknown ones", () => {
  const context = {
    spawnEnvironment: () => ({}),
    safety: runtimeSafetyFixture().safety,
  };
  const runtime = createRuntime(context, "codex");
  assert.ok(runtime instanceof CodexRuntime);
  assert.equal(runtime.harness, "codex");
  assert.throws(
    () => createRuntime(context, "claude"),
    /Claude runtime context unavailable/,
  );
  const claude = createRuntime(
    {
      ...context,
      claude: {
        configDirectory: "/nonexistent/claude/config",
        turnEnvironment: () => ({ unavailable: "unused" }),
      },
    },
    "claude",
  );
  assert.ok(claude instanceof ClaudeRuntime);
  assert.equal(claude.harness, "claude");
  assert.throws(
    () => createRuntime(context, "opencode" as ExecutionHarness),
    /Unsupported execution harness/,
  );
});

test("power supervision follows harness runtimes unless explicitly configured", () => {
  const harnessRuntime = { harness: "codex" as const };
  const fakeRuntime = {};
  assert.equal(powerSupervisionEnabled(undefined, harnessRuntime), true);
  assert.equal(powerSupervisionEnabled(undefined, fakeRuntime), false);
  assert.equal(
    powerSupervisionEnabled({ enabled: false }, harnessRuntime),
    false,
  );
  assert.equal(powerSupervisionEnabled({ enabled: true }, fakeRuntime), true);
  assert.equal(
    powerSupervisionEnabled(
      {
        eventSource: {
          readSince: () => Promise.reject(new Error("not polled")),
        },
      },
      fakeRuntime,
    ),
    true,
  );
});

test("existing bindings and runtime evidence read as Codex after migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-harness-migration-"));
  const filename = join(directory, "standalone.sqlite");
  const db = new DatabaseSync(filename);
  try {
    new Store(db).ensureHost("harness-migration-test");
    new DomainStore(db).migrate();
    // Exact pre-harness DDL for the three tables that gain the column.
    db.exec(`CREATE TABLE task_execution_bindings (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      taskId TEXT NOT NULL, assignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL, instructionsRevision INTEGER NOT NULL,
      profileRevision INTEGER NOT NULL, conversationRevision INTEGER NOT NULL
    );
    CREATE TABLE runtime_terminal_evidence (
      threadId TEXT NOT NULL CHECK(length(threadId) BETWEEN 1 AND 512),
      turnId TEXT NOT NULL CHECK(length(turnId) BETWEEN 1 AND 512),
      firstStatus TEXT CHECK(firstStatus IS NULL OR firstStatus IN ('completed','failed')),
      conflicted INTEGER NOT NULL DEFAULT 0 CHECK(conflicted IN (0,1)),
      workId TEXT REFERENCES execution_intents(workId),
      firstRuntimeGeneration TEXT,
      lastRuntimeGeneration TEXT,
      firstObservedAt INTEGER,
      lastObservedAt INTEGER,
      failureEvidence TEXT CHECK(failureEvidence IS NULL OR length(failureEvidence) <= 256),
      PRIMARY KEY(threadId, turnId),
      CHECK((firstStatus IS NULL AND firstRuntimeGeneration IS NULL AND
        firstObservedAt IS NULL) OR (firstStatus IS NOT NULL AND
        firstRuntimeGeneration IS NOT NULL AND lastRuntimeGeneration IS NOT NULL AND
        firstObservedAt IS NOT NULL AND lastObservedAt IS NOT NULL)),
      CHECK((lastRuntimeGeneration IS NULL AND lastObservedAt IS NULL) OR
        (lastRuntimeGeneration IS NOT NULL AND lastObservedAt IS NOT NULL))
    );
    CREATE TABLE runtime_thread_qualification (
      threadId TEXT PRIMARY KEY CHECK(length(threadId) BETWEEN 1 AND 512),
      toolDigest TEXT,
      codexVersion TEXT,
      executableHash TEXT,
      model TEXT,
      modelProvider TEXT,
      reasoningEffort TEXT,
      serviceTier TEXT,
      developerInstructionsDigest TEXT
    );
    INSERT INTO execution_intents (id, workId, prompt, workspace, state,
        reason, threadId, turnId, accountType, sandbox, approval)
      VALUES ('legacy-intent', 'legacy-work', 'work', '/tmp/work', 'completed',
        NULL, 'legacy-bound-thread', 'legacy-bound-turn', 'chatgpt',
        'workspaceWrite', 'never');
    INSERT INTO task_execution_bindings VALUES
      ('legacy-work', 'task', 'assignment', 1, 1, 1, 1);
    INSERT INTO runtime_terminal_evidence
      (threadId, turnId, firstStatus, conflicted, workId,
        firstRuntimeGeneration, lastRuntimeGeneration,
        firstObservedAt, lastObservedAt, failureEvidence)
      VALUES ('legacy-thread', 'legacy-turn', 'failed', 0, NULL,
        'legacy-generation', 'legacy-generation', 1, 1,
        '{"classification":"transient","reasonCode":"serverOverloaded","source":"codexErrorInfo","codexRetries":null}');
    INSERT INTO runtime_thread_qualification (threadId, toolDigest)
      VALUES ('legacy-thread', '${"c".repeat(64)}');`);

    new ExecutionState(db);
    const state = new ExecutionState(db);

    assert.equal(state.taskBinding("legacy-work")?.harness, "codex");
    const terminal = state.runtimeTerminal(
      "legacy-thread",
      "legacy-turn",
      "legacy-generation",
    );
    assert.equal(terminal?.harness, "codex");
    assert.deepEqual(terminal?.failure, {
      classification: "transient",
      reasonCode: "serverOverloaded",
      source: "harness",
      harnessRetries: null,
    });
    assert.equal(
      state.runtimeThreadQualification("legacy-thread")?.harness,
      "codex",
    );
    for (const table of [
      "task_execution_bindings",
      "runtime_terminal_evidence",
      "runtime_thread_qualification",
    ]) {
      const harness = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          dflt_value: string | null;
          notnull: number;
        }>
      ).find(({ name }) => name === "harness");
      assert.equal(harness?.dflt_value, "'codex'", table);
      assert.equal(harness?.notnull, 1, table);
    }

    // Unknown stored harness values fail closed instead of falling back.
    db.prepare(
      "UPDATE task_execution_bindings SET harness = 'unknown' WHERE workId = ?",
    ).run("legacy-work");
    assert.throws(() => state.taskBinding("legacy-work"));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new bindings and runtime evidence persist harness-neutral Codex facts", () => {
  const f = coordinationFixture();
  try {
    const binding = f.state.taskBinding("work-child-a");
    assert.equal(binding?.harness, "codex");
    assert.ok(binding);
    const context = {
      taskId: binding.taskId,
      assignmentId: binding.assignmentId,
      assignmentVersion: binding.assignmentVersion,
      instructionsRevision: binding.instructionsRevision,
      profileRevision: binding.profileRevision,
    };
    // A bound work keeps its harness rather than adopting the requested one.
    assert.equal(
      f.state.bindTask("work-child-a", context, "claude").harness,
      "codex",
    );
    assert.equal(f.state.bindTask("work-child-a", context).harness, "codex");
    assert.throws(() =>
      f.state.bindTask("work-child-a", context, "gemini" as ExecutionHarness),
    );

    const recorded = f.state.recordRuntimeTerminal({
      threadId: "fresh-thread",
      turnId: "fresh-turn",
      status: "failed",
      runtimeGeneration: "fresh-generation",
      failure: {
        classification: "transient",
        reasonCode: "rateLimitExceeded",
        source: "harness",
        harnessRetries: null,
      },
    });
    assert.equal(recorded.harness, "codex");
    f.state.recordRuntimeTerminal({
      threadId: "fresh-thread",
      turnId: "missing-turn",
      status: "failed",
      runtimeGeneration: "fresh-generation",
    });
    for (const turnId of ["fresh-turn", "missing-turn"]) {
      const stored = f.db
        .prepare(
          "SELECT failureEvidence, harness FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
        )
        .get("fresh-thread", turnId) as {
        failureEvidence: string;
        harness: string;
      };
      assert.equal(stored.harness, "codex");
      assert.match(stored.failureEvidence, /"harnessRetries":null/);
      assert.doesNotMatch(stored.failureEvidence, /codex/i);
    }
    f.state.registerRuntimeThreadTools("fresh-thread", "d".repeat(64));
    assert.equal(
      f.state.runtimeThreadQualification("fresh-thread")?.harness,
      "codex",
    );
  } finally {
    f.close();
  }
});

test("existing profiles read as Codex after migration and unknown runtimes fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-profile-runtime-"));
  const db = new DatabaseSync(join(directory, "standalone.sqlite"));
  try {
    new Store(db).ensureHost("profile-runtime-migration-test");
    // Exact pre-runtime DDL for the two tables that gain the column.
    db.exec(`CREATE TABLE profiles (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL,
      instructions TEXT NOT NULL, capabilities TEXT NOT NULL,
      revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
      summary TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE profile_revisions (
      profileId TEXT NOT NULL REFERENCES profiles(id), revision INTEGER NOT NULL,
      name TEXT NOT NULL, instructions TEXT NOT NULL, capabilities TEXT NOT NULL,
      revoked INTEGER NOT NULL, PRIMARY KEY(profileId, revision)
    );
    INSERT INTO profiles VALUES ('${profileId}', 1, 'Legacy', 'Build', 'code', 0, '');
    INSERT INTO profile_revisions VALUES ('${profileId}', 1, 'Legacy', 'Build', 'code', 0);`);
    new DomainStore(db).migrate();
    const domain = new DomainStore(db);
    domain.migrate();
    assert.deepEqual(domain.profileRuntime(profileId), { harness: "codex" });
    assert.deepEqual(domain.profileRuntime(profileId, 1), { harness: "codex" });

    db.prepare("UPDATE profiles SET runtime = ? WHERE id = ?").run(
      '{"harness":"unknown"}',
      profileId,
    );
    assert.throws(() => domain.profileRuntime(profileId));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an assignment conversation keeps the harness that started it", () => {
  const f = coordinationFixture();
  try {
    const assignment = f.domain.assignment(childB);
    const created = (assignmentId: string) => {
      f.domain.execute({
        type: "assignment.create",
        key: randomUUID(),
        actor: "agent",
        projectId: String(assignment.projectId),
        taskId: String(assignment.taskId),
        assignmentId,
        profileId: String(assignment.profileId),
        brief: "Harness",
        resultDestination: "lead",
        requesterAssignmentId: null,
      });
      const row = f.domain.assignment(assignmentId);
      return {
        taskId: String(row.taskId),
        assignmentId,
        assignmentVersion: Number(row.version),
        instructionsRevision: Number(row.instructionsRevision),
        profileRevision: Number(row.profileRevision),
      };
    };
    const bind = (
      workId: string,
      context: ReturnType<typeof created>,
      harness: ExecutionHarness,
    ) => {
      f.db
        .prepare(
          "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
            "VALUES (?, ?, 'work', '/tmp/work', 'completed', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')",
        )
        .run(randomUUID(), workId);
      return f.state.bindTask(workId, context, harness).harness;
    };
    const a = created(randomUUID());
    assert.equal(bind("harness-a-1", a, "claude"), "claude");
    assert.equal(bind("harness-a-2", a, "codex"), "claude");
    assert.equal(f.state.bindTask("harness-a-1", a, "codex").harness, "claude");
    assert.equal(f.state.taskBinding("harness-a-2")?.harness, "claude");

    f.state.replaceConversation(a.assignmentId);
    assert.equal(bind("harness-a-3", a, "codex"), "codex");

    const b = created(randomUUID());
    assert.equal(bind("harness-b-1", b, "codex"), "codex");
  } finally {
    f.close();
  }
});

test("binding a turn never adopts another harness's earlier terminal evidence", () => {
  const f = coordinationFixture();
  try {
    const assignment = f.domain.assignment(childB);
    const id = randomUUID();
    f.db
      .prepare(
        "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
          "VALUES (?, 'work-late-turn', 'work', '/tmp/work', 'submitting', NULL, 'thread-late', NULL, 'chatgpt', 'workspaceWrite', 'never')",
      )
      .run(id);
    f.state.bindTask("work-late-turn", {
      taskId: String(assignment.taskId),
      assignmentId: childB,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    });
    f.state.recordRuntimeTerminal(
      {
        threadId: "thread-late",
        turnId: "turn-late",
        status: "completed",
        runtimeGeneration: "claude-generation",
      },
      "claude",
    );
    assert.equal(f.state.bindTurn(id, "turn-late"), true);
    const evidence = f.db
      .prepare(
        "SELECT workId, conflicted FROM runtime_terminal_evidence WHERE threadId = 'thread-late'",
      )
      .get() as { workId: string | null; conflicted: number };
    assert.deepEqual({ ...evidence }, { workId: null, conflicted: 1 });
  } finally {
    f.close();
  }
});
