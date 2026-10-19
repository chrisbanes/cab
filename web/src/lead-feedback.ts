import type { DraftTurnReason } from "../../src/operator/contracts.js";

/** How operator feedback reaches the task lead; one source of copy for every entry point. */
export type LeadFeedbackMode = "receives" | "resumes" | "unavailable";

/**
 * The server's decision when the read carries it. Older reads fall back to the
 * lead's state and never offer a resume the server did not announce.
 */
export function leadFeedbackMode(
  data: { leadFeedback?: { mode: LeadFeedbackMode } | undefined },
  leadState: string | undefined,
): LeadFeedbackMode {
  if (data.leadFeedback) return data.leadFeedback.mode;
  return leadState === "pending" || leadState === "running"
    ? "receives"
    : "unavailable";
}

export const leadResumeNotice = (name: string) =>
  `${name} has completed its assignment and will resume to address this feedback.`;

export const leadReceivesNotice = (name: string) =>
  `Your message reaches ${name} on its next eligible turn.`;

export const leadUnavailableNotice = (name: string) =>
  `${name} can't receive messages now; your draft stays here.`;

export const leadAwaitingRecoveryNotice = (name: string) =>
  `${name} is waiting for an operator message to continue after recovery. Sending this review won't resume it. Send an ordinary message to continue.`;

export const draftTurnHeading = (name: string) => `Draft turn with ${name}`;

export const draftTurnPlaceholder = (name: string) =>
  `Ask ${name} to look into this task…`;

export const draftTurnStart = "Start draft turn";

export const draftTurnAccessNotice = (name: string) =>
  `Read-only: ${name} reads the task and its repositories, asks you questions, and comments or labels the issue where granted. No implementation. Readiness is unchanged.`;

export const draftTurnQueueNotice = (name: string) =>
  `Queues one turn for ${name}. Pause, Stop and capacity still apply, and a draft turn can’t be retracted.`;

export const draftTurnSentNotice = (name: string) =>
  `Draft turn queued for ${name}.`;

/** The sentence for a reason; a Ready task shows the ordinary reply instead. */
export const draftTurnUnavailableNotice = (
  reason: DraftTurnReason,
  name: string,
  taskState?: string,
) =>
  ({
    "task-ready":
      "This task is Ready, so the ordinary Message lead reply is shown instead.",
    "task-not-open": `Draft turns need an open task.${taskState === "done" ? " This task is Done." : taskState === "cancelled" ? " This task is Cancelled." : ""}`,
    "lead-unconfigured": "Draft turns need a project lead.",
    "lead-revoked": `${name}’s profile is revoked.`,
    "lead-unavailable": `${name} has started, is held or has completed, so a draft turn can’t start.`,
    "draft-turn-active":
      "A draft turn is already queued or running. Start another when it ends.",
  })[reason];
