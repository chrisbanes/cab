/**
 * Draft turns: a read-only turn of a task's project lead assignment on a task that is
 * not Ready (ADR-1015). The rules here are pure so the command, the task read and the
 * tool filter share one source.
 */

import { materialDigest } from "../core/delivery.js";
import type { DraftTurnReason } from "../operator/contracts.js";
import { draftTurnUnavailableText } from "../operator/draft-turn-copy.js";

/**
 * What a queued draft turn depends on in the task: its title and outcome. Marking the task
 * Ready changes the task version but not this, so only an edit makes a queued draft stale.
 */
export const draftTaskDigest = (task: Record<string, unknown>) =>
  materialDigest({ title: String(task.title), outcome: String(task.outcome) });

export interface DraftTurnFacts {
  taskState: "open" | "done" | "cancelled";
  ready: boolean;
  /** Null when the task has no lead assignment. */
  lead: { state: string; revoked: boolean; ordinaryWork: boolean } | null;
  /** A draft-turn request for this task is queued, held or running. */
  draftTurnActive: boolean;
}

export type DraftTurnAvailability =
  | { available: true }
  | { available: false; reason: DraftTurnReason };

/**
 * Pause, Stop and capacity never make a draft turn unavailable: it queues and is held
 * like any other turn.
 */
export function draftTurnAvailability(
  facts: DraftTurnFacts,
): DraftTurnAvailability {
  const reason: DraftTurnReason | undefined =
    facts.taskState !== "open"
      ? "task-not-open"
      : facts.ready
        ? "task-ready"
        : !facts.lead
          ? "lead-unconfigured"
          : facts.lead.revoked
            ? "lead-revoked"
            : facts.lead.state !== "pending" || facts.lead.ordinaryWork
              ? "lead-unavailable"
              : facts.draftTurnActive
                ? "draft-turn-active"
                : undefined;
  return reason ? { available: false, reason } : { available: true };
}

/** A definite refusal: nothing was recorded. */
export class DraftTurnUnavailableError extends Error {
  constructor(readonly reason: DraftTurnReason) {
    super(draftTurnUnavailableText(reason));
  }
}

/**
 * Appended to the ordinary assignment prompt of a draft turn. It states the limits only;
 * what to do with the task is the operator's message and the project instructions.
 */
export const draftTurnInstruction = [
  "This is a draft turn: the task is not Ready.",
  "You can read the task and its repositories, investigate, ask the operator questions, and, when granted, comment on or label the issue.",
  "Delegation, workspace writes, pull request actions, results and completion requests are refused until the task is Ready.",
  "You cannot make the task Ready.",
].join(" ");

const allowedTools = new Set([
  "ensemble_ask_question",
  "ensemble_request_approval",
]);
const allowedExternalActions = new Set(["issue.comment", "issue.labels"]);

export type DraftTurnToolDecision =
  | { allowed: true }
  | { allowed: false; text: string };

/** Server-side filter applied before any coordination dispatch or receipt write. */
export function draftTurnToolDecision(
  tool: string,
  args: unknown,
): DraftTurnToolDecision {
  if (allowedTools.has(tool)) return { allowed: true };
  if (tool === "ensemble_external_action") {
    const kind = (args as { action?: { kind?: unknown } } | null)?.action?.kind;
    return typeof kind === "string" && allowedExternalActions.has(kind)
      ? { allowed: true }
      : {
          allowed: false,
          text: "Draft turn: only issue.comment and issue.labels are available",
        };
  }
  return {
    allowed: false,
    text: `Draft turn: ${tool} is unavailable until the task is Ready`,
  };
}
