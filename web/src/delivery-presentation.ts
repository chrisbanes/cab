// Delivery wording for the Changes tab: design/DESIGN.md -> Task detail -> Implementation status.
import { codeSentence } from "./presentation.js";

const blockerSentences = {
  "reviewable-pr-awaiting-current-settlement":
    "Waiting for the current PR head to be settled.",
  "pr-not-confirmed-merged": "Waiting for GitHub to confirm the PR merged.",
  "delivery-provider-read-unavailable":
    "The last GitHub read failed, so delivery state may be out of date.",
  "delivery-mode-changed":
    "The project's delivery mode changed after this PR was bound.",
  "external-action-prepared":
    "A GitHub action is prepared and has not been attempted.",
  "external-action-attempting": "A GitHub action is in progress.",
  "external-action-uncertain":
    "A GitHub action's outcome is unknown; check it before retrying.",
};

/** A delivery blocker code as a sentence; an unmapped code gets the generic one, never the raw code. */
export const deliveryBlockerSentence = (code: string) =>
  codeSentence(
    code,
    blockerSentences,
    "Delivery is waiting on a condition this version can't describe.",
  );

export const pullRequestStateLabel = (
  state: "OPEN" | "CLOSED" | "MERGED",
  draft: boolean | undefined,
) =>
  state === "MERGED"
    ? "Merged"
    : state === "CLOSED"
      ? "Closed"
      : draft
        ? "Draft"
        : "Open";

export const checkStatusWord = (status: "success" | "pending" | "failure") =>
  ({ success: "Passed", pending: "Pending", failure: "Failed" })[status];

/** The link only when it is an https github.com URL; the server builds it, this guards a fixture or proxy. */
export function safePullRequestUrl(url: string | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      ? url
      : null;
  } catch {
    return null;
  }
}
