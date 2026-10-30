// Delivery wording for the Changes tab.
import {
  statusEventLabels,
  statusMappingActionLabel,
  statusMappingActionNote,
} from "../../src/operator/status-mapping-copy.js";
import type { StatusMappingEvent } from "../../src/core/status-mapping-contracts.js";
import { codeSentence } from "./presentation.js";

export type CodeHost = "github" | "gitlab";
/** An absent code host is GitHub, as on servers that predate GitLab merge requests. */
export const codeHostName = (codeHost: CodeHost | undefined) =>
  codeHost === "gitlab" ? "GitLab" : "GitHub";
const changeRequestNoun = (codeHost: CodeHost | undefined) =>
  codeHost === "gitlab" ? "merge request" : "PR";

const blockerSentences = (codeHost: CodeHost | undefined) => {
  const name = codeHostName(codeHost),
    noun = changeRequestNoun(codeHost);
  return {
    "reviewable-pr-awaiting-current-settlement": `Waiting for the current ${noun} head to be settled.`,
    "pr-not-confirmed-merged": `Waiting for ${name} to confirm the ${noun} merged.`,
    "delivery-provider-read-unavailable": `The last ${name} read failed, so delivery state may be out of date.`,
    "delivery-mode-changed": `The project's delivery mode changed after this ${noun} was bound.`,
    "external-action-prepared": `A ${name} action is prepared and has not been attempted.`,
    "external-action-attempting": `A ${name} action is in progress.`,
    "external-action-uncertain": `A ${name} action's outcome is unknown; check it before retrying.`,
  };
};

/** A delivery blocker code as a sentence; an unmapped code gets the generic one, never the raw code. */
export const deliveryBlockerSentence = (code: string, codeHost?: CodeHost) =>
  codeSentence(
    code,
    blockerSentences(codeHost),
    "Delivery is waiting on a condition this version can't describe.",
  );

/** What a code-host action acts on, named for its host; null for an action that is not one. */
export function codeHostActionLabel(
  action: string,
  codeHost: CodeHost | undefined,
) {
  const name = codeHostName(codeHost),
    gitlab = codeHost === "gitlab";
  if (action.startsWith("pr.thread."))
    return `${name} ${gitlab ? "discussion" : "review thread"}`;
  if (action.startsWith("pr."))
    return `${name} ${gitlab ? "merge request" : "pull request"}`;
  return action.startsWith("branch.") ? `${name} branch` : null;
}

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

/** What an approval's exact material acts on, when the server named the code host of its repository link. */
export function approvalActsOn(approval: {
  codeHost?: CodeHost | undefined;
  material: unknown;
}) {
  const material = approval.material;
  const kind =
    typeof material === "object" && material !== null && "kind" in material
      ? material.kind
      : null;
  return approval.codeHost && typeof kind === "string"
    ? codeHostActionLabel(kind, approval.codeHost)
    : null;
}

/**
 * The link only on its code host: github.com for GitHub, any https URL for GitLab. Defence in depth
 * behind the read schema, which already rejects any other URL.
 */
export function safePullRequestUrl(
  url: string | undefined,
  codeHost: CodeHost = "github",
) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      (codeHost === "gitlab" || parsed.hostname === "github.com")
      ? url
      : null;
  } catch {
    return null;
  }
}

/** A compare link on the code host that produced it; a link without a code host is not shown. */
export const safeCompareUrl = (
  url: string | undefined,
  codeHost: CodeHost | undefined,
) => (codeHost ? safePullRequestUrl(url, codeHost) : null);

type PullRequestBinding = {
  number: number;
  repositoryName: string;
  url?: string | undefined;
  codeHost?: CodeHost | undefined;
};

/**
 * The repository name a human may read: only when the server built a verified link for it,
 * because without one `repositoryName` is the provider's opaque repository id.
 */
export const pullRequestRepository = (binding: PullRequestBinding) =>
  safePullRequestUrl(binding.url, binding.codeHost)
    ? binding.repositoryName
    : null;

/** "acme/app#12" (GitLab: "group/app!12"), or "PR #12" when the repository name is not verified. */
export function pullRequestReference(binding: PullRequestBinding) {
  const repository = pullRequestRepository(binding),
    gitlab = binding.codeHost === "gitlab";
  return repository
    ? `${repository}${gitlab ? "!" : "#"}${binding.number}`
    : `${gitlab ? "Merge request !" : "PR #"}${binding.number}`;
}

/** A GitLab merge train merge stays pending until the train merges or drops it. */
const mergeTrainNotes = new Map([
  [
    "provider-merge-train-pending",
    "On the GitLab merge train; waits until it merges or drops out.",
  ],
  [
    "provider-merge-train-dropped",
    "Dropped from the GitLab merge train; nothing was merged.",
  ],
]);

/**
 * One retained delivery action as a line. A status-mapping write is named for what it is, and a
 * write skipped because the Status moved on GitHub says so instead of showing its code. A merge train
 * merge that is pending or dropped is described the same way.
 */
export const deliveryActionLine = (a: {
  kind: string;
  caller: "agent" | "operator" | "service";
  event: StatusMappingEvent | null;
  state: string;
  reason: string | null;
  operationId: string;
}) =>
  `${a.caller === "service" && a.event ? `${statusMappingActionLabel} (${statusEventLabels[a.event]}) · ` : ""}${a.kind}: ${a.state} · ${statusMappingActionNote(a.reason) ?? (a.reason ? (mergeTrainNotes.get(a.reason) ?? a.reason) : "receipt recorded")} · operation ${a.operationId}`;
