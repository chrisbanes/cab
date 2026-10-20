import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionState } from "../../src/standalone/state.js";
import {
  assertSettledRuntimeCounts,
  createNativeWork,
  createTask,
  fixture,
  generation,
  receiveTerminal,
  runtimeCollectionSizes,
  type ServiceInternals,
  seedTerminalRows,
  timeIterations,
} from "../fixtures/runtime-retention.js";
import { tmpdir } from "../fixtures/temp.js";

test("production adapter terminal evidence remains SQLite-backed past cache limits", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-retention-"));
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const count = 10_000;
    seedTerminalRows(f.service, count);
    const runtime = f.runtime();
    const db = (f.service as unknown as ServiceInternals).db;
    const collect = (globalThis as unknown as { gc?: () => void }).gc;
    const heapSamples: Array<{ settled: number; heapUsed: number }> = [];
    for (let index = 0; index < count; index++) {
      receiveTerminal(runtime, f.child, `retention-turn-${index}`);
      if (collect && (index + 1) % 5_000 === 0) {
        collect();
        heapSamples.push({
          settled: index + 1,
          heapUsed: process.memoryUsage().heapUsed,
        });
      }
    }
    const state = f.internals().state;
    assert.equal(
      state.runtimeTerminal(
        "retention-thread",
        `retention-turn-${count - 1}`,
        generation,
      )?.firstStatus,
      "completed",
    );
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM runtime_terminal_evidence")
          .get() as {
          count: number;
        }
      ).count,
      count,
    );
    // Turn zero is beyond the 10k settled cohort. Its duplicate remains exact,
    // while an opposite report conflicts durably and retracts its workspace tail.
    receiveTerminal(runtime, f.child, "retention-turn-0", "completed");
    assert.equal(
      state.runtimeTerminal("retention-thread", "retention-turn-0", generation)
        ?.conflicted,
      false,
    );
    receiveTerminal(runtime, f.child, "retention-turn-0", "failed");
    assert.equal(
      state.runtimeTerminal("retention-thread", "retention-turn-0", generation)
        ?.conflicted,
      true,
    );
    assert.equal(state.byWorkId("retention-work-0")?.state, "held");
    assert.equal(state.byWorkId("retention-work-1")?.state, "held");
    assert.equal(
      state.byWorkId("retention-work-2")?.state,
      "completed",
      "retraction is limited to the conflicted workspace tail",
    );
    await assert.rejects(
      runtime.waitForTurn("retention-thread", "retention-turn-0"),
      /uncertain/,
    );
    assert.equal(
      runtime.failureEvidence("retention-thread", "retention-turn-0"),
      undefined,
      "conflicted durable failure evidence cannot authorize a retry",
    );
    assertSettledRuntimeCounts(f);

    const terminalPlan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT firstStatus FROM runtime_terminal_evidence
        WHERE threadId = ? AND turnId = ?`)
      .all("retention-thread", "retention-turn-0") as Array<{
      detail: string;
    }>;
    const terminalLookups = timeIterations(1_000, (index) => {
      assert.ok(
        state.runtimeTerminal(
          "retention-thread",
          `retention-turn-${index + 1}`,
          generation,
        ),
      );
    });
    const terminalStorage = db
      .prepare(`SELECT COUNT(*) AS count, SUM(
        LENGTH(CAST(threadId AS BLOB)) + LENGTH(CAST(turnId AS BLOB)) +
        LENGTH(CAST(COALESCE(firstStatus, '') AS BLOB)) +
        LENGTH(CAST(COALESCE(workId, '') AS BLOB)) +
        LENGTH(CAST(COALESCE(firstRuntimeGeneration, '') AS BLOB)) +
        LENGTH(CAST(COALESCE(lastRuntimeGeneration, '') AS BLOB))
      ) AS utf8Bytes FROM runtime_terminal_evidence`)
      .get() as { count: number; utf8Bytes: number };
    console.log(
      `runtime-retention-terminal ${JSON.stringify({
        fixture: "actual-codex-runtime-receive-real-service-real-sqlite",
        rows: count,
        durableTerminalEvidence: terminalStorage,
        explicitGcAvailable: Boolean(collect),
        heapSamples,
        terminalLookup: terminalLookups,
        settledCollections: runtimeCollectionSizes(f),
        queryPlan: terminalPlan.map((row) => row.detail),
        conflict: {
          turnZero: state.runtimeTerminal(
            "retention-thread",
            "retention-turn-0",
            generation,
          ),
          writer: state.byWorkId("retention-work-0")?.state,
          workspaceSuccessor: state.byWorkId("retention-work-1")?.state,
          unrelated: state.byWorkId("retention-work-2")?.state,
        },
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test("unbound failed terminals retain exact retry facts only in durable evidence", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-failure-retention-"),
  );
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const runtime = f.runtime();
    const db = f.internals().db;
    const count = 1_024;
    for (let index = 0; index < count; index++)
      receiveTerminal(
        runtime,
        f.child,
        `unbound-failure-${index}`,
        "failed",
        "unbound-failure-thread",
        "serverOverloaded",
      );

    const unbound = f
      .internals()
      .state.runtimeTerminal(
        "unbound-failure-thread",
        "unbound-failure-0",
        generation,
      );
    assert.equal(unbound?.firstStatus, "failed");
    assert.equal(unbound?.failure?.classification, "transient");
    assert.equal(unbound?.workId, null);
    assert.equal(
      runtime.failureEvidence("unbound-failure-thread", "unbound-failure-0"),
      undefined,
      "an unbound receipt has no retry authority",
    );
    assert.equal(runtimeCollectionSizes(f).failureEvidenceCache.count, 0);

    const task = createTask(f.service);
    const early = {
      threadId: "retention-early-failure-thread",
      turnId: "retention-early-failure-turn",
    };
    receiveTerminal(
      runtime,
      f.child,
      early.turnId,
      "failed",
      early.threadId,
      "serverOverloaded",
    );
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId),
      undefined,
    );
    const bound = createNativeWork(f, task, 50_000, {
      ...early,
      workId: "retention-early-failure-work",
    });
    assert.equal(bound.workId, "retention-early-failure-work");
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId)?.classification,
      "transient",
      "an early failure is classifiable after exact SQLite binding, without an adapter cache",
    );
    receiveTerminal(
      runtime,
      f.child,
      early.turnId,
      "failed",
      early.threadId,
      "unauthorized",
    );
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId)?.reasonCode,
      "serverOverloaded",
      "a same-status duplicate cannot replace first failure facts",
    );
    receiveTerminal(
      runtime,
      f.child,
      early.turnId,
      "completed",
      early.threadId,
    );
    assert.equal(
      runtime.failureEvidence(early.threadId, early.turnId),
      undefined,
    );
    assert.equal(
      f
        .internals()
        .state.runtimeTerminal(early.threadId, early.turnId, generation)
        ?.conflicted,
      true,
    );

    const unknown = {
      threadId: "retention-unknown-failure-thread",
      turnId: "retention-unknown-failure-turn",
    };
    receiveTerminal(
      runtime,
      f.child,
      unknown.turnId,
      "failed",
      unknown.threadId,
      "not-a-codex-error-code",
    );
    createNativeWork(f, task, 50_001, {
      ...unknown,
      workId: "retention-unknown-failure-work",
    });
    assert.deepEqual(
      {
        classification: runtime.failureEvidence(
          unknown.threadId,
          unknown.turnId,
        )?.classification,
        reasonCode: runtime.failureEvidence(unknown.threadId, unknown.turnId)
          ?.reasonCode,
        source: runtime.failureEvidence(unknown.threadId, unknown.turnId)
          ?.source,
      },
      { classification: "unknown", reasonCode: "unknown", source: "missing" },
    );

    const stored = db
      .prepare(`SELECT COUNT(*) AS count,
        SUM(LENGTH(CAST(failureEvidence AS BLOB))) AS failureUtf8Bytes
        FROM runtime_terminal_evidence WHERE threadId = ?`)
      .get("unbound-failure-thread") as {
      count: number;
      failureUtf8Bytes: number;
    };
    assert.equal(stored.count, count);
    assert.ok(stored.failureUtf8Bytes > 0);
    console.log(
      `runtime-retention-failed-terminals ${JSON.stringify({
        fixture: "actual-codex-runtime-receive-real-service-real-sqlite",
        unboundNonconsumerRows: stored,
        adapterFailureEvidenceCache: { count: 0, utf8Bytes: 0 },
        earlyBoundClassification: "transient-first-fact",
        duplicatePreservedFirstFact: true,
        conflictedRetryEvidence: runtime.failureEvidence(
          early.threadId,
          early.turnId,
        ),
        unknownClassification: runtime.failureEvidence(
          unknown.threadId,
          unknown.turnId,
        ),
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test("missing, corrupt, and failed terminal evidence storage never authorizes turn completion", {
  timeout: 20_000,
}, async () => {
  for (const mode of [
    "missing-expected",
    "corrupt-row",
    "write-failure",
  ] as const) {
    const root = mkdtempSync(
      join(tmpdir(), `ensemble-runtime-retention-${mode}-`),
    );
    const f = fixture(root);
    try {
      await f.service.start();
      f.internals().scheduler.stop();
      const task = createTask(f.service);
      const work = createNativeWork(f, task, 30_000);
      const runtime = f.runtime();
      const db = f.internals().db;
      if (mode === "write-failure")
        db.exec(`CREATE TRIGGER reject_terminal_receipt
            BEFORE INSERT ON runtime_terminal_evidence
            BEGIN SELECT RAISE(ABORT, 'injected terminal receipt write failure'); END`);
      const terminalWait = runtime.waitForTurn(work.threadId, work.turnId);
      receiveTerminal(
        runtime,
        f.child,
        work.turnId,
        "completed",
        work.threadId,
      );
      if (mode === "write-failure") {
        await assert.rejects(
          terminalWait,
          /Runtime terminal evidence unavailable/,
        );
      } else {
        assert.equal(await terminalWait, "completed");
        if (mode === "missing-expected")
          db.prepare(
            "DELETE FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
          ).run(work.threadId, work.turnId);
        else {
          db.exec("PRAGMA ignore_check_constraints = ON");
          db.prepare(`UPDATE runtime_terminal_evidence SET firstStatus = 'corrupt'
              WHERE threadId = ? AND turnId = ?`).run(
            work.threadId,
            work.turnId,
          );
          db.exec("PRAGMA ignore_check_constraints = OFF");
          assert.throws(() =>
            f
              .internals()
              .state.runtimeTerminal(work.threadId, work.turnId, generation),
          );
        }
        const failedWait = runtime.waitForTurn(work.threadId, work.turnId);
        receiveTerminal(
          runtime,
          f.child,
          work.turnId,
          "completed",
          work.threadId,
        );
        await assert.rejects(
          failedWait,
          /Runtime terminal evidence unavailable/,
        );
      }
      assert.equal(
        f.internals().state.byWorkId(work.workId)?.state,
        "held",
        `${mode} must retain ownership uncertainty`,
      );
      assert.equal(runtime.currentUserInputGeneration(), undefined);
      assertSettledRuntimeCounts(f);
    } finally {
      await f.service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("legacy bound turns migrate to unknown evidence and cannot complete", {
  timeout: 10_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-retention-legacy-"),
  );
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const task = createTask(f.service);
    const work = createNativeWork(f, task, 40_000);
    const db = f.internals().db;
    db.prepare(
      "DELETE FROM runtime_retention_migrations WHERE migrationId = ?",
    ).run("runtime-retention-v1");
    db.prepare(
      "DELETE FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
    ).run(work.threadId, work.turnId);
    const migratedState = new ExecutionState(db);
    const unknown = migratedState.runtimeTerminal(
      work.threadId,
      work.turnId,
      generation,
    );
    assert.equal(unknown?.firstStatus, null);
    assert.equal(unknown?.conflicted, false);
    assert.equal(unknown?.workId, work.workId);
    await assert.rejects(
      f.runtime().waitForTurn(work.threadId, work.turnId),
      /uncertain/,
    );
    assert.equal(
      f.internals().state.byWorkId(work.workId)?.state,
      "held",
      "legacy intent state cannot be promoted to observed completion",
    );
    receiveTerminal(
      f.runtime(),
      f.child,
      work.turnId,
      "completed",
      work.threadId,
    );
    const afterLateEvent = migratedState.runtimeTerminal(
      work.threadId,
      work.turnId,
      generation,
    );
    assert.equal(afterLateEvent?.firstStatus, null);
    assert.equal(afterLateEvent?.conflicted, true);
    assert.equal(f.internals().state.byWorkId(work.workId)?.state, "held");
    assertSettledRuntimeCounts(f);
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
