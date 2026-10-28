/**
 * Start again and Reset task: rules for when the operator can restart a task's work.
 * They are pure so the commands and the task read share one source.
 */

import type { ResetReason, StartAgainReason } from "../operator/contracts.js";
import {
  resetUnavailableText,
  startAgainUnavailableText,
} from "../operator/task-restart-copy.js";

/** How an assignment's newest request bears on Start again. */
export type RestartRequestKind =
  /** Held by a revision refusal with no witness that anything ran. */
  | "refused"
  /** Held by something else: a cut-off submission or an execution that may have run. */
  | "interrupted"
  | "unresolved"
  | "settled";

export interface StartAgainFacts {
  taskState: "open" | "done" | "cancelled";
  sourceHeld: boolean;
  /** A writer, ambiguity or archival hold; a Stop hold does not count. */
  nonStopHold: boolean;
  assignments: Array<{
    assignmentId: string;
    held: boolean;
    request?: { workId: string; sequence: number; kind: RestartRequestKind };
  }>;
}

export type StartAgainAvailability =
  | { available: true; assignmentId: string; workId: string }
  | { available: false; reason: StartAgainReason };

/** Stop, pause and capacity never block Start again: the new request queues and is held like any turn. */
export function startAgainAvailability(
  facts: StartAgainFacts,
): StartAgainAvailability {
  const kinds = facts.assignments.map((a) => a.request?.kind);
  const target = facts.assignments
    .filter((a) => a.request?.kind === "refused")
    .sort((a, b) => (b.request?.sequence ?? 0) - (a.request?.sequence ?? 0))[0];
  const reason: StartAgainReason | undefined =
    facts.taskState !== "open"
      ? "task-not-open"
      : facts.sourceHeld
        ? "source-held"
        : kinds.includes("interrupted")
          ? "submission-interrupted"
          : kinds.includes("unresolved") || facts.nonStopHold
            ? "execution-unresolved"
            : !target
              ? "nothing-refused"
              : target.held
                ? "assignment-held"
                : undefined;
  return reason || !target?.request
    ? { available: false, reason: reason ?? "nothing-refused" }
    : {
        available: true,
        assignmentId: target.assignmentId,
        workId: target.request.workId,
      };
}

export interface ResetFacts {
  taskState: "open" | "done" | "cancelled";
  ready: boolean;
  leadConfigured: boolean;
  /** The lead has run or been refused an ordinary turn, so it has a conversation to replace. */
  leadStarted: boolean;
  /** Any request queued, running or held that is not refused before it ran, or live writer or capacity state. */
  unresolvedExecution: boolean;
  /** A Stop, writer, ambiguity or archival hold, a source hold or a held assignment. */
  held: boolean;
}

export type ResetAvailability =
  | { available: true }
  | { available: false; reason: ResetReason };

export function resetAvailability(facts: ResetFacts): ResetAvailability {
  const reason: ResetReason | undefined =
    facts.taskState !== "open"
      ? "task-not-open"
      : !facts.ready
        ? "task-not-ready"
        : !facts.leadConfigured
          ? "lead-unconfigured"
          : !facts.leadStarted
            ? "nothing-to-reset"
            : facts.unresolvedExecution
              ? "execution-unresolved"
              : facts.held
                ? "task-held"
                : undefined;
  return reason ? { available: false, reason } : { available: true };
}

/** A definite refusal: nothing was recorded. */
export class StartAgainUnavailableError extends Error {
  constructor(readonly reason: StartAgainReason) {
    super(startAgainUnavailableText(reason));
  }
}

export class ResetUnavailableError extends Error {
  constructor(readonly reason: ResetReason) {
    super(resetUnavailableText(reason));
  }
}
