import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  boundedQuestionPayload,
  structuredAnswerDigest,
} from "../core/structured-questions.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveOnPath } from "./executable-path.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  encodeNativeInputReply,
  nativeEndpointKey,
  parseNativeInputRequest,
  nativeInputRequestSchema,
  nativeInputEndpointIdentitySchema,
  nativeInputQualificationSchema,
  type NativeInputEndpointIdentity,
  type NativeInputReply,
  type NativeInputProtocolQualification,
  type RuntimeReplyIntent,
  type RuntimeUserInputOutcome,
  type RuntimeUserInputRequest,
} from "./native-input.js";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  type ProfileSkills,
  supportedRuntimeSettingsSchema,
} from "../core/execution-runtime.js";
import type { ExecutionHarness } from "./execution-harness.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RuntimeProcessIdentity,
} from "./recovery-types.js";
import { captureProcessIdentity } from "./termination.js";
import {
  ArchivedResumeRejectedError,
  archivedResumeRejectionSchema,
} from "./pre-turn-recovery.js";
import {
  cabCodexHome,
  type RuntimeSafetyPort,
  type RuntimeTerminalEvidence,
  type RuntimeTerminalFailureEvidence,
  type RuntimeThreadQualification,
} from "./runtime-retention.js";
import {
  type CodexHome,
  PreviousCodexHomeError,
  prepareCodexHome,
  realHome,
} from "./codex-home.js";

const rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const account = z.object({ account: z.object({ type: z.literal("chatgpt") }) });
const configuration = z.object({
  config: z
    .object({
      approval_policy: z.literal("never"),
      sandbox_mode: z.literal("workspace-write"),
    })
    .passthrough(),
});
const thread = z.object({
  thread: z.object({ id: z.string() }),
  approvalPolicy: z.literal("never"),
  sandbox: z.object({ type: z.literal("workspaceWrite") }),
});
const turn = z.object({ turn: z.object({ id: z.string() }) });
/** App Server `model/list`: the runtime's own catalogue of models and their reasoning efforts. */
const modelList = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      isDefault: z.boolean(),
      supportedReasoningEfforts: z.array(
        z.object({ reasoningEffort: z.string() }),
      ),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
const maxModelListPages = 8;
/** A safety margin under V8's ~512 Mi-character string limit, which would throw inside a stream handler. */
export const maxAppServerLineBytes = 128 * 1024 * 1024;
const defaultSettingsRetryMs = 30_000;
const maxSettingsRetryMs = 10 * 60_000;
const qualifiedCodexVersion = "codex-cli 0.159.0";
/** Native input is qualified only for the pinned Codex CLI. */
export const codexNativeInputQualificationSchema =
  nativeInputQualificationSchema.extend({
    codexVersion: z.literal(qualifiedCodexVersion),
  });
const codexErrorInfoSchema = z.enum([
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
]);
const completedTurn = z.object({
  threadId: z.string().min(1),
  turn: z.object({
    id: z.string().min(1),
    status: z.string(),
    error: z
      .object({ codexErrorInfo: z.string().optional() })
      .nullable()
      .optional(),
  }),
});
const runtimeToolDefinitionSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
const runtimeToolCallSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
});
const runtimeToolResultSchema = z
  .object({ text: z.string().max(16000), success: z.boolean() })
  .strict();

export interface RuntimeToolDefinition {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface RuntimeThreadSettings {
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

interface RuntimeThreadSnapshot {
  tools?: readonly RuntimeToolDefinition[];
  settings?: RuntimeThreadSettings;
}

const maxSettledThreadSnapshots = 128;
const maxSettledThreadSnapshotBytes = 256 * 1024;

function threadSnapshotBytes(
  threadId: string,
  snapshot: RuntimeThreadSnapshot,
): number {
  return Buffer.byteLength(JSON.stringify([threadId, snapshot]) ?? "", "utf8");
}

/** One joint bounded cache for tool definitions and thread-start settings. */
class BoundedThreadSnapshotCache extends Map<string, RuntimeThreadSnapshot> {
  constructor(private readonly isPinned: (threadId: string) => boolean) {
    super();
  }

  override get(threadId: string): RuntimeThreadSnapshot | undefined {
    const snapshot = super.get(threadId);
    if (snapshot !== undefined) {
      super.delete(threadId);
      super.set(threadId, snapshot);
    }
    return snapshot;
  }

  override set(threadId: string, snapshot: RuntimeThreadSnapshot): this {
    super.delete(threadId);
    super.set(threadId, snapshot);
    this.trimSettledEntries();
    return this;
  }

  settledStats(): {
    count: number;
    utf8Bytes: number;
    pinnedCount: number;
    pinnedUtf8Bytes: number;
  } {
    let count = 0;
    let utf8Bytes = 0;
    let pinnedCount = 0;
    let pinnedUtf8Bytes = 0;
    for (const [threadId, snapshot] of this) {
      const bytes = threadSnapshotBytes(threadId, snapshot);
      if (this.isPinned(threadId)) {
        pinnedCount++;
        pinnedUtf8Bytes += bytes;
      } else {
        count++;
        utf8Bytes += bytes;
      }
    }
    return { count, utf8Bytes, pinnedCount, pinnedUtf8Bytes };
  }

  trimSettledEntries(): void {
    while (true) {
      const stats = this.settledStats();
      if (
        stats.count <= maxSettledThreadSnapshots &&
        stats.utf8Bytes <= maxSettledThreadSnapshotBytes
      )
        return;
      let evicted = false;
      for (const threadId of this.keys()) {
        if (this.isPinned(threadId)) continue;
        super.delete(threadId);
        evicted = true;
        break;
      }
      if (!evicted) return;
    }
  }
}

export interface RuntimeToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface RuntimeToolResult {
  text: string;
  success: boolean;
}

/** A field over its cap is replaced whole, never cut. */
export type RuntimeOmittedField = { omitted: "size-limit"; bytes: number };

/** Metadata only: never message text, deltas or reasoning content. */
export type RuntimeDiagnosticEvent =
  | {
      kind: "item";
      phase: "started" | "completed";
      threadId: string;
      turnId: string;
      itemId: string;
      itemType: string;
      status?: string;
      /** Claude `toolCall` items only: the tool's fixed name, never its input. */
      tool?: string;
      /** Claude only: the call came from a subagent of the turn. */
      subagent?: { id: string; type?: string };
      /** Present only for `commandExecution` items. */
      command?: string | RuntimeOmittedField;
      cwd?: string;
      exitCode?: number | null;
      aggregatedOutput?: string | RuntimeOmittedField | null;
    }
  | { kind: "turn"; threadId: string; turnId: string; status: string };

export interface RuntimeObservedSettings {
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

export type RuntimeConversationEvent =
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "started";
    }
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "delta";
      bytes: number;
    }
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "completed";
      text: string;
    }
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      kind: "omitted";
      reason:
        | "size-limit"
        | "item-limit"
        | "active-turn-limit"
        | "turn-ended"
        | "missing-text";
    };

type PendingConversationItem =
  | { kind: "capturing"; chunks: string[]; bytes: number; fragments: number }
  | { kind: "size-limit" };

interface PendingConversationTurn {
  items: Map<string, PendingConversationItem>;
  completedItems: Set<string>;
  totalItems: number;
  truncated: boolean;
}

const maxConversationItemBytes = 64 * 1024;
const maxPendingConversationItems = 64;
const maxConversationItemsPerTurn = 256;
const maxActiveConversationTurns = 16;
const maxConversationBufferBytes = 4 * 1024 * 1024;
const maxConversationFragmentsPerItem = 4096;
const maxConversationIdentityLength = 256;

const conversationIdentity = z
  .string()
  .min(1)
  .max(maxConversationIdentityLength);

const threadIdParamsSchema = z.object({ threadId: z.string() });
const nonEmptyThreadIdParamsSchema = z.object({ threadId: z.string().min(1) });
const threadTurnIdentitySchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
const serverRequestResolvedSchema = z.object({
  threadId: z.string(),
  requestId: z.union([z.string(), z.number()]),
});
const nativeItemNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.string(),
    delivery: z.unknown().optional(),
    questions: z.unknown().optional(),
    name: z.unknown().optional(),
  }),
});
const emptyResponseSchema = z.object({}).strict();
const turnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string() }),
});
const threadSettingsSchema = z.object({
  model: z.string(),
  modelProvider: z.string(),
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable(),
});
const diagnosticItemSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  item: z.object({
    id: z.string().min(1),
    type: z.string().min(1).max(64),
    status: z.string().max(64).optional().catch(undefined),
    command: z.string().optional().catch(undefined),
    cwd: z.string().optional().catch(undefined),
    exitCode: z.number().nullable().optional().catch(undefined),
    aggregatedOutput: z.string().nullable().optional().catch(undefined),
  }),
});
export const maxDiagnosticCommandBytes = 4 * 1024;
export const maxDiagnosticOutputBytes = 48 * 1024;
/** Replaces a string over its byte limit whole; shared by every harness. */
export function capDiagnosticField(
  value: string,
  limit: number,
): string | RuntimeOmittedField {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes > limit ? { omitted: "size-limit", bytes } : value;
}
const maxObservedThreads = 128;
const conversationItemStartedSchema = z.object({
  threadId: conversationIdentity,
  turnId: conversationIdentity,
  item: z.object({ id: conversationIdentity, type: z.string().max(64) }),
});
const conversationDeltaSchema = z.object({
  threadId: conversationIdentity,
  turnId: conversationIdentity,
  itemId: conversationIdentity,
  delta: z.string(),
});
const conversationItemCompletedSchema = z.object({
  threadId: conversationIdentity,
  turnId: conversationIdentity,
  item: z.object({
    id: conversationIdentity,
    type: z.string().max(64),
    text: z.unknown().optional(),
  }),
});

export function parseRuntimeToolCall(
  input: unknown,
): RuntimeToolCall | undefined {
  const parsed = runtimeToolCallSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function registeredTools(input: readonly RuntimeToolDefinition[] = []) {
  const parsed = z.array(runtimeToolDefinitionSchema).parse(input);
  const names = new Set<string>();
  for (const tool of parsed) {
    if (names.has(tool.name))
      throw new Error(`Duplicate dynamic tool name: ${tool.name}`);
    names.add(tool.name);
  }
  return Object.freeze(
    parsed.map((tool) =>
      Object.freeze({
        ...tool,
        inputSchema: Object.freeze({ ...tool.inputSchema }),
      }),
    ),
  );
}

export interface FailureEvidence extends RuntimeTerminalFailureEvidence {
  threadId: string;
  turnId: string;
  status: "failed";
  retryAfterMs?: number;
}

const failureEvidenceSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.literal("failed"),
    classification: z.enum(["transient", "permanent", "unknown"]),
    reasonCode: z.string().min(1).max(64),
    source: z.enum(["harness", "missing"]),
    harnessRetries: z.number().int().nonnegative().safe().nullable(),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .max(86_400_000)
      .optional(),
  })
  .strict();

export function parseFailureEvidence(
  input: unknown,
): FailureEvidence | undefined {
  const parsed = failureEvidenceSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { retryAfterMs, ...evidence } = parsed.data;
  return retryAfterMs === undefined ? evidence : { ...evidence, retryAfterMs };
}

/** The failed-terminal evidence recorded by the safety port, or undefined when absent or conflicted. */
export function terminalFailureEvidence(
  safety: RuntimeSafetyPort,
  threadId: string,
  turnId: string,
  generation: string | undefined,
): FailureEvidence | undefined {
  if (!threadId || !turnId || !generation) return undefined;
  try {
    const evidence = safety.terminal(threadId, turnId, generation);
    if (
      evidence?.firstStatus !== "failed" ||
      evidence.conflicted ||
      !evidence.workId ||
      !evidence.failure
    )
      return undefined;
    return parseFailureEvidence({
      threadId,
      turnId,
      status: "failed",
      ...evidence.failure,
    });
  } catch {
    return undefined;
  }
}

function makeFailureClassification(
  rawCode: string | undefined,
): RuntimeTerminalFailureEvidence {
  const parsed =
    rawCode === undefined ? undefined : codexErrorInfoSchema.safeParse(rawCode);
  const code = parsed?.success ? parsed.data : undefined;
  const classification =
    code === "serverOverloaded" || code === "rateLimitExceeded"
      ? "transient"
      : code === "badRequest" || code === "unauthorized"
        ? "permanent"
        : "unknown";
  return {
    classification,
    reasonCode: code ?? "unknown",
    source: code ? "harness" : "missing",
    // App Server's terminal TurnError exposes no per-turn retry count. Null is
    // deliberately non-retryable under the shared cab/Codex budget.
    harnessRetries: null,
  };
}

export const executionPolicy = (workspace: string, networkAccess = false) => ({
  type: "workspaceWrite" as const,
  writableRoots: [workspace],
  networkAccess,
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
});

/** Exact installed protocol denial for known approval requests; others error. */
export function deniedServerRequest(id: string | number, method: string) {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  )
    return { id, result: { decision: "cancel" } };
  if (method === "applyPatchApproval" || method === "execCommandApproval")
    return { id, result: { decision: "abort" } };
  return {
    id,
    error: {
      code: -32601,
      message: "cab denies unexpected server request",
    },
  };
}

export interface UnexpectedRequest {
  nativeReplay?: {
    runtimeGeneration: string;
    requestId: string | number;
    itemId: string;
    paramsDigest: string;
    originalParamsDigest: string | null;
    endpointState: string | null;
    acceptedReplays: number;
    identical: boolean;
  };
  method: string;
  threadId?: string;
  turnId?: string;
}

/** Modern approval params carry server-owned thread/turn IDs; legacy params do not. */
export function unexpectedRequest(
  method: string,
  params: unknown,
): UnexpectedRequest {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval"
  ) {
    const identity = threadTurnIdentitySchema.safeParse(params);
    if (identity.success) return { method, ...identity.data };
  }
  if (method === "item/tool/call") {
    const identity = threadTurnIdentitySchema.safeParse(params);
    if (identity.success) return { method, ...identity.data };
  }
  return { method };
}

/** Model settings of the bound profile revision, passed only when it sets a value. */
export interface RuntimeTurnSettings {
  model: string | null;
  reasoningEffort: string | null;
  /** The skill plugins the bound profile revision enables; absent when it enables none. */
  skills?: ProfileSkills;
}

/**
 * The operator's command network setting captured when the turn was admitted (Codex
 * only), and `access: "read-only"` for a draft turn, which also forces network off.
 */
export interface RuntimeTurnPolicy {
  networkAccess: boolean;
  access?: "read-only";
}

/** Per-turn read-only policy of a draft turn; proven on a workspace-write thread. */
export const readOnlyPolicy = () => ({
  type: "readOnly" as const,
  networkAccess: false,
});

/**
 * Thrown by `Runtime.start()` when the harness cannot run on this host because something it
 * runs is absent (Claude without `claude` on the `PATH`). The service treats that harness as
 * not enabled for this run, not as a failed runtime, and never falls back to another one.
 */
export class RuntimeNotEnabledError extends Error {}

export interface Runtime {
  /** Declared by real harness runtimes; test fakes omit it. */
  readonly harness?: ExecutionHarness;
  onUserInputRequest?(
    listener: (request: RuntimeUserInputRequest) => void,
  ): void;
  onUserInputOutcome?(
    listener: (outcome: RuntimeUserInputOutcome) => void,
  ): void;
  replyUserInput?(
    identity: NativeInputEndpointIdentity,
    reply: NativeInputReply,
    beforeWrite: () => RuntimeReplyIntent,
  ): Promise<void>;
  cancelUserInput?(identity: NativeInputEndpointIdentity, reason: string): void;
  currentUserInputGeneration?(): string | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(
    workspace: string,
    tools?: readonly RuntimeToolDefinition[],
    settings?: RuntimeTurnSettings,
  ): Promise<string>;
  resumeThread(
    threadId: string,
    tools?: readonly RuntimeToolDefinition[],
  ): Promise<void>;
  /**
   * Checked before admission. A reason keeps the work waiting: no writer,
   * capacity or uncertainty hold is taken because nothing has started.
   */
  preflightTurn?(input: {
    workspace: string;
    settings?: RuntimeTurnSettings;
  }): Promise<string | undefined>;
  /** Called when a preflight reason may have cleared, so waiting work is retried. */
  onAdmissionChange?(listener: () => void): void;
  startTurn(
    threadId: string,
    workspace: string,
    prompt: string,
    settings?: RuntimeTurnSettings,
    policy?: RuntimeTurnPolicy,
  ): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed">;
  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void): void;
  /** Called once when the runtime process is lost; the runtime does not restart itself. */
  onFailure?(listener: (error: Error) => void): void;
  onToolCall?(
    listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ): void;
  onTerminalAnomaly?(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ): void;
  onConversationEvent?(
    listener: (event: RuntimeConversationEvent) => void,
  ): void;
  /** Best-effort tool and turn metadata; listener failures never affect the runtime. */
  onDiagnosticEvent?(listener: (event: RuntimeDiagnosticEvent) => void): void;
  /** Settings the runtime reported when it started the thread, if known. */
  observedSettings?(threadId: string): RuntimeObservedSettings | undefined;
  processIdentity?():
    | RuntimeProcessIdentity
    | null
    | Promise<RuntimeProcessIdentity | null>;
  inspectExecution?(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection>;
  failureEvidence?(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined;
}

interface NativeEndpoint {
  call: RuntimeUserInputRequest;
  digest: string;
  state:
    | "pending"
    | "writing"
    | "sent-unconfirmed"
    | "confirmed"
    | "unavailable"
    | "uncertain";
  intent?: RuntimeReplyIntent;
  resolved: boolean;
  order: number;
  orderedReceipt?: RuntimeUserInputOutcome["orderedReceipt"];
  writeInFlight: boolean;
  outcomeRecorded: boolean;
  turnEnded: boolean;
}

/**
 * Delivers each newline-terminated line of `stream` as UTF-8, plus a final unterminated one at end.
 * A line over `maxAppServerLineBytes` is dropped and reported once through `onOverflow`; later
 * data is discarded.
 */
function splitLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onOverflow: () => void,
): void {
  let pending: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  const take = (piece: Buffer): boolean => {
    size += piece.length;
    if (size > maxAppServerLineBytes) {
      overflowed = true;
      pending = [];
      onOverflow();
      return false;
    }
    pending.push(piece);
    return true;
  };
  const emit = () => {
    const line = Buffer.concat(pending);
    pending = [];
    size = 0;
    const end = line.at(-1) === 0x0d ? line.length - 1 : line.length;
    onLine(line.toString("utf8", 0, end));
  };
  stream.on("data", (chunk: Buffer) => {
    let start = 0;
    while (!overflowed) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        take(chunk.subarray(start));
        return;
      }
      if (!take(chunk.subarray(start, newline))) return;
      emit();
      start = newline + 1;
    }
  });
  stream.on("end", () => {
    if (!overflowed && size > 0) emit();
  });
}

/** One private stdio App Server process. It never sends an approval grant. */
export class CodexRuntime implements Runtime {
  readonly harness = "codex" as const;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nativeGeneration: string | undefined;
  private nativeExecutable:
    | { codexVersion: string; executableHash: string }
    | undefined;
  private readonly nativeEndpoints = new Map<string, NativeEndpoint>();
  private readonly nativeEndpointsByTurn = new Map<string, Set<string>>();
  private readonly nativeEndpointsByRpcId = new Map<string, Set<string>>();
  private readonly threadSnapshots = new BoundedThreadSnapshotCache(
    (threadId) => this.isThreadSnapshotPinned(threadId),
  );
  private readonly nativeTurns = new Map<string, string>();
  private readonly invalidNativeTurns = new Set<string>();
  private readonly nativeReadbacks = new Map<
    string,
    {
      input: unknown;
      id: string | number;
      child: ChildProcessWithoutNullStreams;
      digest: string;
      requested: boolean;
      responded: boolean;
      replays: number;
      invalid: boolean;
    }
  >();
  private nativeRequest?: (request: RuntimeUserInputRequest) => void;
  private nativeOutcome?: (outcome: RuntimeUserInputOutcome) => void;
  onUserInputRequest(
    listener: (request: RuntimeUserInputRequest) => void,
  ): void {
    this.nativeRequest = listener;
  }
  onUserInputOutcome(
    listener: (outcome: RuntimeUserInputOutcome) => void,
  ): void {
    this.nativeOutcome = listener;
  }
  currentUserInputGeneration(): string | undefined {
    return this.failure ? undefined : this.nativeGeneration;
  }
  private emitNative(
    endpoint: NativeEndpoint,
    outcome: RuntimeUserInputOutcome["outcome"],
    reason: string,
  ): void {
    if (
      endpoint.state === "confirmed" ||
      endpoint.state === "uncertain" ||
      endpoint.state === "unavailable"
    )
      return;
    endpoint.state = outcome;
    endpoint.outcomeRecorded = false;
    try {
      if (this.nativeOutcome) {
        this.nativeOutcome({
          ...endpoint.call.identity,
          ...endpoint.intent,
          outcome,
          reason,
          ...(endpoint.orderedReceipt
            ? { orderedReceipt: { ...endpoint.orderedReceipt } }
            : {}),
        });
        endpoint.outcomeRecorded = true;
      }
      if (
        outcome !== "sent-unconfirmed" &&
        endpoint.outcomeRecorded &&
        !endpoint.writeInFlight &&
        (outcome !== "confirmed" || endpoint.turnEnded)
      )
        this.retireNativeEndpoint(endpoint.call.identity);
    } catch {
      endpoint.state = "uncertain";
      this.reportUnexpected({
        method: "native-outcome-could-not-be-recorded",
        threadId: endpoint.call.identity.threadId,
        turnId: endpoint.call.identity.turnId,
      });
    }
  }
  cancelUserInput(identity: NativeInputEndpointIdentity, reason: string): void {
    const endpoint = this.nativeEndpoints.get(nativeEndpointKey(identity));
    if (endpoint) {
      if (endpoint.state === "writing" && endpoint.resolved) return;
      const waiting = this.nativeReadbacks.get(identity.threadId);
      if (
        waiting &&
        waiting.child === this.child &&
        waiting.id === identity.requestId &&
        nativeInputRequestSchema.parse(waiting.input).turnId === identity.turnId
      )
        waiting.invalid = true;
      this.emitNative(
        endpoint,
        endpoint.intent ? "uncertain" : "unavailable",
        reason,
      );
    }
  }
  private cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: string,
  ): void {
    for (const endpoint of this.nativeEndpointsForTurn(threadId, turnId))
      this.cancelUserInput(endpoint.call.identity, reason);
  }

  private retireNativeTurn(
    threadId: string,
    turnId: string,
    reason: string,
  ): void {
    const activeTurn = this.nativeTurns.get(threadId);
    const waiting = this.nativeReadbacks.get(threadId);
    const waitingRequest = waiting
      ? nativeInputRequestSchema.safeParse(waiting.input)
      : undefined;
    const waitingTurn = waitingRequest?.success
      ? waitingRequest.data.turnId
      : undefined;
    const turnStartPending = [...this.pending.values()].some((pending) => {
      if (pending.method !== "turn/start") return false;
      const params = threadIdParamsSchema.safeParse(pending.params);
      return params.success && params.data.threadId === threadId;
    });
    const ownsThreadState =
      activeTurn === turnId ||
      (activeTurn === undefined &&
        !turnStartPending &&
        (waiting === undefined || waitingTurn === turnId));
    this.cancelNativeTurn(threadId, turnId, reason);
    for (const endpoint of this.nativeEndpointsForTurn(threadId, turnId)) {
      endpoint.turnEnded = true;
      if (endpoint.outcomeRecorded && !endpoint.writeInFlight)
        this.retireNativeEndpoint(endpoint.call.identity);
    }
    if (waiting) {
      const request = nativeInputRequestSchema.safeParse(waiting.input);
      if (request.success && request.data.turnId === turnId) {
        waiting.invalid = true;
        this.nativeReadbacks.delete(threadId);
      }
    }
    const turnKey = `${threadId}:${turnId}`;
    this.invalidNativeTurns.delete(turnKey);
    if (this.nativeTurns.get(threadId) === turnId)
      this.nativeTurns.delete(threadId);
    if (ownsThreadState) {
      this.threadSnapshots.delete(threadId);
    }
    this.threadSnapshots.trimSettledEntries();
  }
  async replyUserInput(
    identity: NativeInputEndpointIdentity,
    reply: NativeInputReply,
    beforeWrite: () => RuntimeReplyIntent,
  ): Promise<void> {
    const endpoint = this.nativeEndpoints.get(nativeEndpointKey(identity));
    const child = this.child;
    if (
      !endpoint ||
      !child ||
      identity.runtimeGeneration !== this.currentUserInputGeneration() ||
      endpoint.state !== "pending"
    )
      throw new Error("Native endpoint unavailable");
    const encoded = encodeNativeInputReply(
      endpoint.call.request,
      reply.answers,
    );
    const line = `${JSON.stringify({ id: identity.requestId, result: encoded })}\n`;
    return await new Promise<void>((resolve, reject) => {
      try {
        const intent = beforeWrite();
        if (
          !intent.replyIntentId ||
          intent.answerDigest !== structuredAnswerDigest(encoded.answers)
        )
          throw new Error("Invalid native reply intent");
        if (
          endpoint.state !== "pending" ||
          this.child !== child ||
          identity.runtimeGeneration !== this.currentUserInputGeneration()
        )
          throw new Error("Native endpoint changed before write");
        endpoint.intent = { ...intent };
        endpoint.state = "writing";
        endpoint.writeInFlight = true;
        const orderedReceipt = {
          writeInitiated: ++endpoint.order,
        } as NonNullable<RuntimeUserInputOutcome["orderedReceipt"]>;
        endpoint.orderedReceipt = orderedReceipt;
        child.stdin.write(line, (error) => {
          endpoint.writeInFlight = false;
          if (
            error ||
            this.child !== child ||
            endpoint.state === "uncertain" ||
            endpoint.state === "unavailable"
          ) {
            if (
              (endpoint.state === "uncertain" ||
                endpoint.state === "unavailable") &&
              endpoint.outcomeRecorded
            )
              this.retireNativeEndpoint(endpoint.call.identity);
            else
              this.emitNative(
                endpoint,
                "uncertain",
                "Native write failed or endpoint lost",
              );
            reject(error ?? new Error("Native endpoint unavailable"));
            return;
          }
          orderedReceipt.stdinSucceeded = ++endpoint.order;
          this.emitNative(
            endpoint,
            endpoint.resolved ? "confirmed" : "sent-unconfirmed",
            endpoint.resolved
              ? "Matching resolution after successful stdin write"
              : "Successful stdin write; resolution pending",
          );
          resolve();
        });
      } catch (error) {
        endpoint.writeInFlight = false;
        if (endpoint.intent)
          this.emitNative(endpoint, "uncertain", "Native write failed");
        reject(error);
      }
    });
  }
  private async qualifyExecutable(
    environment: NodeJS.ProcessEnv,
    executable: string,
  ): Promise<void> {
    this.nativeExecutable = undefined;
    try {
      const { stdout } = await promisify(execFile)(executable, ["--version"], {
        env: environment,
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      });
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(executable))
        hash.update(chunk);
      const executableHash = hash.digest("hex");
      if (
        stdout.trim() === qualifiedCodexVersion &&
        executableHash ===
          (this.options.qualifiedExecutableHash ??
            "e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a")
      )
        this.nativeExecutable = { codexVersion: stdout.trim(), executableHash };
    } catch {
      /* General runtime remains usable without native qualification. */
    }
  }
  private captureNativeQualification(
    threadId: string,
    input: unknown,
  ): NativeInputProtocolQualification | undefined {
    const parsed = z
      .object({
        thread: z.object({ id: z.literal(threadId) }),
        model: z.string().min(1),
        modelProvider: z.string().min(1),
        reasoningEffort: z.string().nullable(),
        serviceTier: z.string().nullable(),
        collaborationMode: z.object({
          mode: z.literal("default"),
          settings: z.object({
            model: z.string(),
            reasoning_effort: z.string().nullable(),
            developer_instructions: z.string().nullable(),
          }),
        }),
      })
      .safeParse(input);
    const snapshot = this.threadSnapshots.get(threadId);
    const startedSettings = snapshot?.settings;
    if (!parsed.success || !this.nativeExecutable || !this.nativeGeneration)
      return undefined;
    const data = parsed.data;
    if (
      data.collaborationMode.settings.model !== data.model ||
      data.collaborationMode.settings.reasoning_effort !== data.reasoningEffort
    )
      return undefined;
    if (
      startedSettings &&
      ["model", "modelProvider", "reasoningEffort", "serviceTier"].some(
        (key) =>
          startedSettings[key as keyof typeof startedSettings] !==
          data[key as keyof typeof data],
      )
    )
      return undefined;
    const definitions = snapshot?.tools;
    if (!definitions) return undefined;
    const toolDigest = createHash("sha256")
      .update(JSON.stringify(definitions))
      .digest("hex");
    let prior: RuntimeThreadQualification | null;
    try {
      prior = this.options.safety.threadQualification(threadId);
    } catch {
      return undefined;
    }
    if (!prior || prior.toolDigest !== toolDigest) return undefined;
    const qualification = codexNativeInputQualificationSchema.safeParse({
      ...this.nativeExecutable,
      threadId,
      runtimeGeneration: this.nativeGeneration,
      mode: "default",
      model: data.model,
      modelProvider: data.modelProvider,
      reasoningEffort: data.reasoningEffort,
      serviceTier: data.serviceTier,
      developerInstructionsDigest: createHash("sha256")
        .update(
          JSON.stringify(
            data.collaborationMode.settings.developer_instructions,
          ),
        )
        .digest("hex"),
      continuation: "synchronous",
    });
    if (!qualification.success) return undefined;
    const observed = {
      threadId,
      toolDigest,
      codexVersion: this.nativeExecutable.codexVersion,
      executableHash: this.nativeExecutable.executableHash,
      model: data.model,
      modelProvider: data.modelProvider,
      reasoningEffort: data.reasoningEffort,
      serviceTier: data.serviceTier,
      developerInstructionsDigest:
        qualification.data.developerInstructionsDigest,
    };
    const priorFacts = [
      prior.codexVersion,
      prior.executableHash,
      prior.model,
      prior.modelProvider,
      prior.reasoningEffort,
      prior.serviceTier,
      prior.developerInstructionsDigest,
    ];
    try {
      if (priorFacts.every((value) => value === null)) {
        if (!startedSettings) return undefined;
        this.options.safety.recordThreadQualification(observed);
      } else if (
        JSON.stringify(priorFacts) !==
        JSON.stringify([
          observed.codexVersion,
          observed.executableHash,
          observed.model,
          observed.modelProvider,
          observed.reasoningEffort,
          observed.serviceTier,
          observed.developerInstructionsDigest,
        ])
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return qualification.data;
  }
  private receiveNativeRequest(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    input: unknown,
  ): boolean {
    try {
      boundedQuestionPayload(input);
      const request = nativeInputRequestSchema.parse(input);
      nativeInputEndpointIdentitySchema.shape.requestId.parse(id);
      const threadId = request.threadId;
      if (
        !this.nativeExecutable ||
        !this.nativeRequest ||
        !this.nativeGeneration
      )
        return false;
      const digest = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const identity = {
        requestId: id,
        runtimeGeneration: this.nativeGeneration,
        threadId,
        turnId: request.turnId,
        itemId: request.itemId,
      };
      const knownRequest = this.nativeEndpointByRpcId(identity);
      const terminal = this.persistedTerminal(threadId, request.turnId);
      const history = this.options.safety.nativeEndpointHistory(identity);
      const prior = this.nativeReadbacks.get(threadId);
      // Resume retransmission can arrive after the operator has already answered.
      // It is the same request, never permission to expose or reply a second time.
      if (
        prior &&
        !prior.invalid &&
        prior.child === child &&
        child === this.child &&
        prior.id === id &&
        isDeepStrictEqual(prior.input, input) &&
        prior.requested &&
        prior.responded &&
        prior.replays === 0 &&
        knownRequest !== undefined &&
        nativeEndpointKey(knownRequest.call.identity) ===
          nativeEndpointKey(identity) &&
        history === "exact-identity-seen" &&
        this.nativeTurns.get(threadId) === request.turnId &&
        !this.invalidNativeTurns.has(`${threadId}:${request.turnId}`) &&
        terminal === null &&
        ["pending", "writing", "sent-unconfirmed", "confirmed"].includes(
          knownRequest.state,
        )
      ) {
        prior.replays++;
        return true;
      }
      const nativeReplay = {
        runtimeGeneration: this.nativeGeneration,
        requestId: id,
        itemId: request.itemId,
        paramsDigest: digest,
        originalParamsDigest: prior?.digest ?? knownRequest?.digest ?? null,
        endpointState: knownRequest?.state ?? null,
        acceptedReplays: prior?.replays ?? 0,
        identical: Boolean(
          prior && prior.id === id && isDeepStrictEqual(prior.input, input),
        ),
      };
      if (
        terminal !== null ||
        (history !== "new" && history !== "exact-identity-seen") ||
        (history === "exact-identity-seen" && !knownRequest) ||
        (knownRequest &&
          (knownRequest.state !== "pending" ||
            knownRequest.call.identity.turnId !== request.turnId ||
            knownRequest.call.identity.itemId !== request.itemId))
      ) {
        if (
          knownRequest &&
          ["pending", "writing", "sent-unconfirmed"].includes(
            knownRequest.state,
          )
        ) {
          this.cancelUserInput(
            knownRequest.call.identity,
            "Conflicting or late native replay",
          );
          const waiting = this.nativeReadbacks.get(threadId);
          if (
            waiting &&
            nativeInputRequestSchema.parse(waiting.input).turnId ===
              knownRequest.call.identity.turnId
          )
            waiting.invalid = true;
        }
        this.reportUnexpected(
          {
            method: "stale-native-input",
            nativeReplay,
            threadId,
            turnId: request.turnId,
          },
          child,
        );
        return true;
      }
      if (prior) {
        const endpoint = this.nativeEndpointsForTurn(
          threadId,
          request.turnId,
        )[0];
        prior.invalid = true;
        if (endpoint)
          this.cancelUserInput(
            endpoint.call.identity,
            "Conflicting or repeated native request",
          );
        this.reportUnexpected(
          {
            method: "conflicting-native-input",
            nativeReplay,
            threadId,
            turnId: request.turnId,
          },
          child,
        );
        return true;
      }
      this.nativeReadbacks.set(threadId, {
        input,
        id,
        child,
        digest,
        requested: false,
        responded: false,
        replays: 0,
        invalid: false,
      });
      void this.qualifyNativeRequest(threadId);
      return true;
    } catch {
      return false;
    }
  }
  private async qualifyNativeRequest(threadId: string): Promise<void> {
    const pending = this.nativeReadbacks.get(threadId);
    if (!pending || pending.requested || !this.nativeTurns.has(threadId))
      return;
    pending.requested = true;
    try {
      const rawResponse = await this.request(
        "thread/resume",
        { threadId },
        () => {
          pending.responded = true;
        },
      );
      if (this.nativeReadbacks.get(threadId) !== pending)
        throw new Error("Native readback replaced");
      const resumed = thread.parse(rawResponse);
      if (resumed.thread.id !== threadId)
        throw new Error("Native resume identity mismatch");
      const qualification = this.captureNativeQualification(
        threadId,
        rawResponse,
      );
      if (!qualification || pending.invalid || this.child !== pending.child)
        throw new Error("Native request unqualified");
      const request = parseNativeInputRequest(pending.input, qualification);
      if (
        this.nativeTurns.get(threadId) !== request.turnId ||
        this.persistedTerminal(threadId, request.turnId) !== null ||
        this.invalidNativeTurns.has(`${threadId}:${request.turnId}`)
      )
        throw new Error("Native turn unavailable");
      const identity = {
        requestId: pending.id,
        runtimeGeneration: qualification.runtimeGeneration,
        threadId,
        turnId: request.turnId,
        itemId: request.itemId,
      };
      if (this.options.safety.nativeEndpointHistory(identity) !== "new")
        throw new Error("Native endpoint history is not fresh");
      const call = { identity, request, qualification };
      this.addNativeEndpoint({
        call,
        digest: pending.digest,
        state: "pending",
        resolved: false,
        order: 0,
        writeInFlight: false,
        outcomeRecorded: false,
        turnEnded: false,
      });
      this.nativeRequest?.(call);
    } catch {
      const turnId = nativeInputRequestSchema.parse(pending.input).turnId;
      this.reportUnexpected(
        {
          method: "unqualified-native-input",
          threadId,
          ...(turnId ? { turnId } : {}),
        },
        pending.child,
      );
    }
  }
  private receiveNativeNotification(method: string, params: unknown): void {
    if (method === "serverRequest/resolved") {
      const parsed = serverRequestResolvedSchema.safeParse(params);
      if (!parsed.success) return;
      const waiting = this.nativeReadbacks.get(parsed.data.threadId);
      const endpoint = this.nativeGeneration
        ? this.nativeEndpointByRpcId({
            requestId: parsed.data.requestId,
            runtimeGeneration: this.nativeGeneration,
            threadId: parsed.data.threadId,
            turnId: "",
            itemId: "",
          })
        : undefined;
      if (
        waiting &&
        waiting.child === this.child &&
        waiting.id === parsed.data.requestId &&
        !endpoint
      ) {
        waiting.invalid = true;
        this.reportUnexpected({
          method: "native-resolution-before-qualification",
          threadId: parsed.data.threadId,
        });
        return;
      }
      if (endpoint) {
        if (endpoint.state === "pending")
          this.emitNative(
            endpoint,
            "unavailable",
            "Resolution before native write",
          );
        else if (endpoint.state === "writing") {
          if (!endpoint.resolved && endpoint.orderedReceipt)
            endpoint.orderedReceipt.matchingResolution = ++endpoint.order;
          endpoint.resolved = true;
        } else if (endpoint.state === "sent-unconfirmed") {
          if (endpoint.orderedReceipt)
            endpoint.orderedReceipt.matchingResolution = ++endpoint.order;
          this.emitNative(
            endpoint,
            "confirmed",
            "Matching resolution after successful stdin write",
          );
        }
        return;
      }
      this.reportUnexpected({
        method: "unmatched-native-resolution",
        threadId: parsed.data.threadId,
      });
    }
    if (method === "item/started" || method === "item/completed") {
      const parsed = nativeItemNotificationSchema.safeParse(params);
      if (parsed.success) {
        const { item, threadId, turnId } = parsed.data;
        if (
          item.delivery === "async" ||
          item.questions != null ||
          item.name === "request_user_input_async"
        ) {
          this.invalidNativeTurns.add(`${threadId}:${turnId}`);
          const waiting = this.nativeReadbacks.get(threadId);
          if (waiting) waiting.invalid = true;
          this.cancelNativeTurn(
            threadId,
            turnId,
            "Unqualified asynchronous input origin",
          );
          this.reportUnexpected({
            method: "unqualified-async-input",
            threadId,
            turnId,
          });
        }
      }
    }
  }
  private processIdentityValue: RuntimeProcessIdentity | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      beforeResolve?(value: unknown): void;
      timer: NodeJS.Timeout;
      method: string;
      params: unknown;
      processIdentity: RuntimeProcessIdentity | null;
    }
  >();
  private readonly events = new EventEmitter();
  private unexpected?: (request: UnexpectedRequest) => void;
  private toolCall?: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
  private terminalAnomaly?: (anomaly: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  private conversationEvent?: (event: RuntimeConversationEvent) => void;
  private diagnosticEvent?: (event: RuntimeDiagnosticEvent) => void;
  private readonly observedThreadSettings = new Map<
    string,
    RuntimeObservedSettings
  >();
  private readonly conversationTurns = new Map<
    string,
    PendingConversationTurn
  >();
  private conversationBufferBytes = 0;
  private conversationCaptureSaturated = false;
  private readonly overflowedConversationTurns = new Set<string>();
  private conversationOverflowIdentityCapExceeded = false;
  private failure: Error | undefined;

  private isThreadSnapshotPinned(threadId: string): boolean {
    if (this.nativeTurns.has(threadId) || this.nativeReadbacks.has(threadId))
      return true;
    for (const pending of this.pending.values()) {
      if (pending.method !== "thread/resume" && pending.method !== "turn/start")
        continue;
      const params = nonEmptyThreadIdParamsSchema.safeParse(pending.params);
      if (params.success && params.data.threadId === threadId) return true;
    }
    return [...this.nativeEndpoints.values()].some(
      (endpoint) =>
        endpoint.call.identity.threadId === threadId && !endpoint.turnEnded,
    );
  }

  private nativeTurnKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private nativeRpcKey(identity: NativeInputEndpointIdentity): string {
    return JSON.stringify([
      identity.runtimeGeneration,
      identity.threadId,
      typeof identity.requestId,
      String(identity.requestId),
    ]);
  }

  private addNativeEndpoint(endpoint: NativeEndpoint): void {
    const key = nativeEndpointKey(endpoint.call.identity);
    this.nativeEndpoints.set(key, endpoint);
    const turnKey = this.nativeTurnKey(
      endpoint.call.identity.threadId,
      endpoint.call.identity.turnId,
    );
    const turnKeys =
      this.nativeEndpointsByTurn.get(turnKey) ?? new Set<string>();
    turnKeys.add(key);
    this.nativeEndpointsByTurn.set(turnKey, turnKeys);
    const rpcKey = this.nativeRpcKey(endpoint.call.identity);
    const rpcKeys =
      this.nativeEndpointsByRpcId.get(rpcKey) ?? new Set<string>();
    rpcKeys.add(key);
    this.nativeEndpointsByRpcId.set(rpcKey, rpcKeys);
  }

  private nativeEndpointByRpcId(
    identity: NativeInputEndpointIdentity,
  ): NativeEndpoint | undefined {
    const keys = this.nativeEndpointsByRpcId.get(this.nativeRpcKey(identity));
    if (!keys || keys.size === 0) return undefined;
    if (keys.size !== 1)
      throw new Error("Active native RPC identity is ambiguous");
    const key = keys.values().next().value as string | undefined;
    return key ? this.nativeEndpoints.get(key) : undefined;
  }

  private nativeEndpointsForTurn(
    threadId: string,
    turnId: string,
  ): NativeEndpoint[] {
    const keys = this.nativeEndpointsByTurn.get(
      this.nativeTurnKey(threadId, turnId),
    );
    if (!keys) return [];
    return [...keys]
      .map((key) => this.nativeEndpoints.get(key))
      .filter((endpoint): endpoint is NativeEndpoint => endpoint !== undefined);
  }

  private retireNativeEndpoint(identity: NativeInputEndpointIdentity): void {
    const key = nativeEndpointKey(identity);
    const endpoint = this.nativeEndpoints.get(key);
    if (!endpoint) return;
    this.nativeEndpoints.delete(key);
    const turnKey = this.nativeTurnKey(identity.threadId, identity.turnId);
    const turnKeys = this.nativeEndpointsByTurn.get(turnKey);
    turnKeys?.delete(key);
    if (turnKeys?.size === 0) this.nativeEndpointsByTurn.delete(turnKey);
    const rpcKey = this.nativeRpcKey(identity);
    const rpcKeys = this.nativeEndpointsByRpcId.get(rpcKey);
    rpcKeys?.delete(key);
    if (rpcKeys?.size === 0) this.nativeEndpointsByRpcId.delete(rpcKey);
    this.threadSnapshots.trimSettledEntries();
  }

  private persistedTerminal(
    threadId: string,
    turnId: string,
  ): RuntimeTerminalEvidence | null {
    const generation = this.nativeGeneration;
    if (!generation) throw new Error("Runtime stopped");
    try {
      return this.options.safety.terminal(threadId, turnId, generation);
    } catch {
      this.terminalAnomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence could not be read",
      });
      throw new Error("Runtime terminal evidence unavailable");
    }
  }

  private terminalOutcome(
    threadId: string,
    turnId: string,
  ): "completed" | "failed" | null {
    const generation = this.nativeGeneration;
    if (!generation) throw new Error("Runtime stopped");
    let evidence: RuntimeTerminalEvidence | null;
    try {
      evidence = this.options.safety.terminalForWait(
        threadId,
        turnId,
        generation,
      );
    } catch {
      this.terminalAnomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence could not be verified for the bound turn",
      });
      throw new Error("Runtime terminal evidence unavailable");
    }
    if (!evidence) return null;
    if (
      evidence.workId === null ||
      evidence.conflicted ||
      evidence.firstStatus === null
    ) {
      this.terminalAnomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence is incomplete or conflicting",
      });
      throw new Error("Runtime terminal evidence is uncertain");
    }
    return evidence.firstStatus;
  }

  constructor(
    private readonly executable = "codex",
    private readonly options: {
      safety: RuntimeSafetyPort;
      spawnEnvironment?: () => NodeJS.ProcessEnv;
      /**
       * cab's own Codex home. Codex then runs with `CODEX_HOME` and `HOME` under it and a
       * linked login, and refuses to resume conversations started under the previous home.
       */
      codex?: CodexHome;
      /** Test-only executable identity for deterministic stdio fixtures. */
      qualifiedExecutableHash?: string;
      /** Test-only OS boundary for deterministic attached child identity. */
      captureProcessIdentity?: (
        pid: number | undefined,
      ) => Promise<RuntimeProcessIdentity | null>;
      /** First delay before a failed `model/list` read is retried (it doubles, to 10 min); default 30s. */
      settingsRetryMs?: number;
    },
  ) {}

  private supported: Map<string, readonly string[]> | undefined;
  private settingsRead: Promise<void> | undefined;
  private settingsRetry: NodeJS.Timeout | undefined;
  private settingsFailures = 0;
  private admissionChanged?: () => void;

  /** Undefined until `model/list` has been read; `default` is the default model's entry. */
  supportedSettings(): Record<string, readonly string[]> | undefined {
    return this.supported && Object.fromEntries(this.supported);
  }

  onAdmissionChange(listener: () => void): void {
    this.admissionChanged = listener;
  }

  /** Refuses configured values the runtime's own catalogue lacks; no settings is never a wait. */
  async preflightTurn(input: {
    workspace: string;
    settings?: RuntimeTurnSettings;
  }): Promise<string | undefined> {
    const { settings } = input;
    if (
      !settings ||
      (settings.model === null && settings.reasoningEffort === null)
    )
      return undefined;
    const unavailable = (reason: string) =>
      `Codex runtime unavailable: ${reason}`;
    const supported = this.supported;
    if (!supported) {
      this.readSupportedSettings();
      return unavailable("supported models are unknown");
    }
    const model = settings.model ?? "default";
    // `default` names the catalogue's default entry, never a model to send.
    const efforts =
      settings.model === "default" ? undefined : supported.get(model);
    if (!efforts) return unavailable(`model ${model} is not supported`);
    if (
      settings.reasoningEffort !== null &&
      !efforts.includes(settings.reasoningEffort)
    )
      return unavailable(
        `effort ${settings.reasoningEffort} is not supported for ${model}`,
      );
    return undefined;
  }

  /**
   * Single-flight and never awaited by a caller. A failed read schedules one retry with
   * doubling backoff, so an idle installation still learns the catalogue; the next preflight
   * of work with settings also reads it again. Success wakes admission for waiting work.
   */
  private readSupportedSettings(): void {
    const child = this.child;
    if (!child || this.supported || this.settingsRead) return;
    this.settingsRead = this.listSupportedSettings().then(
      (supported) => {
        if (this.child !== child) return;
        this.supported = supported;
        this.settingsRead = undefined;
        this.settingsFailures = 0;
        setTimeout(() => {
          if (this.child === child) this.admissionChanged?.();
        }, 0).unref();
      },
      () => {
        if (this.child !== child) return;
        this.settingsRead = undefined;
        if (this.settingsRetry) return;
        const base = this.options.settingsRetryMs ?? defaultSettingsRetryMs;
        const delay = Math.min(
          base * 2 ** this.settingsFailures++,
          maxSettingsRetryMs,
        );
        this.settingsRetry = setTimeout(() => {
          this.settingsRetry = undefined;
          if (this.child === child) this.readSupportedSettings();
        }, delay);
        this.settingsRetry.unref();
      },
    );
  }

  private resetSupportedSettings(): void {
    this.supported = undefined;
    this.settingsRead = undefined;
    this.settingsFailures = 0;
    clearTimeout(this.settingsRetry);
    this.settingsRetry = undefined;
  }

  private async listSupportedSettings(): Promise<
    Map<string, readonly string[]>
  > {
    const entries: { model: string; efforts: string[] }[] = [];
    let defaultEfforts: string[] | undefined;
    let cursor: string | null = null;
    for (let page = 0; page < maxModelListPages; page += 1) {
      const listed: z.infer<typeof modelList> = modelList.parse(
        await this.request("model/list", cursor ? { cursor } : {}),
      );
      for (const entry of listed.data) {
        const efforts = entry.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        );
        entries.push({ model: entry.model, efforts });
        if (entry.isDefault) defaultEfforts = efforts;
      }
      cursor = listed.nextCursor ?? null;
      if (!cursor) break;
    }
    // An unfinished listing or one without a default marker cannot vouch for `default`.
    if (cursor || !defaultEfforts) throw new Error("model/list is incomplete");
    const models = [{ model: "default", efforts: defaultEfforts }, ...entries];
    supportedRuntimeSettingsSchema.parse({ models });
    return new Map(models.map((entry) => [entry.model, entry.efforts]));
  }

  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void): void {
    this.unexpected = listener;
  }

  onFailure(listener: (error: Error) => void): void {
    this.events.on("failure", listener);
  }

  onToolCall(
    listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ): void {
    this.toolCall = listener;
  }

  onTerminalAnomaly(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ): void {
    this.terminalAnomaly = listener;
  }

  onConversationEvent(
    listener: (event: RuntimeConversationEvent) => void,
  ): void {
    this.conversationEvent = listener;
  }

  onDiagnosticEvent(listener: (event: RuntimeDiagnosticEvent) => void): void {
    this.diagnosticEvent = listener;
  }

  observedSettings(threadId: string): RuntimeObservedSettings | undefined {
    return this.observedThreadSettings.get(threadId);
  }

  async start(): Promise<void> {
    const environment = this.options.spawnEnvironment?.() ?? process.env;
    // One resolution feeds both qualification and spawn, so the hashed file is the one run.
    const executable = isAbsolute(this.executable)
      ? this.executable
      : ((await resolveOnPath(this.executable, environment)) ??
        this.executable);
    const codex = this.options.codex;
    // Awaited before the started guard so overlapping starts cannot both spawn.
    if (codex) await prepareCodexHome(codex, environment);
    if (this.child) throw new Error("Runtime already started");
    this.failure = undefined;
    this.clearConversationCaptures();
    this.nativeGeneration = randomUUID();
    this.resetSupportedSettings();
    this.nativeEndpoints.clear();
    this.nativeEndpointsByTurn.clear();
    this.nativeEndpointsByRpcId.clear();
    this.threadSnapshots.clear();
    this.nativeTurns.clear();
    this.invalidNativeTurns.clear();
    this.nativeReadbacks.clear();
    const child = spawn(
      executable,
      [
        "app-server",
        "-c",
        "approval_policy=never",
        "-c",
        "sandbox_mode=workspace-write",
        ...(codex
          ? [
              // The keyring and auto modes key credentials by CODEX_HOME and would ignore the link.
              "-c",
              "cli_auth_credentials_store=file",
              "-c",
              "features.multi_agent=false",
              "-c",
              "features.plugins=false",
              "-c",
              "features.skill_mcp_dependency_install=false",
              // Agent shell commands keep the real HOME; only Codex itself runs isolated.
              "-c",
              `shell_environment_policy.set.HOME=${JSON.stringify(realHome(environment))}`,
            ]
          : []),
      ],
      {
        stdio: "pipe",
        env: codex
          ? { ...environment, CODEX_HOME: codex.home, HOME: codex.userHome }
          : environment,
      },
    );
    this.child = child;
    this.processIdentityValue = null;
    child.on("error", (error) => this.failChild(child, error));
    child.on("exit", () =>
      this.failChild(child, new Error("Codex App Server exited")),
    );
    child.stdin.on("error", (error) => this.failChild(child, error));
    child.stdin.on("close", () =>
      this.failChild(child, new Error("Codex App Server stdin closed")),
    );
    // Diagnostics may contain sensitive data. Drain without retaining or logging
    // them so a full stderr pipe cannot stall JSON-RPC on stdout.
    child.stderr.resume();
    splitLines(
      child.stdout,
      (line) => this.receive(child, line),
      () =>
        this.failChild(
          child,
          new Error(
            `Codex App Server stdout line exceeds ${maxAppServerLineBytes} bytes`,
          ),
        ),
    );
    // Without stdout no terminal can arrive, so pending turn waits would never settle.
    child.stdout.on("close", () =>
      this.failChild(child, new Error("Codex App Server stdout closed")),
    );
    try {
      await this.qualifyExecutable(environment, executable);
      if (this.child !== child) throw new Error("Runtime stopped");
      this.processIdentityValue = await (
        this.options.captureProcessIdentity ?? captureProcessIdentity
      )(child.pid);
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.request("initialize", {
        clientInfo: { name: "cab", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.send(`${JSON.stringify({ method: "initialized" })}\n`);
      if (this.child !== child) throw new Error("Runtime stopped");
      await this.verifyLoginAndPolicy(child);
    } catch (error) {
      if (this.child === child) await this.stop();
      throw error;
    }
    // Not awaited: a slow or failed catalogue read must not delay or fail start.
    this.readSupportedSettings();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    for (const endpoint of [...this.nativeEndpoints.values()])
      this.cancelUserInput(endpoint.call.identity, "Runtime stopped");
    this.nativeGeneration = undefined;
    this.child = undefined;
    this.processIdentityValue = null;
    this.resetSupportedSettings();
    this.fail(new Error("Runtime stopped"));
    this.nativeEndpoints.clear();
    this.nativeEndpointsByTurn.clear();
    this.nativeEndpointsByRpcId.clear();
    this.threadSnapshots.clear();
    this.nativeTurns.clear();
    this.invalidNativeTurns.clear();
    this.nativeReadbacks.clear();
    this.clearConversationCaptures();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 3000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }

  async verifyLoginAndPolicy(expectedChild = this.child): Promise<void> {
    if (!expectedChild || this.child !== expectedChild)
      throw new Error("Runtime stopped");
    account.parse(await this.request("account/read", { refreshToken: false }));
    if (this.child !== expectedChild) throw new Error("Runtime stopped");
    configuration.parse(await this.request("config/read", {}));
    if (this.child !== expectedChild) throw new Error("Runtime stopped");
  }

  async startThread(
    workspace: string,
    tools: readonly RuntimeToolDefinition[] = [],
    settings?: RuntimeTurnSettings,
  ): Promise<string> {
    const definitions = registeredTools(tools);
    const response = thread.parse(
      await this.request(
        "thread/start",
        {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          ephemeral: false,
          // The thread-start snapshot then reports the configured values, as later resumes do.
          ...(settings?.model ? { model: settings.model } : {}),
          ...(settings?.reasoningEffort
            ? { config: { model_reasoning_effort: settings.reasoningEffort } }
            : {}),
          ...(definitions.length > 0 ? { dynamicTools: definitions } : {}),
        },
        (raw) => {
          const started = thread.parse(raw);
          const toolDigest = createHash("sha256")
            .update(JSON.stringify(definitions))
            .digest("hex");
          try {
            this.options.safety.registerThreadTools(
              started.thread.id,
              toolDigest,
            );
          } catch {
            throw new Error("Runtime thread safety baseline unavailable");
          }
          const settings = threadSettingsSchema.safeParse(raw);
          if (settings.success) {
            this.observedThreadSettings.delete(started.thread.id);
            this.observedThreadSettings.set(started.thread.id, settings.data);
            if (this.observedThreadSettings.size > maxObservedThreads) {
              const oldest = this.observedThreadSettings.keys().next();
              if (!oldest.done)
                this.observedThreadSettings.delete(oldest.value);
            }
          }
          this.threadSnapshots.set(started.thread.id, {
            tools: definitions,
            ...(settings.success && this.nativeExecutable
              ? { settings: settings.data }
              : {}),
          });
          if (!this.threadSnapshots.has(started.thread.id))
            throw new Error(
              "Runtime thread snapshot could not be retained safely",
            );
        },
      ),
    );
    return response.thread.id;
  }

  /**
   * Whether the thread may predate cab's Codex home. Fails closed: a thread without a durable
   * cab-home marker, or whose marker cannot be read, counts as earlier.
   */
  startedUnderPreviousHome(threadId: string): boolean {
    if (!this.options.codex) return false;
    try {
      return (
        this.options.safety.threadQualification(threadId)?.codexHome !==
        cabCodexHome
      );
    } catch {
      return true;
    }
  }

  async resumeThread(
    threadId: string,
    tools?: readonly RuntimeToolDefinition[],
  ): Promise<void> {
    if (this.startedUnderPreviousHome(threadId))
      throw new PreviousCodexHomeError();
    let snapshot = this.threadSnapshots.get(threadId);
    let restoredEmptyTools = false;
    if (!snapshot && tools === undefined) {
      const emptyToolDigest = createHash("sha256").update("[]").digest("hex");
      try {
        restoredEmptyTools =
          this.options.safety.threadQualification(threadId)?.toolDigest ===
          emptyToolDigest;
      } catch {
        // A missing or malformed durable baseline cannot establish tools.
      }
      if (restoredEmptyTools) snapshot = { tools: [] };
    }
    const definitions = registeredTools(tools ?? snapshot?.tools ?? []);
    await this.request(
      "thread/resume",
      {
        threadId,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ...(definitions.length > 0 ? { dynamicTools: definitions } : {}),
      },
      (raw) => {
        const resumed = thread.parse(raw);
        if (resumed.thread.id !== threadId)
          throw new Error("Resumed thread identity mismatch");
        if (tools !== undefined || restoredEmptyTools) {
          const nextSnapshot: RuntimeThreadSnapshot = {
            ...(snapshot?.settings ? { settings: snapshot.settings } : {}),
            tools: definitions,
          };
          this.threadSnapshots.set(threadId, nextSnapshot);
          if (!this.threadSnapshots.has(threadId))
            throw new Error(
              "Runtime thread snapshot could not be retained safely",
            );
        }
        this.captureNativeQualification(threadId, raw);
      },
    );
  }

  async startTurn(
    threadId: string,
    workspace: string,
    prompt: string,
    settings?: RuntimeTurnSettings,
    policy?: RuntimeTurnPolicy,
  ): Promise<string> {
    // Retire only the ephemeral readback before a new turn can emit callbacks.
    // Saved endpoints/receipts and disqualified turn identities remain historical.
    const previousTurn = this.nativeTurns.get(threadId);
    if (previousTurn)
      this.retireNativeTurn(threadId, previousTurn, "New turn requested");
    else {
      this.nativeReadbacks.delete(threadId);
    }
    const response = turn.parse(
      await this.request("turn/start", {
        threadId,
        cwd: workspace,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy:
          policy?.access === "read-only"
            ? readOnlyPolicy()
            : executionPolicy(workspace, policy?.networkAccess === true),
        // Re-asserted every turn so follow-up and resumed turns keep the captured revision.
        ...(settings?.model ? { model: settings.model } : {}),
        ...(settings?.reasoningEffort
          ? { effort: settings.reasoningEffort }
          : {}),
      }),
    );
    this.nativeTurns.set(threadId, response.turn.id);
    if (this.persistedTerminal(threadId, response.turn.id) !== null)
      this.retireNativeTurn(
        threadId,
        response.turn.id,
        "Turn ended before native request qualification",
      );
    else void this.qualifyNativeRequest(threadId);
    return response.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.cancelNativeTurn(threadId, turnId, "Turn interrupted");
    emptyResponseSchema.parse(
      await this.request("turn/interrupt", { threadId, turnId }),
    );
  }

  processIdentity(): RuntimeProcessIdentity | null {
    return this.processIdentityValue;
  }

  async inspectExecution(
    _identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    // thread/read and thread/resume expose history, not proof of this exact
    // process's current execution state. Do not turn either into a recovery fact.
    return {
      kind: "unknown",
      reason: "Codex App Server cannot prove exact historical execution state",
    };
  }

  failureEvidence(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined {
    return terminalFailureEvidence(
      this.options.safety,
      threadId,
      turnId,
      this.nativeGeneration,
    );
  }

  async waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed"> {
    if (this.failure) throw this.failure;
    const observed = this.terminalOutcome(threadId, turnId);
    if (observed) return observed;
    return await new Promise((resolve, reject) => {
      const onTerminal = (data: unknown) => {
        const parsed = turnCompletedSchema.safeParse(data);
        if (
          !parsed.success ||
          parsed.data.threadId !== threadId ||
          parsed.data.turn.id !== turnId
        )
          return;
        cleanup();
        try {
          const persisted = this.terminalOutcome(threadId, turnId);
          if (!persisted)
            throw new Error("Runtime terminal evidence is missing");
          resolve(persisted);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Runtime terminal evidence unavailable"),
          );
        }
      };
      const onFailure = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.events.off("turn/completed", onTerminal);
        this.events.off("failure", onFailure);
      };
      this.events.on("turn/completed", onTerminal);
      this.events.on("failure", onFailure);
    });
  }

  private request(
    method: string,
    params: unknown,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Runtime unavailable"));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.threadSnapshots.trimSettledEntries();
        reject(new Error(`${method} timed out`));
      }, 15000);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        params,
        processIdentity: this.processIdentityValue,
        ...(beforeResolve ? { beforeResolve } : {}),
      });
      void this.send(`${JSON.stringify({ id, method, params })}\n`).catch(
        (error: Error) => this.failChild(child, error),
      );
    });
  }

  private send(line: string): Promise<void> {
    const child = this.child;
    if (!child || this.failure)
      return Promise.reject(this.failure ?? new Error("Runtime unavailable"));
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(line, (error) => {
          if (this.child !== child) {
            reject(new Error("Runtime stopped"));
            return;
          }
          if (error) {
            this.failChild(child, error);
            reject(error);
          } else resolve();
        });
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.failChild(child, failure);
        reject(failure);
      }
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: z.infer<typeof rpc>;
    try {
      message = rpc.parse(JSON.parse(line));
    } catch {
      this.failChild(child, new Error("Malformed App Server message"));
      return;
    }
    if (message.method && message.id !== undefined) {
      const method = message.method;
      if (
        method === "item/tool/requestUserInput" &&
        this.receiveNativeRequest(child, message.id, message.params)
      )
        return;
      if (method === "item/tool/call") {
        this.receiveToolCall(child, message.id, message.params);
        return;
      }
      this.denyUnexpected(
        child,
        unexpectedRequest(method, message.params),
        deniedServerRequest(message.id, method),
      );
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      try {
        if (message.error !== undefined) {
          const params = threadIdParamsSchema.safeParse(pending.params);
          const rejection = archivedResumeRejectionSchema.safeParse({
            method: pending.method,
            requestId: message.id,
            threadId: params.success ? params.data.threadId : undefined,
            processIdentity: pending.processIdentity,
            error: message.error,
          });
          pending.reject(
            rejection.success &&
              message.method === undefined &&
              message.params === undefined &&
              message.result === undefined
              ? new ArchivedResumeRejectedError(rejection.data)
              : new Error(JSON.stringify(message.error)),
          );
        } else {
          try {
            pending.beforeResolve?.(message.result);
            pending.resolve(message.result);
          } catch (error) {
            pending.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      } finally {
        this.threadSnapshots.trimSettledEntries();
      }
      return;
    }
    if (message.method)
      this.receiveNativeNotification(message.method, message.params);
    if (message.method === "turn/completed") {
      const terminal = completedTurn.safeParse(message.params);
      if (!terminal.success) {
        this.terminalAnomaly?.({
          reason: "Missing terminal identity or status",
        });
        // An unattributable terminal could belong to any waiting turn.
        this.failChild(
          child,
          new Error("Runtime terminal evidence unavailable"),
        );
        return;
      } else {
        const runtimeGeneration = this.nativeGeneration;
        if (!runtimeGeneration) {
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: "Terminal event has no current runtime generation",
          });
          this.failChild(
            child,
            new Error("Runtime terminal evidence unavailable"),
          );
          return;
        }
        const status =
          terminal.data.turn.status === "completed" ? "completed" : "failed";
        let evidence: RuntimeTerminalEvidence;
        try {
          evidence = this.options.safety.recordTerminal({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            status,
            runtimeGeneration,
            ...(terminal.data.turn.status === "failed"
              ? {
                  failure: makeFailureClassification(
                    terminal.data.turn.error?.codexErrorInfo,
                  ),
                }
              : {}),
          });
        } catch {
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: "Terminal status could not be durably recorded",
          });
          this.failChild(
            child,
            new Error("Runtime terminal evidence unavailable"),
          );
          return;
        }
        if (evidence.conflicted || evidence.firstStatus === null)
          this.terminalAnomaly?.({
            threadId: terminal.data.threadId,
            turnId: terminal.data.turn.id,
            reason: evidence.conflicted
              ? "Conflicting terminal status"
              : "Terminal status is unknown",
          });
        this.retireNativeTurn(
          terminal.data.threadId,
          terminal.data.turn.id,
          "Turn ended before native receipt",
        );
        this.finishConversationTurn(
          terminal.data.threadId,
          terminal.data.turn.id,
        );
      }
    }
    if (message.method)
      this.projectConversationEvent(message.method, message.params);
    if (message.method) {
      try {
        this.projectDiagnosticEvent(message.method, message.params);
      } catch {
        // Diagnostics are best-effort and never alter runtime control.
      }
    }
    // EventEmitter throws when an unhandled `error` event is emitted. Codex
    // uses this notification for progress such as reconnect retries; turn
    // completion remains the only terminal signal.
    if (message.method && message.method !== "error")
      this.events.emit(message.method, message.params);
  }

  private projectDiagnosticEvent(method: string, params: unknown): void {
    const listener = this.diagnosticEvent;
    if (!listener) return;
    if (method === "turn/completed") {
      const parsed = turnCompletedSchema.safeParse(params);
      if (!parsed.success) return;
      listener({
        kind: "turn",
        threadId: parsed.data.threadId,
        turnId: parsed.data.turn.id,
        status: parsed.data.turn.status,
      });
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const parsed = diagnosticItemSchema.safeParse(params);
    if (!parsed.success) return;
    const { threadId, turnId, item } = parsed.data;
    if (item.type === "agentMessage" || item.type === "userMessage") return;
    const command = item.type === "commandExecution";
    listener({
      kind: "item",
      phase: method === "item/started" ? "started" : "completed",
      threadId,
      turnId,
      itemId: item.id,
      itemType: item.type,
      ...(item.status !== undefined ? { status: item.status } : {}),
      ...(command && item.command !== undefined
        ? {
            command: capDiagnosticField(
              item.command,
              maxDiagnosticCommandBytes,
            ),
          }
        : {}),
      ...(command && item.cwd !== undefined ? { cwd: item.cwd } : {}),
      ...(command && item.exitCode !== undefined
        ? { exitCode: item.exitCode }
        : {}),
      ...(command && item.aggregatedOutput !== undefined
        ? {
            aggregatedOutput:
              item.aggregatedOutput === null
                ? null
                : capDiagnosticField(
                    item.aggregatedOutput,
                    maxDiagnosticOutputBytes,
                  ),
          }
        : {}),
    });
  }

  private projectConversationEvent(method: string, params: unknown): void {
    if (method === "item/started") {
      const parsed = conversationItemStartedSchema.safeParse(params);
      if (!parsed.success || parsed.data.item.type !== "agentMessage") return;
      const { threadId, turnId, item } = parsed.data;
      const turn = this.conversationTurn(threadId, turnId, item.id);
      if (!turn || turn.truncated) return;
      if (turn.completedItems.has(item.id) || turn.items.has(item.id)) return;
      if (
        turn.totalItems >= maxConversationItemsPerTurn ||
        turn.items.size >= maxPendingConversationItems
      ) {
        this.truncateConversationTurn(threadId, turnId, turn, item.id);
        return;
      }
      turn.totalItems += 1;
      turn.items.set(item.id, {
        kind: "capturing",
        chunks: [],
        bytes: 0,
        fragments: 0,
      });
      this.emitConversationEvent({
        threadId,
        turnId,
        itemId: item.id,
        kind: "started",
      });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const parsed = conversationDeltaSchema.safeParse(params);
      if (!parsed.success) return;
      const { threadId, turnId, itemId, delta } = parsed.data;
      const turn = this.conversationTurns.get(
        this.conversationTurnKey(threadId, turnId),
      );
      const item = turn?.items.get(itemId);
      if (!turn || turn.truncated || !item || item.kind !== "capturing") return;
      const bytes = Buffer.byteLength(delta, "utf8");
      if (bytes === 0) return;
      if (
        item.bytes + bytes > maxConversationItemBytes ||
        this.conversationBufferBytes + bytes > maxConversationBufferBytes ||
        item.fragments >= maxConversationFragmentsPerItem
      ) {
        this.conversationBufferBytes -= item.bytes;
        turn.items.set(itemId, { kind: "size-limit" });
        return;
      }
      item.chunks.push(delta);
      item.bytes += bytes;
      item.fragments += 1;
      this.conversationBufferBytes += bytes;
      this.emitConversationEvent({
        threadId,
        turnId,
        itemId,
        kind: "delta",
        bytes,
      });
      return;
    }

    if (method === "item/completed") {
      const parsed = conversationItemCompletedSchema.safeParse(params);
      if (!parsed.success || parsed.data.item.type !== "agentMessage") return;
      const { threadId, turnId, item } = parsed.data;
      const turn = this.conversationTurn(threadId, turnId, item.id);
      if (!turn || turn.truncated) return;
      if (turn.completedItems.has(item.id)) return;
      const pending = turn.items.get(item.id);
      if (!pending && turn.totalItems >= maxConversationItemsPerTurn) {
        this.truncateConversationTurn(threadId, turnId, turn, item.id);
        return;
      }
      if (!pending) turn.totalItems += 1;
      turn.items.delete(item.id);
      turn.completedItems.add(item.id);
      this.releaseConversationItem(pending);
      if (typeof item.text === "string") {
        this.emitConversationText(threadId, turnId, item.id, item.text);
      } else if (pending?.kind === "size-limit") {
        this.emitConversationOmission(threadId, turnId, item.id, "size-limit");
      } else if (pending?.kind === "capturing") {
        if (pending.bytes > 0) {
          this.emitConversationText(
            threadId,
            turnId,
            item.id,
            pending.chunks.join(""),
          );
        } else {
          this.emitConversationOmission(
            threadId,
            turnId,
            item.id,
            "missing-text",
          );
        }
      } else {
        this.emitConversationOmission(
          threadId,
          turnId,
          item.id,
          "missing-text",
        );
      }
    }
  }

  private conversationTurn(
    threadId: string,
    turnId: string,
    itemId: string,
  ): PendingConversationTurn | undefined {
    const key = this.conversationTurnKey(threadId, turnId);
    try {
      if (this.persistedTerminal(threadId, turnId)) return undefined;
    } catch {
      return undefined;
    }
    const existing = this.conversationTurns.get(key);
    if (existing) return existing;
    if (this.conversationCaptureSaturated) {
      this.trackOverflowedConversationTurn(key);
      return undefined;
    }
    if (this.conversationTurns.size >= maxActiveConversationTurns) {
      this.conversationCaptureSaturated = true;
      this.trackOverflowedConversationTurn(key);
      this.emitConversationOmission(
        threadId,
        turnId,
        itemId,
        "active-turn-limit",
      );
      return undefined;
    }
    const turn: PendingConversationTurn = {
      items: new Map(),
      completedItems: new Set(),
      totalItems: 0,
      truncated: false,
    };
    this.conversationTurns.set(key, turn);
    return turn;
  }

  private conversationTurnKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private finishConversationTurn(threadId: string, turnId: string): void {
    const key = this.conversationTurnKey(threadId, turnId);
    const turn = this.conversationTurns.get(key);
    const overflowed = this.overflowedConversationTurns.delete(key);
    if (!turn) {
      if (overflowed) this.maybeResumeConversationCapture();
      return;
    }
    for (const [itemId, item] of turn.items) {
      this.emitConversationOmission(
        threadId,
        turnId,
        itemId,
        item.kind === "size-limit" ? "size-limit" : "turn-ended",
      );
      this.releaseConversationItem(item);
    }
    this.conversationTurns.delete(key);
    this.maybeResumeConversationCapture();
  }

  private trackOverflowedConversationTurn(key: string): void {
    if (
      this.overflowedConversationTurns.has(key) ||
      this.conversationOverflowIdentityCapExceeded
    )
      return;
    if (this.overflowedConversationTurns.size >= maxActiveConversationTurns) {
      this.conversationOverflowIdentityCapExceeded = true;
      return;
    }
    this.overflowedConversationTurns.add(key);
  }

  private maybeResumeConversationCapture(): void {
    if (
      this.conversationTurns.size === 0 &&
      this.overflowedConversationTurns.size === 0 &&
      !this.conversationOverflowIdentityCapExceeded
    )
      this.conversationCaptureSaturated = false;
  }

  private truncateConversationTurn(
    threadId: string,
    turnId: string,
    turn: PendingConversationTurn,
    itemId: string,
  ): void {
    turn.truncated = true;
    for (const [pendingId, pending] of turn.items) {
      this.emitConversationOmission(threadId, turnId, pendingId, "item-limit");
      this.releaseConversationItem(pending);
    }
    turn.items.clear();
    turn.completedItems.clear();
    this.emitConversationOmission(threadId, turnId, itemId, "item-limit");
  }

  private releaseConversationItem(
    item: PendingConversationItem | undefined,
  ): void {
    if (item?.kind !== "capturing") return;
    this.conversationBufferBytes -= item.bytes;
  }

  private clearConversationCaptures(): void {
    this.conversationTurns.clear();
    this.conversationBufferBytes = 0;
    this.conversationCaptureSaturated = false;
    this.overflowedConversationTurns.clear();
    this.conversationOverflowIdentityCapExceeded = false;
  }

  private emitConversationText(
    threadId: string,
    turnId: string,
    itemId: string,
    text: string,
  ): void {
    if (Buffer.byteLength(text, "utf8") > maxConversationItemBytes) {
      this.emitConversationOmission(threadId, turnId, itemId, "size-limit");
      return;
    }
    this.emitConversationEvent({
      threadId,
      turnId,
      itemId,
      kind: "completed",
      text,
    });
  }

  private emitConversationOmission(
    threadId: string,
    turnId: string,
    itemId: string,
    reason: Extract<RuntimeConversationEvent, { kind: "omitted" }>["reason"],
  ): void {
    this.emitConversationEvent({
      threadId,
      turnId,
      itemId,
      kind: "omitted",
      reason,
    });
  }

  private emitConversationEvent(event: RuntimeConversationEvent): void {
    try {
      this.conversationEvent?.(event);
    } catch {
      // History is diagnostic: a consumer failure must not alter runtime control.
    }
  }

  private receiveToolCall(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    params: unknown,
  ): void {
    const call = parseRuntimeToolCall(params);
    const definitions = call
      ? this.threadSnapshots.get(call.threadId)?.tools
      : undefined;
    const registered = definitions?.some((tool) => tool.name === call?.tool);
    if (!call || !registered || !this.toolCall) {
      this.denyUnexpected(child, unexpectedRequest("item/tool/call", params), {
        id,
        result: {
          contentItems: [{ type: "inputText", text: "not authorized" }],
          success: false,
        },
      });
      return;
    }
    void this.dispatchToolCall(child, id, call);
  }

  private async dispatchToolCall(
    child: ChildProcessWithoutNullStreams,
    id: string | number,
    call: RuntimeToolCall,
  ): Promise<void> {
    let response: RuntimeToolResult;
    try {
      const rawResult = await this.toolCall?.(call);
      const parsed = runtimeToolResultSchema.safeParse(rawResult);
      response = parsed.success
        ? parsed.data
        : { text: "request failed", success: false };
    } catch {
      response = { text: "request failed", success: false };
    }
    if (this.child !== child) return;
    try {
      await this.send(
        `${JSON.stringify({
          id,
          result: {
            contentItems: [{ type: "inputText", text: response.text }],
            success: response.success,
          },
        })}\n`,
      );
    } catch (error) {
      this.failChild(
        child,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    for (const endpoint of [...this.nativeEndpoints.values()])
      this.cancelUserInput(endpoint.call.identity, "Runtime lost");
    this.nativeGeneration = undefined;
    this.threadSnapshots.clear();
    this.nativeTurns.clear();
    this.invalidNativeTurns.clear();
    this.nativeReadbacks.clear();
    this.nativeEndpoints.clear();
    this.nativeEndpointsByTurn.clear();
    this.nativeEndpointsByRpcId.clear();
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.clearConversationCaptures();
    this.events.emit("failure", error);
    if (this.child?.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGTERM");
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child === child) this.fail(error);
  }

  /** A listener that cannot persist its hold fails the runtime instead of escaping the native path. */
  private reportUnexpected(
    request: UnexpectedRequest,
    child = this.child,
  ): boolean {
    try {
      this.unexpected?.(request);
      return false;
    } catch (error) {
      if (child)
        this.failChild(
          child,
          new Error(
            `Could not persist unexpected request hold: ${String(error)}`,
          ),
        );
      return true;
    }
  }

  /** Records the hold, then denies the request; a failed hold ends the child once the denial is written. */
  private denyUnexpected(
    child: ChildProcessWithoutNullStreams,
    request: UnexpectedRequest,
    denial: unknown,
  ): void {
    const holdFailed = this.reportUnexpected(request, child);
    if (this.child === child)
      void this.send(`${JSON.stringify(denial)}\n`).then(
        () => {
          if (holdFailed) child.kill("SIGTERM");
        },
        (error: Error) => this.failChild(child, error),
      );
  }
}
