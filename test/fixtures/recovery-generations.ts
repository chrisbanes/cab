import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalMaterial } from "../../src/core/delivery.js";
import { transaction } from "../../src/core/store.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import {
  ArchivedResumeRejectedError,
  archivedResumeMessage,
  type HistoricalNoTurnAdoption,
  type HistoricalPreTurnAdoption,
  type RecoveryReceipt,
  type ReplaceConversationCommand,
  recoveryReceiptSchema,
  replaceConversationCommandSchema,
} from "../../src/standalone/pre-turn-recovery.js";
import type {
  RuntimeProcessIdentity,
  TerminationVerification,
  TerminationVerifier,
} from "../../src/standalone/recovery-types.js";
import type { StandaloneService } from "../../src/standalone/service.js";
import { databaseDigest } from "./database-digest.js";
import { loginCli, startCliService } from "./operator-cli.js";
import { activeWorkIdsOf, startedOf } from "./service-internals.js";
import { until } from "./until.js";

/** Runs the runtime's pre-failure hook, then returns the error to throw. */
export function failing(
  beforeFailure: ((error: Error) => void) | undefined,
  error: Error,
): Error {
  beforeFailure?.(error);
  return error;
}

/**
 * Holds the one submitting execution exactly as a pre-turn failure was held before such
 * failures became refusals: an archived resume rejection captures its runtime witness,
 * anything else is held as an uncertain submission. Called by a fake runtime just before
 * it throws, so the service keeps that hold and the generation matches a record created
 * by an earlier build.
 */
export function holdAsBeforeRefusals(
  service: StandaloneService,
  error: Error,
): void {
  const { state } = startedOf(service);
  const intent = required(state.list().find((i) => i.state === "submitting"));
  if (
    error instanceof ArchivedResumeRejectedError &&
    state.capturePreTurnRejection(intent.workId, error.rejection)
  )
    return;
  state.hold(
    intent.id,
    `Runtime submission or observation uncertain: ${String(error)}`,
  );
}

/** Makes `runtime` hold each pre-turn failure of `service` as an earlier build did. */
export function bindLegacyHold(
  runtime: { beforeFailure: ((error: Error) => void) | undefined },
  service: StandaloneService,
): StandaloneService {
  runtime.beforeFailure = (error) => holdAsBeforeRefusals(service, error);
  return service;
}

/** Copied from no-turn-recovery.test.ts: thread start fails before any turn invocation. */
export class NoTurnRuntime implements Runtime {
  rejectStart = true;
  threads = 0;
  turnInvocations: string[] = [];
  completions: RuntimeToolResult[] = [];
  readonly identity: RuntimeProcessIdentity = {
    processId: "synthetic-no-turn",
    processStartedAt: "2026-10-03T10:00:00.000Z",
    bootId: "synthetic-boot",
  };
  listener: ((call: RuntimeToolCall) => Promise<RuntimeToolResult>) | undefined;
  async start() {}
  async stop() {}
  processIdentity() {
    return this.identity;
  }
  beforeFailure: ((error: Error) => void) | undefined;
  async startThread() {
    const id = `possibly-created-idle-thread-${++this.threads}`;
    if (this.rejectStart)
      throw failing(this.beforeFailure, new Error("Runtime stopped"));
    return id;
  }
  async resumeThread() {
    throw new Error("No predecessor thread should be resumed");
  }
  async startTurn(_thread: string, _workspace: string, prompt: string) {
    this.turnInvocations.push(prompt);
    return `turn-${this.turnInvocations.length}`;
  }
  async interruptTurn() {}
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.listener = listener;
  }
  async waitForTurn(threadId: string, turnId: string) {
    assert.ok(this.listener);
    this.completions.push(
      await this.listener({
        threadId,
        turnId,
        callId: `completion-${turnId}`,
        tool: "cab_request_completion",
        arguments: { reviewedResultIds: [] },
      }),
    );
    return "completed" as const;
  }
}

/** Copied from recovery-continuation.test.ts: turn 1 asks a question, the resume is rejected. */
export class PreTurnRuntime implements Runtime {
  turns = 0;
  threads = 0;
  prompts: string[] = [];
  completionResults: RuntimeToolResult[] = [];
  rejectResume = false;
  resumeError: Error | undefined;
  beforeFailure: ((error: Error) => void) | undefined;
  private listener:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  readonly identity: RuntimeProcessIdentity = {
    processId: "synthetic-1001",
    processStartedAt: "2026-10-03T10:00:00.000Z",
    bootId: "synthetic-boot",
  };
  async start() {}
  async stop() {}
  processIdentity() {
    return this.identity;
  }
  async startThread() {
    return `thread-${++this.threads}`;
  }
  async resumeThread(threadId: string) {
    if (this.resumeError) throw failing(this.beforeFailure, this.resumeError);
    if (this.rejectResume)
      throw failing(
        this.beforeFailure,
        new ArchivedResumeRejectedError({
          method: "thread/resume",
          requestId: 4,
          threadId,
          processIdentity: this.identity,
          error: { code: -32600, message: archivedResumeMessage(threadId) },
        }),
      );
  }
  async startTurn(_thread: string, _workspace: string, prompt: string) {
    this.prompts.push(prompt);
    return `turn-${++this.turns}`;
  }
  async interruptTurn() {}
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.listener = listener;
  }
  async waitForTurn(threadId: string, turnId: string) {
    assert.ok(this.listener);
    if (turnId === "turn-1") {
      const r = await this.listener({
        threadId,
        turnId,
        callId: "initial-question",
        tool: "cab_ask_question",
        arguments: { question: "Initial waiting turn" },
      });
      assert.equal(r.success, true);
      return "completed" as const;
    }
    this.completionResults.push(
      await this.listener({
        threadId,
        turnId,
        callId: `fresh-completion-${turnId}`,
        tool: "cab_request_completion",
        arguments: { reviewedResultIds: [] },
      }),
    );
    return "completed" as const;
  }
}

export type GenerationMode =
  | "no-turn"
  | "pre-turn-runtime"
  | "pre-turn-historical"
  /** A resume held because cab's own schema rejected the runtime's response. */
  | "pre-turn-defect";
export type VerifierMode =
  | "verified"
  | "unknown"
  | "conflict"
  | "other-identity";

/** A termination verifier the test switches; nothing is signalled or inspected. */
export function controllableVerifier() {
  let mode: VerifierMode = "verified";
  const verifier: TerminationVerifier = {
    async verify(identity): Promise<TerminationVerification> {
      if (mode === "unknown")
        return {
          kind: "unknown",
          reason: "Synthetic process is not proven ended",
        };
      if (mode === "conflict")
        return { kind: "conflict", reason: "Synthetic identity conflict" };
      return {
        kind: "verified",
        processIdentity:
          mode === "other-identity"
            ? { ...identity, processId: "other-process" }
            : identity,
        verifiedAt: "2026-10-03T10:05:00.000Z",
        method: "mac-pid-absent-same-boot",
      };
    },
  };
  return {
    verifier,
    set(next: VerifierMode) {
      mode = next;
    },
  };
}

/** The runtime a mode needs; pass it as the service's runtime factory. */
export function generationRuntime(mode: GenerationMode) {
  if (mode === "no-turn") return new NoTurnRuntime();
  const runtime = new PreTurnRuntime();
  if (mode === "pre-turn-runtime") runtime.rejectResume = true;
  else if (mode === "pre-turn-defect") {
    const parsed = z
      .object({ sandbox: z.object({ type: z.literal("workspaceWrite") }) })
      .safeParse({ sandbox: { type: "dangerFullAccess" } });
    assert.equal(parsed.success, false);
    runtime.resumeError = parsed.error;
  } else
    runtime.resumeError = new Error(
      JSON.stringify({
        code: -32600,
        message: archivedResumeMessage("thread-1"),
      }),
    );
  return runtime;
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body } as never);
}
function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null, "missing fixture evidence");
  return value;
}
const db = (service: StandaloneService) =>
  (service as unknown as { db: DatabaseSync }).db;

/** Deterministic, operator-supplied evidence material: never derived from the service. */
export const fixtureEvidence = {
  frozenSourceRevision: "a".repeat(40),
  frozenHarnessSha256: "b".repeat(64),
  evidenceSha256: "c".repeat(64),
  approvedDecisionSha256: "d".repeat(64),
  reviewReference: "https://example.test/review",
  approvalReference: "https://example.test/approval",
};

/**
 * Builds one real held generation of `mode` in a started service whose runtime is
 * `runtime` (from `generationRuntime(mode)`), with a capacity limit of one. Returns its
 * identity and builders for the exact service commands the operator would submit.
 */
export async function holdGeneration(
  service: StandaloneService,
  runtime: NoTurnRuntime | PreTurnRuntime,
  mode: GenerationMode,
) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const noTurn = mode === "no-turn";
  runtime.beforeFailure = (error) => holdAsBeforeRefusals(service, error);
  command(service, {
    type: "profile.create",
    profileId,
    name: "Recovery lead",
    instructions: "Preserved profile",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: `Recovery ${mode}`,
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: noTurn,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Recover",
    outcome: "Complete fresh work",
    ready: noTurn,
  });
  await service.provisionTask(taskId);
  let assignmentId = "";
  if (noTurn)
    command(service, {
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      title: "Current",
    });
  await service.configureCapacity({
    key: randomUUID(),
    minimumLeadSlots: 0,
    globalLimit: 1,
  });
  const known = new Set(service.turnRequests().map((r) => r.workId));
  if (noTurn) {
    assignmentId = String(required(service.domain().assignments(taskId)[0]).id);
    await service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId,
      recipientAssignmentId: assignmentId,
      expectedAssignmentVersion: 1,
      message: "OLD_BATCH_MUST_NOT_REPLAY",
    });
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused: false,
    });
  } else {
    command(service, {
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    assignmentId = String(required(service.domain().assignments(taskId)[0]).id);
    await until(
      () =>
        service.coordinationView().readTask(taskId).questions.length === 1 &&
        service.list().every((i) => i.state !== "running"),
      "initial waiting turn",
    );
    const question = required(
      service.coordinationView().readTask(taskId).questions[0],
    );
    await service.coordinationView().answerQuestion({
      key: randomUUID(),
      taskId,
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: "OLD_BATCH_SHOULD_NOT_REPLAY",
    });
  }
  const held = () =>
    service
      .turnRequests()
      .find(
        (r) =>
          r.state === "held" &&
          r.assignmentId === assignmentId &&
          !r.workId.endsWith(":initial") &&
          !known.has(r.workId),
      );
  await until(() => held() !== undefined, `held ${mode} generation`);
  const old = required(held());
  const workId = old.workId;
  // The failed submission finishes settling before the generation is used.
  await until(
    () => !activeWorkIdsOf(service).includes(workId),
    `settled ${mode} submission`,
  );
  const record = required(
    service.recoveryForTask(taskId).find((r) => r.workId === workId),
  );
  const processIdentity = required(record.processIdentity);
  const workRevision = required(record.generation.workRevision);
  const rpcError = {
    code: -32600 as const,
    message: archivedResumeMessage("thread-1"),
  };
  const noTurnEvidence = () => ({
    ...fixtureEvidence,
    invocationLedgerSha256: createHash("sha256")
      .update(JSON.stringify((runtime as NoTurnRuntime).turnInvocations))
      .digest("hex"),
  });
  /** The current witness ID, once adopted or captured. */
  const witnessId = () => {
    const r = required(
      service.recoveryForTask(taskId).find((x) => x.workId === workId),
    );
    return required(r.noTurnSubmission?.id ?? r.preTurnRejection?.id);
  };
  const row = (sql: string) =>
    required(db(service).prepare(sql).get(workId) as Record<string, number>);
  /** The exact adoption material (historical pre-turn or no-turn) an earlier build stored. */
  const adoption = (
    key: string = randomUUID(),
  ): HistoricalNoTurnAdoption | HistoricalPreTurnAdoption => {
    if (noTurn)
      return {
        key,
        kind: "historical-no-turn-submission",
        workId,
        workRevision,
        requestSequence: record.generation.requestSequence,
        conversationRevision: row(
          "SELECT conversationRevision AS v FROM task_execution_bindings WHERE workId=?",
        ).v as number,
        writerSequence: row(
          "SELECT sequence AS v FROM task_writer_admissions WHERE workId=?",
        ).v as number,
        processIdentity,
        retainedReason: required(old.reason),
        evidence: noTurnEvidence(),
        attestation: {
          completeSynchronousWriteAheadLedger: true,
          noStartTurnInvocation: true,
          independentlyReviewed: true,
          idleThreadMayExist: true,
        },
      };
    return {
      key,
      workId,
      workRevision,
      requestSequence: record.generation.requestSequence,
      predecessorWorkId: required(old.previousWorkId),
      predecessorThreadId: "thread-1",
      processIdentity,
      retainedReason: `Runtime submission or observation uncertain: Error: ${JSON.stringify(rpcError)}`,
      rpcError,
      evidence: fixtureEvidence,
      attestation: {
        beforeTurnRejected: true,
        noTurnSubmitted: true,
        independentlyReviewed: true,
      },
    };
  };
  return {
    mode,
    profileId,
    projectId,
    taskId,
    assignmentId,
    workId,
    old,
    workRevision,
    requestSequence: record.generation.requestSequence,
    processIdentity,
    retainedReason: required(old.reason),
    rpcError,
    /** The evidence file body an operator supplies for this generation's adoption. */
    adoptionEvidence: () =>
      noTurn
        ? {
            evidence: noTurnEvidence(),
            attestation: {
              completeSynchronousWriteAheadLedger: true,
              noStartTurnInvocation: true,
              independentlyReviewed: true,
              idleThreadMayExist: true,
            },
          }
        : {
            rpcError,
            evidence: fixtureEvidence,
            attestation: {
              beforeTurnRejected: true,
              noTurnSubmitted: true,
              independentlyReviewed: true,
            },
          },
    adoption,
    /** The no-turn adoption of a held resume, naming its known predecessor. */
    resumeAdoption(key: string = randomUUID()): HistoricalNoTurnAdoption {
      return {
        key,
        kind: "historical-no-turn-submission",
        workId,
        workRevision,
        requestSequence: record.generation.requestSequence,
        predecessorWorkId: required(old.previousWorkId),
        predecessorThreadId: "thread-1",
        conversationRevision: row(
          "SELECT conversationRevision AS v FROM task_execution_bindings WHERE workId=?",
        ).v as number,
        writerSequence: row(
          "SELECT sequence AS v FROM task_writer_admissions WHERE workId=?",
        ).v as number,
        processIdentity,
        retainedReason: required(old.reason),
        evidence: {
          ...fixtureEvidence,
          invocationLedgerSha256: "e".repeat(64),
        },
        attestation: {
          completeSynchronousWriteAheadLedger: true,
          noStartTurnInvocation: true,
          independentlyReviewed: true,
          idleThreadMayExist: true,
        },
      };
    },
    /** Records this generation's adoption as an earlier build stored it; see `adoptAsBefore`. */
    adoptAsBefore(key: string = randomUUID()): string {
      return adoptAsBefore(service, adoption(key));
    },
    witnessId,
    /** The exact service recovery command for the current witness. */
    recovery(witness = witnessId(), key: string = randomUUID()) {
      return {
        key,
        receipt: {
          kind: noTurn
            ? ("no-turn-submission" as const)
            : ("pre-turn-rejection" as const),
          witnessId: witness,
          workId,
          workRevision,
          requestSequence: record.generation.requestSequence,
          threadId: null,
          turnId: null,
          processIdentity,
          termination: { kind: "process-exit" as const },
          effects: "settled" as const,
          workspace: "preserved" as const,
        },
      };
    },
  };
}
export type HeldGeneration = Awaited<ReturnType<typeof holdGeneration>>;

/**
 * Records the operator-adopted witness and command record the retired adoption routes
 * wrote, exactly as data from an earlier build holds them. Returns the witness id.
 */
export function adoptAsBefore(
  service: StandaloneService,
  value: HistoricalNoTurnAdoption | HistoricalPreTurnAdoption,
): string {
  const noTurn = "kind" in value;
  const { state } = startedOf(service);
  const context = (
    state as unknown as Record<string, (workId: string) => unknown>
  )[noTurn ? "noTurnContext" : "preTurnContext"]?.call(state, value.workId);
  assert.ok(context, "adoptable context");
  const id = randomUUID();
  const raw = db(service);
  raw
    .prepare(
      noTurn
        ? "INSERT INTO execution_no_turn_submissions (id,workId,contextMaterial,evidenceMaterial) VALUES (?,?,?,?)"
        : "INSERT INTO execution_pre_turn_rejections (id,workId,source,contextMaterial,evidenceMaterial) VALUES (?,?,'operator-adopted',?,?)",
    )
    .run(
      id,
      value.workId,
      canonicalMaterial(context),
      canonicalMaterial(value),
    );
  raw
    .prepare(
      "INSERT INTO execution_pre_turn_commands (commandKey,scope,payloadMaterial,result) VALUES (?,?,?,?)",
    )
    .run(
      value.key,
      noTurn ? "adopt-no-turn" : "adopt",
      canonicalMaterial(value),
      JSON.stringify({ witnessId: id, workId: value.workId }),
    );
  return id;
}

/** A served CLI service whose runtime holds one generation of `mode`. */
export async function servedGeneration(
  t: { after(fn: () => unknown): void },
  mode: GenerationMode,
) {
  const runtime = generationRuntime(mode);
  const verifier = controllableVerifier();
  const s = await startCliService(t, {
    service: {
      supervisor: { observationMs: 50 },
      terminationVerifier: verifier.verifier,
    },
    runtimeFactory: () => runtime,
  });
  const g = await holdGeneration(s.f.service, runtime, mode);
  // Let the held turn's background workspace capture settle, then require a stable
  // database, so digests compare only the effects a test causes.
  const pending = () => {
    let count = 0;
    s.f.seedPersistedState((db) => {
      count = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM workspace_turn_captures WHERE captureState = 'pending'",
            )
            .get() as { n: number }
        ).n,
      );
    });
    return count;
  };
  let last = "";
  for (let i = 0; i < 200; i++) {
    const current = databaseDigest(s.f);
    if (pending() === 0 && current === last) break;
    last = current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { s, g, runtime, verifier };
}

/** A held generation served to a CLI harness logged in as `ro` and `rw`. */
export async function cliGeneration(
  t: { after(fn: () => unknown): void },
  mode: GenerationMode,
) {
  const w = await servedGeneration(t, mode);
  const o = await loginCli(t, w.s);
  return { ...w, ...o };
}

/**
 * Writes the rows the retired recover command wrote for a held generation, exactly as an
 * earlier build left them, replaying a recorded key. A keyless call is the retired direct
 * receipt, which recorded no command.
 */
export async function reconcileAsBefore(
  service: StandaloneService,
  command: { key?: string; receipt: RecoveryReceipt; assignmentId?: string },
): Promise<{ id: string; workId: string; state: "reconciled" }> {
  const { state } = startedOf(service);
  const receipt = recoveryReceiptSchema.parse(command.receipt);
  const scope =
    receipt.kind === "bound-turn"
      ? "recover-bound-turn"
      : receipt.kind === "no-turn-submission"
        ? "recover-no-turn"
        : "recover";
  const keyed =
    command.key === undefined ? undefined : { ...command, key: command.key };
  const replay = keyed && state.preTurnCommandReplay(scope, keyed);
  if (replay)
    return replay as { id: string; workId: string; state: "reconciled" };
  const { workId } = receipt;
  const witness =
    receipt.kind === "pre-turn-rejection" ||
    receipt.kind === "no-turn-submission"
      ? (
          state as unknown as Record<
            string,
            (workId: string) => { id: string } | undefined
          >
        )[
          receipt.kind === "no-turn-submission"
            ? "noTurnWitnessForWork"
            : "witnessForWork"
        ]?.call(state, workId)
      : undefined;
  if (
    receipt.kind === "pre-turn-rejection" ||
    receipt.kind === "no-turn-submission"
  )
    assert.equal(witness?.id, receipt.witnessId, "the exact persisted witness");
  const raw = db(service);
  const result = { id: randomUUID(), workId, state: "reconciled" as const };
  const now = Date.now();
  transaction(raw, () => {
    assert.equal(
      raw
        .prepare(`UPDATE execution_intents
        SET state = 'reconciled', reason = 'Execution reconciled from validated recovery receipt'
        WHERE workId = ? AND state = 'held'`)
        .run(workId).changes,
      1,
      "a held generation",
    );
    raw
      .prepare("DELETE FROM execution_stop_targets WHERE workId = ?")
      .run(workId);
    raw
      .prepare(`INSERT INTO execution_recovery_receipts
      (id, workId, workRevision, requestSequence, threadId, turnId, processId,
        processStartedAt, bootId, terminationMethod, terminationVerifiedAt,
        effectsState, workspaceDisposition, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mac-pid-absent-same-boot', ?, 'settled', ?, ?)`)
      .run(
        result.id,
        workId,
        receipt.workRevision,
        receipt.requestSequence,
        receipt.threadId,
        receipt.turnId,
        receipt.processIdentity.processId,
        receipt.processIdentity.processStartedAt,
        receipt.processIdentity.bootId,
        new Date(now).toISOString(),
        receipt.workspace,
        now,
      );
    if (witness)
      raw
        .prepare(
          `INSERT INTO ${receipt.kind === "no-turn-submission" ? "execution_no_turn_receipts" : "execution_pre_turn_receipts"} (receiptId,workId,witnessId,witnessMaterial) VALUES (?,?,?,?)`,
        )
        .run(result.id, workId, witness.id, canonicalMaterial(witness));
    raw
      .prepare(`UPDATE execution_pending_effects SET state = 'settled', reason = NULL
      WHERE workId = ? AND state = 'pending'`)
      .run(workId);
    raw
      .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
      .run(workId);
    raw
      .prepare(`UPDATE turn_requests SET state = 'held',
      reason = 'Execution reconciled; no automatic successor' WHERE workId = ?`)
      .run(workId);
    raw
      .prepare(`INSERT INTO execution_recovery_observations
      (id, workId, kind, reason, recordedAt) VALUES (?, ?, 'receipt-accepted', ?, ?)`)
      .run(
        randomUUID(),
        workId,
        "A validated recovery receipt resolved this generation",
        now,
      );
    if (keyed) recordCommandAsBefore(raw, scope, keyed, result);
  });
  return result;
}

/** The retired conversation-replacement command, as an earlier build recorded it. */
export function replaceConversationAsBefore(
  service: StandaloneService,
  command: ReplaceConversationCommand,
): { revision: number } {
  const { state } = startedOf(service);
  const value = replaceConversationCommandSchema.parse(command);
  const replay = state.preTurnCommandReplay("replace-conversation", value);
  if (replay) return replay as { revision: number };
  const raw = db(service);
  return transaction(raw, () => {
    const result = { revision: state.replaceConversation(value.assignmentId) };
    recordCommandAsBefore(raw, "replace-conversation", value, result);
    return result;
  });
}

function recordCommandAsBefore(
  raw: DatabaseSync,
  scope: string,
  command: { key: string },
  result: unknown,
): void {
  raw
    .prepare(
      "INSERT INTO execution_pre_turn_commands (commandKey,scope,payloadMaterial,result) VALUES (?,?,?,?)",
    )
    .run(
      command.key,
      scope,
      canonicalMaterial(command),
      JSON.stringify(result),
    );
}
