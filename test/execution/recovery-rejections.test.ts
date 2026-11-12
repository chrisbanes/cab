import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  noTurnRecoveryBodySchema,
  releaseBodySchema,
  replaceConversationBodySchema,
} from "../../src/core/recovery-contracts.js";
import {
  noTurnRecoveryCommandSchema,
  releaseCommandSchema,
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
  const directory = mkdtempSync(join(tmpdir(), "cab-recovery-rejections-"));
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
  return {
    service,
    g,
    verifier,
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

const mismatchRelease = "Release does not match the held generation read";

test("release refusals are typed with their existing messages, and a witness no longer blocks release", async (t) => {
  const { service, g, stop } = await world(t, "no-turn");
  const release = {
    key: randomUUID(),
    assignmentId: g.assignmentId,
    workId: g.workId,
    workRevision: g.workRevision,
    requestSequence: g.requestSequence,
  };
  for (const changed of [
    { workRevision: g.workRevision + 1 },
    { requestSequence: g.requestSequence + 1 },
    { assignmentId: randomUUID() },
  ])
    await rejected(
      () =>
        service.releaseUnboundHold({
          ...release,
          ...changed,
          key: randomUUID(),
        }),
      mismatchRelease,
    );
  // A witness an earlier build's adoption recorded stays as evidence only.
  g.adoptAsBefore();
  const released = service.releaseUnboundHold(release);
  assert.deepEqual(service.releaseUnboundHold(release), released);
  await rejected(
    () =>
      service.releaseUnboundHold({
        ...release,
        requestSequence: g.requestSequence + 1,
      }),
    "Pre-turn command key was reused with different material",
  );
  assert.equal(service.startAgainAvailability(g.taskId).available, true);
  // Malformed input stays a validation error; infrastructure failure stays untyped.
  assert.throws(
    () =>
      service.releaseUnboundHold({
        ...release,
        workRevision: 0,
      } as never),
    z.ZodError,
  );
  await stop();
  assert.throws(
    () => service.releaseUnboundHold({ ...release, key: randomUUID() }),
    (error: unknown) =>
      error instanceof Error && !(error instanceof RecoveryRejectedError),
  );
});

test("witnessed pre-turn generations release, and an earlier adoption key keeps its scope", async (t) => {
  const { service, g } = await world(t, "pre-turn-historical");
  const adoption = g.adoption();
  g.adoptAsBefore(adoption.key);
  // The adoption key stays recorded under its own scope.
  await rejected(
    () =>
      service.releaseUnboundHold({
        key: adoption.key,
        assignmentId: g.assignmentId,
        workId: g.workId,
        workRevision: g.workRevision,
        requestSequence: g.requestSequence,
      }),
    "Pre-turn command key was reused with different material",
  );
  service.releaseUnboundHold({
    key: randomUUID(),
    assignmentId: g.assignmentId,
    workId: g.workId,
    workRevision: g.workRevision,
    requestSequence: g.requestSequence,
  });
  assert.equal(service.startAgainAvailability(g.taskId).available, true);

  const runtime = await world(t, "pre-turn-runtime");
  runtime.service.releaseUnboundHold({
    key: randomUUID(),
    workId: runtime.g.workId,
    assignmentId: runtime.g.assignmentId,
    workRevision: runtime.g.workRevision,
    requestSequence: runtime.g.requestSequence,
  });
  assert.equal(
    runtime.service.startAgainAvailability(runtime.g.taskId).available,
    true,
  );
});

test("core recovery bodies accept and reject exactly what the standalone schemas do", () => {
  const key = randomUUID();
  const identity = { processId: "p", processStartedAt: "s", bootId: "b" };
  const release = {
    assignmentId: randomUUID(),
    workId: "w",
    workRevision: 1,
    requestSequence: 2,
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
      ["release", releaseBodySchema, releaseCommandSchema, release],
      [
        "release: zero revision",
        releaseBodySchema,
        releaseCommandSchema,
        { ...release, workRevision: 0 },
      ],
      [
        "release: extra field",
        releaseBodySchema,
        releaseCommandSchema,
        { ...release, retainedReason: "r" },
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
  assert.ok(cases.length >= 10);
  // The standalone form requires its key.
  assert.equal(releaseCommandSchema.safeParse(release).success, false);
});
