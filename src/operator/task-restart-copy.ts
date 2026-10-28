import type { ResetReason, StartAgainReason } from "./contracts.js";

/** Where an unavailable action sends the operator: a task recovery page or its source review. */
export type RestartDestination = "recovery" | "source-review" | "none";

/**
 * The reason sentences and destinations of Start again and Reset task, read by the service,
 * the CLI and the web so every entry point explains the same way.
 */
export const startAgainUnavailable: Record<
  StartAgainReason,
  { text: string; destination: RestartDestination }
> = {
  "nothing-refused": {
    text: "no request was refused before it ran",
    destination: "none",
  },
  "task-not-open": {
    text: "the task is Done or Cancelled",
    destination: "none",
  },
  "source-held": {
    text: "the task's source is held and needs source review first",
    destination: "source-review",
  },
  "assignment-held": {
    text: "the assignment is held",
    destination: "recovery",
  },
  "submission-interrupted": {
    text: "a request was cut off while it was being submitted, so it may have run",
    destination: "recovery",
  },
  "execution-unresolved": {
    text: "an execution is unresolved and may still be live",
    destination: "recovery",
  },
};

export const resetUnavailable: Record<
  ResetReason,
  { text: string; destination: RestartDestination }
> = {
  "task-not-open": {
    text: "the task is Done or Cancelled",
    destination: "none",
  },
  "task-not-ready": { text: "the task is not Ready", destination: "none" },
  "lead-unconfigured": {
    text: "the project has no project lead",
    destination: "none",
  },
  "nothing-to-reset": {
    text: "the project lead has not started any work yet",
    destination: "none",
  },
  "execution-unresolved": {
    text: "an execution is queued, running or unresolved and may still be live",
    destination: "recovery",
  },
  "task-held": {
    text: "the task or an assignment is held, or its source is held",
    destination: "recovery",
  },
};

export const startAgainUnavailableText = (reason: StartAgainReason) =>
  `Start again unavailable: ${startAgainUnavailable[reason].text}`;

export const resetUnavailableText = (reason: ResetReason) =>
  `Reset unavailable: ${resetUnavailable[reason].text}`;

/** What Reset does; the web dialog and the CLI say it before sending. */
export const resetIrreversibleText =
  "Reset replaces the conversation of every assignment and starts the lead fresh in the same workspace. The old conversations and the workspace stay readable, but this cannot be undone.";
