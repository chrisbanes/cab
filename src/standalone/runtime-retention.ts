import type { ExecutionHarness } from "./execution-harness.js";
import type { NativeInputEndpointIdentity } from "./native-input.js";
import type { RuntimeProcessIdentity } from "./recovery-types.js";

export type RuntimeTerminalStatus = "completed" | "failed";

export interface RuntimeTerminalEvidence {
  threadId: string;
  turnId: string;
  firstStatus: RuntimeTerminalStatus | null;
  conflicted: boolean;
  workId: string | null;
  firstRuntimeGeneration: string | null;
  lastRuntimeGeneration: string | null;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  failure: RuntimeTerminalFailureEvidence | null;
  harness: ExecutionHarness;
}

/** Compact, validated first failure facts used by exact bound retry classification. */
export interface RuntimeTerminalFailureEvidence {
  classification: "transient" | "permanent" | "unknown";
  reasonCode: string;
  source: "harness" | "missing";
  harnessRetries: number | null;
}

export interface RuntimeTerminalObservation {
  threadId: string;
  turnId: string;
  status: RuntimeTerminalStatus;
  runtimeGeneration: string;
  failure?: RuntimeTerminalFailureEvidence;
}

export interface RuntimeThreadQualification {
  threadId: string;
  toolDigest: string | null;
  codexVersion: string | null;
  executableHash: string | null;
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  developerInstructionsDigest: string | null;
  harness: ExecutionHarness;
}

export interface RuntimeThreadQualificationEvidence {
  threadId: string;
  toolDigest: string;
  codexVersion: string;
  executableHash: string;
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  developerInstructionsDigest: string;
}

export type RuntimeNativeEndpointHistory =
  | "new"
  | "exact-identity-seen"
  | "typed-id-reused";

/** Synchronous SQLite-backed safety checks used before runtime authority changes. */
export interface RuntimeSafetyPort {
  recordTerminal(input: RuntimeTerminalObservation): RuntimeTerminalEvidence;
  terminal(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): RuntimeTerminalEvidence | null;
  terminalForWait(
    threadId: string,
    turnId: string,
    runtimeGeneration: string,
  ): RuntimeTerminalEvidence | null;
  registerThreadTools(threadId: string, toolDigest: string): void;
  threadQualification(threadId: string): RuntimeThreadQualification | null;
  recordThreadQualification(input: RuntimeThreadQualificationEvidence): void;
  nativeEndpointHistory(
    identity: NativeInputEndpointIdentity,
  ): RuntimeNativeEndpointHistory;
  /**
   * Binds a per-turn process to the one submitting execution on this thread
   * whose turn and process are still unknown; false when no such row exists.
   */
  recordTurnProcess?(input: {
    threadId: string;
    processIdentity: RuntimeProcessIdentity;
  }): boolean;
}
