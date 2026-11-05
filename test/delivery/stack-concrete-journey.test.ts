import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import { offlineStackResources } from "./github-qualification/stack-offline-resources.js";
import { createRealStackAdapter } from "./github-qualification/stack-real-adapter.js";
import { runRealStackJourney } from "./github-qualification/stack-real-journey.js";

for (const platform of [
  "immediate",
  "delayed",
  "absent",
  "missing-registration",
  "budget-exhausted",
] as const)
  test(`concrete offline stack ${platform} platform rebase uses at most four turns and one reconciliation`, async (t) => {
    const f = await offlineStackResources(
      t,
      true,
      platform === "delayed" || platform === "absent" ? platform : "immediate",
      platform === "budget-exhausted" ? 0 : 256,
    );
    const tracePath = process.env.CAB_OFFLINE_TRACE
      ? `${process.env.CAB_OFFLINE_TRACE}.${platform}.json`
      : undefined;
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = f.fakeLogin;
    const envName = f.credentialRef.slice(4);
    assert.equal(process.env[envName], undefined);
    process.env[envName] = "offline-injected-marker";
    const trace: Array<Record<string, unknown>> = [];
    const taskVersions = () => {
      const db = new DatabaseSync(
        join(
          f.guard.manifest.authority.host.dataDirectory,
          "standalone.sqlite",
        ),
        { readOnly: true },
      );
      try {
        return db
          .prepare("SELECT id,version FROM domain_tasks ORDER BY id")
          .all();
      } finally {
        db.close();
      }
    };
    const stages = new AsyncLocalStorage<string>();
    const stage = () => stages.getStore() ?? "bootstrap";
    let listener!: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
    const turns = new Map<
      string,
      { threadId: string; taskId: string; initial: boolean }
    >();
    const taskTurns = new Map<string, number>();
    const processIdentity = {
      processId: "99999999",
      processStartedAt: "offline-synthetic-no-process",
      bootId: "offline-no-process",
    };
    let stopped = false;
    const runtime: Runtime = {
      start: async () => {},
      stop: async () => {
        stopped = true;
      },
      processIdentity: () => processIdentity,
      onUnexpectedRequest: () => {},
      onToolCall: (handler) => {
        listener = handler;
      },
      startThread: async () => randomUUID(),
      resumeThread: async () => {},
      startTurn: async (threadId, workspace) => {
        const taskId = f.guard.manifest.authority.runtime.find(
          (scope) => scope.workspace === workspace,
        )!.taskId;
        const n = (taskTurns.get(taskId) ?? 0) + 1;
        taskTurns.set(taskId, n);
        const turnId = randomUUID();
        turns.set(turnId, { threadId, taskId, initial: n === 1 });
        trace.push({
          stage: stage(),
          event: "turn",
          taskId,
          turnId,
          ordinal: n,
        });
        return turnId;
      },
      waitForTurn: async (threadId, turnId) => {
        const turn = turns.get(turnId)!;
        const lower = turn.taskId === f.resource.lowerTask;
        const call = async (tool: string, args: Record<string, unknown>) => {
          return stages.run(
            `${turn.initial ? "initial" : "notice"}.${lower ? "lower" : "upper"}.${tool}`,
            async () => {
              const result = await listener({
                threadId,
                turnId,
                callId: randomUUID(),
                tool,
                arguments: args,
              });
              trace.push({
                stage: stage(),
                event: "callback",
                taskVersions: taskVersions(),
                taskId: turn.taskId,
                tool,
                result,
              });
              assert.equal(result.success, true, result.text);
            },
          );
        };
        if (turn.initial && platform !== "missing-registration")
          await call("cab_register_pr", {
            repositoryId: "R1",
            prNumber: lower ? 1 : 2,
            expectedPrNodeId: lower
              ? f.resource.lowerPrId
              : f.resource.upperPrId,
            expectedHeadSha: lower
              ? f.resource.lowerHead
              : f.resource.upperHead,
          });
        await call("cab_report_result", {
          summary: turn.initial
            ? "Existing PR registered"
            : "Provider notice processed",
        });
        return "completed";
      },
      interruptTurn: async () => {},
    };
    try {
      const running = runRealStackJourney({
        authority: f.guard,
        credential: async (reference) => {
          assert.equal(reference, f.credentialRef);
          trace.push({ stage: stage(), event: "credential-resolver" });
          return "offline-injected-marker";
        },
        transport: async (url, init) => {
          trace.push({
            stage: stage(),
            event: "http",
            method: init?.method ?? "GET",
            url: String(url),
            body: String(init?.body ?? ""),
          });
          return f.transport(url, init);
        },
        factory: async (authority, credential, transport) => {
          const adapter = await createRealStackAdapter(
            authority,
            credential,
            transport,
            {
              mode: "offline-only",
              runtime: () => runtime,
              trace: (event) =>
                trace.push({
                  stage: stage(),
                  event: "provider-boundary",
                  ...event,
                }),
              termination: {
                verify: async (identity) => {
                  assert.equal(stopped, true);
                  return {
                    kind: "verified",
                    processIdentity: identity,
                    verifiedAt: new Date().toISOString(),
                    method: "mac-pid-absent-same-boot",
                  };
                },
              },
            },
          );
          return new Proxy(adapter, {
            get(target, property) {
              const value: unknown = Reflect.get(target, property, target);
              if (typeof value !== "function") return value;
              return (...callArgs: unknown[]) => {
                return stages.run(String(property), () => {
                  if (property !== "executions")
                    trace.push({ stage: stage(), event: "adapter-call" });
                  const result: unknown = value.apply(target, callArgs);
                  if (property === "audit")
                    return Promise.resolve(result).then((audit) => {
                      trace.push({
                        stage: stage(),
                        event: "audit",
                        taskVersions: taskVersions(),
                        audit,
                      });
                      return audit;
                    });
                  return result;
                });
              };
            },
          });
        },
      });
      if (
        platform === "missing-registration" ||
        platform === "budget-exhausted"
      ) {
        await assert.rejects(
          running,
          platform === "budget-exhausted"
            ? /v2-budget/
            : /v2-execution-held|initial-registration|v2-authority-closed/,
        );
        const journal = f.guard.snapshot();
        assert.equal(journal.counts.writes, undefined);
        assert.equal(journal.counts["call-total:fixture.merge"], undefined);
        assert.equal(journal.counts["call-total:git.prove"], undefined);
        if (platform === "budget-exhausted") {
          assert.equal(
            trace.filter((event) => event.event === "http").length,
            0,
          );
          assert.equal(
            trace.filter((event) => event.event === "credential-resolver")
              .length,
            0,
          );
          assert.equal(journal.counts.turns, undefined);
        }
        if (tracePath)
          await writeFile(
            tracePath,
            JSON.stringify(
              {
                refused: platform,
                trace,
                journal,
                literalRequests: f.trace,
                offlineOnly: true,
              },
              null,
              2,
            ),
          );
        return;
      }
      const result = await running;
      if (platform === "delayed" || platform === "absent") {
        const waiting = f.providerHeads.filter(
          (value) => value.merged && !value.rebased,
        );
        assert.ok(waiting.length >= 3);
        assert.deepEqual(
          new Set(waiting.map((value) => value.channel)),
          new Set(["rest", "graph", "ref"]),
        );
        assert.ok(
          waiting.every((value) => value.head === f.resource.upperHead),
        );
        if (platform === "absent")
          assert.ok(
            f.providerHeads.every(
              (value) => value.head === f.resource.upperHead,
            ),
          );
        else
          assert.ok(
            f.providerHeads.some(
              (value) => value.rebased && value.head !== f.resource.upperHead,
            ),
          );
      }
      assert.equal(
        result.disposition,
        platform === "absent" ? "held" : "recorded",
      );
      assert.equal(result.mode, "offline-injected");
      assert.equal(result.counts.turns, platform === "absent" ? 2 : 4);
      assert.equal(result.counts.callbacks, platform === "absent" ? 4 : 6);
      assert.equal(
        result.counts["call-total:git.prove"],
        platform === "absent" ? undefined : 1,
      );
      assert.equal(
        result.counts["call-total:service.refresh"],
        platform === "absent" ? undefined : 1,
      );
      assert.equal(
        result.counts["call-total:fixture.observe"],
        platform === "absent" ? 8 : platform === "delayed" ? 2 : 1,
      );
      assert.equal(result.counts["call-total:git.adopt"], undefined);
      assert.equal(result.processExit, true);
      assert.deepEqual(
        [...taskTurns.values()],
        platform === "absent" ? [1, 1] : [2, 2],
      );
      const journal = f.guard.snapshot();
      if (platform === "absent") assert.equal(journal.httpRequests.length, 163); // Persists beyond the obsolete160-entry ceiling.
      assert.equal(
        journal.callbacks.filter((c) => c.tool === "cab_register_pr").length,
        2,
      );
      assert.equal(
        journal.callbacks.every((c) => c.succeeded),
        true,
      );
      const db = new DatabaseSync(
        join(
          f.guard.manifest.authority.host.dataDirectory,
          "standalone.sqlite",
        ),
        { readOnly: true },
      );
      try {
        assert.deepEqual(
          db
            .prepare("SELECT DISTINCT version FROM domain_assignments")
            .all()
            .map((r) => r.version),
          [1],
        );
        assert.deepEqual(
          f.guard.manifest.authority.runtime
            .map((scope) => scope.taskVersions[0])
            .sort(),
          [3, 4],
        );
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS n FROM delivery_waiting_work WHERE workId LIKE 'assignment:%:initial'",
            )
            .get()!.n,
          2,
        );
      } finally {
        db.close();
      }
      const audits = trace.filter((event) => event.event === "audit");
      assert.equal(
        (audits.at(-1)!.audit as { unfinished: number }).unfinished,
        0,
      );
      const accesses = trace.filter(
        (event) => event.kind === "credential-access",
      );
      assert.equal(accesses.length, result.counts.credentialCallbacks);
      assert.equal(
        accesses.filter((event) => event.channel === "direct-git").length,
        platform === "absent" ? 0 : 1,
      );
      assert.equal(
        trace.filter((event) => event.kind === "provider-created").length,
        platform === "absent" ? 5 : 7,
      );
      const summary = {
        result,
        trace,
        journal,
        literalRequests: f.trace,
        providerHeads: f.providerHeads,
        preparationRequests: f.preparationTrace,
        offlineOnly: true,
        actualNetworkRequests: 0,
        actualCredentials: 0,
        actualRuntimeProcesses: 0,
      };
      if (tracePath)
        await writeFile(tracePath, JSON.stringify(summary, null, 2));
      t.diagnostic(
        JSON.stringify({
          reads: result.counts.reads,
          writes: result.counts.writes,
          credentialAccesses: result.counts.credentialCallbacks,
          providers: result.counts.credentials,
          turns: result.counts.turns,
          callbacks: result.counts.callbacks,
          trace: tracePath ?? "not-exported",
        }),
      );
    } catch (error) {
      {
        const db = new DatabaseSync(
          join(
            f.guard.manifest.authority.host.dataDirectory,
            "standalone.sqlite",
          ),
          { readOnly: true },
        );
        try {
          t.diagnostic(
            JSON.stringify({
              bindings: db
                .prepare("SELECT recordJson FROM delivery_pr_bindings")
                .all(),
              policies: db
                .prepare("SELECT policyJson FROM delivery_policies")
                .all(),
              executions: db
                .prepare("SELECT workId,state,reason FROM execution_intents")
                .all(),
            }),
          );
        } finally {
          db.close();
        }
      }
      if (tracePath)
        await writeFile(
          tracePath,
          JSON.stringify(
            {
              error: String(error),
              trace,
              journal: f.guard.snapshot(),
              literalRequests: f.trace,
              preparedSummary: f.preparedSummary,
            },
            null,
            2,
          ),
        );
      throw error;
    } finally {
      await f.guard.close();
      delete process.env[envName];
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
