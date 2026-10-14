import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  historicalNoTurnAdoptionBodySchema,
  historicalPreTurnAdoptionBodySchema,
  noTurnRecoveryBodySchema,
  replaceConversationBodySchema,
} from "../../src/core/recovery-contracts.js";
import {
  historicalNoTurnAdoptionSchema,
  historicalPreTurnAdoptionSchema,
  noTurnRecoveryCommandSchema,
  replaceConversationCommandSchema,
} from "../../src/standalone/pre-turn-recovery.js";
import { RecoveryRejectedError } from "../../src/standalone/recovery-types.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  controllableVerifier,
  type GenerationMode,
  generationRuntime,
  holdGeneration,
} from "../fixtures/recovery-generations.js";
import { tmpdir } from "../fixtures/temp.js";

type T = { after(fn: () => unknown): void };

async function world(t: T, mode: GenerationMode) {
  const directory = mkdtempSync(
    join(tmpdir(), "ensemble-recovery-rejections-"),
  );
  const runtime = generationRuntime(mode);
  const verifier = controllableVerifier();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      routingClient: null,
      terminationVerifier: verifier.verifier,
    },
  );
  await service.start();
  let stopped = false;
  t.after(async () => {
    if (!stopped) await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const g = await holdGeneration(service, runtime, mode);
  const replace = (fields: Record<string, number> = {}, key = randomUUID()) =>
    service.replaceConversationCommand({
      key,
      assignmentId: g.assignmentId,
      expectedAssignmentVersion: 1,
      expectedConversationRevision: 1,
      ...fields,
    });
  return {
    service,
    g,
    verifier,
    replace,
    async stop() {
      stopped = true;
      await service.stop();
    },
  };
}

/** Asserts a definite, typed refusal with the existing message. */
async function rejected(action: () => unknown, message: string | RegExp) {
  await assert.rejects(
    async () => action(),
    (error: unknown) => {
      assert.ok(
        error instanceof RecoveryRejectedError,
        `untyped: ${String(error)}`,
      );
      if (typeof message === "string") assert.equal(error.message, message);
      else assert.match(error.message, message);
      return true;
    },
  );
}

const mismatchNoTurn =
  "Historical no-turn adoption does not match the exact held generation";
const mismatchPreTurn =
  "Historical pre-turn adoption does not match the exact held generation";

test("no-turn adoption, recovery and replacement refusals are typed with their existing messages", async (t) => {
  const { service, g, verifier, replace, stop } = await world(t, "no-turn");
  const adoption = g.adoption() as Parameters<
    typeof service.adoptHistoricalNoTurnSubmission
  >[0];
  for (const changed of [
    { workRevision: adoption.workRevision + 1 },
    { requestSequence: adoption.requestSequence + 1 },
    { conversationRevision: adoption.conversationRevision + 1 },
    { writerSequence: adoption.writerSequence + 1 },
    {
      processIdentity: { ...adoption.processIdentity, processId: "other" },
    },
    { retainedReason: "a different reason" },
  ])
    await rejected(
      () =>
        service.adoptHistoricalNoTurnSubmission({
          ...adoption,
          ...changed,
          key: randomUUID(),
        }),
      mismatchNoTurn,
    );
  // Recovery before adoption has no witness.
  await rejected(
    () => service.recoverNoTurnExecution(g.recovery(randomUUID()) as never),
    "No-turn recovery requires its exact persisted witness and keyed command",
  );
  await rejected(() => replace(), "Assignment has unresolved execution");
  const adopted = service.adoptHistoricalNoTurnSubmission(adoption);
  await rejected(
    () =>
      service.adoptHistoricalNoTurnSubmission({
        ...adoption,
        key: randomUUID(),
      }),
    "Historical no-turn submission is already recorded for this generation",
  );
  await rejected(
    () =>
      service.adoptHistoricalNoTurnSubmission({
        ...adoption,
        retainedReason: "reuse",
      }),
    "Pre-turn command key was reused with different material",
  );
  const recovery = g.recovery(adopted.witnessId) as never as Parameters<
    typeof service.recoverNoTurnExecution
  >[0];
  for (const [mode, message] of [
    ["unknown", "Original process termination could not be verified"],
    [
      "conflict",
      "Process termination evidence conflicts with the stored identity",
    ],
    [
      "other-identity",
      "Verified termination proof has a different process identity",
    ],
  ] as const) {
    verifier.set(mode);
    await rejected(
      () => service.recoverNoTurnExecution({ ...recovery, key: randomUUID() }),
      message,
    );
  }
  verifier.set("verified");
  await rejected(
    () =>
      service.recoverNoTurnExecution({
        ...recovery,
        receipt: {
          ...recovery.receipt,
          processIdentity: { ...g.processIdentity, bootId: "other-boot" },
        },
      }),
    "Recovery receipt generation or execution identity does not match",
  );
  await rejected(
    () =>
      service.recoverNoTurnExecution({
        ...recovery,
        key: randomUUID(),
        receipt: { ...recovery.receipt, witnessId: randomUUID() },
      }),
    "No-turn recovery requires its exact persisted witness and keyed command",
  );
  await service.recoverNoTurnExecution(recovery);
  await rejected(
    () =>
      service.recoverNoTurnExecution({
        ...recovery,
        receipt: { ...recovery.receipt, workspace: "reconciled" },
      }),
    "Pre-turn command key was reused with different material",
  );
  await rejected(
    () => service.recoverNoTurnExecution({ ...recovery, key: randomUUID() }),
    "Execution generation is not held for recovery",
  );
  // Replacement: stale material, an operator Stop, then key reuse after success.
  await rejected(
    () => replace({ expectedAssignmentVersion: 2 }),
    "Conversation replacement material is stale",
  );
  await rejected(
    () => replace({ expectedConversationRevision: 2 }),
    "Conversation replacement material is stale",
  );
  await service.controlTask({
    type: "task.stop",
    key: randomUUID(),
    taskId: g.taskId,
  });
  await rejected(() => replace(), "Task remains held for recovery");
  await service.controlTask({
    type: "task.resume",
    key: randomUUID(),
    taskId: g.taskId,
  });
  const key = randomUUID();
  assert.deepEqual(replace({}, key), { revision: 2 });
  assert.deepEqual(replace({}, key), { revision: 2 });
  await rejected(
    () => replace({ expectedConversationRevision: 2 }, key),
    "Pre-turn command key was reused with different material",
  );
  // A key recorded by one recovery type conflicts under another.
  await rejected(
    () => service.recoverNoTurnExecution({ ...recovery, key }),
    "Pre-turn command key was reused with different material",
  );
  // Malformed input stays a validation error; infrastructure failure stays untyped.
  assert.throws(
    () =>
      service.adoptHistoricalNoTurnSubmission({
        ...adoption,
        attestation: { ...adoption.attestation, independentlyReviewed: false },
      } as never),
    z.ZodError,
  );
  await stop();
  assert.throws(
    () => service.adoptHistoricalNoTurnSubmission(g.adoption() as never),
    (error: unknown) =>
      error instanceof Error && !(error instanceof RecoveryRejectedError),
  );
});

test("historical and runtime pre-turn refusals are typed, including duplicate adoption", async (t) => {
  const { service, g } = await world(t, "pre-turn-historical");
  const adoption = g.adoption() as Parameters<
    typeof service.adoptHistoricalPreTurnRejection
  >[0];
  for (const changed of [
    { workRevision: adoption.workRevision + 1 },
    { requestSequence: adoption.requestSequence + 1 },
    { predecessorWorkId: "other-work" },
    {
      processIdentity: { ...adoption.processIdentity, bootId: "other" },
    },
    { retainedReason: "Runtime submission or observation uncertain: other" },
  ])
    await rejected(
      () =>
        service.adoptHistoricalPreTurnRejection({
          ...adoption,
          ...changed,
          key: randomUUID(),
        }),
      mismatchPreTurn,
    );
  // A different predecessor thread fails the archived-message check first.
  assert.throws(
    () =>
      service.adoptHistoricalPreTurnRejection({
        ...adoption,
        key: randomUUID(),
        predecessorThreadId: "thread-2",
      }),
    z.ZodError,
  );
  const adopted = service.adoptHistoricalPreTurnRejection(adoption);
  await rejected(
    () =>
      service.adoptHistoricalPreTurnRejection({
        ...adoption,
        key: randomUUID(),
      }),
    "Pre-turn rejection witness is already recorded for this generation",
  );
  await rejected(
    () =>
      service.recoverPreTurnExecution({
        ...(g.recovery(adopted.witnessId) as never as Parameters<
          typeof service.recoverPreTurnExecution
        >[0]),
        key: adoption.key,
      }),
    "Pre-turn command key was reused with different material",
  );

  const runtime = await world(t, "pre-turn-runtime");
  await rejected(
    () =>
      runtime.service.adoptHistoricalPreTurnRejection(
        runtime.g.adoption() as never,
      ),
    "Pre-turn rejection witness is already recorded for this generation",
  );
  await rejected(
    () => runtime.replace(),
    "Assignment has unresolved execution",
  );
});

test("core recovery bodies accept and reject exactly what the standalone schemas do, apart from the archived-message check", () => {
  const key = randomUUID();
  const identity = { processId: "p", processStartedAt: "s", bootId: "b" };
  const evidence = {
    frozenSourceRevision: "a".repeat(40),
    frozenHarnessSha256: "b".repeat(64),
    evidenceSha256: "c".repeat(64),
    approvedDecisionSha256: "d".repeat(64),
    reviewReference: "https://example.test/r",
    approvalReference: "https://example.test/a",
  };
  const preTurn = {
    workId: "w",
    workRevision: 1,
    requestSequence: 2,
    processIdentity: identity,
    predecessorWorkId: "p",
    predecessorThreadId: "thread-1",
    retainedReason: "r",
    rpcError: { code: -32600, message: "anything" },
    evidence,
    attestation: {
      beforeTurnRejected: true,
      noTurnSubmitted: true,
      independentlyReviewed: true,
    },
  };
  const noTurn = {
    kind: "historical-no-turn-submission",
    workId: "w",
    workRevision: 1,
    requestSequence: 2,
    conversationRevision: 1,
    writerSequence: 3,
    processIdentity: identity,
    retainedReason: "r",
    evidence: { ...evidence, invocationLedgerSha256: "e".repeat(64) },
    attestation: {
      completeSynchronousWriteAheadLedger: true,
      noStartTurnInvocation: true,
      independentlyReviewed: true,
      idleThreadMayExist: true,
    },
  };
  const recover = {
    receipt: {
      kind: "no-turn-submission",
      witnessId: randomUUID(),
      workId: "w",
      workRevision: 1,
      requestSequence: 2,
      threadId: null,
      turnId: null,
      processIdentity: identity,
      termination: { kind: "process-exit" },
      effects: "settled",
      workspace: "preserved",
    },
  };
  const replace = {
    assignmentId: randomUUID(),
    expectedAssignmentVersion: 1,
    expectedConversationRevision: 1,
  };
  const cases: Array<[string, z.ZodType, z.ZodType, Record<string, unknown>]> =
    [
      [
        "no-turn adoption",
        historicalNoTurnAdoptionBodySchema,
        historicalNoTurnAdoptionSchema,
        noTurn,
      ],
      [
        "no-turn adoption: attestation false",
        historicalNoTurnAdoptionBodySchema,
        historicalNoTurnAdoptionSchema,
        {
          ...noTurn,
          attestation: { ...noTurn.attestation, idleThreadMayExist: false },
        },
      ],
      [
        "no-turn adoption: attestation missing",
        historicalNoTurnAdoptionBodySchema,
        historicalNoTurnAdoptionSchema,
        { ...noTurn, attestation: { independentlyReviewed: true } },
      ],
      [
        "no-turn adoption: ledger missing",
        historicalNoTurnAdoptionBodySchema,
        historicalNoTurnAdoptionSchema,
        { ...noTurn, evidence },
      ],
      [
        "no-turn adoption: extra field",
        historicalNoTurnAdoptionBodySchema,
        historicalNoTurnAdoptionSchema,
        { ...noTurn, extra: 1 },
      ],
      [
        "no-turn adoption: short hash",
        historicalNoTurnAdoptionBodySchema,
        historicalNoTurnAdoptionSchema,
        { ...noTurn, evidence: { ...noTurn.evidence, evidenceSha256: "c" } },
      ],
      [
        "pre-turn adoption: 39-char revision",
        historicalPreTurnAdoptionBodySchema,
        historicalPreTurnAdoptionSchema,
        {
          ...preTurn,
          evidence: { ...evidence, frozenSourceRevision: "a".repeat(39) },
        },
      ],
      [
        "pre-turn adoption: http reference",
        historicalPreTurnAdoptionBodySchema,
        historicalPreTurnAdoptionSchema,
        {
          ...preTurn,
          evidence: { ...evidence, reviewReference: "http://x.test/" },
        },
      ],
      [
        "pre-turn adoption: other rpc code",
        historicalPreTurnAdoptionBodySchema,
        historicalPreTurnAdoptionSchema,
        { ...preTurn, rpcError: { code: -1, message: "x" } },
      ],
      [
        "pre-turn adoption: missing rpc error",
        historicalPreTurnAdoptionBodySchema,
        historicalPreTurnAdoptionSchema,
        { ...preTurn, rpcError: undefined },
      ],
      [
        "recovery",
        noTurnRecoveryBodySchema,
        noTurnRecoveryCommandSchema,
        recover,
      ],
      [
        "recovery: effects unknown",
        noTurnRecoveryBodySchema,
        noTurnRecoveryCommandSchema,
        { receipt: { ...recover.receipt, effects: "unknown" } },
      ],
      [
        "recovery: workspace discarded",
        noTurnRecoveryBodySchema,
        noTurnRecoveryCommandSchema,
        { receipt: { ...recover.receipt, workspace: "discarded" } },
      ],
      [
        "recovery: thread id",
        noTurnRecoveryBodySchema,
        noTurnRecoveryCommandSchema,
        { receipt: { ...recover.receipt, threadId: "t" } },
      ],
      [
        "recovery: workspace missing",
        noTurnRecoveryBodySchema,
        noTurnRecoveryCommandSchema,
        { receipt: { ...recover.receipt, workspace: undefined } },
      ],
      [
        "replacement",
        replaceConversationBodySchema,
        replaceConversationCommandSchema,
        replace,
      ],
      [
        "replacement: zero version",
        replaceConversationBodySchema,
        replaceConversationCommandSchema,
        { ...replace, expectedAssignmentVersion: 0 },
      ],
    ];
  for (const [name, body, standalone, input] of cases)
    assert.equal(
      body.safeParse(input).success,
      standalone.safeParse({ ...input, key }).success,
      name,
    );
  assert.ok(cases.length >= 12);
  // Only the standalone schema knows the runtime's archived-resume message.
  assert.equal(
    historicalPreTurnAdoptionBodySchema.safeParse(preTurn).success,
    true,
  );
  assert.equal(
    historicalPreTurnAdoptionSchema.safeParse({ ...preTurn, key }).success,
    false,
  );
  // Neither accepts a missing key in the standalone form.
  assert.equal(historicalNoTurnAdoptionSchema.safeParse(noTurn).success, false);
});
