import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "../fixtures/temp.js";
import { test } from "node:test";
import { nativeEndpointKey } from "../../src/core/structured-questions.js";
import type { NativeInputEndpointIdentity } from "../../src/core/structured-questions.js";
import {
  assertSettledRuntimeCounts,
  createNativeWork,
  createTask,
  fixture,
  generation,
  nativeRequest,
  receiveTerminal,
  runtimeCollectionSizes,
  settledRuntimeCounts,
  timeIterations,
  until,
  type RuntimeInternals,
} from "../fixtures/runtime-retention.js";

test("production service settles 2,000 native waiters and callbacks with SQLite authority", {
  timeout: 180_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-retention-native-"),
  );
  const f = fixture(root);
  let serviceToStop = f.service;
  let waitingTurn:
    | {
        threadId: string;
        turnId: string;
        result: Promise<"completed" | "failed">;
      }
    | undefined;
  try {
    await f.service.start();
    f.internals().scheduler.stop();
    const task = createTask(f.service);
    const runtime = f.runtime() as unknown as RuntimeInternals;
    const coordination = f.internals().coordination;
    const count = 2_000;
    const cohortSize = 250;
    const cohorts: Array<{ settled: number; elapsedMs: number }> = [];
    const collect = (globalThis as unknown as { gc?: () => void }).gc;
    const heapSamples: Array<{ settled: number; heapUsed: number }> = [];
    const started = process.hrtime.bigint();
    let activePins:
      | {
          rawRequestBytes: number;
          endpoints: number;
          endpointTurnIndexes: number;
          endpointRpcIndexes: number;
          readbacks: number;
          nativeTurns: number;
          threadSnapshots: number;
          serviceWaiters: number;
          callbackWorkItems: number;
          callbacks: number;
        }
      | undefined;
    let activeCollections:
      | ReturnType<typeof runtimeCollectionSizes>
      | undefined;
    for (let index = 0; index < count; index++) {
      const work = createNativeWork(f, task, index);
      const requestId = index + 1;
      const itemId = `retention-native-item-${index}`;
      const request = nativeRequest(work.threadId, work.turnId, itemId);
      const identity: NativeInputEndpointIdentity = {
        requestId,
        runtimeGeneration: generation,
        threadId: work.threadId,
        turnId: work.turnId,
        itemId,
      };
      const endpointKey = nativeEndpointKey(identity);
      f.associateRequest(requestId, work.threadId, identity);
      runtime.receive(
        f.child,
        JSON.stringify({
          id: requestId,
          method: "item/tool/requestUserInput",
          params: request,
        }),
      );
      await until(
        () => Boolean(coordination.runtimeQuestionByEndpoint(identity)),
        `durable native question ${index}`,
      );
      const question = coordination.runtimeQuestionByEndpoint(identity);
      assert.ok(question);
      assert.ok(f.internals().nativeWaiters.has(endpointKey));
      assert.equal(f.internals().callbacks.get(work.workId)?.size, 1);
      if (index === 0) {
        activeCollections = runtimeCollectionSizes(f);
        activePins = {
          rawRequestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
          endpoints: runtime.nativeEndpoints.size,
          endpointTurnIndexes: runtime.nativeEndpointsByTurn.size,
          endpointRpcIndexes: runtime.nativeEndpointsByRpcId.size,
          readbacks: runtime.nativeReadbacks.size,
          nativeTurns: runtime.nativeTurns.size,
          threadSnapshots: runtime.threadSnapshots.size,
          serviceWaiters: f.internals().nativeWaiters.size,
          callbackWorkItems: f.internals().callbacks.size,
          callbacks: [...f.internals().callbacks.values()].reduce(
            (sum, entries) => sum + entries.size,
            0,
          ),
        };
        assert.ok(activePins.rawRequestBytes > 0);
        for (const key of [
          "endpoints",
          "endpointTurnIndexes",
          "endpointRpcIndexes",
          "readbacks",
          "nativeTurns",
          "threadSnapshots",
          "serviceWaiters",
          "callbackWorkItems",
          "callbacks",
        ] as const)
          assert.equal(
            activePins[key],
            1,
            `${key} remains pinned while awaiting the operator`,
          );
      }

      await f.service.coordinationView().answerRuntimeQuestion({
        taskId: task.taskId,
        key: randomUUID(),
        interactionId: question.interactionId,
        expectedRevision: question.revision,
        answers: { q: { answers: ["A"] } },
      });
      await until(() => {
        const current = coordination.runtimeQuestionByEndpoint(identity);
        return (
          current?.deliveryState === "confirmed" &&
          !f.internals().nativeWaiters.has(endpointKey) &&
          !f.internals().callbacks.has(work.workId)
        );
      }, `confirmed reply and callback retirement ${index}`);
      const saved = coordination.runtimeQuestionByEndpoint(identity);
      assert.equal(saved?.deliveryState, "confirmed");
      assert.ok(saved?.replyIntentId);

      const turnResult = f.runtime().waitForTurn(work.threadId, work.turnId);
      waitingTurn = {
        threadId: work.threadId,
        turnId: work.turnId,
        result: turnResult,
      };
      receiveTerminal(
        f.runtime(),
        f.child,
        work.turnId,
        "completed",
        work.threadId,
      );
      assert.equal(await turnResult, "completed");
      waitingTurn = undefined;
      f.internals().state.complete(work.intent.id, work.threadId, work.turnId);

      if ((index + 1) % cohortSize === 0) {
        assertSettledRuntimeCounts(f);
        const settled = index + 1;
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        cohorts.push({ settled, elapsedMs });
        const questionCount = (
          f
            .internals()
            .db.prepare(
              "SELECT COUNT(*) AS count FROM coordination_runtime_questions",
            )
            .get() as { count: number }
        ).count;
        assert.equal(questionCount, settled);
        if (collect && settled % 1_000 === 0) {
          collect();
          heapSamples.push({
            settled,
            heapUsed: process.memoryUsage().heapUsed,
          });
        }
      }
    }

    const db = f.internals().db;
    const replyRows = db
      .prepare(
        "SELECT replyIntentId, deliveryState FROM coordination_runtime_questions",
      )
      .all() as Array<{
      replyIntentId: string | null;
      deliveryState: string;
    }>;
    assert.equal(replyRows.length, count);
    assert.ok(
      replyRows.every(
        (row) => row.replyIntentId && row.deliveryState === "confirmed",
      ),
    );
    assert.equal(
      new Set(replyRows.map((row) => row.replyIntentId)).size,
      count,
    );
    assert.deepEqual(f.writeIntentEvidence(), {
      observations: count,
      violations: 0,
    });
    assertSettledRuntimeCounts(f);
    const questionRows = db
      .prepare(`SELECT identityJson, requestJson, qualificationJson, answerJson,
          answerDigest, replyIntentId FROM coordination_runtime_questions ORDER BY rowid`)
      .all() as Array<Record<string, string | null>>;
    const durableQuestionBytes = questionRows.reduce(
      (sum, row) =>
        sum +
        Object.values(row).reduce(
          (bytes, value) =>
            bytes + (value ? Buffer.byteLength(value, "utf8") : 0),
          0,
        ),
      0,
    );
    const durableQualification = f
      .internals()
      .db.prepare(`SELECT COUNT(*) AS count, SUM(
          LENGTH(CAST(threadId AS BLOB)) + LENGTH(CAST(COALESCE(toolDigest, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(codexVersion, '') AS BLOB)) + LENGTH(CAST(COALESCE(executableHash, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(model, '') AS BLOB)) + LENGTH(CAST(COALESCE(modelProvider, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(reasoningEffort, '') AS BLOB)) + LENGTH(CAST(COALESCE(serviceTier, '') AS BLOB)) +
          LENGTH(CAST(COALESCE(developerInstructionsDigest, '') AS BLOB))
        ) AS utf8Bytes FROM runtime_thread_qualification`)
      .get() as { count: number; utf8Bytes: number };
    const terminalLookups = timeIterations(1_000, (index) => {
      assert.ok(
        f
          .internals()
          .state.runtimeTerminal(
            `retention-native-thread-${index + 1}`,
            `retention-native-turn-${index + 1}`,
            generation,
          ),
      );
    });
    const nativeLookups = timeIterations(1_000, (index) => {
      const identity: NativeInputEndpointIdentity = {
        requestId: index + 1,
        runtimeGeneration: generation,
        threadId: `retention-native-thread-${index}`,
        turnId: `retention-native-turn-${index}`,
        itemId: `retention-native-item-${index}`,
      };
      assert.ok(coordination.runtimeQuestionByEndpoint(identity));
    });
    const directCancellation = timeIterations(1_000, (index) => {
      runtime.cancelUserInput(
        {
          requestId: index + 1,
          runtimeGeneration: generation,
          threadId: `retention-native-thread-${index + 1}`,
          turnId: `retention-native-turn-${index + 1}`,
          itemId: `retention-native-item-${index + 1}`,
        },
        "retention lookup of settled endpoint",
      );
    });
    const nativePlan = f
      .internals()
      .db.prepare(`EXPLAIN QUERY PLAN SELECT interactionId FROM coordination_runtime_questions
          WHERE endpointKey = ?`)
      .all(
        nativeEndpointKey({
          requestId: 1,
          runtimeGeneration: generation,
          threadId: "retention-native-thread-0",
          turnId: "retention-native-turn-0",
          itemId: "retention-native-item-0",
        }),
      ) as Array<{ detail: string }>;
    const terminalPlan = f
      .internals()
      .db.prepare(`EXPLAIN QUERY PLAN SELECT firstStatus FROM runtime_terminal_evidence
          WHERE threadId = ? AND turnId = ?`)
      .all("retention-native-thread-0", "retention-native-turn-0") as Array<{
      detail: string;
    }>;

    await f.service.stop();
    const reopened = fixture(root, "retention-generation-restarted");
    serviceToStop = reopened.service;
    await reopened.service.start();
    const firstIdentity: NativeInputEndpointIdentity = {
      requestId: 1,
      runtimeGeneration: generation,
      threadId: "retention-native-thread-0",
      turnId: "retention-native-turn-0",
      itemId: "retention-native-item-0",
    };
    assert.equal(
      reopened.internals().coordination.runtimeQuestionByEndpoint(firstIdentity)
        ?.deliveryState,
      "confirmed",
      "confirmed durable answer survives a production service restart",
    );
    assert.equal(
      reopened.runtime().currentUserInputGeneration(),
      "retention-generation-restarted",
    );
    assert.equal(
      reopened
        .internals()
        .state.runtimeTerminal(
          "retention-native-thread-0",
          "retention-native-turn-0",
          generation,
        )?.firstStatus,
      "completed",
    );
    assertSettledRuntimeCounts(reopened);
    assert.ok(activePins);
    console.log(
      `runtime-retention-native ${JSON.stringify({
        fixture: "synthetic-child-injected-receive-real-service-real-sqlite",
        count,
        cohortSize,
        cohorts,
        explicitGcAvailable: Boolean(collect),
        heapSamples,
        activePins,
        activeCollections,
        settledCollections: runtimeCollectionSizes(reopened),
        settledRuntime: settledRuntimeCounts(reopened),
        durableRows: questionRows.length,
        durableQuestionBytes,
        durableQualification,
        measurementHarness: {
          questionRowsMaterialized: questionRows.length,
          questionPayloadBytes: durableQuestionBytes,
          timingSamplesPerOperation: 1_000,
          timingSampleStoragePeak: 1_000,
        },
        terminalLookup: terminalLookups,
        nativeLookup: nativeLookups,
        settledDirectCancellationLookup: directCancellation,
        queryPlans: {
          terminal: terminalPlan.map((row) => row.detail),
          nativeEndpoint: nativePlan.map((row) => row.detail),
        },
        runtime: {
          version: process.version,
          platform: process.platform,
          architecture: process.arch,
        },
        restart: {
          generationChanged: true,
          confirmedQuestionStayedConfirmed: true,
          oldTerminalRemainedReadable: true,
        },
        writeIntentEvidence: f.writeIntentEvidence(),
      })}`,
    );
  } finally {
    if (waitingTurn) {
      receiveTerminal(
        f.runtime(),
        f.child,
        waitingTurn.turnId,
        "completed",
        waitingTurn.threadId,
      );
      await Promise.race([
        waitingTurn.result,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Timed out settling fixture turn")),
            2_000,
          ),
        ),
      ]).catch(() => {});
    }
    await serviceToStop.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test("changed or missing legacy native qualification facts stay unqualified", {
  timeout: 20_000,
}, async () => {
  for (const mode of [
    "changed-settings",
    "missing-legacy-settings",
    "changed-tools",
  ] as const) {
    const root = mkdtempSync(
      join(tmpdir(), `ensemble-runtime-retention-${mode}-`),
    );
    const f = fixture(root);
    try {
      await f.service.start();
      f.internals().scheduler.stop();
      const task = createTask(f.service);
      const work = createNativeWork(f, task, 20_000);
      const runtime = f.runtime() as unknown as RuntimeInternals;
      if (mode === "changed-settings") f.setResumeModel("different-model");
      if (mode === "missing-legacy-settings") {
        const snapshot = runtime.threadSnapshots.get(work.threadId);
        assert.ok(snapshot);
        runtime.threadSnapshots.set(
          work.threadId,
          snapshot.tools === undefined ? {} : { tools: snapshot.tools },
        );
      }
      if (mode === "changed-tools")
        runtime.threadSnapshots.set(work.threadId, {
          settings: {
            model: "fixture-model",
            modelProvider: "fixture-provider",
            reasoningEffort: null,
            serviceTier: null,
          },
          tools: [
            {
              type: "function",
              name: "changed-tool",
              description: "Changed tool",
              inputSchema: { type: "object" },
            },
          ],
        });
      const identity: NativeInputEndpointIdentity = {
        requestId: 20_000,
        runtimeGeneration: generation,
        threadId: work.threadId,
        turnId: work.turnId,
        itemId: "retention-unqualified-item",
      };
      runtime.receive(
        f.child,
        JSON.stringify({
          id: identity.requestId,
          method: "item/tool/requestUserInput",
          params: nativeRequest(
            identity.threadId,
            identity.turnId,
            identity.itemId,
          ),
        }),
      );
      await until(
        () => f.internals().state.byWorkId(work.workId)?.state === "held",
        `${mode} to fail closed at the service boundary`,
      );
      assert.equal(
        f.internals().coordination.runtimeQuestionByEndpoint(identity),
        undefined,
        `${mode} must not persist a qualified question`,
      );
      assert.equal(f.internals().nativeWaiters.size, 0);
      assert.equal(f.internals().callbacks.size, 0);
      assert.equal(runtime.nativeEndpoints.size, 0);
      receiveTerminal(
        f.runtime(),
        f.child,
        work.turnId,
        "completed",
        work.threadId,
      );
      assertSettledRuntimeCounts(f);
    } finally {
      await f.service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
