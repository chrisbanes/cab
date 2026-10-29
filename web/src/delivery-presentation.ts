// Delivery wording for the Changes tab.
import {
  statusEventLabels,
  statusMappingActionLabel,
  statusMappingActionNote,
} from "../../src/operator/status-mapping-copy.js";
import type { StatusMappingEvent } from "../../src/core/status-mapping-contracts.js";
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

/** The link only when it is an https github.com URL: defence in depth behind the read schema, which already rejects any other URL. */
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

/** A compare link on the code host that produced it: github.com for GitHub, any https URL for GitLab. */
export function safeCompareUrl(
  url: string | undefined,
  codeHost: "github" | "gitlab" | undefined,
) {
  if (codeHost === "github") return safePullRequestUrl(url);
  if (codeHost !== "gitlab" || !url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

type PullRequestBinding = {
  number: number;
  repositoryName: string;
  url?: string | undefined;
};

/**
 * The repository name a human may read: only when the server built a verified link for it,
 * because without one `repositoryName` is the provider's opaque repository id.
 */
export const pullRequestRepository = (binding: PullRequestBinding) =>
  safePullRequestUrl(binding.url) ? binding.repositoryName : null;

/** "acme/app#12", or "PR #12" when the repository name is not verified. */
export function pullRequestReference(binding: PullRequestBinding) {
  const repository = pullRequestRepository(binding);
  return repository
    ? `${repository}#${binding.number}`
    : `PR #${binding.number}`;
}

/**
 * One retained delivery action as a line. A status-mapping write is named for what it is, and a
 * write skipped because the Status moved on GitHub says so instead of showing its code.
 */
export const deliveryActionLine = (a: {
  kind: string;
  caller: "agent" | "operator" | "service";
  event: StatusMappingEvent | null;
  state: string;
  reason: string | null;
  operationId: string;
}) =>
  `${a.caller === "service" && a.event ? `${statusMappingActionLabel} (${statusEventLabels[a.event]}) · ` : ""}${a.kind}: ${a.state} · ${statusMappingActionNote(a.reason) ?? a.reason ?? "receipt recorded"} · operation ${a.operationId}`;
