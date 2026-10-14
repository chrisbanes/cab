import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PassThrough } from "node:stream";
import { tmpdir } from "../fixtures/temp.js";
import { test } from "node:test";
import {
  fixture,
  receiveTerminal,
  until,
  type RuntimeInternals,
} from "../fixtures/runtime-retention.js";

test("service bounds settled thread snapshots after held bindings and failed turn startup", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-thread-retention-"),
  );
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals()
      .db.prepare(
        "UPDATE scheduler_capacity_limits SET globalLimit = 256 WHERE singleton = 1",
      )
      .run();
    const runtime = f.runtime() as unknown as RuntimeInternals;
    const baselineThread = await f.runtime().startThread(workspace, []);
    await f.runtime().resumeThread(baselineThread, []);
    const baseline = f
      .internals()
      .state.runtimeThreadQualification(baselineThread);
    assert.equal(baseline?.model, "fixture-model");
    f.setTurnStartFailure(true);
    await assert.rejects(
      f
        .runtime()
        .startTurn(baselineThread, workspace, "synthetic failed startup"),
      /Synthetic turn startup failure/,
    );
    f.setTurnStartFailure(false);
    assert.equal(runtime.nativeEndpoints.size, 0);

    const heldBindingWorkId = "retention-held-binding-work";
    let heldBindingThread: string | undefined;
    const originalStartThread = f.runtime().startThread.bind(f.runtime());
    f.runtime().startThread = async (...args) => {
      const threadId = await originalStartThread(...args);
      heldBindingThread = threadId;
      const intent = f.internals().state.byWorkId(heldBindingWorkId);
      assert.ok(intent);
      f.internals().state.hold(
        intent.id,
        "Synthetic hold after thread creation",
      );
      return threadId;
    };
    const heldWorkspace = join(root, "held-binding-workspace");
    mkdirSync(heldWorkspace);
    const heldBinding = await f.service.submit(
      heldBindingWorkId,
      "synthetic held binding",
      heldWorkspace,
    );
    f.runtime().startThread = originalStartThread;
    assert.equal(heldBinding.state, "held");
    assert.ok(heldBindingThread);
    assert.ok(runtime.threadSnapshots.has(heldBindingThread));
    assert.equal(runtime.threadSnapshots.settledStats().pinnedCount, 0);

    f.setTurnStartFailure(true);
    const failedStarts = 140;
    for (let index = 0; index < failedStarts; index++) {
      const failedWorkspace = join(root, `failed-start-workspace-${index}`);
      mkdirSync(failedWorkspace);
      const result = await f.service.submit(
        `retention-failed-start-${index}`,
        "synthetic failed turn start",
        failedWorkspace,
      );
      assert.equal(result.state, "held");
      assert.ok(result.threadId);
      assert.equal(result.turnId, null);
    }
    f.setTurnStartFailure(false);
    assert.deepEqual(f.stageCounts(), {
      threadStarts: failedStarts + 2,
      turnStartRequests: failedStarts + 1,
      successfulTurnStarts: 0,
    });
    const countStats = runtime.threadSnapshots.settledStats();
    assert.ok(countStats.count <= 128);
    assert.ok(countStats.utf8Bytes <= 256 * 1024);
    assert.equal(countStats.pinnedCount, 0);
    assert.equal(runtime.threadSnapshots.has(baselineThread), false);

    const largeThreads: string[] = [];
    const largeTools = (index: number) => [
      {
        type: "function" as const,
        name: `large-retention-tool-${index}`,
        description: "Large synthetic tool schema",
        inputSchema: {
          type: "object",
          description: "x".repeat(60_000),
        },
      },
    ];
    for (let index = 0; index < 5; index++)
      largeThreads.push(
        await f.runtime().startThread(workspace, largeTools(index)),
      );
    const byteStats = runtime.threadSnapshots.settledStats();
    assert.ok(byteStats.count < 128);
    assert.ok(byteStats.utf8Bytes <= 256 * 1024);
    assert.equal(byteStats.pinnedCount, 0);
    assert.equal(runtime.threadSnapshots.has(largeThreads[0]!), false);

    const activeThread = await f.runtime().startThread(workspace, []);
    const activeTurn = await f
      .runtime()
      .startTurn(activeThread, workspace, "synthetic active turn");
    assert.ok(runtime.threadSnapshots.has(activeThread));
    assert.equal(runtime.threadSnapshots.settledStats().pinnedCount, 1);
    await f.runtime().startThread(workspace, largeTools(6));
    const pinnedStats = runtime.threadSnapshots.settledStats();
    assert.ok(pinnedStats.count <= 128);
    assert.ok(pinnedStats.utf8Bytes <= 256 * 1024);
    assert.equal(pinnedStats.pinnedCount, 1);
    assert.ok(runtime.threadSnapshots.has(activeThread));
    receiveTerminal(
      f.runtime(),
      f.child,
      activeTurn,
      "completed",
      activeThread,
    );
    assert.equal(runtime.threadSnapshots.has(activeThread), false);
    assert.equal(runtime.threadSnapshots.settledStats().pinnedCount, 0);

    assert.equal(
      f.internals().state.runtimeThreadQualification(baselineThread)?.model,
      "fixture-model",
      "eviction preserves the exact durable first qualification",
    );
    await f.runtime().resumeThread(baselineThread, []);
    assert.equal(
      f.internals().state.runtimeThreadQualification(baselineThread)?.model,
      "fixture-model",
      "a matching resumed thread retains its exact durable first facts",
    );
    f.setResumeModel("different-model");
    await f.runtime().resumeThread(baselineThread, []);
    assert.equal(runtime.nativeEndpoints.size, 0);
    assert.equal(
      f.internals().state.runtimeThreadQualification(baselineThread)?.model,
      "fixture-model",
      "a changed current readback cannot overwrite the durable first settings",
    );

    console.log(
      `runtime-retention-thread-snapshots ${JSON.stringify({
        fixture: "production-codex-runtime-and-standalone-service-real-sqlite",
        heldBindingSnapshot: {
          created: true,
          pinnedAfterHold: false,
          retainedBeforeChurn: true,
        },
        failedTurnStartupCohort: failedStarts,
        afterCountChurn: countStats,
        afterByteChurn: byteStats,
        activeTurnPinDuringChurn: pinnedStats,
        nativeQualificationAfterEvictedSnapshot: "exact durable prior matched",
        changedReadback: "withheld without overwriting first facts",
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test("successful resumes do not retain unused native qualifications", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-resume-qualification-retention-"),
  );
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const f = fixture(root);
  try {
    await f.service.start();
    const runtime = f.runtime() as unknown as RuntimeInternals;
    const qualificationCount = 140;
    let durableFacts = 0;
    for (let index = 0; index < qualificationCount; index++) {
      const tools = [
        {
          type: "function" as const,
          name: `retention-resume-tool-${index}`,
          description: `Tool snapshot ${index}`,
          inputSchema: {
            type: "object",
            properties: { index: { type: "number" } },
          },
        },
      ];
      const threadId = await f.runtime().startThread(workspace, tools);
      await f.runtime().resumeThread(threadId, tools);
      const prior = f.internals().state.runtimeThreadQualification(threadId);
      assert.equal(prior?.model, "fixture-model");
      assert.equal(
        prior?.toolDigest,
        createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
      );
      durableFacts++;
    }

    const stats = runtime.threadSnapshots.settledStats();
    assert.equal(durableFacts, qualificationCount);
    assert.ok(stats.count <= 128);
    assert.ok(stats.utf8Bytes <= 256 * 1024);
    assert.equal(stats.pinnedCount, 0);
    assert.equal(runtime.nativeEndpoints.size, 0);
    assert.equal(runtime.nativeTurns.size, 0);
    assert.equal(runtime.nativeReadbacks.size, 0);
    assert.equal(
      Object.hasOwn(runtime, "nativeQualifications"),
      false,
      "validated resume facts are returned to their immediate consumer, not retained by thread",
    );
    const stored = f
      .internals()
      .db.prepare("SELECT COUNT(*) AS count FROM runtime_thread_qualification")
      .get() as { count: number };
    assert.equal(stored.count, qualificationCount);
    assert.deepEqual(f.stageCounts(), {
      threadStarts: qualificationCount,
      turnStartRequests: 0,
      successfulTurnStarts: 0,
    });
    console.log(
      `runtime-retention-unused-resume-qualifications ${JSON.stringify({
        fixture: "production-codex-adapter-and-standalone-service-real-sqlite",
        successfulThreadStartsAndResumes: qualificationCount,
        durableFirstFactsPreserved: durableFacts,
        turnsStarted: 0,
        nativeEndpoints: runtime.nativeEndpoints.size,
        threadSnapshotCache: stats,
        unownedQualificationMap: false,
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
test("service trims settled snapshots as concurrent failed turn-start owners release", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-thread-release-retention-"),
  );
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(workspaceRoot);
  const f = fixture(root);
  try {
    await f.service.start();
    f.internals()
      .db.prepare(
        "UPDATE scheduler_capacity_limits SET globalLimit = 256 WHERE singleton = 1",
      )
      .run();

    const runtime = f.runtime();
    const internals = runtime as unknown as RuntimeInternals;
    const productionRequest = (
      Object.getPrototypeOf(runtime) as {
        request: RuntimeInternals["request"];
      }
    ).request.bind(runtime);
    internals.request = productionRequest;

    const pendingTurnStarts: Array<{
      id: number | string;
      threadId: string;
    }> = [];
    let threadStartCount = 0;
    const threadStartResult = (threadId: string) => ({
      thread: { id: threadId },
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite" },
      model: "fixture-model",
      modelProvider: "fixture-provider",
      reasoningEffort: null,
      serviceTier: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: "fixture-model",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
    const stdin = f.child.stdin as unknown as PassThrough;
    stdin.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === "function") as
        | ((error: Error | null) => void)
        | undefined;
      const message = JSON.parse(String(chunk)) as {
        id?: number | string;
        method?: string;
        params?: { threadId?: string };
      };
      if (message.id !== undefined && message.method === "thread/start") {
        const threadId = `retention-release-thread-${threadStartCount++}`;
        queueMicrotask(() =>
          internals.receive(
            f.child,
            JSON.stringify({
              id: message.id,
              result: threadStartResult(threadId),
            }),
          ),
        );
      } else if (
        message.id !== undefined &&
        message.method === "turn/start" &&
        message.params?.threadId
      ) {
        pendingTurnStarts.push({
          id: message.id,
          threadId: message.params.threadId,
        });
      }
      queueMicrotask(() => callback?.(null));
      return true;
    }) as typeof stdin.write;

    const largeTools = (index: number) => [
      {
        type: "function" as const,
        name: `release-retention-tool-${index}`,
        description: "Large synthetic tool schema",
        inputSchema: {
          type: "object",
          description: "x".repeat(100_000),
        },
      },
    ];
    const originalStartThread = runtime.startThread.bind(runtime);
    let toolSet = 0;
    runtime.startThread = async (workspace) =>
      originalStartThread(workspace, largeTools(toolSet++));

    const submissions = Array.from({ length: 4 }, (_, index) => {
      const workspace = join(workspaceRoot, String(index));
      mkdirSync(workspace);
      return f.service.submit(
        `retention-release-failed-start-${index}`,
        "synthetic concurrent turn startup",
        workspace,
      );
    });
    await until(
      () => pendingTurnStarts.length === 4,
      "four pending production turn/start requests",
    );

    const activeStats = internals.threadSnapshots.settledStats();
    assert.equal(activeStats.pinnedCount, 4);
    assert.ok(activeStats.pinnedUtf8Bytes > 256 * 1024);
    for (const pending of pendingTurnStarts)
      assert.ok(internals.threadSnapshots.has(pending.threadId));

    for (const pending of pendingTurnStarts)
      internals.receive(
        f.child,
        JSON.stringify({
          id: pending.id,
          error: { code: -32000, message: "Synthetic turn startup failure" },
        }),
      );
    const results = await Promise.all(submissions);

    assert.equal(threadStartCount, 4);
    assert.equal(pendingTurnStarts.length, 4);
    assert.equal(internals.pending.size, 0);
    assert.ok(results.every((result) => result.state === "held"));
    assert.ok(results.every((result) => result.turnId === null));
    const releasedStats = internals.threadSnapshots.settledStats();
    assert.ok(releasedStats.count <= 128);
    assert.ok(releasedStats.utf8Bytes <= 256 * 1024);
    assert.equal(releasedStats.pinnedCount, 0);
    console.log(
      `runtime-retention-thread-pin-release ${JSON.stringify({
        fixture:
          "production-runtime-rpc-response-and-standalone-service-real-sqlite",
        concurrentFailedTurnStarts: pendingTurnStarts.length,
        activeOwners: activeStats,
        ownersReleasedWithoutFurtherInsertion: true,
        serviceStates: results.map((result) => result.state),
        nativeQualificationAuthority:
          "none; held submissions have no endpoint or turn",
        afterRelease: releasedStats,
      })}`,
    );
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
