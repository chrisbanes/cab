import type { RuntimeSafetyPort } from "../../src/standalone/runtime-retention.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeTemporaryBase } from "../../src/standalone/claude.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { coordinationFixture } from "../fixtures/coordination.js";

const contract = () =>
  import(
    pathToFileURL(
      resolve(
        "test/execution/workspace-environment-qualification/runtime-contract.mjs",
      ),
    ).href
  );
const fakeGrant = () => ({
  schema: "cab.workspace-environment-grant/v1",
  grantId: randomUUID(),
  planDigest:
    "5d2a4fa84fc5ecab2a0d0e8f27181e43dc10aefa7ca8e4ddfeefa72dda81a245",
  auth: "native-disposable-homes",
  maxTurns: 8,
  deadlineMs: 900_000,
  expiresAt: Date.now() + 900_000,
  root: "/private/tmp/cab-1727-runtime-FAKE-NOT-AUTHORIZED",
  evidenceDir: resolve(
    ".scratch/issue-1727-evidence/r1/offline-integration/FAKE-NOT-WRITTEN",
  ),
  runtimes: Object.fromEntries(
    ["codex", "claude"].map((harness) => [
      harness,
      {
        binary: `/FAKE-NOT-AUTHORIZED/${harness}`,
        sha256: "0".repeat(64),
        version: "fake",
        model: "fake",
        effort: "low",
        configHome: `/private/tmp/cab-1727-runtime-FAKE-NOT-AUTHORIZED/${harness}-home`,
      },
    ]),
  ),
});

test("missing, invalid, expired or changed grant refuses before runtime initialization or auth access", async () => {
  const { runQualification, grantDigest } = await contract();
  let initialized = 0,
    authReads = 0,
    starts = 0;
  const initialize = async () => {
    initialized++;
    authReads++;
    starts++;
    throw Error("must never initialize");
  };
  const grant = fakeGrant(),
    authorizedDigest = grantDigest(grant);
  for (const input of [
    {},
    { live: true, oneAttempt: true },
    { live: true, oneAttempt: true, grant },
    { live: true, oneAttempt: true, grant, authorizedDigest: "0".repeat(64) },
    {
      live: true,
      oneAttempt: true,
      grant: { ...grant, maxTurns: 9 },
      authorizedDigest,
    },
    {
      live: true,
      oneAttempt: true,
      grant: { ...grant, expiresAt: 0 },
      authorizedDigest: grantDigest({ ...grant, expiresAt: 0 }),
    },
  ])
    await assert.rejects(runQualification(input, { initialize }));
  assert.deepEqual(
    { initialized, authReads, starts },
    { initialized: 0, authReads: 0, starts: 0 },
  );
});

test("measurement checks actual sentinel attribution and deliberately crossed scratch paths fail", async () => {
  const { assertMeasurement } = await contract();
  const expected = { harness: "codex", workspace: "/task-a", nonce: "a" };
  const actual = {
    cwd: "/task-a",
    scratch: "/task-a/scratch",
    tmp: "/task-a/scratch",
    nonce: "a",
    sentinel: "a",
  };
  assert.doesNotThrow(() => assertMeasurement(actual, expected));
  assert.throws(() =>
    assertMeasurement(actual, { ...expected, workspace: "/task-b" }),
  );
  assert.throws(() =>
    assertMeasurement({ ...actual, scratch: "/task-b/scratch" }, expected),
  );
  assert.throws(() =>
    assertMeasurement({ ...actual, sentinel: "b" }, expected),
  );
  const claude = {
    ...actual,
    claudeBase: "/tmp/ens-fixture",
    tmp: "/tmp/ens-fixture/claude-501",
  };
  assert.doesNotThrow(() =>
    assertMeasurement(claude, {
      ...expected,
      harness: "claude",
      claudeBase: "/tmp/ens-fixture",
    }),
  );
  assert.throws(() =>
    assertMeasurement(
      { ...claude, tmp: "/tmp/unowned" },
      { ...expected, harness: "claude", claudeBase: "/tmp/ens-fixture" },
    ),
  );
});

test("finite offline matrix keeps same conversation on moved resume and writes one durable checkpoint before each dispatch", async () => {
  const { runQualification, grantDigest } = await contract();
  const grant = fakeGrant();
  const f = coordinationFixture();
  const snapshots: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  let restarts = 0,
    stopped = 0;
  const io = {
    exists: () => false,
    save: (value: Record<string, unknown>) =>
      snapshots.push(structuredClone(value)),
  };
  try {
    const result = await runQualification(
      {
        live: true,
        oneAttempt: true,
        grant,
        authorizedDigest: grantDigest(grant),
      },
      {
        io,
        initialize: async () => ({
          turn: async (
            record: Record<string, unknown>,
            save: (identity: Record<string, unknown>) => void,
          ) => {
            const before = snapshots.at(-1)!;
            assert.equal(before.turnsUsed, dispatches.length + 1);
            const threadId =
              record.threadId ?? `${record.harness}-${record.phase}`;
            const turnId = randomUUID();
            save({
              threadId,
              turnId,
              runtimeGeneration: "fake-generation",
              intentId: record.workId,
            });
            dispatches.push(structuredClone(record));
            f.state.create(
              String(record.workId),
              "synthetic probe",
              String(record.workspace),
            );
            const workspace = String(record.workspace),
              nonce = String(record.nonce),
              claudeBase = "/tmp/ens-fake";
            return {
              status: "completed",
              claudeBase,
              measurement: {
                cwd: workspace,
                scratch: `${workspace}/scratch`,
                tmp:
                  record.harness === "codex"
                    ? `${workspace}/scratch`
                    : `${claudeBase}/claude-501`,
                claudeBase,
                nonce,
                sentinel: nonce,
              },
            };
          },
          restart: async () => {
            restarts++;
            f.reopen();
          },
          reconcile: async () => {
            throw Error("not expected");
          },
          stop: async () => {
            stopped++;
            return "fake-stopped";
          },
        }),
      },
    );
    assert.equal(result.pass, true);
    assert.equal(result.turnsUsed, 8);
    assert.equal(result.remainingTurns, 0);
    assert.equal(restarts, 2);
    assert.equal(stopped, 1);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM execution_intents WHERE prompt='synthetic probe'",
        )
        .get()?.n,
      8,
    );
    for (const harness of ["codex", "claude"]) {
      const turns = dispatches.filter((record) => record.harness === harness);
      assert.equal(turns.length, 4);
      assert.equal(turns[0]!.threadId, turns[2]!.threadId);
      assert.equal(turns[0]!.threadId, turns[3]!.threadId);
      assert.notEqual(turns[0]!.workspace, turns[3]!.workspace);
    }
    await assert.rejects(
      runQualification(
        {
          live: true,
          oneAttempt: true,
          grant,
          authorizedDigest: grantDigest(grant),
        },
        {
          io: { exists: () => true, save: () => {} },
          initialize: async () => {
            throw Error("no redispatch");
          },
        },
      ),
      /already exists/,
    );
  } finally {
    f.close();
  }
});

test("failed asynchronous dispatch retains consumed allowance, exact identity and unknown ownership without stop or redispatch", async () => {
  const { runQualification, grantDigest } = await contract();
  const grant = fakeGrant();
  let dispatches = 0,
    stops = 0,
    reads = 0;
  const snapshots: Array<Record<string, unknown>> = [];
  const result = await runQualification(
    {
      live: true,
      oneAttempt: true,
      grant,
      authorizedDigest: grantDigest(grant),
    },
    {
      io: {
        exists: () => false,
        save: (value: Record<string, unknown>) =>
          snapshots.push(structuredClone(value)),
      },
      initialize: async () => ({
        turn: async (
          _record: unknown,
          save: (identity: Record<string, unknown>) => void,
        ) => {
          dispatches++;
          save({
            threadId: "thread-held",
            turnId: "turn-held",
            intentId: "work-held",
            runtimeGeneration: "generation-held",
            state: "running",
          });
          await Promise.resolve();
          throw Error("injected assertion while execution remains active");
        },
        restart: async () => {
          throw Error("no restart");
        },
        reconcile: async (
          record: Record<string, unknown>,
          bound: { maxReads: number },
        ) => {
          reads++;
          assert.equal(record.turnId, "turn-held");
          assert.equal(bound.maxReads, 12);
          return false;
        },
        stop: async () => {
          stops++;
          return "unsafe-stop";
        },
      }),
    },
  );
  assert.equal(result.pass, false);
  assert.equal(result.settlement, "unknown");
  assert.equal(result.turnsUsed, 1);
  assert.equal(result.remainingTurns, 7);
  assert.equal(dispatches, 1);
  assert.equal(reads, 1);
  assert.equal(stops, 0);
  assert.equal(result.active.threadId, "thread-held");
  assert.equal(snapshots.at(-1)!.remainingTurns, 7);
});

test("production qualification bookkeeping persists exact admitted work and terminal identities across offline runtime restart", async () => {
  const { runQualification, grantDigest, initializeProduction } =
    await contract();
  const root = mkdtempSync("/private/tmp/cab-1727-runtime-offline-");
  const evidenceParent = process.env.CAB_TEST_EVIDENCE_DIR ?? root;
  mkdirSync(evidenceParent, { recursive: true, mode: 0o700 });
  const evidenceDir = join(
    evidenceParent,
    `workspace-environment-${process.pid}-${Date.now()}`,
  );
  mkdirSync(evidenceDir, { mode: 0o700 });
  const grant = { ...fakeGrant(), root, evidenceDir };
  let terminalWrites = 0;
  try {
    for (const harness of ["codex", "claude"]) {
      const configHome = join(root, `${harness}-home`),
        binary = join(root, `${harness}-FAKE`);
      mkdirSync(configHome, { mode: 0o700 });
      writeFileSync(binary, "offline fixture only");
      grant.runtimes[harness] = {
        ...grant.runtimes[harness]!,
        configHome,
        binary,
        sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      };
    }
    const result = await runQualification(
      {
        live: true,
        oneAttempt: true,
        grant,
        authorizedDigest: grantDigest(grant),
      },
      {
        initialize: (approved: unknown) =>
          initializeProduction(approved, {
            createRuntime: ({
              harness,
              safety,
            }: {
              harness: string;
              safety: RuntimeSafetyPort;
            }) => ({
              async start() {},
              async stop() {},
              onUnexpectedRequest() {},
              onToolCall() {},
              async startThread() {
                const threadId = randomUUID();
                safety.registerThreadTools!(
                  threadId,
                  createHash("sha256").update("[]").digest("hex"),
                );
                return threadId;
              },
              async resumeThread() {},
              currentUserInputGeneration() {
                return "offline-generation";
              },
              async startTurn(
                threadId: string,
                workspace: string,
                prompt: string,
                settings: { scratchDirectory: string },
              ) {
                const nonce = JSON.parse(
                  /const n=("[^";]+")/.exec(prompt)![1]!,
                );
                const turnId = randomUUID(),
                  claudeBase = claudeTemporaryBase(workspace);
                writeFileSync(
                  join(workspace, "observation.json"),
                  JSON.stringify({
                    cwd: workspace,
                    scratch: settings.scratchDirectory,
                    tmp:
                      harness === "codex"
                        ? settings.scratchDirectory
                        : `${claudeBase}/claude-501`,
                    claudeBase,
                    nonce,
                    sentinel: nonce,
                  }),
                );
                setImmediate(() => {
                  terminalWrites++;
                  safety.recordTerminal!({
                    threadId,
                    turnId,
                    status: "completed",
                    runtimeGeneration: "offline-generation",
                  });
                });
                return turnId;
              },
              async waitForTurn(threadId: string, turnId: string) {
                for (let i = 0; i < 100; i++) {
                  const evidence = safety.terminal!(
                    threadId,
                    turnId,
                    "offline-generation",
                  );
                  if (evidence?.firstStatus) return evidence.firstStatus;
                  await new Promise((ready) => setImmediate(ready));
                }
                throw Error("fake terminal not persisted");
              },
            }),
          }),
      },
    );
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(terminalWrites, 8);
    const db = new DatabaseSync(join(root, "qualification.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM execution_intents WHERE state='completed'",
          )
          .get()?.n,
        8,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM runtime_terminal_evidence WHERE conflicted=0 AND workId IS NOT NULL AND firstObservedAt IS NOT NULL",
          )
          .get()?.n,
        8,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM execution_recovery_identities WHERE threadId IS NOT NULL AND turnId IS NOT NULL AND runtimeGeneration='offline-generation'",
          )
          .get()?.n,
        8,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(DISTINCT taskId) n FROM task_execution_bindings",
          )
          .get()?.n,
        4,
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed restart retains ownership and allowance; failed shutdown cannot report a pass", async () => {
  const { runQualification, grantDigest } = await contract();
  for (const failure of ["restart", "stop"]) {
    const grant = fakeGrant();
    let stopped = 0;
    const result = await runQualification(
      {
        live: true,
        oneAttempt: true,
        grant,
        authorizedDigest: grantDigest(grant),
      },
      {
        io: { exists: () => false, save: () => {} },
        initialize: async () => ({
          turn: async (
            record: {
              harness: string;
              workspace: string;
              nonce: string;
              threadId: string;
            },
            save: (identity: Record<string, unknown>) => void,
          ) => {
            save({
              threadId: record.threadId ?? `${record.harness}-thread`,
              turnId: randomUUID(),
            });
            return {
              status: "completed",
              claudeBase: "/managed",
              measurement: {
                cwd: record.workspace,
                scratch: join(record.workspace, "scratch"),
                tmp:
                  record.harness === "codex"
                    ? join(record.workspace, "scratch")
                    : "/managed/child",
                claudeBase: "/managed",
                nonce: record.nonce,
                sentinel: record.nonce,
              },
            };
          },
          restart: async () => {
            if (failure === "restart") throw Error("restart response lost");
          },
          stop: async () => {
            stopped++;
            throw Error("shutdown response lost");
          },
        }),
      },
    );
    assert.equal(result.pass, false);
    assert.equal(result.turnsUsed, failure === "restart" ? 3 : 8);
    assert.equal(result.remainingTurns, failure === "restart" ? 5 : 0);
    assert.equal(stopped, failure === "restart" ? 0 : 1);
    if (failure === "restart") {
      assert.equal(result.settlement, "unknown");
      assert.equal(result.runtimeOperation.state, "pending");
    } else assert.match(result.cleanup, /stop-unconfirmed/);
  }
});

test("a terminal observation cannot release an unfinished cab callback after failure", async () => {
  const { runQualification, grantDigest } = await contract();
  const grant = fakeGrant();
  let stops = 0;
  const result = await runQualification(
    {
      live: true,
      oneAttempt: true,
      grant,
      authorizedDigest: grantDigest(grant),
    },
    {
      io: { exists: () => false, save: () => {} },
      initialize: async () => ({
        turn: async (
          _record: unknown,
          save: (identity: Record<string, unknown>) => void,
        ) => {
          save({
            threadId: "held-thread",
            turnId: "ended-turn",
            callbacks: { active: 1, ended: 0 },
          });
          throw Error("callback unfinished");
        },
        reconcile: async () => true,
        stop: async () => {
          stops++;
        },
      }),
    },
  );
  assert.equal(result.settlement, "unknown");
  assert.equal(result.active.callbacks.active, 1);
  assert.equal(result.remainingTurns, 7);
  assert.equal(stops, 0);
});
