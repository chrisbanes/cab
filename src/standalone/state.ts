import { TaskReviewStore } from "../core/task-review.js";
import { canonicalMaterial, materialDigest } from "../core/delivery.js";
import { DomainConflictError, TaskNotOpenError } from "../core/domain.js";
import { executionIntentStateSchema } from "../core/execution-runtime.js";
import type { CommandReceipt } from "../operator/contracts.js";
import {
  archivedResumeRejectionSchema,
  historicalPreTurnAdoptionSchema,
  historicalNoTurnAdoptionSchema,
  replaceConversationCommandSchema,
  type ArchivedResumeRejection,
  type HistoricalPreTurnAdoption,
  type HistoricalNoTurnAdoption,
  type ReplaceConversationCommand,
} from "./pre-turn-recovery.js";
import { createDraftingTable } from "./drafting.js";
import { recoveryReceiptSchema } from "./pre-turn-recovery.js";
import { RecoveryRejectedError } from "./recovery-types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defaultExecutionHarness,
  type ExecutionHarness,
  executionHarnessSchema,
} from "./execution-harness.js";
import { transaction, type Database } from "../core/store.js";
import type { ReconciledAssignmentProof } from "../core/coordination.js";
import type {
  RecoveryRecord,
  RecoveryReceipt,
  RuntimeProcessIdentity,
  VerifiedTermination,
} from "./recovery-types.js";
import type { ConversationHistoryBinding } from "./conversation-history.js";
import type {
  RuntimeTerminalEvidence,
  RuntimeTerminalFailureEvidence,
  RuntimeTerminalObservation,
  RuntimeThreadQualification,
  RuntimeThreadQualificationEvidence,
} from "./runtime-retention.js";

export type TaskControlReceipt = Extract<
  CommandReceipt,
  { kind: "task-stop" | "task-resume" }
>;
export type DraftTurnReceipt = Extract<CommandReceipt, { kind: "draft-turn" }>;
export type StartAgainReceipt = Extract<
  CommandReceipt,
  { kind: "start-again" }
>;
export type TaskResetReceipt = Extract<CommandReceipt, { kind: "task-reset" }>;

const stopTargetColumns = `(
      taskId TEXT NOT NULL,
      workId TEXT NOT NULL REFERENCES execution_intents(workId),
      threadId TEXT,
      turnId TEXT,
      interruptState TEXT NOT NULL CHECK(interruptState IN ('pending','uncertain','acknowledged','failed','unbound')),
      terminalState TEXT NOT NULL CHECK(terminalState IN ('unknown','completed','failed')),
      reason TEXT,
      requestedAt INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'operator' CHECK(origin IN ('operator','shutdown')),
      PRIMARY KEY(taskId, workId)
    )`;
// Reason texts earlier builds used as the uncertain-interrupt discriminator.
const legacyUncertainInterruptReason =
  "Codex interrupt request outcome is uncertain";
const legacyFailedInterruptReason = "Codex interrupt request failed";

const recoveryReceiptColumns = `(
      id TEXT PRIMARY KEY,
      workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT,
      turnId TEXT,
      processId TEXT NOT NULL,
      processStartedAt TEXT NOT NULL,
      bootId TEXT NOT NULL,
      terminationMethod TEXT NOT NULL,
      terminationVerifiedAt TEXT NOT NULL,
      effectsState TEXT NOT NULL CHECK(effectsState = 'settled'),
      workspaceDisposition TEXT NOT NULL CHECK(workspaceDisposition IN ('preserved','reconciled')),
      createdAt INTEGER NOT NULL
    )`;

const intentSchema = z.object({
  id: z.string().uuid(),
  workId: z.string().min(1),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  state: executionIntentStateSchema,
  reason: z.string().nullable(),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  accountType: z.literal("chatgpt"),
  sandbox: z.literal("workspaceWrite"),
  approval: z.literal("never"),
});
export type ExecutionIntent = z.infer<typeof intentSchema>;

export interface TaskExecutionContext {
  taskId: string;
  assignmentId: string;
  assignmentVersion: number;
  instructionsRevision: number;
  profileRevision: number;
}

export interface TaskExecutionBinding extends TaskExecutionContext {
  workId: string;
  conversationRevision: number;
}

export interface TaskExecutionBindingRecord extends TaskExecutionBinding {
  harness: ExecutionHarness;
}

export interface TaskTurnCaptureIdentity extends TaskExecutionBinding {
  profileId: string;
  workRevision: number;
  requestSequence: number;
  taskVersion: number;
}

export interface CoordinationExecutionBinding extends TaskExecutionBinding {
  /** Current task revision for workspace and access-policy checks. */
  taskVersion: number;
  workRevision: number;
  requestSequence: number | null;
  /** Immutable revision admitted by the exact turn request. */
  admittedTaskVersion: number | null;
  profileId: string;
  state: "running" | "completed";
  /** The turn is a read-only draft turn of a pending lead. */
  draftTurn: boolean;
}

export interface NativeTurnPrebinding extends TaskExecutionBinding {
  intentId: string;
  workRevision: number;
  requestSequence: number;
  threadId: string;
  turnId: string;
  runtimeGeneration: string;
  processIdentity: RuntimeProcessIdentity;
}

export type NativeTurnStartReconciliation =
  | { status: "matched" }
  | { status: "absent" }
  | { status: "rejected"; prebinding: NativeTurnPrebinding };

export interface StopTarget {
  taskId: string;
  workId: string;
  threadId: string | null;
  turnId: string | null;
  interruptState:
    | "pending"
    | "uncertain"
    | "acknowledged"
    | "failed"
    | "unbound";
  terminalState: "unknown" | "completed" | "failed";
  reason: string | null;
  /** A shutdown target is transient and never an operator Stop. */
  origin: "operator" | "shutdown";
}

export interface RecoveryExecutionIdentity {
  workId: string;
  workRevision: number | null;
  requestSequence: number;
  threadId: string | null;
  turnId: string | null;
  processIdentity: RuntimeProcessIdentity | null;
}

export interface TaskTurnRequest {
  workId: string;
  assignmentId: string | null;
  assignmentVersion: number | null;
  sequence: number;
  state: "queued" | "active" | "completed" | "held";
}

export interface WorkspaceNormalizationRow {
  cursor: number;
  id: string;
  workId: string;
  workspace: string;
  taskId: string | null;
  workspaceId: string | null;
  workspacePath: string | null;
}

const runtimeTerminalFailureEvidenceSchema = z
  .object({
    classification: z.enum(["transient", "permanent", "unknown"]),
    reasonCode: z.string().min(1).max(64),
    source: z.enum(["harness", "missing"]),
    harnessRetries: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();

/** Rows written before harness-neutral evidence carried Codex field names. */
const legacyRuntimeTerminalFailureEvidenceSchema = z
  .object({
    classification: z.enum(["transient", "permanent", "unknown"]),
    reasonCode: z.enum([
      "contextWindowExceeded",
      "sessionBudgetExceeded",
      "usageLimitExceeded",
      "rateLimitExceeded",
      "flexUnavailable",
      "serverOverloaded",
      "cyberPolicy",
      "misalignmentPolicyViolation",
      "internalServerError",
      "unauthorized",
      "badRequest",
      "threadRollbackFailed",
      "sandboxError",
      "other",
      "unknown",
    ]),
    source: z.enum(["codexErrorInfo", "missing"]),
    codexRetries: z.number().int().nonnegative().safe().nullable(),
  })
  .strict()
  .transform(
    ({ source, codexRetries, ...rest }): RuntimeTerminalFailureEvidence => ({
      ...rest,
      source: source === "codexErrorInfo" ? "harness" : "missing",
      harnessRetries: codexRetries,
    }),
  );

const storedRuntimeTerminalFailureEvidenceSchema =
  runtimeTerminalFailureEvidenceSchema.or(
    legacyRuntimeTerminalFailureEvidenceSchema,
  );

const runtimeTerminalEvidenceRowSchema = z
  .object({
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
    firstStatus: z.enum(["completed", "failed"]).nullable(),
    conflicted: z
      .number()
      .int()
      .refine((value) => value === 0 || value === 1),
    workId: z.string().min(1).nullable(),
    firstRuntimeGeneration: z.string().min(1).nullable(),
    lastRuntimeGeneration: z.string().min(1).nullable(),
    firstObservedAt: z.number().int().nonnegative().nullable(),
    lastObservedAt: z.number().int().nonnegative().nullable(),
    failureEvidence: z.string().max(256).nullable(),
    harness: executionHarnessSchema,
  })
  .strict();

function parseRuntimeTerminalEvidence(input: unknown): RuntimeTerminalEvidence {
  const row = runtimeTerminalEvidenceRowSchema.parse(input);
  const failure: RuntimeTerminalFailureEvidence | null =
    row.failureEvidence === null
      ? null
      : storedRuntimeTerminalFailureEvidenceSchema.parse(
          JSON.parse(row.failureEvidence),
        );
  if (failure !== null && row.firstStatus !== "failed")
    throw new Error("Runtime terminal failure evidence has no failed status");
  return { ...row, conflicted: row.conflicted === 1, failure };
}

const runtimeThreadQualificationSchema = z
  .object({
    threadId: z.string().min(1).max(512),
    toolDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    codexVersion: z.string().min(1).max(128).nullable(),
    executableHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    model: z.string().min(1).max(256).nullable(),
    modelProvider: z.string().min(1).max(256).nullable(),
    reasoningEffort: z.string().max(128).nullable(),
    serviceTier: z.string().max(128).nullable(),
    developerInstructionsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    harness: executionHarnessSchema,
  })
  .strict();

export interface PowerEventCursor {
  version: 1;
  value: string;
}

export interface PowerAdmissionState {
  cursor: PowerEventCursor | null;
  held: boolean;
  reason: string | null;
  revision: number;
}

const powerEventCursorSchema = z
  .object({
    version: z.literal(1),
    value: z.string().min(1).max(512),
  })
  .strict();
export const refusedRevisionPrefix =
  "Request refused: captured revisions no longer match (";
const safeRefusedAssignmentRevisionReasons = new Set([
  "assignment-revision-changed",
  "assignment-instructions-changed",
  "assignment-profile-changed",
  "assignment-instructions-revision-stale",
  "assignment-profile-revision-stale",
  "project-paused",
]);
const refusedAssignmentRevisionReasons = new Set(
  [...safeRefusedAssignmentRevisionReasons].filter(
    (reason) => reason !== "project-paused",
  ),
);

export interface FailureResolutionEvidence {
  workId: string;
  workRevision: number | null;
  requestSequence: number;
  threadId: string;
  turnId: string;
  terminalStatus: "failed";
  classification: "transient";
  reasonCode: "serverOverloaded" | "rateLimitExceeded";
  harness: ExecutionHarness;
  source: "harness";
  harnessRetries: number;
  callbacksEnded: true;
  noSurvivor: true;
  effects: "settled";
  nextEligibleAt: number;
}

export interface ShutdownInterruptResolution {
  interruptedWorkId: string;
  requeueWorkId: string;
}

export interface FailedGenerationResolution {
  failedWorkId: string;
  retryWorkId: string;
  retryIndex: number;
  ensembleRetriesUsed: number;
  harnessRetriesUsed: number;
  nextEligibleAt: number;
}

/** Stored retry rows keep their original Codex-named column values. */
const retryFailureSource: Record<ExecutionHarness, "codexErrorInfo" | null> = {
  codex: "codexErrorInfo",
  // Deliberate: Claude failures are classified and held, never retried (#825).
  claude: null,
};

export function harnessRetrySupported(harness: ExecutionHarness): boolean {
  return retryFailureSource[harness] !== null;
}

const failureResolutionSchema = z
  .object({
    workId: z.string().min(1),
    workRevision: z.number().int().positive().nullable(),
    requestSequence: z.number().int().positive(),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    terminalStatus: z.literal("failed"),
    classification: z.literal("transient"),
    reasonCode: z.enum(["serverOverloaded", "rateLimitExceeded"]),
    harness: executionHarnessSchema,
    source: z.literal("harness"),
    harnessRetries: z.number().int().nonnegative().safe(),
    callbacksEnded: z.literal(true),
    noSurvivor: z.literal(true),
    effects: z.literal("settled"),
    nextEligibleAt: z.number().int().nonnegative().safe(),
  })
  .strict();

const shutdownResolutionSchema = z
  .object({
    workId: z.string().min(1),
    workRevision: z.number().int().positive().nullable(),
    requestSequence: z.number().int().positive(),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    harness: executionHarnessSchema,
    callbacksEnded: z.literal(true),
    noSurvivor: z.literal(true),
  })
  .strict();
export type ShutdownResolutionEvidence = z.infer<
  typeof shutdownResolutionSchema
>;

const processIdentitySchema = z.object({
  processId: z.string().min(1).max(128),
  processStartedAt: z.string().min(1).max(128),
  bootId: z.string().min(1).max(128),
});

const verifiedTerminationSchema = z
  .object({
    kind: z.literal("verified"),
    processIdentity: processIdentitySchema,
    verifiedAt: z.string().datetime({ offset: true }),
    method: z.literal("mac-pid-absent-same-boot"),
  })
  .strict();

// Binds the task id three times: ambiguity hold, writer hold, execution bindings.
const archiveUnblockedClause = `NOT EXISTS (
            SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_writer_holds WHERE taskId = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM task_execution_bindings b
            JOIN execution_intents e ON e.workId = b.workId
            WHERE b.taskId = ?
            AND e.state IN ('ready','capacity-waiting','held','submitting','running')
            AND NOT EXISTS (
              SELECT 1 FROM execution_request_refusals r WHERE r.workId = e.workId
            )
          )`;

function recoveryReason(kind: string): string {
  switch (kind) {
    case "exact-live":
      return "The exact original execution was confirmed live";
    case "exact-terminal-completed":
      return "The exact original execution reported completion";
    case "exact-terminal-failed":
      return "The exact original execution reported failure";
    case "historical-only":
      return "Only historical execution information was available";
    case "conflicting":
      return "Execution identity evidence conflicted";
    case "no-proof":
      return "No exact execution identity could be proven";
    case "termination-verified":
      return "Original process termination was independently verified";
    case "termination-conflict":
      return "Process termination evidence conflicted with the stored identity";
    case "termination-unknown":
      return "Original process termination could not be verified";
    case "receipt-accepted":
      return "A validated recovery receipt resolved this generation";
    case "retry-enqueued":
      return "A validated transient failure queued one bounded retry generation";
    case "shutdown-requeued":
      return "Planned shutdown interrupted this turn; one fresh generation was queued";
    default:
      return "Execution state requires operator attention";
  }
}

/** No method retries an uncertain submission. Callers must create a new work ID. */
export class ExecutionState {
  private readonly hasTurnRequests: boolean;

  constructor(private readonly db: Database) {
    // Harness lookups join it, so it exists even before the drafting store opens.
    createDraftingTable(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS assignment_conversations (
      assignmentId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0)
    );
    CREATE TABLE IF NOT EXISTS task_execution_bindings (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      taskId TEXT NOT NULL, assignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL, instructionsRevision INTEGER NOT NULL,
      profileRevision INTEGER NOT NULL, conversationRevision INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'codex' CHECK(length(harness) BETWEEN 1 AND 64)
    );
    CREATE INDEX IF NOT EXISTS task_execution_bindings_task
      ON task_execution_bindings(taskId);
    CREATE INDEX IF NOT EXISTS task_execution_bindings_assignment
      ON task_execution_bindings(assignmentId, assignmentVersion);
    CREATE TABLE IF NOT EXISTS task_writer_holds (
      taskId TEXT, reason TEXT NOT NULL,
      holdKind TEXT CHECK(holdKind IS NULL OR holdKind = 'operator-stop')
    );
    CREATE TABLE IF NOT EXISTS task_control_receipts (
      taskId TEXT NOT NULL, key TEXT NOT NULL, payloadHash TEXT NOT NULL,
      receiptJson TEXT NOT NULL, createdAt INTEGER NOT NULL,
      PRIMARY KEY (taskId, key)
    );
    CREATE TABLE IF NOT EXISTS execution_stop_targets ${stopTargetColumns};
    CREATE TABLE IF NOT EXISTS task_writer_ambiguity_holds (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_archival_holds (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_execution_results (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId),
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_writer_admissions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      workspace TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_work_revisions (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId),
      assignmentId TEXT NOT NULL,
      conversationRevision INTEGER NOT NULL,
      workRevision INTEGER NOT NULL CHECK(workRevision > 0),
      UNIQUE(assignmentId, conversationRevision, workRevision)
    );
    CREATE TABLE IF NOT EXISTS task_work_revision_ambiguities (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId),
      assignmentId TEXT NOT NULL,
      conversationRevision INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_work_revision_pending (
      workId TEXT PRIMARY KEY REFERENCES task_execution_bindings(workId)
    );
    CREATE TABLE IF NOT EXISTS execution_request_predecessors (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      previousWorkId TEXT,
      predecessorKnown INTEGER NOT NULL CHECK(predecessorKnown IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS execution_request_refusals (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_request_restarts (
      refusedWorkId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      workId TEXT NOT NULL UNIQUE,
      taskId TEXT NOT NULL,
      key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_capacity_reservations (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      projectId TEXT,
      admittedAt INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS scheduler_capacity_limits (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      globalLimit INTEGER NOT NULL CHECK(globalLimit > 0)
    );
    CREATE TABLE IF NOT EXISTS scheduler_project_capacity_limits (
      projectId TEXT PRIMARY KEY, projectLimit INTEGER NOT NULL CHECK(projectLimit > 0)
    );
    CREATE TABLE IF NOT EXISTS project_command_network_access (
      projectId TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS execution_intent_network_access (
      intentId TEXT PRIMARY KEY REFERENCES execution_intents(id),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS execution_retry_chains (
      chainId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      ensembleRetriesUsed INTEGER NOT NULL CHECK(ensembleRetriesUsed >= 0),
      codexRetriesUsed INTEGER NOT NULL CHECK(codexRetriesUsed >= 0),
      nextEligibleAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS execution_retry_attempts (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      chainId TEXT NOT NULL REFERENCES execution_retry_chains(chainId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      reasonCode TEXT NOT NULL CHECK(reasonCode IN ('serverOverloaded','rateLimitExceeded')),
      failureSource TEXT NOT NULL CHECK(failureSource = 'codexErrorInfo'),
      codexRetries INTEGER NOT NULL CHECK(codexRetries >= 0),
      disposition TEXT NOT NULL CHECK(disposition IN ('retry-queued','budget-exhausted')),
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_retry_generations (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      chainId TEXT NOT NULL REFERENCES execution_retry_chains(chainId),
      retryIndex INTEGER NOT NULL CHECK(retryIndex >= 0)
    );
    CREATE TABLE IF NOT EXISTS execution_retry_resolutions (
      failedWorkId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      retryWorkId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      chainId TEXT NOT NULL REFERENCES execution_retry_chains(chainId),
      retryIndex INTEGER NOT NULL CHECK(retryIndex > 0),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      reasonCode TEXT NOT NULL CHECK(reasonCode IN ('serverOverloaded','rateLimitExceeded')),
      failureSource TEXT NOT NULL CHECK(failureSource = 'codexErrorInfo'),
      codexRetries INTEGER NOT NULL CHECK(codexRetries >= 0),
      ensembleRetriesUsed INTEGER NOT NULL CHECK(ensembleRetriesUsed >= 0),
      codexRetriesUsed INTEGER NOT NULL CHECK(codexRetriesUsed >= 0),
      nextEligibleAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_shutdown_resolutions (
      interruptedWorkId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      requeueWorkId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL,
      threadId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      harness TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_recovery_identities (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      workRevision INTEGER,
      requestSequence INTEGER NOT NULL CHECK(requestSequence > 0),
      processId TEXT,
      processStartedAt TEXT,
      bootId TEXT,
      threadId TEXT,
      turnId TEXT,
      runtimeGeneration TEXT,
      terminalEvidenceObserved INTEGER NOT NULL DEFAULT 0
        CHECK(terminalEvidenceObserved IN (0,1)),
      inspectionKind TEXT,
      terminalStatus TEXT CHECK(terminalStatus IS NULL OR terminalStatus IN ('completed','failed')),
      CHECK((processId IS NULL AND processStartedAt IS NULL AND bootId IS NULL)
        OR (processId IS NOT NULL AND processStartedAt IS NOT NULL AND bootId IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS runtime_terminal_evidence (
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
      harness TEXT NOT NULL DEFAULT 'codex' CHECK(length(harness) BETWEEN 1 AND 64),
      PRIMARY KEY(threadId, turnId),
      CHECK((firstStatus IS NULL AND firstRuntimeGeneration IS NULL AND
        firstObservedAt IS NULL) OR (firstStatus IS NOT NULL AND
        firstRuntimeGeneration IS NOT NULL AND lastRuntimeGeneration IS NOT NULL AND
        firstObservedAt IS NOT NULL AND lastObservedAt IS NOT NULL)),
      CHECK((lastRuntimeGeneration IS NULL AND lastObservedAt IS NULL) OR
        (lastRuntimeGeneration IS NOT NULL AND lastObservedAt IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS runtime_thread_qualification (
      threadId TEXT PRIMARY KEY CHECK(length(threadId) BETWEEN 1 AND 512),
      toolDigest TEXT,
      codexVersion TEXT,
      executableHash TEXT,
      model TEXT,
      modelProvider TEXT,
      reasoningEffort TEXT,
      serviceTier TEXT,
      developerInstructionsDigest TEXT,
      harness TEXT NOT NULL DEFAULT 'codex' CHECK(length(harness) BETWEEN 1 AND 64)
    );
    CREATE TABLE IF NOT EXISTS runtime_retention_migrations (
      migrationId TEXT PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS execution_intents_thread_turn_idx
      ON execution_intents(threadId, turnId);
    CREATE INDEX IF NOT EXISTS execution_intents_thread_state_idx
      ON execution_intents(threadId, state, turnId);
    CREATE TABLE IF NOT EXISTS execution_recovery_observations (
      id TEXT PRIMARY KEY,
      workId TEXT NOT NULL REFERENCES execution_intents(workId),
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      recordedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_pending_effects (
      workId TEXT NOT NULL REFERENCES execution_intents(workId),
      effectKey TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','settled')),
      reason TEXT,
      PRIMARY KEY(workId, effectKey)
    );
    CREATE TABLE IF NOT EXISTS execution_recovery_receipts ${recoveryReceiptColumns};
    CREATE TABLE IF NOT EXISTS execution_power_supervision (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      cursor TEXT,
      wakeHeld INTEGER NOT NULL DEFAULT 0 CHECK(wakeHeld IN (0,1)),
      reason TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
    );
    CREATE TABLE IF NOT EXISTS execution_power_reconciliation_pending (
      workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
      revision INTEGER NOT NULL CHECK(revision > 0)
    );
    INSERT OR IGNORE INTO execution_power_supervision (singleton) VALUES (1);
    INSERT OR IGNORE INTO scheduler_capacity_limits (singleton, globalLimit)
      VALUES (1, 4)`);
    const recoveryIdentityColumns = this.db
      .prepare("PRAGMA table_info(execution_recovery_identities)")
      .all() as Array<{ name: string }>;
    if (
      !recoveryIdentityColumns.some(({ name }) => name === "runtimeGeneration")
    )
      this.db.exec(
        "ALTER TABLE execution_recovery_identities ADD COLUMN runtimeGeneration TEXT",
      );
    if (
      !recoveryIdentityColumns.some(
        ({ name }) => name === "terminalEvidenceObserved",
      )
    )
      this.db.exec(`ALTER TABLE execution_recovery_identities
        ADD COLUMN terminalEvidenceObserved INTEGER NOT NULL DEFAULT 0
        CHECK(terminalEvidenceObserved IN (0,1))`);
    for (const table of [
      "task_execution_bindings",
      "runtime_terminal_evidence",
      "runtime_thread_qualification",
    ]) {
      const columns = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      // Rows written before harness selection existed were all Codex executions.
      if (!columns.some(({ name }) => name === "harness"))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN harness TEXT NOT NULL
          DEFAULT 'codex' CHECK(length(harness) BETWEEN 1 AND 64)`);
    }
    this.migrateRuntimeRetention();
    this.migratePreTurnReceipts();
    this.migrateStopInterruptState();
    // Targets written before shutdown targets existed were all operator Stops.
    if (
      !(
        this.db.prepare("PRAGMA table_info(execution_stop_targets)").all() as {
          name: string;
        }[]
      ).some(({ name }) => name === "origin")
    )
      this.db.exec(`ALTER TABLE execution_stop_targets ADD COLUMN origin TEXT
        NOT NULL DEFAULT 'operator' CHECK(origin IN ('operator','shutdown'))`);
    this.migrateTaskStopHoldKind();
    // Earlier builds kept Stop targets after a receipt reconciled their work.
    this.db.exec(`DELETE FROM execution_stop_targets
      WHERE workId IN (SELECT workId FROM execution_intents WHERE state = 'reconciled')`);
    // Workspace recovery runs before this state is opened. Keep the archival
    // hold only when bounded Git work recorded unresolved filesystem effects.
    const workspaceColumns = this.db
      .prepare("PRAGMA table_info(task_workspace_bindings)")
      .all() as Array<{ name: string }>;
    if (workspaceColumns.some(({ name }) => name === "gitUncertain"))
      this.db.exec(`DELETE FROM task_archival_holds
        WHERE NOT EXISTS (
          SELECT 1 FROM task_workspace_bindings binding
          WHERE binding.taskId = task_archival_holds.taskId
            AND binding.gitUncertain = 1
        )`);
    else this.db.exec("DELETE FROM task_archival_holds");
    this.db.exec(`INSERT OR IGNORE INTO task_writer_ambiguity_holds (taskId, reason)
      SELECT taskId, reason FROM task_writer_holds
      WHERE reason = 'Legacy work revision order is ambiguous'
        AND holdKind IS NULL;
    DELETE FROM task_writer_holds
      WHERE reason = 'Legacy work revision order is ambiguous'
        AND holdKind IS NULL`);
    this.db.exec(`INSERT OR IGNORE INTO execution_request_predecessors
      (workId, previousWorkId, predecessorKnown)
      SELECT workId, NULL, 0 FROM execution_intents`);
    this.db.exec(`INSERT OR IGNORE INTO task_work_revisions
      (workId, assignmentId, conversationRevision, workRevision)
      SELECT b.workId, b.assignmentId, b.conversationRevision,
        ROW_NUMBER() OVER (
          PARTITION BY b.assignmentId, b.conversationRevision
          ORDER BY a.sequence
        )
      FROM task_writer_admissions a
      JOIN task_execution_bindings b ON b.workId = a.workId;
    INSERT OR IGNORE INTO task_work_revision_pending (workId)
      SELECT b.workId FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE e.state = 'ready' AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions disposition
        WHERE disposition.workId = b.workId
      )`);
    this.db.exec(`INSERT OR IGNORE INTO task_work_revisions
      (workId, assignmentId, conversationRevision, workRevision)
      SELECT b.workId, b.assignmentId, b.conversationRevision, 1
      FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE NOT EXISTS (
        SELECT 1 FROM task_work_revisions existing
        WHERE existing.workId = b.workId
      ) AND NOT EXISTS (
        SELECT 1 FROM task_work_revision_pending pending
        WHERE pending.workId = b.workId
      ) AND e.state IN ('submitting', 'running', 'completed') AND (
        SELECT COUNT(*) FROM task_execution_bindings onlyBinding
        WHERE onlyBinding.assignmentId = b.assignmentId
        AND onlyBinding.conversationRevision = b.conversationRevision
      ) = 1;
    INSERT OR IGNORE INTO task_work_revision_ambiguities
      (workId, assignmentId, conversationRevision, reason)
      SELECT b.workId, b.assignmentId, b.conversationRevision,
        'Legacy work revision order is ambiguous'
      FROM task_execution_bindings b
      WHERE EXISTS (
        SELECT 1 FROM task_execution_bindings missing
        WHERE missing.assignmentId = b.assignmentId
        AND missing.conversationRevision = b.conversationRevision
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions disposition
          WHERE disposition.workId = missing.workId
        ) AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_pending pending
          WHERE pending.workId = missing.workId
        )
      );
    UPDATE execution_intents SET state = 'held',
      reason = 'Legacy work revision order is ambiguous'
      WHERE workId IN (SELECT workId FROM task_work_revision_ambiguities);
    INSERT OR IGNORE INTO task_writer_ambiguity_holds (taskId, reason)
      SELECT DISTINCT b.taskId, 'Legacy work revision order is ambiguous'
      FROM task_execution_bindings b
      JOIN task_work_revision_ambiguities a ON a.workId = b.workId;
    UPDATE execution_intents SET state = 'held',
      reason = 'Legacy predecessor identity is unknown'
      WHERE state = 'ready' AND workId IN (
        SELECT b.workId FROM task_execution_bindings b
        JOIN execution_request_predecessors p ON p.workId = b.workId
        WHERE p.predecessorKnown = 0
      )`);
    this.db.exec(`INSERT OR IGNORE INTO execution_capacity_reservations (workId, projectId)
      SELECT e.workId, (
        SELECT a.projectId FROM task_execution_bindings b
        JOIN domain_assignments a ON a.id = b.assignmentId
        WHERE b.workId = e.workId
      )
      FROM execution_intents e
      JOIN task_writer_admissions admitted ON admitted.workId = e.workId
      WHERE e.state IN ('held','submitting','running')`);
    this.hasTurnRequests =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_requests'",
        )
        .get() !== undefined;
    if (this.hasTurnRequests) {
      this.db.exec(`INSERT OR IGNORE INTO execution_recovery_identities
        (workId, workRevision, requestSequence, processId, processStartedAt,
          bootId, threadId, turnId)
        SELECT e.workId, revision.workRevision, request.sequence, NULL, NULL, NULL,
          e.threadId, e.turnId
        FROM execution_intents e
        JOIN turn_requests request ON request.workId = e.workId
        LEFT JOIN task_work_revisions revision ON revision.workId = e.workId
        WHERE e.state IN ('held','submitting','running')
        AND EXISTS (SELECT 1 FROM task_writer_admissions admission WHERE admission.workId = e.workId);
      `);
      const unresolvedAssignments = this.db
        .prepare(`SELECT binding.workId
          FROM task_execution_bindings binding
          JOIN execution_intents intent ON intent.workId = binding.workId
          WHERE intent.state IN ('held','submitting','running')`)
        .all() as { workId: string }[];
      const recordPendingAssignmentResult = this.db.prepare(
        `INSERT OR IGNORE INTO execution_pending_effects
          (workId, effectKey, state, reason)
        VALUES (?, 'assignment-result', 'pending',
          'Assignment result has not been committed')`,
      );
      for (const { workId } of unresolvedAssignments)
        if (!this.refusedBeforeStart(workId))
          recordPendingAssignmentResult.run(workId);
    }
  }

  stopTask(taskId: string): StopTarget[] {
    const id = z.string().uuid().parse(taskId);
    transaction(this.db, () => this.holdTask(id));
    return this.stopTargets(id);
  }

  /**
   * Records a receipted Stop or Resume atomically with its hold change. The receipt is
   * scoped to the task: a same-content retry replays it with no effect, other content
   * under the same key conflicts, and a supplied version must match the task's.
   */
  controlTask(command: {
    type: "task.stop" | "task.resume";
    key: string;
    taskId: string;
    expectedVersion?: number | undefined;
  }): { receipt: TaskControlReceipt; replayed: boolean } {
    const id = z.string().uuid().parse(command.taskId);
    const key = z.string().uuid().parse(command.key);
    const payloadHash = materialDigest({
      type: command.type,
      taskId: id,
      expectedVersion: command.expectedVersion ?? null,
    });
    return transaction(this.db, () => {
      const stored = this.db
        .prepare(
          "SELECT payloadHash, receiptJson FROM task_control_receipts WHERE taskId = ? AND key = ?",
        )
        .get(id, key) as
        | { payloadHash: string; receiptJson: string }
        | undefined;
      if (stored) {
        if (stored.payloadHash !== payloadHash)
          throw new DomainConflictError("Request key reused for other content");
        return {
          receipt: JSON.parse(stored.receiptJson) as TaskControlReceipt,
          replayed: true,
        };
      }
      if (command.expectedVersion !== undefined) {
        const row = this.db
          .prepare("SELECT version FROM domain_tasks WHERE id = ?")
          .get(id) as { version: number } | undefined;
        if (row?.version !== command.expectedVersion)
          throw new DomainConflictError("Task version conflict");
      }
      const base = { key, recorded: true as const, taskId: id };
      let receipt: TaskControlReceipt;
      if (command.type === "task.stop") {
        receipt = {
          ...base,
          kind: "task-stop",
          cancellationRequested: this.holdTask(id).active,
        };
      } else {
        const { cleared, requeued } = this.releaseStop(id);
        receipt = {
          ...base,
          kind: "task-resume",
          stopCleared: cleared,
          requeued,
        };
      }
      this.db
        .prepare(
          "INSERT INTO task_control_receipts (taskId, key, payloadHash, receiptJson, createdAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, key, payloadHash, JSON.stringify(receipt), Date.now());
      return { receipt, replayed: false };
    });
  }

  /**
   * Runs `record` and stores its receipt in one transaction, so a refusal or failure leaves
   * nothing behind. Same key and content replays the receipt; other content under the key,
   * or a stale task version, conflicts.
   */
  private recordReceipted<R extends { kind: string }>(
    material: {
      type: string;
      taskId: string;
      expectedVersion: number;
      [field: string]: unknown;
    },
    keyValue: string,
    receiptOf: (base: { key: string; recorded: true; taskId: string }) => R,
  ): { receipt: R; replayed: boolean } {
    const id = z.string().uuid().parse(material.taskId);
    const key = z.string().uuid().parse(keyValue);
    const payloadHash = materialDigest({ ...material, taskId: id });
    return transaction(this.db, () => {
      const stored = this.db
        .prepare(
          "SELECT payloadHash, receiptJson FROM task_control_receipts WHERE taskId = ? AND key = ?",
        )
        .get(id, key) as
        | { payloadHash: string; receiptJson: string }
        | undefined;
      if (stored) {
        if (stored.payloadHash !== payloadHash)
          throw new DomainConflictError("Request key reused for other content");
        return { receipt: JSON.parse(stored.receiptJson) as R, replayed: true };
      }
      const row = this.db
        .prepare("SELECT version FROM domain_tasks WHERE id = ?")
        .get(id) as { version: number } | undefined;
      if (row?.version !== material.expectedVersion)
        throw new DomainConflictError("Task version conflict");
      const receipt = receiptOf({ key, recorded: true, taskId: id });
      this.db
        .prepare(
          "INSERT INTO task_control_receipts (taskId, key, payloadHash, receiptJson, createdAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, key, payloadHash, JSON.stringify(receipt), Date.now());
      return { receipt, replayed: false };
    });
  }

  recordDraftTurn(
    command: {
      key: string;
      taskId: string;
      expectedVersion: number;
      message: string;
    },
    record: () => { leadAssignmentId: string; workId: string },
  ): { receipt: DraftTurnReceipt; replayed: boolean } {
    return this.recordReceipted(
      {
        type: "task.draft-turn",
        taskId: command.taskId,
        expectedVersion: command.expectedVersion,
        message: command.message,
      },
      command.key,
      (base) => ({ kind: "draft-turn" as const, ...base, ...record() }),
    );
  }

  /** Queues a new request in place of the refused `command.workId`; the refusal stays in history. */
  recordStartAgain(
    command: {
      key: string;
      taskId: string;
      expectedVersion: number;
      workId: string;
    },
    record: () => { assignmentId: string; workId: string },
  ): { receipt: StartAgainReceipt; replayed: boolean } {
    return this.recordReceipted(
      {
        type: "task.start-again",
        taskId: command.taskId,
        expectedVersion: command.expectedVersion,
        workId: command.workId,
      },
      command.key,
      (base) => {
        const { assignmentId, workId } = record();
        return {
          kind: "start-again" as const,
          ...base,
          assignmentId,
          refusedWorkId: command.workId,
          workId,
        };
      },
    );
  }

  recordTaskReset(
    command: { key: string; taskId: string; expectedVersion: number },
    record: () => Omit<
      TaskResetReceipt,
      "kind" | "key" | "recorded" | "taskId"
    >,
  ): { receipt: TaskResetReceipt; replayed: boolean } {
    return this.recordReceipted(
      {
        type: "task.reset",
        taskId: command.taskId,
        expectedVersion: command.expectedVersion,
      },
      command.key,
      (base) => ({ kind: "task-reset" as const, ...base, ...record() }),
    );
  }

  /** Links a refused request to the request that replaced it; the refusal itself stays. */
  recordRestart(
    refusedWorkId: string,
    workId: string,
    taskId: string,
    key: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO turn_request_restarts (refusedWorkId, workId, taskId, key) VALUES (?, ?, ?, ?)",
      )
      .run(refusedWorkId, workId, taskId, key);
  }

  /** A completed draft turn expects no result, so its result effect is not left pending. */
  settleDraftTurnEffects(): void {
    if (!this.hasTurnRequests) return;
    this.db.exec(`UPDATE execution_pending_effects
      SET state = 'settled', reason = 'Draft turns record no result'
      WHERE effectKey = 'assignment-result' AND state = 'pending'
        AND workId IN (
          SELECT request.workId FROM turn_requests request
          JOIN execution_intents intent ON intent.workId = request.workId
          WHERE request.draftTurn = 1 AND intent.state = 'completed')`);
  }

  /** Must run inside a transaction. */
  private holdTask(id: string): { active: number } {
    const task = this.db
      .prepare("SELECT state FROM domain_tasks WHERE id = ?")
      .get(id) as { state: string } | undefined;
    if (task && task.state !== "open") throw new TaskNotOpenError(task.state);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
      )
      .run(id);
    const active = this.db
      .prepare(`SELECT e.workId, e.threadId, e.turnId FROM execution_intents e
          JOIN task_execution_bindings b ON b.workId = e.workId
          WHERE b.taskId = ? AND (
            e.state IN ('submitting','running') OR (
              e.state = 'held' AND EXISTS (
                SELECT 1 FROM execution_capacity_reservations r
                WHERE r.workId = e.workId
              )
            )
          )`)
      .all(id) as Array<{
      workId: string;
      threadId: string | null;
      turnId: string | null;
    }>;
    const insertTarget = this.db.prepare(`INSERT INTO execution_stop_targets
        (taskId, workId, threadId, turnId, interruptState, terminalState, reason, requestedAt, origin)
        VALUES (?, ?, ?, ?, ?, 'unknown', NULL, ?, 'operator')
        ON CONFLICT(taskId, workId) DO UPDATE SET origin = 'operator'`);
    for (const item of active)
      insertTarget.run(
        id,
        item.workId,
        item.threadId,
        item.turnId,
        item.threadId && item.turnId ? "pending" : "unbound",
        Date.now(),
      );
    this.db
      .prepare(`UPDATE execution_intents SET state = 'held', reason = 'Task stopped', holdKind = 'operator-stop'
          WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
          AND state IN ('submitting','running')`)
      .run(id);
    this.db
      .prepare(`UPDATE execution_intents SET reason = 'Task stopped', holdKind = 'operator-stop'
          WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
          AND state IN ('ready','capacity-waiting')`)
      .run(id);
    if (this.hasTurnRequests) {
      this.db
        .prepare(`UPDATE turn_requests SET state = 'held', reason = 'Task stopped', holdKind = 'operator-stop'
            WHERE workId IN (SELECT workId FROM execution_stop_targets WHERE taskId = ?)
            AND state = 'active'`)
        .run(id);
      this.db
        .prepare(`UPDATE turn_requests SET reason = 'Task stopped', holdKind = 'operator-stop'
            WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
            AND state = 'queued'`)
        .run(id);
    }
    return { active: active.length };
  }

  stopTargets(taskId: string): StopTarget[] {
    return this.db
      .prepare(
        "SELECT * FROM execution_stop_targets WHERE taskId = ? ORDER BY requestedAt, workId",
      )
      .all(z.string().uuid().parse(taskId))
      .map((row) => stopTargetSchema.parse(row));
  }

  /**
   * Records a transient shutdown Stop target for each task-bound execution that
   * is submitting or running and has no target yet. Returns only the rows added.
   */
  beginShutdownInterrupts(): StopTarget[] {
    return transaction(this.db, () =>
      (
        this.db
          .prepare(`INSERT OR IGNORE INTO execution_stop_targets
            (taskId, workId, threadId, turnId, interruptState, terminalState,
              reason, requestedAt, origin)
            SELECT b.taskId, e.workId, e.threadId, e.turnId,
              CASE WHEN e.threadId IS NOT NULL AND e.turnId IS NOT NULL
                THEN 'pending' ELSE 'unbound' END,
              'unknown', NULL, ?, 'shutdown'
            FROM execution_intents e
            JOIN task_execution_bindings b ON b.workId = e.workId
            WHERE e.state IN ('submitting','running')
              AND NOT EXISTS (
                SELECT 1 FROM execution_stop_targets t WHERE t.workId = e.workId)
            RETURNING *`)
          .all(Date.now()) as unknown[]
      ).map((row) => stopTargetSchema.parse(row)),
    );
  }

  /** The shutdown resolution that queued this work as its interrupted generation's successor. */
  shutdownRequeue(
    workId: string,
  ): { interruptedWorkId: string; requeueWorkId: string } | undefined {
    const row = this.db
      .prepare(`SELECT interruptedWorkId, requeueWorkId
        FROM execution_shutdown_resolutions WHERE requeueWorkId = ?`)
      .get(workId) as
      | { interruptedWorkId: string; requeueWorkId: string }
      | undefined;
    return row && { ...row };
  }

  stopTarget(workId: string): StopTarget | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_stop_targets WHERE workId = ?")
      .get(z.string().min(1).parse(workId));
    return row === undefined ? undefined : stopTargetSchema.parse(row);
  }

  bindStopIdentity(workId: string, threadId: string, turnId?: string): void {
    const target = this.stopTarget(workId);
    if (!target) return;
    if (
      (target.threadId && target.threadId !== threadId) ||
      (turnId && target.turnId && target.turnId !== turnId)
    ) {
      this.db
        .prepare(
          "UPDATE execution_stop_targets SET interruptState = 'failed', reason = 'Conflicting late execution identity' WHERE workId = ?",
        )
        .run(workId);
      return;
    }
    if (turnId)
      this.db
        .prepare(`UPDATE execution_stop_targets SET threadId = ?, turnId = ?,
          interruptState = CASE WHEN interruptState = 'unbound' THEN 'pending' ELSE interruptState END
          WHERE workId = ?`)
        .run(threadId, turnId, workId);
    else
      this.db
        .prepare(
          "UPDATE execution_stop_targets SET threadId = ? WHERE workId = ?",
        )
        .run(threadId, workId);
  }

  claimStopInterrupt(workId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE execution_stop_targets
        SET interruptState = 'uncertain', reason = NULL
        WHERE workId = ? AND interruptState = 'pending' AND threadId IS NOT NULL
        AND turnId IS NOT NULL RETURNING workId`)
        .get(workId) !== undefined
    );
  }

  recordStopInterrupt(workId: string, result: "acknowledged" | "failed"): void {
    this.db
      .prepare(`UPDATE execution_stop_targets SET interruptState = ?, reason = NULL
        WHERE workId = ? AND interruptState = 'uncertain'`)
      .run(result, workId);
  }

  recordStopTerminal(
    workId: string,
    threadId: string,
    turnId: string,
    status: "completed" | "failed",
  ): void {
    this.db
      .prepare(`UPDATE execution_stop_targets SET terminalState = ?
        WHERE workId = ? AND threadId = ? AND turnId = ?`)
      .run(status, workId, threadId, turnId);
    const identity = this.recoveryIdentity(workId);
    if (identity?.threadId === threadId && identity.turnId === turnId)
      this.recordRecoveryObservation(
        workId,
        status === "completed"
          ? "exact-terminal-completed"
          : "exact-terminal-failed",
        status,
      );
  }

  recordStopAnomaly(workId: string | undefined, reason: string): void {
    // An anomaly settles an uncertain interrupt as failed, so a late
    // acknowledgement cannot release it.
    const settle = `reason = ?, interruptState = CASE WHEN interruptState = 'uncertain'
      THEN 'failed' ELSE interruptState END`;
    if (workId)
      this.db
        .prepare(`UPDATE execution_stop_targets SET ${settle} WHERE workId = ?`)
        .run(reason, workId);
    else
      this.db
        .prepare(
          `UPDATE execution_stop_targets SET ${settle} WHERE interruptState != 'acknowledged'`,
        )
        .run(reason);
  }

  resumeTask(taskId: string): void {
    const id = z.string().uuid().parse(taskId);
    transaction(this.db, () => this.releaseStop(id));
  }

  /** Clears only the operator Stop; must run inside a transaction. */
  private releaseStop(id: string): { cleared: boolean; requeued: number } {
    const cleared = this.db
      .prepare(
        "DELETE FROM task_writer_holds WHERE taskId = ? AND holdKind = 'operator-stop'",
      )
      .run(id) as { changes: number };
    const requeued = this.db
      .prepare(`UPDATE execution_intents SET state = 'ready', reason = NULL, holdKind = NULL
          WHERE workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
          AND state IN ('ready','capacity-waiting') AND holdKind = 'operator-stop'`)
      .run(id) as { changes: number };
    if (this.hasTurnRequests)
      this.db
        .prepare(`UPDATE turn_requests SET reason = NULL, holdKind = NULL WHERE state = 'queued'
            AND workId IN (SELECT workId FROM task_execution_bindings WHERE taskId = ?)
            AND holdKind = 'operator-stop'`)
        .run(id);
    return { cleared: cleared.changes > 0, requeued: Number(requeued.changes) };
  }

  /** The operator Stop, independent of any other hold that `taskHold` reports first. */
  isTaskStopped(taskId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM task_writer_holds WHERE taskId = ? AND holdKind = 'operator-stop'",
        )
        .get(taskId) !== undefined
    );
  }

  /** True when any independent or unrecognized task hold remains alongside Stop. */
  hasNonStopTaskHold(taskId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 WHERE
          EXISTS (SELECT 1 FROM task_writer_holds WHERE taskId = ? AND holdKind IS NOT 'operator-stop')
          OR EXISTS (SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId = ?)
          OR EXISTS (SELECT 1 FROM task_archival_holds WHERE taskId = ?)`)
        .get(taskId, taskId, taskId) !== undefined
    );
  }

  taskHold(taskId: string): string | undefined {
    return this.firstTaskHoldReason(taskId, false);
  }

  /** How many turns of the task's assignments (not read-only draft turns) have bound to a runtime turn. */
  taskStartedTurnCount(taskId: string): number {
    if (!this.hasTurnRequests) return 0;
    return Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM turn_requests request JOIN execution_intents intent ON intent.workId = request.workId
          WHERE request.taskId = ? AND request.draftTurn = 0 AND request.kind = 'assignment'
            AND intent.turnId IS NOT NULL`,
          )
          .get(taskId) as { count: number }
      ).count,
    );
  }

  /** The reason of a task hold other than the operator Stop, which the task shows on its own line. */
  nonStopTaskHoldReason(taskId: string): string | undefined {
    return this.firstTaskHoldReason(taskId, true);
  }

  private firstTaskHoldReason(
    taskId: string,
    excludeStop: boolean,
  ): string | undefined {
    const row = this.db
      .prepare(`SELECT COALESCE(NULLIF(reason, ''), 'Task held') AS reason
        FROM (
          SELECT reason, 0 AS priority FROM task_writer_ambiguity_holds WHERE taskId = ?
          UNION ALL
          SELECT reason, CASE WHEN holdKind = 'operator-stop' THEN 2 ELSE 1 END
            FROM task_writer_holds
            WHERE taskId = ? AND (? = 0 OR holdKind IS NOT 'operator-stop')
          UNION ALL
          SELECT reason, 3 AS priority FROM task_archival_holds WHERE taskId = ?
        ) ORDER BY priority LIMIT 1`)
      .get(taskId, taskId, excludeStop ? 1 : 0, taskId) as
      | { reason: string }
      | undefined;
    return row?.reason;
  }

  beginArchive(taskId: string): boolean {
    const id = z.string().uuid().parse(taskId);
    return transaction(this.db, () => {
      const acquired =
        this.db
          .prepare(`INSERT INTO task_archival_holds (taskId, reason)
          SELECT ?, 'Task archival in progress'
          WHERE NOT EXISTS (
            SELECT 1 FROM task_archival_holds WHERE taskId = ?
          ) AND ${archiveUnblockedClause} RETURNING taskId`)
          .get(id, id, id, id, id) !== undefined;
      return acquired;
    });
  }

  /** No writer or ambiguity hold and no unfinished bound execution: a safe stopping point. */
  taskExecutionSettled(taskId: string): boolean {
    const id = z.string().uuid().parse(taskId);
    return (
      this.db
        .prepare(`SELECT 1 WHERE ${archiveUnblockedClause}`)
        .get(id, id, id) !== undefined
    );
  }

  isArchiveHeld(taskId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM task_archival_holds WHERE taskId = ?")
        .get(z.string().uuid().parse(taskId)) !== undefined
    );
  }

  confirmArchive(taskId: string): boolean {
    const id = z.string().uuid().parse(taskId);
    return transaction(this.db, () => {
      const confirmed =
        this.db
          .prepare(`SELECT 1 FROM task_archival_holds archival
          WHERE archival.taskId = ?
          AND ${archiveUnblockedClause}`)
          .get(id, id, id, id) !== undefined;
      return confirmed;
    });
  }

  endArchive(taskId: string): void {
    this.db
      .prepare("DELETE FROM task_archival_holds WHERE taskId = ?")
      .run(z.string().uuid().parse(taskId));
  }

  bindTask(
    workId: string,
    context: TaskExecutionContext,
    harness: ExecutionHarness = defaultExecutionHarness,
  ): TaskExecutionBindingRecord {
    const requestedHarness = executionHarnessSchema.parse(harness);
    const input = z
      .object({
        taskId: z.string().uuid(),
        assignmentId: z.string().uuid(),
        assignmentVersion: z.number().int().positive(),
        instructionsRevision: z.number().int().positive(),
        profileRevision: z.number().int().positive(),
      })
      .parse(context);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO assignment_conversations (assignmentId, revision) VALUES (?, 1)",
      )
      .run(input.assignmentId);
    const revision = Number(
      (
        this.db
          .prepare(
            "SELECT revision FROM assignment_conversations WHERE assignmentId = ?",
          )
          .get(input.assignmentId) as { revision: number }
      ).revision,
    );
    // A conversation keeps the harness that started it; never fall back. This work's own
    // binding counts only once it got past waiting for admission: until then a re-captured
    // profile revision may move it to another runtime.
    const own = this.awaitingAdmission(workId)
      ? undefined
      : this.db
          .prepare(
            "SELECT harness FROM task_execution_bindings WHERE workId = ?",
          )
          .get(workId);
    const inherited = (own ??
      this.db
        .prepare(`SELECT harness FROM task_execution_bindings
        WHERE assignmentId = ? AND conversationRevision = ? AND workId != ?
        ORDER BY rowid LIMIT 1`)
        .get(input.assignmentId, revision, workId)) as
      | { harness: unknown }
      | undefined;
    const executionHarness = inherited
      ? executionHarnessSchema.parse(inherited.harness)
      : requestedHarness;
    this.db
      .prepare(`INSERT OR IGNORE INTO task_execution_bindings
      (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision, harness)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        workId,
        input.taskId,
        input.assignmentId,
        input.assignmentVersion,
        input.instructionsRevision,
        input.profileRevision,
        revision,
        executionHarness,
      );
    const binding = this.taskBinding(workId);
    if (
      binding?.taskId === input.taskId &&
      binding.assignmentId === input.assignmentId &&
      (binding.assignmentVersion !== input.assignmentVersion ||
        binding.instructionsRevision !== input.instructionsRevision ||
        binding.profileRevision !== input.profileRevision ||
        binding.harness !== executionHarness)
    )
      this.db
        .prepare(`UPDATE task_execution_bindings
        SET assignmentVersion = ?, instructionsRevision = ?,
          profileRevision = ?, harness = ?
        WHERE workId = ? AND taskId = ? AND assignmentId = ?
        AND EXISTS (
          SELECT 1 FROM execution_intents e
          WHERE e.workId = task_execution_bindings.workId
            AND e.state IN ('ready','capacity-waiting') AND e.threadId IS NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM task_writer_admissions a
          WHERE a.workId = task_execution_bindings.workId
        ) AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions revision
          WHERE revision.workId = task_execution_bindings.workId
        )`)
        .run(
          input.assignmentVersion,
          input.instructionsRevision,
          input.profileRevision,
          executionHarness,
          workId,
          input.taskId,
          input.assignmentId,
        );
    const current = this.taskBinding(workId);
    if (
      !current ||
      Object.entries({
        ...input,
        workId,
        conversationRevision: revision,
        harness: executionHarness,
      }).some(
        ([key, value]) =>
          current[key as keyof TaskExecutionBindingRecord] !== value,
      )
    )
      throw new Error(
        "Work ID already bound to another task or assignment revision",
      );
    new TaskReviewStore(this.db).captureAssignment(
      input.assignmentId,
      "service:work-preparation",
      workId,
    );
    this.db
      .prepare(`INSERT OR IGNORE INTO task_work_revision_pending (workId)
      SELECT b.workId FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE b.workId = ? AND e.state = 'ready' AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions disposition
        WHERE disposition.workId = b.workId
      )`)
      .run(workId);
    return current;
  }

  /** Whether any task's execution has started a turn; intents are never deleted. */
  taskTurnStarted(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 AS started FROM execution_intents i JOIN task_execution_bindings b ON b.workId = i.workId WHERE i.turnId IS NOT NULL LIMIT 1",
        )
        .get() !== undefined
    );
  }

  /** Command network access the turn was admitted with; null when no admission recorded it. */
  commandNetworkAccess(intentId: string): boolean | null {
    const row = this.db
      .prepare(
        "SELECT enabled FROM execution_intent_network_access WHERE intentId = ?",
      )
      .get(intentId) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : null;
  }

  /** The harness a work item runs on: its task binding, else its drafting run, else the default. */
  workHarness(workId: string): ExecutionHarness {
    const bound = this.taskBinding(workId)?.harness;
    if (bound) return bound;
    const drafting = workId.startsWith("drafting:")
      ? (this.db
          .prepare("SELECT harness FROM drafting_runs WHERE runId = ?")
          .get(workId.slice("drafting:".length)) as
          | { harness: unknown }
          | undefined)
      : undefined;
    return drafting
      ? executionHarnessSchema.parse(drafting.harness)
      : defaultExecutionHarness;
  }

  taskBinding(workId: string): TaskExecutionBindingRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_execution_bindings WHERE workId = ?")
      .get(workId) as (TaskExecutionBinding & { harness: unknown }) | undefined;
    return (
      row && { ...row, harness: executionHarnessSchema.parse(row.harness) }
    );
  }

  taskTurnCaptureIdentity(workId: string): TaskTurnCaptureIdentity | undefined {
    if (!this.hasTurnRequests) return undefined;
    const rows = this.db
      .prepare(`SELECT binding.workId, binding.taskId, binding.assignmentId,
        binding.assignmentVersion, binding.instructionsRevision,
        binding.profileRevision, binding.conversationRevision,
        assignment.profileId, revision.workRevision,
        request.sequence AS requestSequence,
        request.taskVersion AS taskVersion
        FROM task_execution_bindings binding
        JOIN task_work_revisions revision ON revision.workId = binding.workId
        JOIN turn_requests request ON request.workId = binding.workId
          AND request.kind = 'assignment'
          AND request.taskId = binding.taskId
          AND request.assignmentId = binding.assignmentId
          AND request.assignmentVersion = binding.assignmentVersion
          AND request.instructionsRevision = binding.instructionsRevision
          AND request.profileRevision = binding.profileRevision
          AND request.state = 'active'
        JOIN execution_intents intent ON intent.workId = binding.workId
          AND intent.state = 'submitting'
        JOIN domain_assignments assignment ON assignment.id = binding.assignmentId
          AND assignment.taskId = binding.taskId
          AND assignment.version = binding.assignmentVersion
          AND assignment.instructionsRevision = binding.instructionsRevision
          AND assignment.profileRevision = binding.profileRevision
        WHERE binding.workId = ? LIMIT 2`)
      .all(workId) as Array<Record<string, unknown>>;
    if (rows.length !== 1) return undefined;
    return z
      .object({
        workId: z.string().min(1),
        taskId: z.string().min(1),
        assignmentId: z.string().min(1),
        assignmentVersion: z.number().int().positive(),
        instructionsRevision: z.number().int().positive(),
        profileRevision: z.number().int().positive(),
        conversationRevision: z.number().int().positive(),
        profileId: z.string().min(1),
        workRevision: z.number().int().positive(),
        requestSequence: z.number().int().positive(),
        taskVersion: z.number().int().positive(),
      })
      .parse(rows[0]);
  }

  /** Historical diagnostic binding only; it does not authorize commands or recovery. */
  conversationHistoryBinding(
    workId: string,
    threadId: string,
    turnId: string,
  ): ConversationHistoryBinding | undefined {
    const rows = this.db
      .prepare(`SELECT binding.workId, binding.taskId, binding.assignmentId,
        binding.assignmentVersion, binding.instructionsRevision,
        binding.profileRevision, binding.conversationRevision,
        revision.workRevision, intent.threadId, intent.turnId
        FROM task_execution_bindings binding
        JOIN execution_intents intent ON intent.workId = binding.workId
        JOIN task_work_revisions revision ON revision.workId = binding.workId
        WHERE binding.workId = ? AND intent.threadId = ? AND intent.turnId = ?
          AND (SELECT COUNT(*) FROM execution_intents duplicate
            WHERE duplicate.threadId = intent.threadId
              AND duplicate.turnId = intent.turnId) = 1
        LIMIT 2`)
      .all(workId, threadId, turnId) as Array<Record<string, unknown>>;
    if (rows.length !== 1) return undefined;
    return z
      .object({
        workId: z.string().min(1),
        taskId: z.string().min(1),
        assignmentId: z.string().min(1),
        assignmentVersion: z.number().int().positive(),
        instructionsRevision: z.number().int().positive(),
        profileRevision: z.number().int().positive(),
        conversationRevision: z.number().int().positive(),
        workRevision: z.number().int().positive(),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
      })
      .parse(rows[0]);
  }

  private readonly nativePrebindings = new Map<string, NativeTurnPrebinding>();
  runtimeQuestionBinding(
    threadId: string,
    turnId: string,
  ): CoordinationExecutionBinding | undefined {
    const binding = this.coordinationBinding(threadId, turnId);
    return binding?.state === "running" ? binding : undefined;
  }
  nativeTurnPrebinding(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): NativeTurnPrebinding | undefined {
    const matches = this.db
      .prepare(`SELECT * FROM execution_intents
        WHERE threadId = ? AND state = 'submitting' AND turnId IS NULL
        ORDER BY rowid LIMIT 2`)
      .all(z.string().min(1).max(512).parse(threadId))
      .map((row) => intentSchema.parse(row));
    if (matches.length !== 1) return undefined;
    const intent = matches[0];
    if (!intent) return undefined;
    const binding = this.taskBinding(intent.workId);
    const recovery = this.recoveryIdentity(intent.workId);
    if (
      !binding ||
      !recovery?.processIdentity ||
      recovery.workRevision === null ||
      this.taskHold(binding.taskId) ||
      this.powerAdmissionState().held ||
      this.stopTarget(intent.workId)
    )
      return undefined;
    return {
      ...binding,
      intentId: intent.id,
      workRevision: recovery.workRevision,
      requestSequence: recovery.requestSequence,
      threadId,
      turnId,
      runtimeGeneration,
      processIdentity: recovery.processIdentity,
    };
  }
  prebindNativeTurn(input: NativeTurnPrebinding): boolean {
    return transaction(this.db, () => {
      const current = this.nativeTurnPrebinding(
        input.threadId,
        input.turnId,
        input.runtimeGeneration,
      );
      if (!current || JSON.stringify(current) !== JSON.stringify(input)) {
        return false;
      }
      const bound = this.bindTurn(
        input.intentId,
        input.turnId,
        input.runtimeGeneration,
      );
      if (bound && !this.runtimeQuestionBinding(input.threadId, input.turnId))
        throw new Error("Native prebinding revisions changed");
      if (bound)
        this.nativePrebindings.set(input.workId, Object.freeze({ ...input }));
      return bound;
    });
  }
  reconcileNativeTurnStartResponse(input: {
    intentId: string;
    workId: string;
    threadId: string;
    turnId: string;
    runtimeGeneration: string | undefined;
  }): NativeTurnStartReconciliation {
    const proof = this.nativePrebindings.get(input.workId);
    if (!proof) return { status: "absent" };
    this.nativePrebindings.delete(input.workId);
    const intent = this.byWorkId(input.workId);
    const binding = this.runtimeQuestionBinding(input.threadId, input.turnId);
    const recovery = this.recoveryIdentity(input.workId);
    if (
      !intent ||
      intent.id !== input.intentId ||
      intent.state !== "running" ||
      !binding ||
      !recovery ||
      (
        [
          "workId",
          "taskId",
          "assignmentId",
          "assignmentVersion",
          "instructionsRevision",
          "profileRevision",
          "conversationRevision",
        ] as const
      ).some((key) => binding[key] !== proof[key]) ||
      proof.runtimeGeneration !== input.runtimeGeneration ||
      proof.threadId !== input.threadId ||
      proof.turnId !== input.turnId ||
      proof.workRevision !== recovery.workRevision ||
      proof.requestSequence !== recovery.requestSequence ||
      JSON.stringify(proof.processIdentity) !==
        JSON.stringify(recovery.processIdentity) ||
      this.taskHold(binding.taskId) ||
      this.powerAdmissionState().held ||
      this.stopTarget(input.workId)
    )
      return { status: "rejected", prebinding: proof };
    return { status: "matched" };
  }

  coordinationBinding(
    threadId: string,
    turnId: string,
  ): CoordinationExecutionBinding | undefined {
    const requestJoin = this.hasTurnRequests
      ? `LEFT JOIN turn_requests request ON request.workId = binding.workId
        AND request.kind = 'assignment' AND request.taskId = binding.taskId
        AND request.assignmentId = binding.assignmentId
        AND request.assignmentVersion = binding.assignmentVersion
        AND request.instructionsRevision = binding.instructionsRevision
        AND request.profileRevision = binding.profileRevision`
      : "";
    const rows = this.db
      .prepare(`SELECT binding.workId, binding.taskId, task.version AS taskVersion,
      binding.assignmentId, binding.assignmentVersion,
      binding.instructionsRevision, binding.profileRevision,
      binding.conversationRevision, revision.workRevision,
      assignment.profileId,
      ${this.hasTurnRequests ? "request.sequence" : "NULL"} AS requestSequence,
      ${this.hasTurnRequests ? "request.taskVersion" : "NULL"} AS admittedTaskVersion,
      ${this.hasTurnRequests ? "request.draftTurn" : "0"} AS draftTurn,
      intent.state
      FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN domain_tasks task ON task.id = binding.taskId
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
      JOIN domain_assignments assignment ON assignment.id = binding.assignmentId
        AND assignment.taskId = binding.taskId
        AND assignment.instructionsRevision = binding.instructionsRevision
        AND assignment.profileRevision = binding.profileRevision
      ${requestJoin}
      WHERE intent.threadId = ? AND intent.turnId = ?
        AND intent.state IN ('running','completed')
        AND assignment.version = binding.assignmentVersion
        AND conversation.revision = binding.conversationRevision
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = binding.assignmentId
            AND ambiguous.conversationRevision = binding.conversationRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = revision.assignmentId
            AND newer.conversationRevision = revision.conversationRevision
            AND newer.workRevision > revision.workRevision
        )
      LIMIT 2`)
      .all(threadId, turnId) as Array<
      Omit<CoordinationExecutionBinding, "draftTurn"> & { draftTurn: number }
    >;
    if (rows.length > 1)
      throw new Error("Coordination callback matches ambiguous work");
    const [row] = rows;
    return row && { ...row, draftTurn: row.draftTurn === 1 };
  }

  /**
   * Whether the work is still waiting for admission: no execution yet, or one that is
   * ready or capacity-waiting with no thread, owning no writer or capacity reservation.
   */
  awaitingAdmission(workId: string): boolean {
    const intent = this.byWorkId(workId);
    return (
      !intent ||
      ((intent.state === "ready" || intent.state === "capacity-waiting") &&
        !intent.threadId)
    );
  }

  /** Whether any execution bound to the assignment got past waiting for admission. */
  assignmentHasStartedExecution(assignmentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 AS present FROM task_execution_bindings binding
          JOIN execution_intents intent ON intent.workId = binding.workId
          WHERE binding.assignmentId = ?
            AND (intent.state NOT IN ('ready','capacity-waiting')
              OR intent.threadId IS NOT NULL)
          LIMIT 1`)
        .get(assignmentId) !== undefined
    );
  }

  latestCompletedAssignmentWork(assignmentId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT binding.workId
      FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN task_work_revisions revision ON revision.workId = binding.workId
      JOIN assignment_conversations conversation
        ON conversation.assignmentId = binding.assignmentId
        AND conversation.revision = binding.conversationRevision
      WHERE binding.assignmentId = ? AND intent.state = 'completed'
        AND intent.threadId IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = binding.assignmentId
            AND ambiguous.conversationRevision = binding.conversationRevision
        )
      ORDER BY revision.workRevision DESC LIMIT 1`)
      .get(z.string().uuid().parse(assignmentId)) as
      | { workId: string }
      | undefined;
    return row?.workId;
  }

  assignmentHasUnfinishedExecution(assignmentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      WHERE binding.assignmentId = ?
        AND intent.state IN ('ready','capacity-waiting','held','submitting','running')
        AND NOT EXISTS (
          SELECT 1 FROM execution_request_refusals refusal
          WHERE refusal.workId = intent.workId
        ) LIMIT 1`)
        .get(z.string().uuid().parse(assignmentId)) !== undefined
    );
  }

  /**
   * Witness-only proof that an assignment request was refused at admission before it ran:
   * the exact held request and intent still match their immutable revision refusal, and
   * nothing records a thread, turn, writer admission, capacity reservation, recovery
   * identity, pending effect or stop target. It does not look at the refusal's reasons
   * or the work identity; admission applies again when the work is requeued.
   */
  refusedBeforeStart(workId: string): boolean {
    return this.refusedBeforeStartRow(workId) !== undefined;
  }

  private refusedBeforeStartRow(workId: string) {
    const id = z.string().min(1).max(512).parse(workId);
    if (!this.hasTurnRequests) return undefined;
    const row = this.db
      .prepare(`SELECT request.kind, request.draftTurn, request.taskId, request.projectId,
        request.assignmentId, request.taskVersion, request.assignmentVersion,
        request.instructionsRevision, request.profileRevision,
        request.state AS requestState, request.reason AS requestReason,
        intent.state AS intentState, intent.reason AS intentReason,
        intent.threadId, intent.turnId,
        binding.taskId AS bindingTaskId,
        binding.assignmentId AS bindingAssignmentId,
        binding.assignmentVersion AS bindingAssignmentVersion,
        binding.instructionsRevision AS bindingInstructionsRevision,
        binding.profileRevision AS bindingProfileRevision,
        refusal.reason AS refusalReason,
        EXISTS (SELECT 1 FROM task_writer_admissions admission
          WHERE admission.workId = intent.workId) AS hasWriterAdmission,
        EXISTS (SELECT 1 FROM execution_capacity_reservations capacity
          WHERE capacity.workId = intent.workId) AS hasCapacityReservation,
        EXISTS (SELECT 1 FROM execution_recovery_identities recovery
          WHERE recovery.workId = intent.workId) AS hasRecoveryIdentity,
        EXISTS (SELECT 1 FROM execution_pending_effects effect
          WHERE effect.workId = intent.workId AND effect.state = 'pending')
          AS hasPendingEffect,
        EXISTS (SELECT 1 FROM execution_stop_targets stop
          WHERE stop.workId = intent.workId) AS hasStopTarget
        FROM turn_requests request
        JOIN execution_intents intent ON intent.workId = request.workId
        JOIN task_execution_bindings binding ON binding.workId = intent.workId
        JOIN execution_request_refusals refusal ON refusal.workId = intent.workId
        JOIN domain_tasks task ON task.id = request.taskId
          AND task.projectId = request.projectId
        JOIN domain_assignments assignment ON assignment.id = request.assignmentId
          AND assignment.taskId = request.taskId
          AND assignment.projectId = request.projectId
        WHERE request.workId = ?`)
      .get(id) as
      | {
          kind: string;
          draftTurn: number;
          taskId: string | null;
          projectId: string | null;
          assignmentId: string | null;
          taskVersion: number | null;
          assignmentVersion: number | null;
          instructionsRevision: number | null;
          profileRevision: number | null;
          requestState: string;
          requestReason: string | null;
          intentState: string;
          intentReason: string | null;
          threadId: string | null;
          turnId: string | null;
          bindingTaskId: string;
          bindingAssignmentId: string;
          bindingAssignmentVersion: number;
          bindingInstructionsRevision: number;
          bindingProfileRevision: number;
          refusalReason: string;
          hasWriterAdmission: number;
          hasCapacityReservation: number;
          hasRecoveryIdentity: number;
          hasPendingEffect: number;
          hasStopTarget: number;
        }
      | undefined;
    if (
      row?.kind !== "assignment" ||
      !row.taskId ||
      !row.projectId ||
      !row.assignmentId ||
      row.taskVersion === null ||
      row.assignmentVersion === null ||
      row.instructionsRevision === null ||
      row.profileRevision === null ||
      row.requestState !== "held" ||
      row.intentState !== "held" ||
      !row.refusalReason ||
      row.requestReason !== row.refusalReason ||
      row.intentReason !== row.refusalReason ||
      row.bindingTaskId !== row.taskId ||
      row.bindingAssignmentId !== row.assignmentId ||
      row.bindingAssignmentVersion !== row.assignmentVersion ||
      row.bindingInstructionsRevision !== row.instructionsRevision ||
      row.bindingProfileRevision !== row.profileRevision ||
      row.threadId !== null ||
      row.turnId !== null ||
      row.hasWriterAdmission !== 0 ||
      row.hasCapacityReservation !== 0 ||
      row.hasRecoveryIdentity !== 0 ||
      row.hasPendingEffect !== 0 ||
      row.hasStopTarget !== 0 ||
      !row.refusalReason.startsWith(refusedRevisionPrefix) ||
      !row.refusalReason.endsWith(")")
    )
      return undefined;
    return {
      id,
      draftTurn: row.draftTurn,
      taskId: row.taskId,
      assignmentId: row.assignmentId,
      assignmentVersion: row.assignmentVersion,
      refusalReason: row.refusalReason,
    };
  }

  /**
   * A revision refusal is ignorable only when it is `refusedBeforeStart`, its reasons are
   * the safe revision changes, and it identifies canonical initial work or a durable inbox
   * event. Current assignment eligibility is checked by admission/delivery withdrawal,
   * not here, so this historical proof remains stable after later completion.
   */
  isNeverAdmittedRefusedAssignmentWork(workId: string): boolean {
    if (
      this.db
        .prepare(`SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'coordination_inbox_events'`)
        .get() === undefined
    )
      return false;
    const row = this.refusedBeforeStartRow(workId);
    if (!row) return false;
    const id = row.id;
    const initial = id === `assignment:${row.assignmentId}:initial`;
    const refusal = row.refusalReason;
    const reasons = refusal.slice(refusedRevisionPrefix.length, -1).split(", ");
    // A refused draft turn is history on the same evidence; its stale task is the extra reason.
    if (row.draftTurn === 1)
      return (
        reasons.some(
          (reason) =>
            refusedAssignmentRevisionReasons.has(reason) ||
            reason === "task-revision-changed",
        ) &&
        reasons.every(
          (reason) =>
            safeRefusedAssignmentRevisionReasons.has(reason) ||
            reason === "task-revision-changed",
        )
      );
    if (
      reasons.length === 0 ||
      !reasons.some(
        (reason) =>
          refusedAssignmentRevisionReasons.has(reason) ||
          (initial && reason === "task-revision-changed"),
      ) ||
      reasons.some(
        (reason) =>
          !safeRefusedAssignmentRevisionReasons.has(reason) &&
          !(initial && reason === "task-revision-changed"),
      )
    )
      return false;

    if (initial) return true;

    const eventPrefix = `assignment:${row.assignmentId}:v${row.assignmentVersion}:inbox:`;
    if (!id.startsWith(eventPrefix)) return false;
    const eventId = id.slice(eventPrefix.length);
    if (!z.string().uuid().safeParse(eventId).success) return false;
    return (
      this.db
        .prepare(`SELECT 1 FROM coordination_inbox_events event
          WHERE event.eventId = ? AND event.taskId = ?
            AND event.recipientAssignmentId = ? LIMIT 1`)
        .get(eventId, row.taskId, row.assignmentId) !== undefined
    );
  }

  /** Rebuild only the recognized receipt schema without changing legacy material. */
  private migrateRuntimeRetention(): void {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM runtime_retention_migrations WHERE migrationId = ?",
        )
        .get("runtime-retention-v1")
    ) {
      this.migrateRuntimeFailureEvidence();
      return;
    }
    transaction(this.db, () => {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM runtime_retention_migrations WHERE migrationId = ?",
          )
          .get("runtime-retention-v1")
      ) {
        this.db.exec(`INSERT INTO runtime_terminal_evidence
          (threadId, turnId, firstStatus, conflicted, workId,
            firstRuntimeGeneration, lastRuntimeGeneration,
            firstObservedAt, lastObservedAt)
          SELECT threadId, turnId, NULL,
            CASE WHEN COUNT(*) = 1 THEN 0 ELSE 1 END,
            CASE WHEN COUNT(*) = 1 THEN MIN(workId) ELSE NULL END,
            NULL, NULL, NULL, NULL
          FROM execution_intents
          WHERE threadId IS NOT NULL AND turnId IS NOT NULL
          GROUP BY threadId, turnId;
          INSERT OR IGNORE INTO runtime_thread_qualification (threadId)
          SELECT DISTINCT threadId FROM execution_intents
          WHERE threadId IS NOT NULL;
          INSERT INTO runtime_retention_migrations (migrationId)
          VALUES ('runtime-retention-v1')`);
      }
    });
    this.migrateRuntimeFailureEvidence();
  }

  private migrateRuntimeFailureEvidence(): void {
    transaction(this.db, () => {
      const columns = this.db
        .prepare("PRAGMA table_info(runtime_terminal_evidence)")
        .all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "failureEvidence"))
        this.db.exec(
          "ALTER TABLE runtime_terminal_evidence ADD COLUMN failureEvidence TEXT",
        );
      // Operator reads look up a work's latest terminal turn.
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS runtime_terminal_evidence_work_idx ON runtime_terminal_evidence(workId, lastObservedAt)",
      );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO runtime_retention_migrations (migrationId) VALUES (?)",
        )
        .run("runtime-retention-v2-failure-evidence");
    });
  }

  private noteBoundRuntimeTurn(id: string, turnId: string): void {
    const row = this.db
      .prepare("SELECT workId, threadId FROM execution_intents WHERE id = ?")
      .get(id) as { workId: string; threadId: string | null } | undefined;
    if (!row?.threadId) return;
    const evidence = this.db
      .prepare(
        "SELECT * FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
      )
      .get(row.threadId, turnId);
    if (evidence === undefined) return;
    const parsed = parseRuntimeTerminalEvidence(evidence);
    // Another harness's evidence never marks this work; it stays conflicted.
    if (parsed.harness !== this.workHarness(row.workId)) {
      this.db
        .prepare(
          "UPDATE runtime_terminal_evidence SET conflicted = 1 WHERE threadId = ? AND turnId = ?",
        )
        .run(row.threadId, turnId);
      return;
    }
    const matches = this.db
      .prepare(
        "SELECT workId FROM execution_intents WHERE threadId = ? AND turnId = ? LIMIT 2",
      )
      .all(row.threadId, turnId) as Array<{ workId: string }>;
    const ambiguous = matches.length !== 1 || matches[0]?.workId !== row.workId;
    this.db
      .prepare(
        `UPDATE runtime_terminal_evidence SET
          workId = COALESCE(workId, ?), conflicted = CASE WHEN ? THEN 1 ELSE conflicted END
          WHERE threadId = ? AND turnId = ?`,
      )
      .run(row.workId, Number(ambiguous), row.threadId, turnId);
    this.db
      .prepare(`UPDATE execution_recovery_identities SET terminalEvidenceObserved = 1
        WHERE workId = ? AND threadId = ? AND turnId = ?`)
      .run(row.workId, row.threadId, turnId);
    if (parsed.workId !== null && parsed.workId !== row.workId)
      this.db
        .prepare(
          "UPDATE runtime_terminal_evidence SET conflicted = 1 WHERE threadId = ? AND turnId = ?",
        )
        .run(row.threadId, turnId);
  }

  /** Bounded failure classification of a work's latest terminal turn when it failed, else null. */
  terminalFailure(workId: string): {
    classification: "transient" | "permanent" | "unknown";
    reasonCode: string;
  } | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runtime_terminal_evidence WHERE workId = ? AND firstStatus IS NOT NULL ORDER BY lastObservedAt DESC LIMIT 1",
      )
      .get(workId) as { firstStatus?: unknown } | undefined;
    if (row?.firstStatus !== "failed") return null;
    const unknown = {
      classification: "unknown",
      reasonCode: "unknown",
    } as const;
    try {
      const failure = parseRuntimeTerminalEvidence(row).failure;
      return failure
        ? {
            classification: failure.classification,
            reasonCode: /^[A-Za-z0-9_.:-]{1,64}$/.test(failure.reasonCode)
              ? failure.reasonCode
              : "unknown",
          }
        : unknown;
    } catch {
      return unknown;
    }
  }

  runtimeTerminal(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): RuntimeTerminalEvidence | null {
    const key = {
      threadId: z.string().min(1).max(512).parse(threadId),
      turnId: z.string().min(1).max(512).parse(turnId),
      runtimeGeneration: z.string().min(1).max(128).parse(runtimeGeneration),
    };
    const row = this.db
      .prepare(
        "SELECT * FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
      )
      .get(key.threadId, key.turnId);
    if (row === undefined) {
      const matches = this.db
        .prepare(`SELECT identity.runtimeGeneration,
          identity.terminalEvidenceObserved
          FROM execution_intents intent
          LEFT JOIN execution_recovery_identities identity
            ON identity.workId = intent.workId
          WHERE intent.threadId = ? AND intent.turnId = ? LIMIT 2`)
        .all(key.threadId, key.turnId) as Array<{
        runtimeGeneration: string | null;
        terminalEvidenceObserved: number | null;
      }>;
      if (
        matches.length > 0 &&
        (matches.length !== 1 ||
          matches[0]?.runtimeGeneration !== key.runtimeGeneration ||
          matches[0]?.terminalEvidenceObserved !== 0)
      )
        throw new Error(
          "Runtime terminal evidence is missing for a bound turn",
        );
      return null;
    }
    const evidence = parseRuntimeTerminalEvidence(row);
    const matches = this.db
      .prepare(`SELECT intent.workId, identity.runtimeGeneration,
        identity.terminalEvidenceObserved
        FROM execution_intents intent
        LEFT JOIN execution_recovery_identities identity
          ON identity.workId = intent.workId
        WHERE intent.threadId = ? AND intent.turnId = ? LIMIT 2`)
      .all(key.threadId, key.turnId) as Array<{
      workId: string;
      runtimeGeneration: string | null;
      terminalEvidenceObserved: number | null;
    }>;
    if (matches.length > 1)
      throw new Error("Runtime terminal binding is ambiguous");
    if (
      (matches.length === 1 && evidence.workId !== matches[0]?.workId) ||
      (matches.length === 1 && evidence.workId === null) ||
      (matches.length === 0 && evidence.workId !== null) ||
      (matches.length === 1 &&
        evidence.firstStatus !== null &&
        matches[0]?.terminalEvidenceObserved !== 1)
    )
      throw new Error("Runtime terminal evidence binding is inconsistent");
    return evidence;
  }

  runtimeTerminalForWait(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): RuntimeTerminalEvidence | null {
    const evidence = this.runtimeTerminal(threadId, turnId, runtimeGeneration);
    if (evidence) {
      if (evidence.workId === null)
        throw new Error("Runtime terminal evidence is not bound to work");
      return evidence;
    }
    this.assertRuntimeTerminalCanWait(threadId, turnId, runtimeGeneration);
    return null;
  }

  private assertRuntimeTerminalCanWait(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): void {
    const rows = this.db
      .prepare(`SELECT intent.workId, identity.runtimeGeneration,
        identity.terminalEvidenceObserved
        FROM execution_intents intent
        LEFT JOIN execution_recovery_identities identity
          ON identity.workId = intent.workId
        WHERE intent.threadId = ? AND intent.turnId = ? LIMIT 2`)
      .all(threadId, turnId) as Array<{
      workId: string;
      runtimeGeneration: string | null;
      terminalEvidenceObserved: number | null;
    }>;
    if (
      rows.length !== 1 ||
      rows[0]?.runtimeGeneration !== runtimeGeneration ||
      rows[0]?.terminalEvidenceObserved !== 0
    )
      throw new Error("Runtime terminal evidence is missing for a bound turn");
  }

  recordRuntimeTerminal(
    input: RuntimeTerminalObservation,
    harness: ExecutionHarness = defaultExecutionHarness,
  ): RuntimeTerminalEvidence {
    const executionHarness = executionHarnessSchema.parse(harness);
    const value = z
      .object({
        threadId: z.string().min(1).max(512),
        turnId: z.string().min(1).max(512),
        status: z.enum(["completed", "failed"]),
        runtimeGeneration: z.string().min(1).max(128),
        failure: runtimeTerminalFailureEvidenceSchema.optional(),
      })
      .strict()
      .parse(input);
    if (value.status === "completed" && value.failure !== undefined)
      throw new Error("Completed terminal cannot carry failure evidence");
    const failureEvidence =
      value.status === "failed"
        ? JSON.stringify(
            value.failure ?? {
              classification: "unknown",
              reasonCode: "unknown",
              source: "missing",
              harnessRetries: null,
            },
          )
        : null;
    const observedAt = Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error("Runtime terminal evidence timestamp unavailable");
    transaction(this.db, () => {
      const matches = this.db
        .prepare(
          `SELECT intent.workId, identity.runtimeGeneration,
            identity.terminalEvidenceObserved
          FROM execution_intents intent
          LEFT JOIN execution_recovery_identities identity ON identity.workId = intent.workId
          WHERE intent.threadId = ? AND intent.turnId = ? LIMIT 2`,
        )
        .all(value.threadId, value.turnId) as Array<{
        workId: string;
        runtimeGeneration: string | null;
        terminalEvidenceObserved: number | null;
      }>;
      const workId = matches.length === 1 ? (matches[0]?.workId ?? null) : null;
      const ambiguous = matches.length > 1;
      const rawPrior = this.db
        .prepare(
          "SELECT * FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
        )
        .get(value.threadId, value.turnId);
      if (rawPrior === undefined) {
        if (matches.length > 0 && matches.length !== 1)
          throw new Error("Runtime terminal binding is ambiguous");
        if (
          matches.length === 1 &&
          (matches[0]?.runtimeGeneration !== value.runtimeGeneration ||
            matches[0]?.terminalEvidenceObserved !== 0)
        )
          throw new Error(
            "Runtime terminal evidence is missing for a bound turn",
          );
        this.db
          .prepare(`INSERT INTO runtime_terminal_evidence
            (threadId, turnId, firstStatus, conflicted, workId,
              firstRuntimeGeneration, lastRuntimeGeneration,
              firstObservedAt, lastObservedAt, failureEvidence, harness)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            value.threadId,
            value.turnId,
            value.status,
            Number(ambiguous),
            workId,
            value.runtimeGeneration,
            value.runtimeGeneration,
            observedAt,
            observedAt,
            failureEvidence,
            executionHarness,
          );
        if (matches.length === 1) {
          const marked = this.db
            .prepare(`UPDATE execution_recovery_identities
              SET terminalEvidenceObserved = 1
              WHERE workId = ? AND runtimeGeneration = ?
                AND terminalEvidenceObserved = 0`)
            .run(workId, value.runtimeGeneration) as { changes: number };
          if (marked.changes !== 1)
            throw new Error("Runtime terminal evidence binding changed");
        }
      } else {
        const prior = parseRuntimeTerminalEvidence(rawPrior);
        if (prior.harness !== executionHarness)
          throw new Error("Runtime terminal evidence harness conflicts");
        const bindingMismatch =
          (matches.length > 1 && prior.workId !== null) ||
          (workId !== null && prior.workId !== null && workId !== prior.workId);
        const conflict =
          prior.conflicted ||
          prior.firstStatus === null ||
          prior.firstStatus !== value.status ||
          ambiguous ||
          bindingMismatch;
        this.db
          .prepare(`UPDATE runtime_terminal_evidence SET
            conflicted = ?, workId = COALESCE(workId, ?),
            lastRuntimeGeneration = ?, lastObservedAt = ?
            WHERE threadId = ? AND turnId = ?`)
          .run(
            Number(conflict),
            workId,
            value.runtimeGeneration,
            observedAt,
            value.threadId,
            value.turnId,
          );
        if (matches.length === 1 && workId !== null)
          this.db
            .prepare(`UPDATE execution_recovery_identities
              SET terminalEvidenceObserved = 1
              WHERE workId = ? AND threadId = ? AND turnId = ?`)
            .run(workId, value.threadId, value.turnId);
      }
    });
    const record = this.db
      .prepare(
        "SELECT * FROM runtime_terminal_evidence WHERE threadId = ? AND turnId = ?",
      )
      .get(value.threadId, value.turnId);
    if (record === undefined)
      throw new Error("Runtime terminal evidence is unavailable");
    return parseRuntimeTerminalEvidence(record);
  }

  registerRuntimeThreadTools(
    threadId: string,
    toolDigest: string,
    harness: ExecutionHarness = defaultExecutionHarness,
  ): void {
    const executionHarness = executionHarnessSchema.parse(harness);
    const id = z.string().min(1).max(512).parse(threadId);
    const digest = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(toolDigest);
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO runtime_thread_qualification (threadId, toolDigest, harness) VALUES (?, ?, ?)",
      )
      .run(id, digest, executionHarness) as { changes: number };
    if (inserted.changes === 0) {
      const existing = this.runtimeThreadQualification(id);
      if (
        !existing ||
        existing.toolDigest !== digest ||
        existing.harness !== executionHarness
      )
        throw new Error("Runtime thread tool baseline conflicts");
    }
  }

  runtimeThreadQualification(
    threadId: string,
  ): RuntimeThreadQualification | null {
    const row = this.db
      .prepare(
        "SELECT threadId, toolDigest, codexVersion, executableHash, model, modelProvider, reasoningEffort, serviceTier, developerInstructionsDigest, harness FROM runtime_thread_qualification WHERE threadId = ?",
      )
      .get(z.string().min(1).max(512).parse(threadId));
    return row === undefined
      ? null
      : runtimeThreadQualificationSchema.parse(row);
  }

  recordRuntimeThreadQualification(
    input: RuntimeThreadQualificationEvidence,
  ): void {
    const value = z
      .object({
        threadId: z.string().min(1).max(512),
        toolDigest: z.string().regex(/^[a-f0-9]{64}$/),
        codexVersion: z.string().min(1).max(128),
        executableHash: z.string().regex(/^[a-f0-9]{64}$/),
        model: z.string().min(1).max(256),
        modelProvider: z.string().min(1).max(256),
        reasoningEffort: z.string().max(128).nullable(),
        serviceTier: z.string().max(128).nullable(),
        developerInstructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(input);
    const prior = this.runtimeThreadQualification(value.threadId);
    if (!prior || prior.toolDigest !== value.toolDigest)
      throw new Error("Runtime thread tool baseline unavailable");
    const qualification = {
      codexVersion: value.codexVersion,
      executableHash: value.executableHash,
      model: value.model,
      modelProvider: value.modelProvider,
      reasoningEffort: value.reasoningEffort,
      serviceTier: value.serviceTier,
      developerInstructionsDigest: value.developerInstructionsDigest,
    };
    const existing = {
      codexVersion: prior.codexVersion,
      executableHash: prior.executableHash,
      model: prior.model,
      modelProvider: prior.modelProvider,
      reasoningEffort: prior.reasoningEffort,
      serviceTier: prior.serviceTier,
      developerInstructionsDigest: prior.developerInstructionsDigest,
    };
    if (Object.values(existing).some((field) => field !== null)) {
      if (JSON.stringify(existing) !== JSON.stringify(qualification))
        throw new Error("Runtime thread qualification baseline conflicts");
      return;
    }
    this.db
      .prepare(`UPDATE runtime_thread_qualification SET
        codexVersion = ?, executableHash = ?, model = ?, modelProvider = ?,
        reasoningEffort = ?, serviceTier = ?, developerInstructionsDigest = ?
        WHERE threadId = ? AND toolDigest = ? AND codexVersion IS NULL`)
      .run(
        value.codexVersion,
        value.executableHash,
        value.model,
        value.modelProvider,
        value.reasoningEffort,
        value.serviceTier,
        value.developerInstructionsDigest,
        value.threadId,
        value.toolDigest,
      );
    const after = this.runtimeThreadQualification(value.threadId);
    if (
      !after ||
      JSON.stringify(after) !==
        JSON.stringify({
          threadId: value.threadId,
          toolDigest: value.toolDigest,
          ...qualification,
          harness: prior.harness,
        })
    )
      throw new Error("Runtime thread qualification could not be persisted");
  }

  /**
   * Converts reason-text uncertain interrupts into typed `uncertain` state.
   * Forward-only: builds that predate `uncertain` cannot parse migrated rows.
   */
  private migrateStopInterruptState(): void {
    const stored = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='execution_stop_targets'",
      )
      .get() as { sql: string };
    if (stored.sql.includes("'uncertain'")) return;
    transaction(this.db, () => {
      const columns =
        "taskId, workId, threadId, turnId, interruptState, terminalState, reason, requestedAt";
      this.db.exec(
        `CREATE TABLE execution_stop_targets_typed ${stopTargetColumns}`,
      );
      this.db
        .prepare(`INSERT INTO execution_stop_targets_typed (${columns})
          SELECT taskId, workId, threadId, turnId,
            CASE WHEN interruptState = 'failed' AND reason = ? THEN 'uncertain' ELSE interruptState END,
            terminalState,
            CASE WHEN interruptState = 'failed' AND reason IN (?, ?) THEN NULL ELSE reason END,
            requestedAt
          FROM execution_stop_targets`)
        .run(
          legacyUncertainInterruptReason,
          legacyUncertainInterruptReason,
          legacyFailedInterruptReason,
        );
      this.db.exec(`DROP TABLE execution_stop_targets;
        ALTER TABLE execution_stop_targets_typed RENAME TO execution_stop_targets;`);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Stop target migration broke a foreign key");
    });
  }

  /** Converts only the known legacy Stop reason, once, while preserving display text. */
  private migrateTaskStopHoldKind(): void {
    const hasTurnRequests =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_requests'",
        )
        .get() !== undefined;
    const tables = ["task_writer_holds", "execution_intents"];
    if (hasTurnRequests) tables.push("turn_requests");
    const tablesMissingHoldKind = tables.filter(
      (table) =>
        !(
          this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).some(({ name }) => name === "holdKind"),
    );
    const holdColumns = this.db
      .prepare("PRAGMA table_info(task_writer_holds)")
      .all() as Array<{ name: string; pk: number }>;
    const taskIdPrimaryKey =
      holdColumns.filter(({ pk }) => pk > 0).length === 1 &&
      holdColumns.find(({ name }) => name === "taskId")?.pk === 1;
    const holdKindIndex = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='task_writer_holds_task_kind'",
      )
      .get() as { sql: string } | undefined;
    const indexSql = holdKindIndex?.sql
      ?.toLowerCase()
      .replaceAll('"', "")
      .replaceAll(/\s/g, "");
    if (
      tablesMissingHoldKind.length === 0 &&
      !taskIdPrimaryKey &&
      indexSql?.includes("coalesce(holdkind,'unknown')")
    )
      return;

    transaction(this.db, () => {
      for (const table of tablesMissingHoldKind)
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN holdKind TEXT
          CHECK(holdKind IS NULL OR holdKind = 'operator-stop')`);
      if (tablesMissingHoldKind.includes("task_writer_holds"))
        this.db.exec(`UPDATE task_writer_holds SET holdKind = 'operator-stop'
          WHERE reason = 'Task stopped'`);
      if (tablesMissingHoldKind.includes("execution_intents"))
        this.db.exec(`UPDATE execution_intents SET holdKind = 'operator-stop'
          WHERE reason = 'Task stopped' AND EXISTS (
          SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = execution_intents.workId
            AND hold.holdKind = 'operator-stop'
        )`);
      if (tablesMissingHoldKind.includes("turn_requests"))
        this.db.exec(`UPDATE turn_requests SET holdKind = 'operator-stop'
          WHERE reason = 'Task stopped' AND EXISTS (
            SELECT 1 FROM task_execution_bindings binding
            JOIN task_writer_holds hold ON hold.taskId = binding.taskId
            WHERE binding.workId = turn_requests.workId
              AND hold.holdKind = 'operator-stop'
          )`);

      // Earlier schemas keyed this table only by taskId, which prevented an
      // independent ownership hold and operator Stop from coexisting. Rebuild
      // the table transactionally while preserving every stored row and its
      // display reason, then enforce one row per task and hold kind. This also
      // runs for the already-typed schema introduced before this migration.
      const currentHoldColumns = this.db
        .prepare("PRAGMA table_info(task_writer_holds)")
        .all() as Array<{ name: string; pk: number }>;
      const stillHasTaskIdPrimaryKey =
        currentHoldColumns.filter(({ pk }) => pk > 0).length === 1 &&
        currentHoldColumns.find(({ name }) => name === "taskId")?.pk === 1;
      if (stillHasTaskIdPrimaryKey) {
        this.db.exec("DROP INDEX IF EXISTS task_writer_holds_task_kind");
        this.db.exec(`CREATE TABLE task_writer_holds_rebuild (
          taskId TEXT, reason TEXT NOT NULL,
          holdKind TEXT CHECK(holdKind IS NULL OR holdKind = 'operator-stop')
        )`);
        this.db.exec(`INSERT INTO task_writer_holds_rebuild (taskId, reason, holdKind)
          SELECT taskId, reason, holdKind FROM task_writer_holds`);
        this.db.exec("DROP TABLE task_writer_holds");
        this.db.exec(
          "ALTER TABLE task_writer_holds_rebuild RENAME TO task_writer_holds",
        );
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS task_writer_holds_task_kind
        ON task_writer_holds(taskId, COALESCE(holdKind, 'unknown'))`);
    });
  }

  private migratePreTurnReceipts(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(execution_recovery_receipts)")
      .all() as Array<{ name: string; notnull: number }>;
    const stored = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='execution_recovery_receipts'",
      )
      .get() as { sql: string };
    const normalize = (sql: string) =>
      sql
        .replace(
          /"execution_recovery_receipts"/g,
          "execution_recovery_receipts",
        )
        .split(/('(?:[^']|'')*')/)
        .map((part) =>
          part.startsWith("'") ? part : part.replace(/\s+/g, "").toUpperCase(),
        )
        .join("");
    const current = `CREATE TABLE execution_recovery_receipts ${recoveryReceiptColumns}`;
    const legacy = current
      .replace("threadId TEXT,", "threadId TEXT NOT NULL,")
      .replace("turnId TEXT,", "turnId TEXT NOT NULL,");
    const names = [
      "id",
      "workId",
      "workRevision",
      "requestSequence",
      "threadId",
      "turnId",
      "processId",
      "processStartedAt",
      "bootId",
      "terminationMethod",
      "terminationVerifiedAt",
      "effectsState",
      "workspaceDisposition",
      "createdAt",
    ];
    if (
      ![normalize(current), normalize(legacy)].includes(
        normalize(stored.sql),
      ) ||
      JSON.stringify(columns.map((c) => c.name)) !== JSON.stringify(names) ||
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE tbl_name='execution_recovery_receipts' AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .get()
    )
      throw new Error(
        "Unrecognized recovery receipt schema; migration refused",
      );
    if (
      columns.some(
        (c) =>
          (c.name === "threadId" || c.name === "turnId") && c.notnull === 1,
      )
    ) {
      const foreignKeys = (
        this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
      ).foreign_keys;
      this.db.exec("PRAGMA foreign_keys = OFF");
      let started = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        started = true;
        this.db.exec(`CREATE TABLE execution_recovery_receipts_nullable ${recoveryReceiptColumns};
          INSERT INTO execution_recovery_receipts_nullable SELECT * FROM execution_recovery_receipts;
          DROP TABLE execution_recovery_receipts;
          ALTER TABLE execution_recovery_receipts_nullable RENAME TO execution_recovery_receipts;`);
        if (this.db.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error("Pre-turn receipt migration broke a foreign key");
        this.db.exec("COMMIT");
        started = false;
      } catch (error) {
        if (started) this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
      }
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_pre_turn_rejections (
      id TEXT PRIMARY KEY, workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      source TEXT NOT NULL CHECK(source IN ('runtime','operator-adopted')),
      contextMaterial TEXT NOT NULL, evidenceMaterial TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_pre_turn_receipts (
      receiptId TEXT PRIMARY KEY REFERENCES execution_recovery_receipts(id),
      workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      witnessId TEXT NOT NULL UNIQUE REFERENCES execution_pre_turn_rejections(id), witnessMaterial TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_no_turn_submissions (
      id TEXT PRIMARY KEY, workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      contextMaterial TEXT NOT NULL, evidenceMaterial TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_no_turn_receipts (
      receiptId TEXT PRIMARY KEY REFERENCES execution_recovery_receipts(id),
      workId TEXT NOT NULL UNIQUE REFERENCES execution_intents(workId),
      witnessId TEXT NOT NULL UNIQUE REFERENCES execution_no_turn_submissions(id), witnessMaterial TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_pre_turn_commands (
      commandKey TEXT PRIMARY KEY, scope TEXT NOT NULL, payloadMaterial TEXT NOT NULL, result TEXT NOT NULL
    );`);
  }

  preTurnCommandReplay(
    scope: string,
    command: { key: string },
  ): Record<string, string | number> | undefined {
    const row = this.db
      .prepare(
        "SELECT scope,payloadMaterial,result FROM execution_pre_turn_commands WHERE commandKey = ?",
      )
      .get(command.key) as
      | { scope: string; payloadMaterial: string; result: string }
      | undefined;
    if (!row) return undefined;
    if (
      row.scope !== scope ||
      row.payloadMaterial !== canonicalMaterial(command)
    )
      throw new RecoveryRejectedError(
        "Pre-turn command key was reused with different material",
      );
    return JSON.parse(row.result) as Record<string, string | number>;
  }
  /** One recorded recovery command by key, for read-only receipt readback. */
  preTurnCommandRecord(
    key: string,
  ): { scope: string; payloadMaterial: string; result: string } | undefined {
    return this.db
      .prepare(
        "SELECT scope,payloadMaterial,result FROM execution_pre_turn_commands WHERE commandKey = ?",
      )
      .get(key) as
      | { scope: string; payloadMaterial: string; result: string }
      | undefined;
  }
  private recordPreTurnCommand(
    scope: string,
    command: { key: string },
    result: unknown,
  ): void {
    this.db
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
  private preTurnContext(
    workId: string,
  ): Record<string, string | number | null> | undefined {
    if (!this.hasTurnRequests) return undefined;
    return this.db
      .prepare(`SELECT request.workId, revision.workRevision, request.sequence AS requestSequence,
      request.taskId, request.projectId, request.assignmentId, request.taskVersion, request.assignmentVersion,
      request.instructionsRevision, request.profileRevision, binding.conversationRevision,
      identity.processId, identity.processStartedAt, identity.bootId, intent.workspace,
      admission.sequence AS writerSequence, predecessor.workId AS predecessorWorkId,
      predecessor.threadId AS predecessorThreadId, predecessor.turnId AS predecessorTurnId
    FROM turn_requests request JOIN execution_intents intent ON intent.workId=request.workId
    JOIN execution_recovery_identities identity ON identity.workId=request.workId
    JOIN task_work_revisions revision ON revision.workId=request.workId
    JOIN task_execution_bindings binding ON binding.workId=request.workId
    JOIN task_writer_admissions admission ON admission.workId=request.workId
    JOIN execution_request_predecessors link ON link.workId=request.workId AND link.predecessorKnown=1
    JOIN execution_intents predecessor ON predecessor.workId=request.previousWorkId AND predecessor.workId=link.previousWorkId
    JOIN task_execution_bindings priorBinding ON priorBinding.workId=predecessor.workId
    WHERE request.workId=? AND request.kind='assignment'
      AND intent.state IN ('submitting','held','reconciled')
      AND intent.threadId IS NULL AND intent.turnId IS NULL AND identity.threadId IS NULL AND identity.turnId IS NULL
      AND identity.workRevision=revision.workRevision AND identity.requestSequence=request.sequence
      AND identity.processId IS NOT NULL AND identity.processStartedAt IS NOT NULL AND identity.bootId IS NOT NULL
      AND binding.taskId=request.taskId AND binding.assignmentId=request.assignmentId
      AND binding.assignmentVersion=request.assignmentVersion AND binding.instructionsRevision=request.instructionsRevision
      AND binding.profileRevision=request.profileRevision AND revision.assignmentId=request.assignmentId
      AND revision.conversationRevision=binding.conversationRevision AND admission.workspace=intent.workspace
      AND predecessor.state='completed' AND predecessor.threadId IS NOT NULL AND predecessor.turnId IS NOT NULL
      AND priorBinding.taskId=binding.taskId AND priorBinding.assignmentId=binding.assignmentId
      AND priorBinding.conversationRevision=binding.conversationRevision`)
      .get(workId) as Record<string, string | number | null> | undefined;
  }
  private noTurnContext(
    workId: string,
  ): Record<string, string | number | null> | undefined {
    if (!this.hasTurnRequests) return undefined;
    return this.db
      .prepare(`SELECT request.workId, revision.workRevision, request.sequence AS requestSequence,
      request.taskId, request.projectId, request.assignmentId, request.taskVersion, request.assignmentVersion,
      request.instructionsRevision, request.profileRevision, binding.conversationRevision,
      identity.processId, identity.processStartedAt, identity.bootId, intent.workspace,
      admission.sequence AS writerSequence, link.previousWorkId AS predecessorWorkId,
      link.predecessorKnown
    FROM turn_requests request JOIN execution_intents intent ON intent.workId=request.workId
    JOIN execution_recovery_identities identity ON identity.workId=request.workId
    JOIN task_work_revisions revision ON revision.workId=request.workId
    JOIN task_execution_bindings binding ON binding.workId=request.workId
    JOIN task_writer_admissions admission ON admission.workId=request.workId
    JOIN execution_request_predecessors link ON link.workId=request.workId AND link.predecessorKnown=1
    WHERE request.workId=? AND request.kind='assignment'
      AND intent.state IN ('submitting','held','reconciled')
      AND intent.threadId IS NULL AND intent.turnId IS NULL AND identity.threadId IS NULL AND identity.turnId IS NULL
      AND identity.workRevision=revision.workRevision AND identity.requestSequence=request.sequence
      AND identity.processId IS NOT NULL AND identity.processStartedAt IS NOT NULL AND identity.bootId IS NOT NULL
      AND binding.taskId=request.taskId AND binding.assignmentId=request.assignmentId
      AND binding.assignmentVersion=request.assignmentVersion AND binding.instructionsRevision=request.instructionsRevision
      AND binding.profileRevision=request.profileRevision AND revision.assignmentId=request.assignmentId
      AND revision.conversationRevision=binding.conversationRevision AND admission.workspace=intent.workspace
      AND request.previousWorkId IS NULL AND link.previousWorkId IS NULL`)
      .get(workId) as Record<string, string | number | null> | undefined;
  }
  /**
   * The exact identity each recovery command binds for one work, read with the same
   * joins the commands re-check; undefined when the work has no execution intent.
   */
  recoveryMaterial(workId: string):
    | {
        preTurn: Record<string, string | number | null> | undefined;
        noTurn: Record<string, string | number | null> | undefined;
        intent: { state: string; reason: string | null };
        request: { state: string; reason: string | null } | undefined;
        assignmentId: string | null;
      }
    | undefined {
    const intent = this.db
      .prepare("SELECT state, reason FROM execution_intents WHERE workId=?")
      .get(workId) as { state: string; reason: string | null } | undefined;
    if (!intent) return undefined;
    const request = this.hasTurnRequests
      ? (this.db
          .prepare(
            "SELECT state, reason, assignmentId FROM turn_requests WHERE workId=?",
          )
          .get(workId) as
          | {
              state: string;
              reason: string | null;
              assignmentId: string | null;
            }
          | undefined)
      : undefined;
    return {
      preTurn: this.preTurnContext(workId),
      noTurn: this.noTurnContext(workId),
      intent: { state: intent.state, reason: intent.reason },
      request: request && { state: request.state, reason: request.reason },
      assignmentId:
        this.taskBinding(workId)?.assignmentId ?? request?.assignmentId ?? null,
    };
  }
  /** What conversation replacement re-checks, read without changing anything. */
  replacementFacts(assignmentId: string) {
    const conversation = this.db
      .prepare(
        "SELECT revision FROM assignment_conversations WHERE assignmentId=?",
      )
      .get(assignmentId) as { revision: number } | undefined;
    return {
      conversationRevision: conversation?.revision ?? 1,
      unresolvedExecution: this.assignmentHasUnresolvedExecution(assignmentId),
    };
  }
  private noTurnWitnessForWork(workId: string):
    | {
        id: string;
        workId: string;
        contextMaterial: string;
        evidenceMaterial: string;
      }
    | undefined {
    const witness = this.db
      .prepare("SELECT * FROM execution_no_turn_submissions WHERE workId=?")
      .get(workId) as
      | {
          id: string;
          workId: string;
          contextMaterial: string;
          evidenceMaterial: string;
        }
      | undefined;
    const context = this.noTurnContext(workId);
    if (
      !witness ||
      !context ||
      canonicalMaterial(context) !== witness.contextMaterial
    )
      return undefined;
    try {
      const value = historicalNoTurnAdoptionSchema.parse(
        JSON.parse(witness.evidenceMaterial),
      );
      if (
        value.workId !== workId ||
        value.workRevision !== context.workRevision ||
        value.requestSequence !== context.requestSequence ||
        value.conversationRevision !== context.conversationRevision ||
        value.writerSequence !== context.writerSequence ||
        value.processIdentity.processId !== context.processId ||
        value.processIdentity.processStartedAt !== context.processStartedAt ||
        value.processIdentity.bootId !== context.bootId
      )
        return undefined;
      const replay = this.preTurnCommandReplay("adopt-no-turn", value);
      if (replay?.witnessId !== witness.id || replay.workId !== workId)
        return undefined;
      return witness;
    } catch {
      return undefined;
    }
  }
  adoptHistoricalNoTurnSubmission(command: HistoricalNoTurnAdoption): {
    witnessId: string;
    workId: string;
  } {
    const value = historicalNoTurnAdoptionSchema.parse(command);
    const replay = this.preTurnCommandReplay("adopt-no-turn", value);
    if (replay)
      return z
        .object({ witnessId: z.string().uuid(), workId: z.string().min(1) })
        .strict()
        .parse(replay);
    return transaction(this.db, () => {
      const context = this.noTurnContext(value.workId);
      const intent = this.db
        .prepare("SELECT state,reason FROM execution_intents WHERE workId=?")
        .get(value.workId) as { state: string; reason: string } | undefined;
      const request = this.db
        .prepare("SELECT state,reason FROM turn_requests WHERE workId=?")
        .get(value.workId) as { state: string; reason: string } | undefined;
      if (
        !context ||
        intent?.state !== "held" ||
        request?.state !== "held" ||
        intent.reason !== value.retainedReason ||
        request.reason !== value.retainedReason ||
        context.workRevision !== value.workRevision ||
        context.requestSequence !== value.requestSequence ||
        context.conversationRevision !== value.conversationRevision ||
        context.writerSequence !== value.writerSequence ||
        context.processId !== value.processIdentity.processId ||
        context.processStartedAt !== value.processIdentity.processStartedAt ||
        context.bootId !== value.processIdentity.bootId ||
        !this.db
          .prepare(
            "SELECT 1 FROM execution_capacity_reservations WHERE workId=?",
          )
          .get(value.workId) ||
        this.db
          .prepare("SELECT 1 FROM execution_pre_turn_rejections WHERE workId=?")
          .get(value.workId)
      )
        throw new RecoveryRejectedError(
          "Historical no-turn adoption does not match the exact held generation",
        );
      if (
        this.db
          .prepare("SELECT 1 FROM execution_no_turn_submissions WHERE workId=?")
          .get(value.workId)
      )
        throw new RecoveryRejectedError(
          "Historical no-turn submission is already recorded for this generation",
        );
      const result = { witnessId: randomUUID(), workId: value.workId };
      this.db
        .prepare(
          "INSERT INTO execution_no_turn_submissions (id,workId,contextMaterial,evidenceMaterial) VALUES (?,?,?,?)",
        )
        .run(
          result.witnessId,
          value.workId,
          canonicalMaterial(context),
          canonicalMaterial(value),
        );
      this.recordPreTurnCommand("adopt-no-turn", value, result);
      return result;
    });
  }

  private witnessForWork(workId: string):
    | {
        id: string;
        workId: string;
        source: "runtime" | "operator-adopted";
        contextMaterial: string;
        evidenceMaterial: string;
      }
    | undefined {
    const witness = this.db
      .prepare("SELECT * FROM execution_pre_turn_rejections WHERE workId=?")
      .get(workId) as
      | {
          id: string;
          workId: string;
          source: "runtime" | "operator-adopted";
          contextMaterial: string;
          evidenceMaterial: string;
        }
      | undefined;
    const context = this.preTurnContext(workId);
    if (
      !witness ||
      !context ||
      canonicalMaterial(context) !== witness.contextMaterial
    )
      return undefined;
    try {
      const evidence = JSON.parse(witness.evidenceMaterial);
      const value =
        witness.source === "runtime"
          ? archivedResumeRejectionSchema.parse(evidence)
          : historicalPreTurnAdoptionSchema.parse(evidence);
      const threadId =
        "threadId" in value ? value.threadId : value.predecessorThreadId;
      if (
        threadId !== context.predecessorThreadId ||
        value.processIdentity.processId !== context.processId ||
        value.processIdentity.processStartedAt !== context.processStartedAt ||
        value.processIdentity.bootId !== context.bootId
      )
        return undefined;
      if (witness.source === "operator-adopted") {
        const replay = this.preTurnCommandReplay(
          "adopt",
          value as HistoricalPreTurnAdoption,
        );
        if (replay?.witnessId !== witness.id || replay.workId !== workId)
          return undefined;
      }
      return witness;
    } catch {
      return undefined;
    }
  }
  capturePreTurnRejection(
    workId: string,
    rejection: ArchivedResumeRejection,
  ): boolean {
    const value = archivedResumeRejectionSchema.parse(rejection);
    return transaction(this.db, () => {
      const context = this.preTurnContext(workId);
      const intent = this.db
        .prepare("SELECT id,state FROM execution_intents WHERE workId=?")
        .get(workId) as { id: string; state: string } | undefined;
      if (
        !context ||
        intent?.state !== "submitting" ||
        value.threadId !== context.predecessorThreadId ||
        value.processIdentity.processId !== context.processId ||
        value.processIdentity.processStartedAt !== context.processStartedAt ||
        value.processIdentity.bootId !== context.bootId
      )
        return false;
      this.db
        .prepare(
          "INSERT INTO execution_pre_turn_rejections (id,workId,source,contextMaterial,evidenceMaterial) VALUES (?,?,'runtime',?,?)",
        )
        .run(
          randomUUID(),
          workId,
          canonicalMaterial(context),
          canonicalMaterial(value),
        );
      this.hold(
        intent.id,
        `Runtime submission or observation uncertain: Error: ${JSON.stringify(value.error)}`,
      );
      return true;
    });
  }
  adoptHistoricalPreTurnRejection(command: HistoricalPreTurnAdoption): {
    witnessId: string;
    workId: string;
  } {
    const value = historicalPreTurnAdoptionSchema.parse(command);
    const replay = this.preTurnCommandReplay("adopt", value);
    if (replay)
      return z
        .object({ witnessId: z.string().uuid(), workId: z.string().min(1) })
        .strict()
        .parse(replay);
    return transaction(this.db, () => {
      const context = this.preTurnContext(value.workId);
      const intent = this.db
        .prepare("SELECT state,reason FROM execution_intents WHERE workId=?")
        .get(value.workId) as { state: string; reason: string } | undefined;
      const request = this.db
        .prepare("SELECT state,reason FROM turn_requests WHERE workId=?")
        .get(value.workId) as { state: string; reason: string } | undefined;
      if (
        !context ||
        intent?.state !== "held" ||
        request?.state !== "held" ||
        intent.reason !== value.retainedReason ||
        request.reason !== value.retainedReason ||
        value.retainedReason !==
          `Runtime submission or observation uncertain: Error: ${JSON.stringify(value.rpcError)}` ||
        context.workRevision !== value.workRevision ||
        context.requestSequence !== value.requestSequence ||
        context.predecessorWorkId !== value.predecessorWorkId ||
        context.predecessorThreadId !== value.predecessorThreadId ||
        context.processId !== value.processIdentity.processId ||
        context.processStartedAt !== value.processIdentity.processStartedAt ||
        context.bootId !== value.processIdentity.bootId ||
        !this.db
          .prepare(
            "SELECT 1 FROM execution_capacity_reservations WHERE workId=?",
          )
          .get(value.workId)
      )
        throw new RecoveryRejectedError(
          "Historical pre-turn adoption does not match the exact held generation",
        );
      if (
        this.db
          .prepare("SELECT 1 FROM execution_pre_turn_rejections WHERE workId=?")
          .get(value.workId)
      )
        throw new RecoveryRejectedError(
          "Pre-turn rejection witness is already recorded for this generation",
        );
      const result = { witnessId: randomUUID(), workId: value.workId };
      this.db
        .prepare(
          "INSERT INTO execution_pre_turn_rejections (id,workId,source,contextMaterial,evidenceMaterial) VALUES (?,?,'operator-adopted',?,?)",
        )
        .run(
          result.witnessId,
          value.workId,
          canonicalMaterial(context),
          canonicalMaterial(value),
        );
      this.recordPreTurnCommand("adopt", value, result);
      return result;
    });
  }
  replaceConversationCommand(command: ReplaceConversationCommand): {
    revision: number;
  } {
    const value = replaceConversationCommandSchema.parse(command);
    const replay = this.preTurnCommandReplay("replace-conversation", value);
    if (replay)
      return z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(replay);
    return transaction(this.db, () => {
      const assignment = this.db
        .prepare("SELECT version,taskId FROM domain_assignments WHERE id=?")
        .get(value.assignmentId) as
        | { version: number; taskId: string }
        | undefined;
      const conversation = this.db
        .prepare(
          "SELECT revision FROM assignment_conversations WHERE assignmentId=?",
        )
        .get(value.assignmentId) as { revision: number } | undefined;
      if (
        !assignment ||
        assignment.version !== value.expectedAssignmentVersion ||
        (conversation?.revision ?? 1) !== value.expectedConversationRevision
      )
        throw new RecoveryRejectedError(
          "Conversation replacement material is stale",
        );
      if (
        this.db
          .prepare(
            `SELECT 1 FROM task_writer_holds WHERE taskId=? UNION SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId=? UNION SELECT 1 FROM task_archival_holds WHERE taskId=?`,
          )
          .get(assignment.taskId, assignment.taskId, assignment.taskId)
      )
        throw new RecoveryRejectedError("Task remains held for recovery");
      const result = { revision: this.replaceConversation(value.assignmentId) };
      this.recordPreTurnCommand("replace-conversation", value, result);
      return result;
    });
  }

  /** Recheck the distinct bound-turn or pre-turn proof on every use. */
  reconciledAssignmentProof(
    workId: string,
  ): ReconciledAssignmentProof | undefined {
    if (!this.hasTurnRequests) return undefined;
    const row = this.db
      .prepare(`SELECT receipt.*, request.taskId, request.projectId,
        request.assignmentId, request.taskVersion, request.assignmentVersion,
        request.instructionsRevision, request.profileRevision,
        binding.conversationRevision, intent.workspace, admission.sequence AS writerSequence
      FROM execution_recovery_receipts receipt
      JOIN execution_intents intent ON intent.workId = receipt.workId
      JOIN turn_requests request ON request.workId = receipt.workId
      JOIN execution_recovery_identities identity ON identity.workId = receipt.workId
      JOIN task_execution_bindings binding ON binding.workId = receipt.workId
      JOIN task_work_revisions revision ON revision.workId = receipt.workId
      JOIN task_writer_admissions admission ON admission.workId = receipt.workId
      JOIN domain_tasks task ON task.id = request.taskId AND task.projectId = request.projectId
      JOIN domain_assignments assignment ON assignment.id = request.assignmentId
        AND assignment.taskId = request.taskId AND assignment.projectId = request.projectId
      WHERE receipt.workId = ? AND intent.state = 'reconciled'
        AND request.kind = 'assignment' AND request.state = 'held'
        AND request.reason = 'Execution reconciled; no automatic successor'
        AND request.sequence = receipt.requestSequence
        AND identity.requestSequence = receipt.requestSequence
        AND revision.workRevision = receipt.workRevision
        AND identity.workRevision = receipt.workRevision
        AND revision.assignmentId = request.assignmentId
        AND revision.conversationRevision = binding.conversationRevision
        AND binding.taskId = request.taskId AND binding.assignmentId = request.assignmentId
        AND binding.assignmentVersion = request.assignmentVersion
        AND binding.instructionsRevision = request.instructionsRevision
        AND binding.profileRevision = request.profileRevision
        AND intent.threadId IS receipt.threadId AND identity.threadId IS receipt.threadId
        AND intent.turnId IS receipt.turnId AND identity.turnId IS receipt.turnId
        AND identity.processId = receipt.processId
        AND identity.processStartedAt = receipt.processStartedAt
        AND identity.bootId = receipt.bootId
        AND admission.workspace = intent.workspace
        AND receipt.effectsState = 'settled'
        AND receipt.workspaceDisposition IN ('preserved','reconciled')
        AND receipt.terminationMethod = 'mac-pid-absent-same-boot'
        AND NOT EXISTS (SELECT 1 FROM execution_capacity_reservations WHERE workId = receipt.workId)
        AND NOT EXISTS (SELECT 1 FROM execution_pending_effects WHERE workId = receipt.workId AND state = 'pending')
        AND NOT EXISTS (SELECT 1 FROM execution_stop_targets WHERE taskId = request.taskId AND terminalState != 'completed')
        AND NOT EXISTS (SELECT 1 FROM task_writer_holds WHERE taskId = request.taskId)
        AND NOT EXISTS (SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId = request.taskId)
        AND NOT EXISTS (SELECT 1 FROM task_archival_holds WHERE taskId = request.taskId)
        AND NOT EXISTS (SELECT 1 FROM task_work_revision_ambiguities WHERE assignmentId = request.assignmentId)
        AND NOT EXISTS (SELECT 1 FROM execution_request_refusals WHERE workId = receipt.workId)`)
      .get(z.string().min(1).max(512).parse(workId)) as
      | Record<string, string | number | null>
      | undefined;
    if (
      !row ||
      !z
        .string()
        .datetime({ offset: true })
        .safeParse(row.terminationVerifiedAt).success
    )
      return undefined;
    const discriminator = this.db
      .prepare("SELECT * FROM execution_pre_turn_receipts WHERE receiptId=?")
      .get(String(row.id)) as
      | {
          receiptId: string;
          workId: string;
          witnessId: string;
          witnessMaterial: string;
        }
      | undefined;
    const noTurnDiscriminator = this.db
      .prepare("SELECT * FROM execution_no_turn_receipts WHERE receiptId=?")
      .get(String(row.id)) as
      | {
          receiptId: string;
          workId: string;
          witnessId: string;
          witnessMaterial: string;
        }
      | undefined;
    let material = JSON.stringify(row);
    if (row.threadId === null && row.turnId === null) {
      const preTurnWitness = this.witnessForWork(workId);
      const noTurnWitness = this.noTurnWitnessForWork(workId);
      const witness = noTurnWitness ?? preTurnWitness;
      const proofDiscriminator = noTurnDiscriminator ?? discriminator;
      const mixed =
        Boolean(noTurnDiscriminator && discriminator) ||
        Boolean(noTurnWitness && preTurnWitness) ||
        Boolean(
          noTurnDiscriminator &&
            this.db
              .prepare(
                "SELECT 1 FROM execution_pre_turn_rejections WHERE workId=?",
              )
              .get(workId),
        ) ||
        Boolean(
          discriminator &&
            this.db
              .prepare(
                "SELECT 1 FROM execution_no_turn_submissions WHERE workId=?",
              )
              .get(workId),
        );
      const conversation = this.db
        .prepare(
          "SELECT revision FROM assignment_conversations WHERE assignmentId=?",
        )
        .get(String(row.assignmentId)) as { revision: number } | undefined;
      if (
        !witness ||
        mixed ||
        !proofDiscriminator ||
        Boolean(noTurnWitness) !== Boolean(noTurnDiscriminator) ||
        proofDiscriminator.workId !== workId ||
        proofDiscriminator.witnessId !== witness.id ||
        proofDiscriminator.witnessMaterial !== canonicalMaterial(witness) ||
        (conversation?.revision ?? 1) <= Number(row.conversationRevision)
      )
        return undefined;
      material = noTurnWitness
        ? JSON.stringify({ receipt: row, noTurnWitness, noTurnDiscriminator })
        : JSON.stringify({ receipt: row, witness, discriminator });
    } else if (
      row.threadId === null ||
      row.turnId === null ||
      discriminator ||
      noTurnDiscriminator ||
      this.db
        .prepare("SELECT 1 FROM execution_no_turn_submissions WHERE workId=?")
        .get(workId) ||
      this.db
        .prepare("SELECT 1 FROM execution_pre_turn_rejections WHERE workId=?")
        .get(workId)
    )
      return undefined;
    return {
      workId,
      receiptId: String(row.id),
      taskId: String(row.taskId),
      assignmentId: String(row.assignmentId),
      assignmentVersion: Number(row.assignmentVersion),
      material,
    };
  }

  /** A post-continuation survivor invalidates recovery without rewriting its history. */
  holdReconciledContinuationSurvivor(workId: string, reason: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO task_writer_ambiguity_holds (taskId, reason)
      SELECT binding.taskId, ? FROM task_execution_bindings binding
      JOIN execution_intents intent ON intent.workId = binding.workId
      JOIN coordination_recovery_continuations audit ON audit.workId = binding.workId
      WHERE binding.workId = ? AND intent.state = 'reconciled'`)
      .run(
        z.string().min(1).max(1000).parse(reason),
        z.string().min(1).max(512).parse(workId),
      );
  }

  /**
   * The task's work that is queued, running or held other than a request refused before it
   * ran, or that holds writer, capacity or effect state. Unless something else resolved it
   * (see `CoordinationStore.isHistoricalWorkResolved`), it may still be live.
   */
  unsettledTaskWorkIds(taskId: string): string[] {
    if (!this.hasTurnRequests) return [];
    const rows = this.db
      .prepare(`SELECT request.workId, request.state FROM turn_requests request
          WHERE request.taskId = ? AND request.state IN ('queued','active','held')
          UNION
          SELECT intent.workId, intent.state FROM task_execution_bindings binding
          JOIN execution_intents intent ON intent.workId = binding.workId
          WHERE binding.taskId = ? AND (
            intent.state IN ('ready','capacity-waiting','held','submitting','running')
            OR (intent.state NOT IN ('completed','reconciled','resolved-failed') AND (
              EXISTS (SELECT 1 FROM task_writer_admissions a WHERE a.workId = intent.workId)
              OR EXISTS (SELECT 1 FROM execution_capacity_reservations c WHERE c.workId = intent.workId)
              OR EXISTS (SELECT 1 FROM execution_pending_effects e
                WHERE e.workId = intent.workId AND e.state = 'pending'))))`)
      .all(taskId, taskId) as { workId: string; state: string }[];
    return [
      ...new Set(
        rows
          .filter(
            ({ workId, state }) =>
              !(state === "held" && this.refusedBeforeStart(workId)),
          )
          .map(({ workId }) => workId),
      ),
    ];
  }

  /** Whether a bound, unrefused generation of the assignment is still unresolved. */
  assignmentHasUnresolvedExecution(assignmentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      WHERE b.assignmentId = ? AND e.state IN ('ready','capacity-waiting','held','submitting','running')
      AND NOT EXISTS (
        SELECT 1 FROM execution_request_refusals r WHERE r.workId = e.workId
      ) LIMIT 1`)
        .get(assignmentId) !== undefined
    );
  }

  replaceConversation(assignmentId: string): number {
    const id = z.string().uuid().parse(assignmentId);
    if (this.assignmentHasUnresolvedExecution(id))
      throw new RecoveryRejectedError("Assignment has unresolved execution");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO assignment_conversations (assignmentId, revision) VALUES (?, 1)",
      )
      .run(id);
    this.db
      .prepare(
        "UPDATE assignment_conversations SET revision = revision + 1 WHERE assignmentId = ?",
      )
      .run(id);
    return Number(
      (
        this.db
          .prepare(
            "SELECT revision FROM assignment_conversations WHERE assignmentId = ?",
          )
          .get(id) as { revision: number }
      ).revision,
    );
  }

  isCurrentResult(workId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      JOIN assignment_conversations c ON c.assignmentId = b.assignmentId
      JOIN domain_assignments a ON a.id = b.assignmentId
      JOIN task_work_revisions w ON w.workId = b.workId
      WHERE b.workId = ? AND e.state = 'completed' AND
        c.revision = b.conversationRevision AND a.version = b.assignmentVersion
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revision_ambiguities ambiguous
          WHERE ambiguous.assignmentId = b.assignmentId
          AND ambiguous.conversationRevision = b.conversationRevision
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_work_revisions newer
          WHERE newer.assignmentId = w.assignmentId
          AND newer.conversationRevision = w.conversationRevision
          AND newer.workRevision > w.workRevision
        )
      LIMIT 1`)
        .get(workId) !== undefined
    );
  }

  recordResult(workId: string, payload: string): boolean {
    const value = z.string().max(16000).parse(payload);
    const inserted = this.db
      .prepare(`INSERT OR IGNORE INTO task_execution_results (workId, payload)
      SELECT b.workId, ? FROM task_execution_bindings b
      JOIN execution_intents e ON e.workId = b.workId
      JOIN assignment_conversations c ON c.assignmentId = b.assignmentId
      JOIN domain_assignments a ON a.id = b.assignmentId
      JOIN task_work_revisions w ON w.workId = b.workId
      WHERE b.workId = ? AND e.state = 'completed'
      AND c.revision = b.conversationRevision AND a.version = b.assignmentVersion
      AND NOT EXISTS (
        SELECT 1 FROM task_work_revision_ambiguities ambiguous
        WHERE ambiguous.assignmentId = b.assignmentId
        AND ambiguous.conversationRevision = b.conversationRevision
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_work_revisions newer
        WHERE newer.assignmentId = w.assignmentId
        AND newer.conversationRevision = w.conversationRevision
        AND newer.workRevision > w.workRevision
      )
      RETURNING workId`)
      .get(value, workId);
    if (inserted) {
      this.db
        .prepare(`UPDATE execution_pending_effects
        SET state = 'settled', reason = NULL WHERE workId = ? AND effectKey = 'assignment-result'`)
        .run(workId);
      return true;
    }
    const existing = this.db
      .prepare("SELECT payload FROM task_execution_results WHERE workId = ?")
      .get(workId) as { payload: string } | undefined;
    if (existing && existing.payload !== value)
      throw new Error("Result already recorded with different content");
    return existing !== undefined && this.isCurrentResult(workId);
  }

  create(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
  ): ExecutionIntent {
    const input = z
      .object({
        workId: z.string().min(1),
        prompt: z.string().min(1),
        workspace: z.string().min(1),
        previousWorkId: z.string().min(1).nullable(),
      })
      .parse({
        workId,
        prompt,
        workspace,
        previousWorkId: previousWorkId ?? null,
      });
    const existing = this.byWorkId(input.workId);
    if (existing) {
      if (
        existing.prompt !== input.prompt ||
        existing.workspace !== input.workspace
      )
        throw new Error("Work ID already used with different content");
      const predecessor = this.db
        .prepare(`SELECT previousWorkId, predecessorKnown
        FROM execution_request_predecessors WHERE workId = ?`)
        .get(input.workId) as
        | { previousWorkId: string | null; predecessorKnown: number }
        | undefined;
      if (predecessor?.predecessorKnown !== 1)
        throw new Error("Work ID has unknown legacy predecessor identity");
      if (predecessor.previousWorkId !== input.previousWorkId)
        throw new Error("Work ID already used with different predecessor");
      return existing;
    }
    const id = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) VALUES (?, ?, ?, ?, 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')",
        )
        .run(id, input.workId, input.prompt, input.workspace);
      this.db
        .prepare(`INSERT INTO execution_request_predecessors
        (workId, previousWorkId, predecessorKnown) VALUES (?, ?, 1)`)
        .run(input.workId, input.previousWorkId);
    });
    return this.get(id);
  }

  get(id: string): ExecutionIntent {
    return intentSchema.parse(
      this.db.prepare("SELECT * FROM execution_intents WHERE id = ?").get(id),
    );
  }

  byWorkId(workId: string): ExecutionIntent | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_intents WHERE workId = ?")
      .get(workId);
    return row === undefined ? undefined : intentSchema.parse(row);
  }

  workspaceNormalizationPage(
    afterRowId: number,
    limit = 64,
  ): WorkspaceNormalizationRow[] {
    const cursor = z.number().int().nonnegative().safe().parse(afterRowId);
    const pageSize = z.number().int().min(1).max(128).parse(limit);
    return this.db
      .prepare(`SELECT intent.rowid AS cursor, intent.id, intent.workId,
        intent.workspace, binding.taskId, workspace.workspaceId,
        workspace.path AS workspacePath
        FROM execution_intents intent
        LEFT JOIN task_execution_bindings binding ON binding.workId = intent.workId
        LEFT JOIN task_workspace_bindings workspace ON workspace.taskId = binding.taskId
        WHERE intent.rowid > ? ORDER BY intent.rowid LIMIT ?`)
      .all(cursor, pageSize)
      .map((row) => {
        const value = z
          .object({
            cursor: z.number().int().positive().safe(),
            id: z.string().uuid(),
            workId: z.string().min(1),
            workspace: z.string().min(1),
            taskId: z.string().uuid().nullable(),
            workspaceId: z.string().uuid().nullable(),
            workspacePath: z.string().min(1).nullable(),
          })
          .strict()
          .parse(row);
        return value;
      });
  }

  /** Bound harnesses of the executions on a thread; a thread has one owner. */
  runtimeIdentityHarnesses(threadId: string): ExecutionHarness[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT COALESCE(binding.harness, drafting.harness, ?) AS harness
        FROM execution_intents intent
        LEFT JOIN task_execution_bindings binding
          ON binding.workId = intent.workId
        LEFT JOIN drafting_runs drafting
          ON intent.workId LIKE 'drafting:%' AND drafting.runId = substr(intent.workId, 10)
        WHERE intent.threadId = ?`)
        .all(
          defaultExecutionHarness,
          z.string().min(1).max(512).parse(threadId),
        ) as Array<{ harness: unknown }>
    ).map(({ harness }) => executionHarnessSchema.parse(harness));
  }

  executionsForRuntimeIdentity(
    threadId: string,
    turnId: string,
  ): ExecutionIntent[] {
    return this.db
      .prepare(`SELECT * FROM execution_intents
        WHERE threadId = ? AND (turnId = ? OR turnId IS NULL)
        ORDER BY rowid LIMIT 16`)
      .all(
        z.string().min(1).max(512).parse(threadId),
        z.string().min(1).max(512).parse(turnId),
      )
      .map((row) => intentSchema.parse(row));
  }

  executionsForTerminalIdentity(
    threadId: string,
    turnId: string,
  ): ExecutionIntent[] {
    return this.db
      .prepare(`SELECT * FROM execution_intents
        WHERE threadId = ? AND turnId = ? ORDER BY rowid`)
      .all(
        z.string().min(1).max(512).parse(threadId),
        z.string().min(1).max(512).parse(turnId),
      )
      .map((row) => intentSchema.parse(row));
  }

  activeExecutions(): ExecutionIntent[] {
    return this.db
      .prepare(`SELECT * FROM execution_intents
        WHERE state IN ('submitting','running') ORDER BY rowid`)
      .all()
      .map((row) => intentSchema.parse(row));
  }

  /** Distinct tasks with unfinished work bound to this harness: what a disable makes wait. */
  boundTaskCount(harness: ExecutionHarness): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT b.taskId) AS count
        FROM task_execution_bindings b JOIN execution_intents e ON e.workId = b.workId
        WHERE b.harness = ?
          AND e.state IN ('ready','capacity-waiting','held','submitting','running')`,
      )
      .get(harness) as { count: number };
    return row.count;
  }

  /** Whether an execution this harness owns may still need its runtime, held ones included. */
  hasRuntimeOwnedExecution(harness: ExecutionHarness): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM execution_intents e
          LEFT JOIN task_execution_bindings b ON b.workId = e.workId
          LEFT JOIN drafting_runs d
            ON e.workId LIKE 'drafting:%' AND d.runId = substr(e.workId, 10)
          WHERE e.state IN ('submitting','running','held')
            AND COALESCE(b.harness, d.harness, 'codex') = ? LIMIT 1`,
        )
        .get(harness) !== undefined
    );
  }

  activeOrLastCompleted(lastCompletedWorkId?: string): ExecutionIntent[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_intents
        WHERE state IN ('submitting','running')
          OR (state = 'completed' AND workId = ?)
        ORDER BY rowid`)
      .all(lastCompletedWorkId ?? "")
      .map((row) => intentSchema.parse(row));
    return rows;
  }

  hasCompetingTaskExecution(taskId: string, excludingWorkId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM task_execution_bindings binding
          JOIN execution_intents intent ON intent.workId = binding.workId
          WHERE binding.taskId = ? AND intent.workId <> ?
            AND intent.state IN ('submitting','running','held') LIMIT 1`)
        .get(z.string().uuid().parse(taskId), excludingWorkId) !== undefined
    );
  }

  holdReadyOnStartupFailure(reason: string): void {
    this.db
      .prepare(`UPDATE execution_intents SET state = 'held', reason = ?
        WHERE state = 'ready'`)
      .run(z.string().min(1).max(1024).parse(reason));
    if (this.hasTurnRequests)
      this.db
        .prepare(`UPDATE turn_requests SET state = 'held', reason = ?
          WHERE state = 'queued'`)
        .run(reason);
  }

  list(): ExecutionIntent[] {
    return this.db
      .prepare("SELECT * FROM execution_intents ORDER BY rowid")
      .all()
      .map((row) => intentSchema.parse(row));
  }

  hasTaskWorkspaceEvidence(taskId: string): boolean {
    const id = z.string().uuid().parse(taskId);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM task_execution_bindings WHERE taskId = ? LIMIT 1",
        )
        .get(id)
    )
      return true;
    return Boolean(
      this.hasTurnRequests &&
        this.db
          .prepare(`SELECT 1 FROM turn_requests WHERE taskId = ?
            AND (workspace IS NOT NULL OR previousWorkId IS NOT NULL) LIMIT 1`)
          .get(id),
    );
  }

  taskTurnRequests(taskId: string): TaskTurnRequest[] {
    if (!this.hasTurnRequests) return [];
    return this.db
      .prepare(`SELECT workId, assignmentId, assignmentVersion, sequence, state
        FROM turn_requests
        WHERE taskId = ? AND kind = 'assignment'
        ORDER BY sequence`)
      .all(z.string().uuid().parse(taskId))
      .map((row) => {
        const value = z
          .object({
            workId: z.string().min(1),
            assignmentId: z.string().uuid().nullable(),
            assignmentVersion: z.number().int().positive().nullable(),
            sequence: z.number().int().positive(),
            state: z.enum(["queued", "active", "completed", "held"]),
          })
          .parse(row);
        return value;
      });
  }

  recoveryIdentity(workId: string): RecoveryExecutionIdentity | undefined {
    const row = this.db
      .prepare(`SELECT identity.workId, identity.workRevision, identity.requestSequence,
      COALESCE(identity.threadId, intent.threadId) AS threadId,
      COALESCE(identity.turnId, intent.turnId) AS turnId,
      processId, processStartedAt, bootId
      FROM execution_recovery_identities identity
      JOIN execution_intents intent ON intent.workId = identity.workId
      WHERE identity.workId = ?`)
      .get(z.string().min(1).parse(workId)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const processIdentity =
      row.processId === null
        ? null
        : processIdentitySchema.parse({
            processId: row.processId,
            processStartedAt: row.processStartedAt,
            bootId: row.bootId,
          });
    return {
      workId: z.string().min(1).parse(row.workId),
      workRevision: z
        .number()
        .int()
        .positive()
        .nullable()
        .parse(row.workRevision),
      requestSequence: z.number().int().positive().parse(row.requestSequence),
      threadId: z.string().min(1).nullable().parse(row.threadId),
      turnId: z.string().min(1).nullable().parse(row.turnId),
      processIdentity,
    };
  }

  admittedWorkIds(): string[] {
    return (
      this.db
        .prepare(`SELECT intent.workId
      FROM task_writer_admissions admission
      JOIN execution_intents intent ON intent.workId = admission.workId
      WHERE intent.state IN ('held','submitting','running')
      ORDER BY admission.sequence`)
        .all() as Array<{ workId: string }>
    ).map((row) => row.workId);
  }

  powerAdmissionState(): PowerAdmissionState {
    const row = this.db
      .prepare(`SELECT cursor, wakeHeld, reason, revision
      FROM execution_power_supervision WHERE singleton = 1`)
      .get() as
      | {
          cursor: string | null;
          wakeHeld: number;
          reason: string | null;
          revision: number;
        }
      | undefined;
    if (!row) throw new Error("Power admission state is unavailable");
    let cursor: PowerEventCursor | null = null;
    let invalidCursor = false;
    if (row.cursor !== null) {
      try {
        cursor = powerEventCursorSchema.parse(JSON.parse(row.cursor));
      } catch {
        invalidCursor = true;
      }
    }
    return {
      cursor,
      held: row.wakeHeld === 1 || invalidCursor,
      reason: row.reason,
      revision: row.revision,
    };
  }

  holdPowerAdmission(reason: string): number {
    const safeReason = z.string().trim().min(1).max(200).parse(reason);
    return transaction(this.db, () => {
      const revision =
        (
          this.db
            .prepare(`SELECT revision FROM execution_power_supervision
        WHERE singleton = 1`)
            .get() as { revision: number }
        ).revision + 1;
      this.db
        .prepare(`UPDATE execution_power_supervision
        SET wakeHeld = 1, reason = ?, revision = ? WHERE singleton = 1`)
        .run(safeReason, revision);
      this.db
        .prepare(`INSERT INTO execution_power_reconciliation_pending (workId, revision)
        SELECT intent.workId, ? FROM task_writer_admissions admission
        JOIN execution_intents intent ON intent.workId = admission.workId
        WHERE intent.state IN ('held','submitting','running')
        ON CONFLICT(workId) DO UPDATE SET revision = excluded.revision`)
        .run(revision);
      return revision;
    });
  }

  setPowerCursorBaseline(cursor: PowerEventCursor): boolean {
    const value = powerEventCursorSchema.parse(cursor);
    return transaction(this.db, () => {
      const state = this.db
        .prepare(`SELECT wakeHeld FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { wakeHeld: number };
      const active = this.db
        .prepare(`SELECT 1 FROM task_writer_admissions admission
        JOIN execution_intents intent ON intent.workId = admission.workId
        WHERE intent.state IN ('held','submitting','running') LIMIT 1`)
        .get();
      const accepted = state.wakeHeld === 0 && active === undefined;
      if (accepted)
        this.db
          .prepare(`UPDATE execution_power_supervision
        SET cursor = ?, reason = NULL WHERE singleton = 1`)
          .run(JSON.stringify(value));
      return accepted;
    });
  }

  /**
   * Replaces `expected` with `cursor` while admission is unheld and no hold has
   * landed since `expectedRevision`. Unlike the baseline, it accepts admitted work.
   */
  advancePowerCursor(
    expected: PowerEventCursor,
    cursor: PowerEventCursor,
    expectedRevision: number,
  ): boolean {
    const previous = JSON.stringify(powerEventCursorSchema.parse(expected));
    const value = JSON.stringify(powerEventCursorSchema.parse(cursor));
    const revision = z.number().int().nonnegative().parse(expectedRevision);
    return transaction(this.db, () => {
      const state = this.db
        .prepare(`SELECT cursor, wakeHeld, revision FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { cursor: string | null; wakeHeld: number; revision: number };
      const accepted =
        state.wakeHeld === 0 &&
        state.revision === revision &&
        state.cursor === previous;
      if (accepted)
        this.db
          .prepare(`UPDATE execution_power_supervision
        SET cursor = ? WHERE singleton = 1`)
          .run(value);
      return accepted;
    });
  }

  completePowerReconciliation(
    cursor: PowerEventCursor,
    expectedRevision: number,
  ): boolean {
    const value = powerEventCursorSchema.parse(cursor);
    const revision = z.number().int().positive().parse(expectedRevision);
    return transaction(this.db, () => {
      const state = this.db
        .prepare(`SELECT wakeHeld, revision FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { wakeHeld: number; revision: number };
      const pending = this.db
        .prepare(`SELECT 1 FROM execution_power_reconciliation_pending LIMIT 1`)
        .get();
      const accepted =
        state.wakeHeld === 1 &&
        state.revision === revision &&
        pending === undefined;
      if (accepted)
        this.db
          .prepare(`UPDATE execution_power_supervision
        SET cursor = ?, wakeHeld = 0, reason = NULL WHERE singleton = 1 AND revision = ?`)
          .run(JSON.stringify(value), revision);
      return accepted;
    });
  }

  powerReconciliationPending(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS count
      FROM execution_power_reconciliation_pending`)
        .get() as { count: number }
    ).count;
  }

  recordRecoveryObservation(
    workId: string,
    kind: string,
    terminalStatus?: "completed" | "failed",
  ): void {
    const safeKind = z
      .enum([
        "exact-live",
        "exact-terminal-completed",
        "exact-terminal-failed",
        "historical-only",
        "conflicting",
        "no-proof",
        "unknown",
        "termination-verified",
        "termination-conflict",
        "termination-unknown",
        "receipt-accepted",
        "retry-enqueued",
      ])
      .parse(kind);
    transaction(this.db, () => {
      const identity = this.db
        .prepare("SELECT 1 FROM execution_recovery_identities WHERE workId = ?")
        .get(z.string().min(1).parse(workId));
      const admitted = this.db
        .prepare("SELECT 1 FROM task_writer_admissions WHERE workId = ?")
        .get(workId);
      if (!identity && !admitted)
        throw new Error("Execution recovery identity is unavailable");
      const parsedTerminal =
        terminalStatus === undefined
          ? undefined
          : z.enum(["completed", "failed"]).parse(terminalStatus);
      if (
        safeKind === "exact-terminal-completed" ||
        safeKind === "exact-terminal-failed"
      )
        this.db
          .prepare(`UPDATE execution_recovery_identities
          SET inspectionKind = ?, terminalStatus = ? WHERE workId = ?`)
          .run(
            safeKind,
            parsedTerminal ??
              (safeKind.endsWith("completed") ? "completed" : "failed"),
            workId,
          );
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt) VALUES (?, ?, ?, ?, ?)`)
        .run(
          randomUUID(),
          workId,
          safeKind,
          recoveryReason(safeKind),
          Date.now(),
        );
      this.db
        .prepare(`DELETE FROM execution_power_reconciliation_pending
        WHERE workId = ?`)
        .run(workId);
    });
  }

  /** Every recoverable execution; a drafting run has no recovery page, so it is left out. */
  recoveryView(): RecoveryRecord[] {
    return this.recoveryRecords(`SELECT workId FROM execution_recovery_identities
      ${
        this.hasTurnRequests
          ? "WHERE workId NOT IN (SELECT workId FROM turn_requests WHERE kind = 'drafting')"
          : ""
      }
      ORDER BY rowid`);
  }

  /** `recoveryView()` rows bound to one assignment version, optionally one work. */
  recoveryFor(
    assignmentId: string,
    assignmentVersion: number,
    workId?: string,
  ): RecoveryRecord[] {
    if (!Number.isSafeInteger(assignmentVersion)) return [];
    return this.recoveryRecords(
      `SELECT identity.workId FROM execution_recovery_identities identity
      JOIN task_execution_bindings binding ON binding.workId = identity.workId
      WHERE binding.assignmentId = ? AND binding.assignmentVersion = ?
      ${workId === undefined ? "" : "AND binding.workId = ?"}
      ORDER BY identity.rowid`,
      assignmentId,
      assignmentVersion,
      ...(workId === undefined ? [] : [workId]),
    );
  }

  /** `recoveryView()` rows bound to one task, plus one optional (possibly unbound) work. */
  recoveryForTask(taskId: string, alsoWorkId?: string): RecoveryRecord[] {
    return this.recoveryRecords(
      `SELECT identity.workId FROM execution_recovery_identities identity
      WHERE identity.workId IN (
        SELECT workId FROM task_execution_bindings WHERE taskId = ?
        UNION SELECT ?)
      ORDER BY identity.rowid`,
      taskId,
      alsoWorkId ?? null,
    );
  }

  /**
   * The rows `recoveryForTask(taskId)` would load (without `alsoWorkId`), counted
   * up to `limit`, reading at most `limit` index entries.
   */
  recoveryCountForTaskUpTo(taskId: string, limit: number): number {
    return Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS count FROM
          (SELECT 1 FROM task_execution_bindings binding
          JOIN execution_recovery_identities identity ON identity.workId = binding.workId
          WHERE binding.taskId = ? LIMIT ?)`)
          .get(taskId, limit) as { count: number }
      ).count,
    );
  }

  /** One task's intents with their bindings, in intent order. */
  taskExecutions(
    taskId: string,
  ): { intent: ExecutionIntent; binding: TaskExecutionBindingRecord }[] {
    return (
      this.db
        .prepare(`SELECT binding.workId FROM task_execution_bindings binding
        JOIN execution_intents intent ON intent.workId = binding.workId
        WHERE binding.taskId = ? ORDER BY intent.rowid`)
        .all(taskId) as Array<{ workId: string }>
    ).flatMap(({ workId }) => {
      const intent = this.byWorkId(workId),
        binding = this.taskBinding(workId);
      return intent && binding ? [{ intent, binding }] : [];
    });
  }

  private recoveryRecords(
    sql: string,
    ...parameters: (string | number | null)[]
  ): RecoveryRecord[] {
    const workIds = (
      this.db.prepare(sql).all(...parameters) as Array<{ workId: string }>
    ).map((row) => row.workId);
    return workIds.map((workId) => {
      const row = this.db
        .prepare(`SELECT intent.state, intent.reason,
        COALESCE(identity.threadId, intent.threadId) AS threadId,
        COALESCE(identity.turnId, intent.turnId) AS turnId,
        identity.workRevision, identity.requestSequence,
        identity.processId, identity.processStartedAt, identity.bootId
        FROM execution_intents intent
        JOIN execution_recovery_identities identity ON identity.workId = intent.workId
        WHERE intent.workId = ?`)
        .get(workId) as Record<string, unknown>;
      const requestRow = this.hasTurnRequests
        ? (this.db
            .prepare(
              "SELECT state, reason, assignmentId FROM turn_requests WHERE workId = ?",
            )
            .get(workId) as Record<string, unknown> | undefined)
        : undefined;
      const bindingRow = this.db
        .prepare(`SELECT taskId, assignmentId,
        assignmentVersion, instructionsRevision, profileRevision
        FROM task_execution_bindings WHERE workId = ?`)
        .get(workId) as Record<string, unknown> | undefined;
      const effectRows = this.db
        .prepare(`SELECT state FROM execution_pending_effects
        WHERE workId = ? AND state = 'pending' ORDER BY effectKey`)
        .all(workId) as Array<{ state: string }>;
      const observationRows = this.db
        .prepare(`SELECT kind FROM execution_recovery_observations
        WHERE workId = ? ORDER BY recordedAt, rowid`)
        .all(workId) as Array<{ kind: string }>;
      const holdRow = this.db
        .prepare(`SELECT (
          SELECT h.reason FROM task_writer_holds h
          WHERE h.taskId = binding.taskId
          ORDER BY CASE WHEN h.holdKind = 'operator-stop' THEN 1 ELSE 0 END,
            h.rowid LIMIT 1
        ) AS reason, (
          SELECT h.holdKind FROM task_writer_holds h
          WHERE h.taskId = binding.taskId
          ORDER BY CASE WHEN h.holdKind = 'operator-stop' THEN 1 ELSE 0 END,
            h.rowid LIMIT 1
        ) AS holdKind,
        EXISTS (SELECT 1 FROM task_writer_admissions admission WHERE admission.workId = ?) AS writer,
        EXISTS (SELECT 1 FROM execution_capacity_reservations reservation WHERE reservation.workId = ?) AS capacity,
        EXISTS (SELECT 1 FROM task_writer_holds present WHERE present.taskId = binding.taskId) AS present,
        EXISTS (SELECT 1 FROM task_writer_holds stop WHERE stop.taskId = binding.taskId
          AND stop.holdKind = 'operator-stop') AS stop
        FROM task_execution_bindings binding WHERE binding.workId = ?`)
        .get(workId, workId, workId) as
        | {
            reason: string | null;
            holdKind: string | null;
            writer: number;
            capacity: number;
            present: number;
            stop: number;
          }
        | undefined;
      const writerAndCapacity = this.db
        .prepare(`SELECT
        EXISTS (SELECT 1 FROM task_writer_admissions WHERE workId = ?) AS writer,
        EXISTS (SELECT 1 FROM execution_capacity_reservations WHERE workId = ?) AS capacity`)
        .get(workId, workId) as { writer: number; capacity: number };
      const uncertainty =
        row.state === "held" && writerAndCapacity.writer === 1;
      const receiptRow = this.db
        .prepare(`SELECT id, workspaceDisposition
        FROM execution_recovery_receipts WHERE workId = ?`)
        .get(workId) as
        | { id: string; workspaceDisposition: string }
        | undefined;
      const processIdentity =
        row.processId === null
          ? null
          : processIdentitySchema.parse({
              processId: row.processId,
              processStartedAt: row.processStartedAt,
              bootId: row.bootId,
            });
      const taskReason =
        holdRow?.holdKind === "operator-stop"
          ? holdRow.reason
          : holdRow?.present === 1
            ? recoveryReason("unknown")
            : null;
      const preTurnWitness = this.witnessForWork(workId);
      const noTurnWitness = this.noTurnWitnessForWork(workId);
      return {
        workId,
        ...(noTurnWitness
          ? {
              noTurnSubmission: {
                id: noTurnWitness.id,
                source: "operator-adopted" as const,
                idleThreadMayExist: true as const,
              },
            }
          : {}),
        ...(preTurnWitness
          ? {
              preTurnRejection: {
                id: preTurnWitness.id,
                source: preTurnWitness.source,
                predecessorThreadId: String(
                  (
                    JSON.parse(preTurnWitness.contextMaterial) as {
                      predecessorThreadId: string;
                    }
                  ).predecessorThreadId,
                ),
              },
            }
          : {}),
        generation: {
          workRevision: z
            .number()
            .int()
            .positive()
            .nullable()
            .parse(row.workRevision),
          requestSequence: z
            .number()
            .int()
            .positive()
            .parse(row.requestSequence),
        },
        intent: {
          state: z.string().parse(row.state),
          reason: row.reason === null ? null : recoveryReason("unknown"),
          threadId: z.string().min(1).nullable().parse(row.threadId),
          turnId: z.string().min(1).nullable().parse(row.turnId),
        },
        request: requestRow
          ? {
              state: z.string().parse(requestRow.state),
              reason:
                requestRow.reason === null ? null : recoveryReason("unknown"),
              assignmentId: z
                .string()
                .min(1)
                .nullable()
                .parse(requestRow.assignmentId),
            }
          : null,
        binding: bindingRow
          ? {
              taskId: z.string().uuid().parse(bindingRow.taskId),
              assignmentId: z.string().uuid().parse(bindingRow.assignmentId),
              assignmentVersion: z
                .number()
                .int()
                .positive()
                .parse(bindingRow.assignmentVersion),
              instructionsRevision: z
                .number()
                .int()
                .positive()
                .parse(bindingRow.instructionsRevision),
              profileRevision: z
                .number()
                .int()
                .positive()
                .parse(bindingRow.profileRevision),
            }
          : null,
        processIdentity,
        pendingEffects: effectRows.map((effect) => ({
          state: effect.state,
          reason: "Assignment result has not been committed",
        })),
        observations: observationRows.map((observation) => ({
          kind: observation.kind,
          reason: recoveryReason(observation.kind),
        })),
        holds: {
          task: taskReason,
          writer:
            writerAndCapacity.writer === 1 &&
            ["held", "submitting", "running"].includes(String(row.state)),
          capacity: writerAndCapacity.capacity === 1,
          uncertainty,
          stop: holdRow?.stop === 1,
        },
        receipt: receiptRow
          ? {
              id: receiptRow.id,
              workspaceDisposition: receiptRow.workspaceDisposition,
            }
          : null,
      };
    });
  }

  resolveHeldExecution(
    receipt: RecoveryReceipt,
    verification: VerifiedTermination,
    command?: { key: string; receipt: RecoveryReceipt },
  ): { id: string; workId: string; state: "reconciled" } {
    const value = recoveryReceiptSchema.parse(receipt);
    const proof = verifiedTerminationSchema.parse(verification);
    return transaction(this.db, () => {
      if (command) {
        const replay = this.preTurnCommandReplay(
          value.kind === "no-turn-submission" ? "recover-no-turn" : "recover",
          command,
        );
        if (replay) {
          const result = z
            .object({
              id: z.string().uuid(),
              workId: z.string().min(1),
              state: z.literal("reconciled"),
            })
            .strict()
            .parse(replay);
          return result;
        }
      }

      const intent = this.db
        .prepare(`SELECT id, state, threadId, turnId
        FROM execution_intents WHERE workId = ?`)
        .get(value.workId) as
        | {
            id: string;
            state: string;
            threadId: string | null;
            turnId: string | null;
          }
        | undefined;
      const identity = this.recoveryIdentity(value.workId);
      if (intent?.state !== "held" || !identity)
        throw new RecoveryRejectedError(
          "Execution generation is not held for recovery",
        );
      const requestSequence = this.hasTurnRequests
        ? (
            this.db
              .prepare("SELECT sequence FROM turn_requests WHERE workId = ?")
              .get(value.workId) as { sequence: number } | undefined
          )?.sequence
        : undefined;
      const actualWorkRevision =
        (
          this.db
            .prepare(
              "SELECT workRevision FROM task_work_revisions WHERE workId = ?",
            )
            .get(value.workId) as { workRevision: number } | undefined
        )?.workRevision ?? null;
      if (
        identity.workRevision !== value.workRevision ||
        actualWorkRevision !== value.workRevision ||
        identity.requestSequence !== value.requestSequence ||
        requestSequence !== value.requestSequence ||
        identity.threadId !== value.threadId ||
        intent.threadId !== value.threadId ||
        identity.turnId !== value.turnId ||
        intent.turnId !== value.turnId ||
        !identity.processIdentity ||
        identity.processIdentity.processId !==
          value.processIdentity.processId ||
        identity.processIdentity.processStartedAt !==
          value.processIdentity.processStartedAt ||
        identity.processIdentity.bootId !== value.processIdentity.bootId ||
        proof.processIdentity.processId !==
          identity.processIdentity.processId ||
        proof.processIdentity.processStartedAt !==
          identity.processIdentity.processStartedAt ||
        proof.processIdentity.bootId !== identity.processIdentity.bootId
      )
        throw new RecoveryRejectedError(
          "Recovery receipt generation or execution identity does not match",
        );
      if (
        this.db
          .prepare("SELECT 1 FROM task_writer_admissions WHERE workId = ?")
          .get(value.workId) === undefined ||
        this.db
          .prepare(
            "SELECT 1 FROM execution_capacity_reservations WHERE workId = ?",
          )
          .get(value.workId) === undefined
      )
        throw new RecoveryRejectedError(
          "Exact generation no longer owns its writer and capacity holds",
        );

      const preTurnWitness =
        value.kind === "pre-turn-rejection"
          ? this.witnessForWork(value.workId)
          : undefined;
      if (
        value.kind === "pre-turn-rejection" &&
        (!command || !preTurnWitness || preTurnWitness.id !== value.witnessId)
      )
        throw new RecoveryRejectedError(
          "Pre-turn recovery requires its exact persisted witness and keyed command",
        );
      const noTurnWitness =
        value.kind === "no-turn-submission"
          ? this.noTurnWitnessForWork(value.workId)
          : undefined;
      if (
        value.kind === "no-turn-submission" &&
        (!command || !noTurnWitness || noTurnWitness.id !== value.witnessId)
      )
        throw new RecoveryRejectedError(
          "No-turn recovery requires its exact persisted witness and keyed command",
        );
      if (
        value.kind !== "no-turn-submission" &&
        this.db
          .prepare("SELECT 1 FROM execution_no_turn_submissions WHERE workId=?")
          .get(value.workId)
      )
        throw new RecoveryRejectedError(
          "Other receipt kinds cannot adopt a no-turn witness",
        );
      if (
        value.kind !== "pre-turn-rejection" &&
        this.db
          .prepare("SELECT 1 FROM execution_pre_turn_rejections WHERE workId=?")
          .get(value.workId)
      )
        throw new RecoveryRejectedError(
          "Bound-turn receipt cannot adopt a pre-turn witness",
        );
      const receiptId = randomUUID();
      const changed = this.db
        .prepare(`UPDATE execution_intents
        SET state = 'reconciled', reason = 'Execution reconciled from validated recovery receipt'
        WHERE workId = ? AND state = 'held' AND threadId IS ? AND turnId IS ?
        RETURNING id`)
        .get(value.workId, value.threadId, value.turnId) as
        | { id: string }
        | undefined;
      if (!changed)
        throw new RecoveryRejectedError(
          "Recovery generation changed during receipt validation",
        );
      // The verified receipt independently resolves a stopped generation; its
      // target must not gate or answer later Stops of the task.
      this.db
        .prepare("DELETE FROM execution_stop_targets WHERE workId = ?")
        .run(value.workId);
      this.db
        .prepare(`INSERT INTO execution_recovery_receipts
        (id, workId, workRevision, requestSequence, threadId, turnId, processId,
          processStartedAt, bootId, terminationMethod, terminationVerifiedAt,
          effectsState, workspaceDisposition, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?)`)
        .run(
          receiptId,
          value.workId,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.processIdentity.processId,
          value.processIdentity.processStartedAt,
          value.processIdentity.bootId,
          proof.method,
          proof.verifiedAt,
          value.workspace,
          Date.now(),
        );
      if (preTurnWitness)
        this.db
          .prepare(
            "INSERT INTO execution_pre_turn_receipts (receiptId,workId,witnessId,witnessMaterial) VALUES (?,?,?,?)",
          )
          .run(
            receiptId,
            value.workId,
            preTurnWitness.id,
            canonicalMaterial(preTurnWitness),
          );
      if (noTurnWitness)
        this.db
          .prepare(
            "INSERT INTO execution_no_turn_receipts (receiptId,workId,witnessId,witnessMaterial) VALUES (?,?,?,?)",
          )
          .run(
            receiptId,
            value.workId,
            noTurnWitness.id,
            canonicalMaterial(noTurnWitness),
          );
      this.db
        .prepare(`UPDATE execution_pending_effects SET state = 'settled', reason = NULL
        WHERE workId = ? AND state = 'pending'`)
        .run(value.workId);
      this.db
        .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
        .run(value.workId);
      if (this.hasTurnRequests)
        this.db
          .prepare(`UPDATE turn_requests SET state = 'held',
          reason = 'Execution reconciled; no automatic successor' WHERE workId = ?`)
          .run(value.workId);
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt) VALUES (?, ?, 'receipt-accepted', ?, ?)`)
        .run(
          randomUUID(),
          value.workId,
          recoveryReason("receipt-accepted"),
          Date.now(),
        );
      if (command)
        this.recordPreTurnCommand(
          value.kind === "no-turn-submission" ? "recover-no-turn" : "recover",
          command,
          {
            id: receiptId,
            workId: value.workId,
            state: "reconciled",
          },
        );
      return { id: receiptId, workId: value.workId, state: "reconciled" };
    });
  }

  writerAndSuccessors(workId: string): ExecutionIntent[] {
    const admission = this.db
      .prepare(
        "SELECT sequence, workspace FROM task_writer_admissions WHERE workId = ?",
      )
      .get(workId) as { sequence: number; workspace: string } | undefined;
    if (!admission) {
      const writer = this.byWorkId(workId);
      return writer
        ? this.db
            .prepare(`SELECT * FROM execution_intents
              WHERE workspace = ?
                AND state IN ('completed','submitting','running')
              ORDER BY rowid`)
            .all(writer.workspace)
            .map((row) => intentSchema.parse(row))
        : [];
    }
    return this.db
      .prepare(`SELECT e.* FROM task_writer_admissions a
      JOIN execution_intents e ON e.workId = a.workId
      WHERE a.workspace = ? AND a.sequence >= ? ORDER BY a.sequence`)
      .all(admission.workspace, admission.sequence)
      .map((row) => intentSchema.parse(row));
  }

  setWorkspaceKey(id: string, workspace: string): void {
    this.db
      .prepare("UPDATE execution_intents SET workspace = ? WHERE id = ?")
      .run(workspace, id);
  }

  /** An interrupted service cannot prove a send failed or a writer stopped. */
  holdUnfinishedOnOpen(): void {
    // An unresolved shutdown target must leave exactly today's restart hold.
    this.db.exec(
      "DELETE FROM execution_stop_targets WHERE origin = 'shutdown'",
    );
    const held = this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = 'service restarted with unresolved execution' WHERE state IN ('submitting','running') RETURNING workId",
      )
      .all() as { workId: string }[];
    if (this.hasTurnRequests)
      for (const row of held)
        this.db
          .prepare(
            "UPDATE turn_requests SET state = 'held', reason = 'service restarted with unresolved execution' WHERE workId = ?",
          )
          .run(row.workId);
  }

  begin(
    id: string,
    options: {
      projectId: string | null;
      requestSequence?: number;
      processIdentity?: RuntimeProcessIdentity | null;
      validate?: () => string[];
      refuse?: (reasons: string[]) => boolean;
    } = {
      projectId: null,
    },
  ): boolean {
    return transaction(this.db, () => {
      const reasons = options.validate?.() ?? [];
      if (reasons.length > 0) {
        const refused = options.refuse?.(reasons) ?? false;
        const reason = refused
          ? `Request refused: captured revisions no longer match (${reasons.join(", ")})`
          : `Admission waiting: ${reasons.join(", ")}`;
        this.db
          .prepare(
            `UPDATE execution_intents SET state = ?, reason = ?
           WHERE id = ? AND state IN ('ready','capacity-waiting')`,
          )
          .run(refused ? "held" : "ready", reason, id);
        if (refused) {
          const intent = this.db
            .prepare("SELECT workId FROM execution_intents WHERE id = ?")
            .get(id) as { workId: string } | undefined;
          if (intent) {
            this.db
              .prepare(
                "INSERT OR REPLACE INTO execution_request_refusals (workId, reason) VALUES (?, ?)",
              )
              .run(intent.workId, reason);
            if (this.hasTurnRequests)
              this.db
                .prepare(
                  "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = ? AND state = 'queued'",
                )
                .run(reason, intent.workId);
          }
        } else if (this.hasTurnRequests) {
          const intent = this.db
            .prepare("SELECT workId FROM execution_intents WHERE id = ?")
            .get(id) as { workId: string } | undefined;
          if (intent)
            this.db
              .prepare(
                "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
              )
              .run(reason, intent.workId);
        }
        return false;
      }
      const pending = this.db
        .prepare("SELECT workId, state FROM execution_intents WHERE id = ?")
        .get(id) as { state: string; workId: string } | undefined;
      if (
        !pending ||
        (pending.state !== "ready" && pending.state !== "capacity-waiting")
      ) {
        return false;
      }
      const powerGate = this.db
        .prepare(`SELECT wakeHeld FROM execution_power_supervision
        WHERE singleton = 1`)
        .get() as { wakeHeld: number } | undefined;
      if (powerGate?.wakeHeld === 1) {
        const reason = "Admission waiting: power-event reconciliation";
        this.db
          .prepare(`UPDATE execution_intents
          SET state = 'capacity-waiting', reason = ?
          WHERE id = ? AND state IN ('ready','capacity-waiting')`)
          .run(reason, id);
        if (this.hasTurnRequests)
          this.db
            .prepare(`UPDATE turn_requests SET reason = ?
            WHERE workId = ? AND state = 'queued'`)
            .run(reason, pending.workId);
        return false;
      }
      const configuredGlobalLimit = this.db
        .prepare(
          "SELECT globalLimit FROM scheduler_capacity_limits WHERE singleton = 1",
        )
        .get() as { globalLimit: number } | undefined;
      const globalLimit = configuredGlobalLimit?.globalLimit ?? 4;
      const globalUsage = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM execution_capacity_reservations",
          )
          .get() as { count: number }
      ).count;
      const projectLimit = options.projectId
        ? ((
            this.db
              .prepare(
                "SELECT projectLimit FROM scheduler_project_capacity_limits WHERE projectId = ?",
              )
              .get(options.projectId) as { projectLimit: number } | undefined
          )?.projectLimit ?? 2)
        : undefined;
      const projectUsage = options.projectId
        ? (
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE projectId = ?",
              )
              .get(options.projectId) as { count: number }
          ).count
        : 0;
      const capacityReason =
        globalUsage >= globalLimit
          ? `Capacity waiting: global active-turn limit (${globalLimit})`
          : projectLimit !== undefined && projectUsage >= projectLimit
            ? `Capacity waiting: project active-turn limit (${projectLimit})`
            : undefined;
      if (capacityReason) {
        this.db
          .prepare(
            "UPDATE execution_intents SET state = 'capacity-waiting', reason = ? WHERE id = ? AND state IN ('ready','capacity-waiting')",
          )
          .run(capacityReason, id);
        if (this.hasTurnRequests)
          this.db
            .prepare(
              "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
            )
            .run(capacityReason, pending.workId);
        return false;
      }
      const admitted =
        this.db
          .prepare(
            `UPDATE execution_intents SET state = 'submitting', reason = NULL
           WHERE id = ? AND state IN ('ready','capacity-waiting')
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_bindings b JOIN task_writer_holds h ON h.taskId = b.taskId
             WHERE b.workId = execution_intents.workId
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_bindings b
             JOIN task_writer_ambiguity_holds h ON h.taskId = b.taskId
             WHERE b.workId = execution_intents.workId
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_execution_bindings b
             JOIN task_archival_holds h ON h.taskId = b.taskId
             WHERE b.workId = execution_intents.workId
           )
           AND NOT EXISTS (
             SELECT 1 FROM execution_intents AS other
             WHERE other.workspace = execution_intents.workspace
             AND other.id != execution_intents.id
             AND other.state IN ('held','submitting','running')
             AND NOT EXISTS (
               SELECT 1 FROM execution_request_refusals r WHERE r.workId = other.workId
             )
           ) RETURNING id`,
          )
          .get(id) !== undefined;
      if (admitted) {
        const workId = (
          this.db
            .prepare("SELECT workId FROM execution_intents WHERE id = ?")
            .get(id) as { workId: string }
        ).workId;
        // Only a Codex task turn can run with command network access: drafting
        // runs and Claude turns have no qualifying binding and stay off.
        this.db
          .prepare(`INSERT OR REPLACE INTO execution_intent_network_access (intentId, enabled)
          SELECT ?, EXISTS (
            SELECT 1 FROM project_command_network_access p
            JOIN task_execution_bindings b ON b.workId = ?
            WHERE p.projectId = ? AND p.enabled = 1 AND b.harness = 'codex')
            ${
              // A draft turn never gets command network access.
              this.hasTurnRequests
                ? "AND NOT EXISTS (SELECT 1 FROM turn_requests r WHERE r.workId = ? AND r.draftTurn = 1)"
                : ""
            }`)
          .run(
            id,
            workId,
            options.projectId,
            ...(this.hasTurnRequests ? [workId] : []),
          );
        const retryGeneration = this.db
          .prepare(`SELECT chainId FROM execution_retry_generations
          WHERE workId = ?`)
          .get(workId) as { chainId: string } | undefined;
        if (!retryGeneration) {
          this.db
            .prepare(`INSERT INTO execution_retry_chains
            (chainId, ensembleRetriesUsed, codexRetriesUsed, nextEligibleAt)
            VALUES (?, 0, 0, NULL)`)
            .run(workId);
          this.db
            .prepare(`INSERT INTO execution_retry_generations
            (workId, chainId, retryIndex) VALUES (?, ?, 0)`)
            .run(workId, workId);
        }
        this.db
          .prepare(`INSERT INTO task_writer_admissions (workId, workspace)
          SELECT workId, workspace FROM execution_intents WHERE id = ?`)
          .run(id);
        this.db
          .prepare(`INSERT INTO execution_capacity_reservations (workId, projectId)
          VALUES (?, ?)`)
          .run(workId, options.projectId);
        const taskBinding = this.taskBinding(workId);
        if (taskBinding) {
          // A draft turn only checks the lead is still pending: it never activates it.
          const draftTurn =
            this.hasTurnRequests &&
            this.db
              .prepare(
                "SELECT 1 FROM turn_requests WHERE workId = ? AND draftTurn = 1",
              )
              .get(workId) !== undefined;
          const activated = this.db
            .prepare(`UPDATE domain_assignments
            SET state = ${draftTurn ? "state" : "'running'"}
            WHERE id = ? AND taskId = ? AND version = ?
              AND state IN (${draftTurn ? "'pending'" : "'pending', 'running'"})
              AND EXISTS (
                SELECT 1 FROM task_execution_bindings binding
                WHERE binding.workId = ?
                  AND binding.assignmentId = domain_assignments.id
                  AND binding.taskId = domain_assignments.taskId
                  AND binding.assignmentVersion = domain_assignments.version
              ) RETURNING id`)
            .get(
              taskBinding.assignmentId,
              taskBinding.taskId,
              taskBinding.assignmentVersion,
              workId,
            ) as { id: string } | undefined;
          if (!activated)
            throw new Error(
              "Assignment admission no longer matches its bound version",
            );
        }
        if (this.hasTurnRequests)
          this.db
            .prepare(
              "UPDATE turn_requests SET state = 'active', reason = NULL WHERE workId = ? AND state = 'queued'",
            )
            .run(workId);
        this.db
          .prepare(`INSERT INTO task_work_revisions
          (workId, assignmentId, conversationRevision, workRevision)
          SELECT b.workId, b.assignmentId, b.conversationRevision,
            COALESCE((
              SELECT MAX(existing.workRevision) FROM task_work_revisions existing
              WHERE existing.assignmentId = b.assignmentId
              AND existing.conversationRevision = b.conversationRevision
            ), 0) + 1
          FROM task_execution_bindings b
          JOIN execution_intents e ON e.workId = b.workId
          WHERE e.id = ?`)
          .run(id);
        this.db
          .prepare(`DELETE FROM task_work_revision_pending
          WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?) `)
          .run(id);
        if (options.requestSequence !== undefined) {
          const requestSequence = z
            .number()
            .int()
            .positive()
            .parse(options.requestSequence);
          const workRevision =
            (
              this.db
                .prepare(
                  "SELECT workRevision FROM task_work_revisions WHERE workId = ?",
                )
                .get(pending.workId) as { workRevision: number } | undefined
            )?.workRevision ?? null;
          const processIdentity = options.processIdentity
            ? processIdentitySchema.parse(options.processIdentity)
            : null;
          this.db
            .prepare(`INSERT INTO execution_recovery_identities
            (workId, workRevision, requestSequence, processId, processStartedAt,
              bootId, threadId, turnId, inspectionKind, terminalStatus)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
            .run(
              pending.workId,
              workRevision,
              requestSequence,
              processIdentity?.processId ?? null,
              processIdentity?.processStartedAt ?? null,
              processIdentity?.bootId ?? null,
            );
          this.db
            .prepare(`INSERT OR IGNORE INTO execution_pending_effects
            (workId, effectKey, state, reason)
            SELECT ?, 'assignment-result', 'pending',
              'Assignment result has not been committed'
            WHERE EXISTS (SELECT 1 FROM task_execution_bindings WHERE workId = ?)`)
            .run(pending.workId, pending.workId);
        }
      } else {
        const intent = this.db
          .prepare(
            "SELECT workId, workspace, state FROM execution_intents WHERE id = ?",
          )
          .get(id) as
          | { state: string; workId: string; workspace: string }
          | undefined;
        if (intent?.state === "ready" || intent?.state === "capacity-waiting") {
          const binding = this.db
            .prepare(
              "SELECT taskId FROM task_execution_bindings WHERE workId = ?",
            )
            .get(intent.workId) as { taskId: string } | undefined;
          const taskHold = binding ? this.taskHold(binding.taskId) : undefined;
          const unresolved = this.db
            .prepare(`SELECT state, reason FROM execution_intents
              WHERE workspace = ? AND id != ? AND state IN ('held','submitting','running')
              ORDER BY rowid LIMIT 1`)
            .get(intent.workspace, id) as
            | { state: string; reason: string | null }
            | undefined;
          const reason = taskHold
            ? `Admission waiting: ${taskHold}`
            : unresolved?.state === "held"
              ? `Workspace has unresolved execution${unresolved.reason ? `: ${unresolved.reason}` : ""}`
              : "Waiting for workspace writer";
          this.db
            .prepare(
              "UPDATE execution_intents SET state = 'ready', reason = ? WHERE id = ?",
            )
            .run(reason, id);
          if (this.hasTurnRequests)
            this.db
              .prepare(
                "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
              )
              .run(reason, intent.workId);
        }
      }
      return admitted;
    });
  }

  /** Records a per-turn process identity before that turn's prompt is released. */
  recordTurnProcess(
    threadId: string,
    processIdentity: RuntimeProcessIdentity,
  ): boolean {
    const identity = processIdentitySchema.parse(processIdentity);
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT identity.workId FROM execution_recovery_identities identity
          JOIN execution_intents intent ON intent.workId = identity.workId
          WHERE identity.threadId = ? AND identity.turnId IS NULL
            AND identity.processId IS NULL AND intent.state = 'submitting'
            AND intent.threadId = ? AND intent.turnId IS NULL LIMIT 2`)
        .all(threadId, threadId) as Array<{ workId: string }>;
      const workId = rows.length === 1 ? rows[0]?.workId : undefined;
      if (!workId) return false;
      this.db
        .prepare(`UPDATE execution_recovery_identities
          SET processId = ?, processStartedAt = ?, bootId = ? WHERE workId = ?`)
        .run(
          identity.processId,
          identity.processStartedAt,
          identity.bootId,
          workId,
        );
      return true;
    });
  }

  bindThread(id: string, threadId: string): boolean {
    if (
      this.db
        .prepare(
          "UPDATE execution_intents SET threadId = ? WHERE id = ? AND state = 'submitting' AND threadId IS NULL RETURNING id",
        )
        .get(threadId, id) !== undefined
    ) {
      this.db
        .prepare(
          "UPDATE execution_recovery_identities SET threadId = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(threadId, id);
      return true;
    }
    const held = this.db
      .prepare(`UPDATE execution_intents SET threadId = ? WHERE id = ? AND state = 'held'
        AND threadId IS NULL AND turnId IS NULL AND EXISTS (
          SELECT 1 FROM execution_stop_targets s WHERE s.workId = execution_intents.workId
        ) RETURNING workId`)
      .get(threadId, id) as { workId: string } | undefined;
    if (held) {
      this.db
        .prepare(
          "UPDATE execution_recovery_identities SET threadId = ? WHERE workId = ?",
        )
        .run(threadId, held.workId);
      this.bindStopIdentity(held.workId, threadId);
    }
    return false;
  }

  bindTurn(id: string, turnId: string, runtimeGeneration?: string): boolean {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    const finish = (result: boolean): boolean => {
      if (ownsTransaction) this.db.exec("COMMIT");
      return result;
    };
    try {
      if (
        this.db
          .prepare(
            "UPDATE execution_intents SET state = 'running', turnId = ? WHERE id = ? AND state = 'submitting' AND turnId IS NULL RETURNING id",
          )
          .get(turnId, id) !== undefined
      ) {
        this.db
          .prepare(
            "UPDATE execution_recovery_identities SET turnId = ?, runtimeGeneration = COALESCE(?, runtimeGeneration) WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
          )
          .run(turnId, runtimeGeneration ?? null, id);
        this.noteBoundRuntimeTurn(id, turnId);
        return finish(true);
      }
      const stoppedThreadId = this.get(id).threadId;
      if (stoppedThreadId) {
        const stopped = this.db
          .prepare(`UPDATE execution_intents SET turnId = ? WHERE id = ? AND state = 'held'
          AND threadId = ? AND turnId IS NULL AND EXISTS (
            SELECT 1 FROM execution_stop_targets s WHERE s.workId = execution_intents.workId
          ) RETURNING workId`)
          .get(turnId, id, stoppedThreadId) as { workId: string } | undefined;
        if (stopped) {
          this.db
            .prepare(
              "UPDATE execution_recovery_identities SET turnId = ?, runtimeGeneration = COALESCE(?, runtimeGeneration) WHERE workId = ?",
            )
            .run(turnId, runtimeGeneration ?? null, stopped.workId);
          this.noteBoundRuntimeTurn(id, turnId);
          this.bindStopIdentity(stopped.workId, stoppedThreadId, turnId);
          return finish(false);
        }
      }
      // The server may return after a callback has held this submission. Record
      // the server turn identity without reviving the writer or admitting work.
      if (
        this.db
          .prepare(
            "UPDATE execution_intents SET turnId = ? WHERE id = ? AND state = 'held' AND threadId IS NOT NULL AND turnId IS NULL RETURNING id",
          )
          .get(turnId, id) !== undefined
      ) {
        this.db
          .prepare(
            "UPDATE execution_recovery_identities SET turnId = ?, runtimeGeneration = COALESCE(?, runtimeGeneration) WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
          )
          .run(turnId, runtimeGeneration ?? null, id);
        this.noteBoundRuntimeTurn(id, turnId);
        return finish(false);
      }
      this.db
        .prepare(
          "UPDATE execution_intents SET reason = COALESCE(reason, '') || '; conflicting turn/start response: ' || ? WHERE id = ? AND state = 'held' AND turnId IS NOT NULL AND turnId != ?",
        )
        .run(turnId, id, turnId);
      return finish(false);
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  holdPendingTurn(
    id: string,
    threadId: string,
    turnId: string,
    reason: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE execution_intents SET state = 'held', reason = ?, turnId = ? WHERE id = ? AND state IN ('submitting','held') AND threadId = ? AND turnId IS NULL RETURNING id",
        )
        .get(reason, turnId, id, threadId) !== undefined
    );
  }

  /** Returns false when the intent was already settled and stays unheld. */
  hold(id: string, reason: string): boolean {
    const held = this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state NOT IN ('completed','reconciled','resolved-failed') RETURNING workId",
      )
      .get(reason, id) as { workId: string } | undefined;
    // A settled intent keeps its request settled so later inbox delivery is not blocked.
    if (held && this.hasTurnRequests)
      this.db
        .prepare(
          "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = ?",
        )
        .run(reason, held.workId);
    return held !== undefined;
  }

  wait(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'ready', reason = ? WHERE id = ? AND state IN ('ready','capacity-waiting')",
      )
      .run(reason, id);
    if (this.hasTurnRequests)
      this.db
        .prepare(
          "UPDATE turn_requests SET reason = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?) AND state = 'queued'",
        )
        .run(reason, id);
  }

  holdTerminalConflict(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE execution_intents SET state = 'held', reason = ? WHERE id = ? AND state IN ('submitting','running','completed')",
      )
      .run(reason, id);
    if (this.hasTurnRequests)
      this.db
        .prepare(
          "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = (SELECT workId FROM execution_intents WHERE id = ?)",
        )
        .run(reason, id);
  }

  resolveFailedGeneration(
    input: FailureResolutionEvidence,
  ): FailedGenerationResolution | undefined {
    const value = failureResolutionSchema.parse(input);
    if (!harnessRetrySupported(value.harness))
      throw new Error(`Retry is not supported for harness: ${value.harness}`);
    if (!this.hasTurnRequests)
      throw new Error("Retry resolution requires durable turn requests");
    return transaction(this.db, () => {
      const committed = this.db
        .prepare(`SELECT * FROM execution_retry_resolutions
        WHERE failedWorkId = ?`)
        .get(value.workId) as
        | {
            failedWorkId: string;
            retryWorkId: string;
            retryIndex: number;
            ensembleRetriesUsed: number;
            codexRetriesUsed: number;
            workRevision: number | null;
            requestSequence: number;
            threadId: string;
            turnId: string;
            reasonCode: string;
            failureSource: string;
            codexRetries: number;
            nextEligibleAt: number;
          }
        | undefined;
      if (committed) {
        if (
          committed.workRevision !== value.workRevision ||
          committed.requestSequence !== value.requestSequence ||
          committed.threadId !== value.threadId ||
          committed.turnId !== value.turnId ||
          committed.reasonCode !== value.reasonCode ||
          committed.failureSource !== retryFailureSource[value.harness] ||
          committed.codexRetries !== value.harnessRetries
        )
          throw new Error(
            "Retry resolution proof does not match the committed generation",
          );
        return {
          failedWorkId: committed.failedWorkId,
          retryWorkId: committed.retryWorkId,
          retryIndex: committed.retryIndex,
          ensembleRetriesUsed: committed.ensembleRetriesUsed,
          harnessRetriesUsed: committed.codexRetriesUsed,
          nextEligibleAt: committed.nextEligibleAt,
        };
      }

      const current = this.db
        .prepare(`SELECT intent.id, intent.state, intent.threadId,
        intent.turnId, intent.workspace, request.requestKey, request.kind,
        request.taskId, request.projectId, request.assignmentId, request.taskVersion,
        request.assignmentVersion, request.instructionsRevision,
        request.profileRevision, request.prompt, request.state AS requestState,
        request.draftTurn, request.draftTaskDigest,
        request.sequence AS requestSequence, identity.workRevision,
        identity.requestSequence AS identitySequence,
        identity.threadId AS identityThreadId, identity.turnId AS identityTurnId,
        identity.inspectionKind, identity.terminalStatus
        FROM execution_intents intent
        JOIN turn_requests request ON request.workId = intent.workId
        JOIN execution_recovery_identities identity ON identity.workId = intent.workId
        WHERE intent.workId = ?`)
        .get(value.workId) as
        | {
            id: string;
            state: string;
            threadId: string | null;
            turnId: string | null;
            workspace: string;
            requestKey: string;
            kind: string;
            taskId: string | null;
            projectId: string | null;
            assignmentId: string | null;
            taskVersion: number | null;
            assignmentVersion: number | null;
            instructionsRevision: number | null;
            profileRevision: number | null;
            prompt: string;
            requestState: string;
            draftTurn: number;
            draftTaskDigest: string | null;
            requestSequence: number;
            workRevision: number | null;
            identitySequence: number;
            identityThreadId: string | null;
            identityTurnId: string | null;
            inspectionKind: string | null;
            terminalStatus: string | null;
          }
        | undefined;
      const actualWorkRevision =
        (
          this.db
            .prepare(`SELECT workRevision FROM task_work_revisions
        WHERE workId = ?`)
            .get(value.workId) as { workRevision: number } | undefined
        )?.workRevision ?? null;
      if (
        current?.state !== "held" ||
        current.requestState !== "held" ||
        current.workRevision !== value.workRevision ||
        actualWorkRevision !== value.workRevision ||
        current.requestSequence !== value.requestSequence ||
        current.identitySequence !== value.requestSequence ||
        current.threadId !== value.threadId ||
        current.identityThreadId !== value.threadId ||
        current.turnId !== value.turnId ||
        current.identityTurnId !== value.turnId ||
        current.inspectionKind !== "exact-terminal-failed" ||
        current.terminalStatus !== "failed"
      )
        throw new Error(
          "Retry resolution evidence does not match the exact failed generation",
        );

      const writer = this.db
        .prepare(`SELECT 1 FROM task_writer_admissions
        WHERE workId = ?`)
        .get(value.workId);
      const reservation = this.db
        .prepare(`SELECT 1 FROM execution_capacity_reservations
        WHERE workId = ?`)
        .get(value.workId);
      if (!writer || !reservation)
        throw new Error(
          "Failed generation no longer owns its exact writer and capacity",
        );

      const independentlyHeld = this.db
        .prepare(`SELECT
        EXISTS (SELECT 1 FROM execution_stop_targets WHERE workId = ?) AS stopped,
        EXISTS (SELECT 1 FROM execution_request_refusals WHERE workId = ?) AS refused,
        EXISTS (SELECT 1 FROM execution_pending_effects
          WHERE workId = ? AND state = 'pending') AS pendingEffect,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS taskHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_ambiguity_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS ambiguousTaskHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_archival_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS archivalHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_execution_bindings otherBinding ON otherBinding.taskId = binding.taskId
          JOIN execution_intents other ON other.workId = otherBinding.workId
          JOIN task_writer_admissions otherAdmission ON otherAdmission.workId = other.workId
          WHERE binding.workId = ? AND other.workId != ?
          AND other.state IN ('held','submitting','running')) AS otherTaskWriter,
        EXISTS (SELECT 1 FROM execution_intents other
          JOIN task_writer_admissions otherAdmission ON otherAdmission.workId = other.workId
          WHERE other.workspace = ? AND other.workId != ?
          AND other.state IN ('held','submitting','running')) AS otherWorkspaceWriter`)
        .get(
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          current.workspace,
          value.workId,
        ) as {
        stopped: number;
        refused: number;
        pendingEffect: number;
        taskHold: number;
        ambiguousTaskHold: number;
        archivalHold: number;
        otherTaskWriter: number;
        otherWorkspaceWriter: number;
      };
      if (
        !value.callbacksEnded ||
        !value.noSurvivor ||
        independentlyHeld.stopped ||
        independentlyHeld.refused ||
        independentlyHeld.pendingEffect ||
        independentlyHeld.taskHold ||
        independentlyHeld.ambiguousTaskHold ||
        independentlyHeld.archivalHold ||
        independentlyHeld.otherTaskWriter ||
        independentlyHeld.otherWorkspaceWriter
      ) {
        return undefined;
      }

      const generation = this.db
        .prepare(`SELECT chainId, retryIndex
        FROM execution_retry_generations WHERE workId = ?`)
        .get(value.workId) as
        | { chainId: string; retryIndex: number }
        | undefined;
      const chain = generation
        ? (this.db
            .prepare(`SELECT ensembleRetriesUsed, codexRetriesUsed
            FROM execution_retry_chains WHERE chainId = ?`)
            .get(generation.chainId) as
            | { ensembleRetriesUsed: number; codexRetriesUsed: number }
            | undefined)
        : undefined;
      if (
        !generation ||
        !chain ||
        generation.retryIndex !== chain.ensembleRetriesUsed
      )
        throw new Error(
          "Retry accounting state is unavailable or inconsistent",
        );

      const priorAttempt = this.db
        .prepare(`SELECT chainId, workRevision, requestSequence,
        threadId, turnId, reasonCode, failureSource, codexRetries, disposition
        FROM execution_retry_attempts WHERE workId = ?`)
        .get(value.workId) as
        | {
            chainId: string;
            workRevision: number | null;
            requestSequence: number;
            threadId: string;
            turnId: string;
            reasonCode: string;
            failureSource: string;
            codexRetries: number;
            disposition: string;
          }
        | undefined;
      if (priorAttempt) {
        if (
          priorAttempt.chainId !== generation.chainId ||
          priorAttempt.workRevision !== value.workRevision ||
          priorAttempt.requestSequence !== value.requestSequence ||
          priorAttempt.threadId !== value.threadId ||
          priorAttempt.turnId !== value.turnId ||
          priorAttempt.reasonCode !== value.reasonCode ||
          priorAttempt.failureSource !== retryFailureSource[value.harness] ||
          priorAttempt.codexRetries !== value.harnessRetries
        )
          throw new Error(
            "Retry attempt evidence conflicts with the recorded terminal failure",
          );
        return undefined;
      }

      const failureSource = retryFailureSource[value.harness];
      const harnessRetriesUsed = chain.codexRetriesUsed + value.harnessRetries;
      const ensembleRetriesUsed = chain.ensembleRetriesUsed + 1;
      if (harnessRetriesUsed + ensembleRetriesUsed > 2) {
        this.db
          .prepare(`UPDATE execution_retry_chains SET codexRetriesUsed = ?,
          nextEligibleAt = NULL WHERE chainId = ?`)
          .run(harnessRetriesUsed, generation.chainId);
        this.db
          .prepare(`INSERT INTO execution_retry_attempts
          (workId, chainId, workRevision, requestSequence, threadId, turnId,
            reasonCode, failureSource, codexRetries, disposition, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'budget-exhausted', ?)`)
          .run(
            value.workId,
            generation.chainId,
            value.workRevision,
            value.requestSequence,
            value.threadId,
            value.turnId,
            value.reasonCode,
            failureSource,
            value.harnessRetries,
            Date.now(),
          );
        return undefined;
      }

      const retryIndex = ensembleRetriesUsed;
      const retryWorkId = `retry:${generation.chainId}:${retryIndex}`;
      const retryRequestKey = retryWorkId;
      this.db
        .prepare(`INSERT INTO execution_intents
        (id, workId, prompt, workspace, state, reason, threadId, turnId,
          accountType, sandbox, approval)
        VALUES (?, ?, ?, ?, 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')`)
        .run(randomUUID(), retryWorkId, current.prompt, current.workspace);
      this.db
        .prepare(`INSERT INTO execution_request_predecessors
        (workId, previousWorkId, predecessorKnown) VALUES (?, NULL, 1)`)
        .run(retryWorkId);
      this.db
        .prepare(`INSERT INTO task_execution_bindings
        (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, harness)
        SELECT ?, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, harness FROM task_execution_bindings
        WHERE workId = ?`)
        .run(retryWorkId, value.workId);
      this.db
        .prepare(`INSERT INTO turn_requests
        (requestKey, workId, kind, taskId, projectId, assignmentId, taskVersion,
          assignmentVersion, instructionsRevision, profileRevision, prompt,
          workspace, previousWorkId, state, reason, nextEligibleAt, draftTurn,
          draftTaskDigest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', NULL, ?, ?, ?)`)
        .run(
          retryRequestKey,
          retryWorkId,
          current.kind,
          current.taskId,
          current.projectId,
          current.assignmentId,
          current.taskVersion,
          current.assignmentVersion,
          current.instructionsRevision,
          current.profileRevision,
          current.prompt,
          current.workspace,
          value.nextEligibleAt,
          current.draftTurn,
          current.draftTaskDigest,
        );
      const resolved = this.db
        .prepare(`UPDATE execution_intents SET state = 'resolved-failed',
        reason = ? WHERE workId = ? AND state = 'held' RETURNING workId`)
        .get(
          `Confirmed transient failure (${value.reasonCode}); retry queued`,
          value.workId,
        );
      if (!resolved)
        throw new Error("Failed generation changed before retry resolution");
      this.db
        .prepare(`UPDATE turn_requests SET state = 'held',
        reason = 'Confirmed transient failure resolved; retry queued'
        WHERE workId = ? AND state = 'held'`)
        .run(value.workId);
      this.db
        .prepare(`DELETE FROM execution_capacity_reservations WHERE workId = ?`)
        .run(value.workId);
      this.db
        .prepare(`DELETE FROM task_writer_admissions WHERE workId = ?`)
        .run(value.workId);
      this.db
        .prepare(`UPDATE execution_retry_chains SET ensembleRetriesUsed = ?,
        codexRetriesUsed = ?, nextEligibleAt = ? WHERE chainId = ?`)
        .run(
          ensembleRetriesUsed,
          harnessRetriesUsed,
          value.nextEligibleAt,
          generation.chainId,
        );
      this.db
        .prepare(`INSERT INTO execution_retry_generations
        (workId, chainId, retryIndex) VALUES (?, ?, ?)`)
        .run(retryWorkId, generation.chainId, retryIndex);
      this.db
        .prepare(`INSERT INTO execution_retry_attempts
        (workId, chainId, workRevision, requestSequence, threadId, turnId,
          reasonCode, failureSource, codexRetries, disposition, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'retry-queued', ?)`)
        .run(
          value.workId,
          generation.chainId,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.reasonCode,
          failureSource,
          value.harnessRetries,
          Date.now(),
        );
      this.db
        .prepare(`INSERT INTO execution_retry_resolutions
        (failedWorkId, retryWorkId, chainId, retryIndex, workRevision,
          requestSequence, threadId, turnId, reasonCode, failureSource,
          codexRetries, ensembleRetriesUsed, codexRetriesUsed,
          nextEligibleAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          value.workId,
          retryWorkId,
          generation.chainId,
          retryIndex,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.reasonCode,
          failureSource,
          value.harnessRetries,
          ensembleRetriesUsed,
          harnessRetriesUsed,
          value.nextEligibleAt,
          Date.now(),
        );
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt)
        VALUES (?, ?, 'retry-enqueued', ?, ?)`)
        .run(
          randomUUID(),
          value.workId,
          recoveryReason("retry-enqueued"),
          Date.now(),
        );
      return {
        failedWorkId: value.workId,
        retryWorkId,
        retryIndex,
        ensembleRetriesUsed,
        harnessRetriesUsed,
        nextEligibleAt: value.nextEligibleAt,
      };
    });
  }

  /**
   * Releases a turn that planned shutdown interrupted, once its exact bound turn
   * reported failed after an acknowledged interrupt: the writer and capacity go,
   * and the same request is requeued as a fresh generation that resumes the
   * thread. Returns undefined, releasing nothing, while any other hold remains.
   * It never touches the transient-retry allowance.
   */
  resolveShutdownInterrupted(
    input: ShutdownResolutionEvidence,
  ): ShutdownInterruptResolution | undefined {
    const value = shutdownResolutionSchema.parse(input);
    if (!this.hasTurnRequests)
      throw new Error("Shutdown resolution requires durable turn requests");
    return transaction(this.db, () => {
      const committed = this.db
        .prepare(`SELECT * FROM execution_shutdown_resolutions
        WHERE interruptedWorkId = ?`)
        .get(value.workId) as
        | {
            interruptedWorkId: string;
            requeueWorkId: string;
            workRevision: number | null;
            requestSequence: number;
            threadId: string;
            turnId: string;
            harness: string;
          }
        | undefined;
      if (committed) {
        if (
          committed.workRevision !== value.workRevision ||
          committed.requestSequence !== value.requestSequence ||
          committed.threadId !== value.threadId ||
          committed.turnId !== value.turnId ||
          committed.harness !== value.harness
        )
          throw new Error(
            "Shutdown resolution proof does not match the committed generation",
          );
        return {
          interruptedWorkId: committed.interruptedWorkId,
          requeueWorkId: committed.requeueWorkId,
        };
      }

      const current = this.db
        .prepare(`SELECT intent.id, intent.state, intent.threadId,
        intent.turnId, intent.workspace, request.kind, request.taskId,
        request.projectId, request.assignmentId, request.taskVersion,
        request.assignmentVersion, request.instructionsRevision,
        request.profileRevision, request.prompt, request.state AS requestState,
        request.draftTurn, request.draftTaskDigest,
        request.sequence AS requestSequence, identity.workRevision,
        identity.requestSequence AS identitySequence,
        identity.threadId AS identityThreadId, identity.turnId AS identityTurnId,
        identity.inspectionKind, identity.terminalStatus,
        binding.harness AS bindingHarness
        FROM execution_intents intent
        JOIN turn_requests request ON request.workId = intent.workId
        JOIN execution_recovery_identities identity ON identity.workId = intent.workId
        JOIN task_execution_bindings binding ON binding.workId = intent.workId
        WHERE intent.workId = ?`)
        .get(value.workId) as
        | {
            id: string;
            state: string;
            threadId: string | null;
            turnId: string | null;
            workspace: string;
            kind: string;
            taskId: string | null;
            projectId: string | null;
            assignmentId: string | null;
            taskVersion: number | null;
            assignmentVersion: number | null;
            instructionsRevision: number | null;
            profileRevision: number | null;
            prompt: string;
            requestState: string;
            draftTurn: number;
            draftTaskDigest: string | null;
            requestSequence: number;
            workRevision: number | null;
            identitySequence: number;
            identityThreadId: string | null;
            identityTurnId: string | null;
            inspectionKind: string | null;
            terminalStatus: string | null;
            bindingHarness: string;
          }
        | undefined;
      const actualWorkRevision =
        (
          this.db
            .prepare(
              "SELECT workRevision FROM task_work_revisions WHERE workId = ?",
            )
            .get(value.workId) as { workRevision: number } | undefined
        )?.workRevision ?? null;
      if (
        current?.state !== "held" ||
        current.requestState !== "held" ||
        current.bindingHarness !== value.harness ||
        current.workRevision !== value.workRevision ||
        actualWorkRevision !== value.workRevision ||
        current.requestSequence !== value.requestSequence ||
        current.identitySequence !== value.requestSequence ||
        current.threadId !== value.threadId ||
        current.identityThreadId !== value.threadId ||
        current.turnId !== value.turnId ||
        current.identityTurnId !== value.turnId ||
        current.inspectionKind !== "exact-terminal-failed" ||
        current.terminalStatus !== "failed"
      )
        throw new Error(
          "Shutdown resolution evidence does not match the exact interrupted generation",
        );

      const owns = this.db
        .prepare(`SELECT
        EXISTS (SELECT 1 FROM task_writer_admissions WHERE workId = ?) AS writer,
        EXISTS (SELECT 1 FROM execution_capacity_reservations WHERE workId = ?) AS capacity`)
        .get(value.workId, value.workId) as {
        writer: number;
        capacity: number;
      };
      if (!owns.writer || !owns.capacity)
        throw new Error(
          "Interrupted generation no longer owns its exact writer and capacity",
        );

      const target = this.stopTarget(value.workId);
      const hasTable = (name: string) =>
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(name) !== undefined;
      const held = this.db
        .prepare(`SELECT
        EXISTS (SELECT 1 FROM execution_request_refusals WHERE workId = ?) AS refused,
        EXISTS (SELECT 1 FROM execution_pending_effects
          WHERE workId = ? AND state = 'pending'
          AND effectKey != 'assignment-result') AS pendingEffect,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS taskHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_writer_ambiguity_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS ambiguousTaskHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_archival_holds hold ON hold.taskId = binding.taskId
          WHERE binding.workId = ?) AS archivalHold,
        EXISTS (SELECT 1 FROM task_execution_bindings binding
          JOIN task_execution_bindings otherBinding ON otherBinding.taskId = binding.taskId
          JOIN execution_intents other ON other.workId = otherBinding.workId
          JOIN task_writer_admissions otherAdmission ON otherAdmission.workId = other.workId
          WHERE binding.workId = ? AND other.workId != ?
          AND other.state IN ('held','submitting','running')) AS otherTaskWriter,
        EXISTS (SELECT 1 FROM execution_intents other
          JOIN task_writer_admissions otherAdmission ON otherAdmission.workId = other.workId
          WHERE other.workspace = ? AND other.workId != ?
          AND other.state IN ('held','submitting','running')) AS otherWorkspaceWriter,
        EXISTS (SELECT 1 FROM turn_requests
          WHERE previousWorkId = ? AND state = 'queued') AS queuedSuccessor`)
        .get(
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          value.workId,
          current.workspace,
          value.workId,
          value.workId,
        ) as Record<string, number>;
      const completionPending =
        hasTable("coordination_completion_requests") &&
        this.db
          .prepare(`SELECT 1 FROM coordination_completion_requests
          WHERE leadWorkId = ? AND status = 'pending'`)
          .get(value.workId) !== undefined;
      if (
        target?.origin !== "shutdown" ||
        target.interruptState !== "acknowledged" ||
        target.terminalState !== "failed" ||
        target.threadId !== value.threadId ||
        target.turnId !== value.turnId ||
        Object.values(held).some(Boolean) ||
        completionPending
      )
        return undefined;

      const generation = this.db
        .prepare(`SELECT chainId, retryIndex
        FROM execution_retry_generations WHERE workId = ?`)
        .get(value.workId) as
        | { chainId: string; retryIndex: number }
        | undefined;
      if (!generation) throw new Error("Retry accounting state is unavailable");

      const requeueWorkId = `shutdown:${randomUUID()}`;
      this.db
        .prepare(`INSERT INTO execution_intents
        (id, workId, prompt, workspace, state, reason, threadId, turnId,
          accountType, sandbox, approval)
        VALUES (?, ?, ?, ?, 'ready', NULL, NULL, NULL, 'chatgpt', 'workspaceWrite', 'never')`)
        .run(randomUUID(), requeueWorkId, current.prompt, current.workspace);
      this.db
        .prepare(`INSERT INTO execution_request_predecessors
        (workId, previousWorkId, predecessorKnown) VALUES (?, ?, 1)`)
        .run(requeueWorkId, value.workId);
      this.db
        .prepare(`INSERT INTO task_execution_bindings
        (workId, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, harness)
        SELECT ?, taskId, assignmentId, assignmentVersion, instructionsRevision,
          profileRevision, conversationRevision, harness FROM task_execution_bindings
        WHERE workId = ?`)
        .run(requeueWorkId, value.workId);
      this.db
        .prepare(`INSERT INTO turn_requests
        (requestKey, workId, kind, taskId, projectId, assignmentId, taskVersion,
          assignmentVersion, instructionsRevision, profileRevision, prompt,
          workspace, previousWorkId, state, reason, nextEligibleAt, draftTurn,
          draftTaskDigest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`)
        .run(
          requeueWorkId,
          requeueWorkId,
          current.kind,
          current.taskId,
          current.projectId,
          current.assignmentId,
          current.taskVersion,
          current.assignmentVersion,
          current.instructionsRevision,
          current.profileRevision,
          current.prompt,
          current.workspace,
          value.workId,
          current.draftTurn,
          current.draftTaskDigest,
        );
      this.db
        .prepare(`INSERT INTO execution_retry_generations
        (workId, chainId, retryIndex) VALUES (?, ?, ?)`)
        .run(requeueWorkId, generation.chainId, generation.retryIndex);
      const resolved = this.db
        .prepare(`UPDATE execution_intents SET state = 'resolved-failed',
        reason = 'Interrupted by planned shutdown; requeued'
        WHERE workId = ? AND state = 'held' RETURNING workId`)
        .get(value.workId);
      if (!resolved)
        throw new Error(
          "Interrupted generation changed before shutdown resolution",
        );
      this.db
        .prepare(`UPDATE turn_requests SET
        reason = 'Interrupted by planned shutdown; requeued'
        WHERE workId = ? AND state = 'held'`)
        .run(value.workId);
      this.db
        .prepare(`UPDATE execution_pending_effects SET state = 'settled',
        reason = 'Superseded by shutdown requeue'
        WHERE workId = ? AND effectKey = 'assignment-result'`)
        .run(value.workId);
      for (const table of [
        "execution_capacity_reservations",
        "task_writer_admissions",
        "execution_stop_targets",
      ])
        this.db
          .prepare(`DELETE FROM ${table} WHERE workId = ?`)
          .run(value.workId);
      // The delivery batch's work ID is unique, so it follows the requeue.
      if (hasTable("coordination_delivery_batches"))
        this.db
          .prepare(`UPDATE coordination_delivery_batches SET deliveryWorkId = ?
          WHERE deliveryWorkId = ? AND state = 'queued'`)
          .run(requeueWorkId, value.workId);
      this.db
        .prepare(`INSERT INTO execution_shutdown_resolutions
        (interruptedWorkId, requeueWorkId, workRevision, requestSequence,
          threadId, turnId, harness, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          value.workId,
          requeueWorkId,
          value.workRevision,
          value.requestSequence,
          value.threadId,
          value.turnId,
          value.harness,
          Date.now(),
        );
      this.db
        .prepare(`INSERT INTO execution_recovery_observations
        (id, workId, kind, reason, recordedAt)
        VALUES (?, ?, 'shutdown-requeued', ?, ?)`)
        .run(
          randomUUID(),
          value.workId,
          recoveryReason("shutdown-requeued"),
          Date.now(),
        );
      return { interruptedWorkId: value.workId, requeueWorkId };
    });
  }

  /**
   * Ends a drafting run's request once its runtime is known to have ended (or,
   * for a queued run, never started), releasing any capacity it held. Task
   * executions never pass through here: their release goes through completion
   * or a recovery receipt.
   */
  releaseDraftingExecution(workId: string): boolean {
    return transaction(this.db, () => {
      const request = this.db
        .prepare(`UPDATE turn_requests SET state = 'completed', reason = NULL
          WHERE workId = ? AND kind = 'drafting' AND state != 'completed' RETURNING workId`)
        .get(workId);
      if (!request) return false;
      this.db
        .prepare(`UPDATE execution_intents SET state = 'resolved-failed',
          reason = 'Drafting run ended' WHERE workId = ?
          AND state IN ('ready','capacity-waiting','submitting','running','held')`)
        .run(workId);
      this.db
        .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
        .run(workId);
      this.db
        .prepare("DELETE FROM task_writer_admissions WHERE workId = ?")
        .run(workId);
      return true;
    });
  }

  /** The recorded inspection of a work item's runtime, if any. */
  recoveryInspectionKind(workId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT inspectionKind FROM execution_recovery_identities WHERE workId = ?",
      )
      .get(workId) as { inspectionKind: string | null } | undefined;
    return row?.inspectionKind ?? null;
  }

  /** `alongside` runs in the same transaction, so a caller's own record commits with it. */
  complete(
    id: string,
    threadId: string,
    turnId: string,
    alongside?: () => void,
  ): void {
    transaction(this.db, () => {
      const row = this.db
        .prepare(
          "UPDATE execution_intents SET state = 'completed', reason = NULL WHERE id = ? AND state = 'running' AND threadId = ? AND turnId = ? RETURNING workId",
        )
        .get(id, threadId, turnId) as { workId: string } | undefined;
      if (!row)
        throw new Error(
          "Completion identity or state does not match execution binding",
        );
      this.db
        .prepare("DELETE FROM execution_capacity_reservations WHERE workId = ?")
        .run(row.workId);
      this.db
        .prepare(
          "DELETE FROM execution_stop_targets WHERE workId = ? AND origin = 'shutdown'",
        )
        .run(row.workId);
      if (this.hasTurnRequests)
        this.db
          .prepare(
            "UPDATE turn_requests SET state = 'completed', reason = NULL WHERE workId = ?",
          )
          .run(row.workId);
      alongside?.();
    });
  }
}

const stopTargetSchema = z.object({
  taskId: z.string().uuid(),
  workId: z.string().min(1),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  interruptState: z.enum([
    "pending",
    "uncertain",
    "acknowledged",
    "failed",
    "unbound",
  ]),
  terminalState: z.enum(["unknown", "completed", "failed"]),
  reason: z.string().nullable(),
  requestedAt: z.number().int(),
  origin: z.enum(["operator", "shutdown"]),
});
