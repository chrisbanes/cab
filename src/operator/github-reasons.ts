/**
 * Why a task's GitHub comment cannot be posted, as the server decides it. Shared by the task
 * read's schema and the web, like `wait-reasons.ts`. The state of a source's last read has its
 * own record below (`sourceStates`); it does not widen `CommentReasonCode`.
 */
export const commentReasonCodes = [
  "no-source-issue",
  "no-comment-grant",
  "held",
  "no-delivery-credential",
] as const;
export type CommentReasonCode = (typeof commentReasonCodes)[number];

export const commentReasonSentences: Record<CommentReasonCode, string> = {
  "no-source-issue": "This task has no GitHub issue to comment on.",
  "no-comment-grant": "This project doesn't permit GitHub issue comments.",
  held: "Comments wait while the task's admission or delivery is held.",
  "no-delivery-credential":
    "This project has no GitHub delivery credential set.",
};

/**
 * Whether a comment can be posted, and if not, the one sentence that says why. `postable` is
 * `available` with no `reasonCode`: the server keeps `available` true without a delivery
 * credential, so a code alone also stops the web. An older read without `reasonCode` falls
 * back to its `reason` text.
 */
export function commentAvailability(
  policy:
    | {
        available: boolean;
        reason: string | null;
        reasonCode?: CommentReasonCode | null | undefined;
      }
    | undefined,
): { postable: boolean; sentence: string | null } {
  if (policy?.available && !policy.reasonCode)
    return { postable: true, sentence: null };
  const code = policy?.reasonCode;
  return {
    postable: false,
    sentence:
      (code && Object.hasOwn(commentReasonSentences, code)
        ? commentReasonSentences[code]
        : undefined) ??
      (policy?.reason
        ? `${policy.reason}.`
        : "GitHub comments aren't available for this task."),
  };
}

/** How a source's last read ended, as `sourceObservationSchema` reports it. */
export const sourceStates = [
  "complete",
  "partial",
  "never",
  "unavailable",
] as const;
export type SourceState = (typeof sourceStates)[number];

/**
 * The lead words of a source's status sentence. `complete` and `partial` lead a sentence the
 * web finishes with a clock label and counts; `unavailable` is a sentence of its own, so the
 * word "unavailable" is never printed as a value.
 */
export const sourceStateSentences: Record<SourceState, string> = {
  complete: "Synced",
  partial: "Partly synced",
  never: "Not synced yet",
  unavailable: "Sync state can't be read right now",
};

/**
 * Why an imported task's issue cannot be improved and edited by the operator, in the order the
 * server reports them. The first reason that applies wins. Running work, an unready task and a
 * held task are not reasons: an edit does not wait for admission.
 */
export const issueEditReasonCodes = [
  "no-source-issue",
  "task-not-open",
  "no-edit-grant",
  "no-project-lead",
  "action-unresolved",
  "no-delivery-credential",
] as const;
export type IssueEditReasonCode = (typeof issueEditReasonCodes)[number];

export const issueEditReasonSentences: Record<IssueEditReasonCode, string> = {
  "no-source-issue": "This task isn’t imported from a GitHub issue.",
  "task-not-open": "Improve with lead needs an open task.",
  "no-edit-grant":
    "This repository doesn’t allow Ensemble to edit issues. Allow issue edits in project configuration.",
  "no-project-lead":
    "Improve with lead needs a project lead. Choose a lead in project configuration.",
  "action-unresolved":
    "An earlier GitHub action on this task has an unknown outcome. Resolve it first.",
  "no-delivery-credential":
    "No GitHub credential is available for delivery. Add one in project configuration.",
};
