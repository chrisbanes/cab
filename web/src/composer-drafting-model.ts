import type { DraftProposal } from "../../src/operator/contracts.js";
import type { ComposerInput } from "./composer-state.js";

export const draftingPollMs = 2000;
/** A release the service has not confirmed is sent again this often. */
export const draftingReleaseRetryMs = 5000;
/** The longest wait between attempts for a release that keeps not completing. */
export const draftingReleaseMaxBackoffMs = 60_000;
/** Doubles from the retry interval to the cap, so a run stuck stopping is still retried. */
export const releaseBackoffMs = (failures: number) =>
  Math.min(
    draftingReleaseRetryMs * 2 ** Math.max(0, failures - 1),
    draftingReleaseMaxBackoffMs,
  );
/** A proposal nobody has settled is read this often, so its expiry is shown. */
export const draftingProposedPollMs = 30_000;
/** The service's fixed run limit, shown beside the elapsed time. */
export const draftingLimitSeconds = 600;

export type DraftField = "title" | "outcome";
export interface DraftChoice {
  field: DraftField;
  proposed: string;
}

/**
 * Empty fields take the proposal at once; a field the operator already filled
 * keeps their text and offers the proposal beside it. A field that already
 * holds the proposal needs no choice, so a reload does not ask twice.
 */
export function planFill(
  input: Pick<ComposerInput, DraftField>,
  proposal: DraftProposal,
): { fill: Partial<Pick<ComposerInput, DraftField>>; choices: DraftChoice[] } {
  const fill: Partial<Pick<ComposerInput, DraftField>> = {};
  const choices: DraftChoice[] = [];
  for (const field of ["title", "outcome"] as const) {
    const current = input[field];
    if (current.trim() === "") fill[field] = proposal[field];
    else if (current !== proposal[field])
      choices.push({ field, proposed: proposal[field] });
  }
  return { fill, choices };
}

/** When to read a waiting proposal again: at its expiry, or at the slow interval if sooner. */
export const proposedReadDelay = (expiresAt: number | null, now: number) =>
  Math.min(
    draftingProposedPollMs,
    expiresAt === null
      ? draftingProposedPollMs
      : Math.max(0, expiresAt - now) + 500,
  );

export const formatElapsed = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

export const draftingCopy = {
  access:
    "The lead reads this project's linked repositories in a throwaway copy with network off. This is not a read-only sandbox: reads keep the runtime's normal host access. Nothing is saved until you choose Save draft or Create and start.",
  chooseProject: "Choose a project to draft with its lead.",
  noLead:
    "This project has no project lead, so nobody can draft. Choose a lead in project configuration.",
  waiting:
    "Waiting to start. A draft waits for capacity, and for a paused project to resume.",
  stopping:
    "Stopping. The draft ends when the runtime is seen to stop; capacity is released then. For a draft that never started, Stop again retries removing its working copy; otherwise the next service start does.",
  interrupted:
    "The run ended and its working copy was deleted. Your idea, title and outcome are unchanged.",
  failed:
    "Nothing was saved and the working copy was deleted. Your idea, title and outcome are unchanged.",
  expired: "The draft expired before it was used. Your text is unchanged.",
  gone: "That draft is no longer available. Your text is unchanged.",
  withheld:
    "The draft holds text that cannot be shown, such as a private path or credential. Discard it and draft again.",
  proposed:
    "Keep or replace the text you already wrote. Empty fields are filled. The draft is kept for 24 hours.",
  unconfirmed:
    "We couldn't confirm the draft started. If it did, it will appear here.",
} as const;
