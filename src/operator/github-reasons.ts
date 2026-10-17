/**
 * Why a task's GitHub comment cannot be posted, as the server decides it. Shared by the task
 * read's schema and the web, like `wait-reasons.ts`. Source-state codes (#1103) belong in a
 * separate record here; they do not widen `CommentReasonCode`.
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
