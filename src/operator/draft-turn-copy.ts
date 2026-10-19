import type { DraftTurnReason } from "./contracts.js";

/** The reason sentences of a refused draft turn; the service, the CLI and the web read them. */
export const draftTurnUnavailableMessages: Record<DraftTurnReason, string> = {
  "task-not-open": "task is Done or Cancelled",
  "task-ready": "task is Ready",
  "lead-unconfigured": "the project has no project lead",
  "lead-revoked": "the project lead's profile is revoked",
  "lead-unavailable": "the project lead is running, held or has completed",
  "draft-turn-active":
    "a draft turn for this task is already queued or running",
};

export const draftTurnUnavailableText = (reason: DraftTurnReason) =>
  `Draft turn unavailable: ${draftTurnUnavailableMessages[reason]}`;
