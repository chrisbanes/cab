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

const mergeBlockerSentences: Record<string, string> = {
  "no-required-checks":
    "No required checks: neither the code host nor cab requires a check, so the merge is held.",
  "merge-method-not-configured":
    "No merge method: this repository has no configured merge method the code host allows, so the merge is held.",
};
/** A merge-gate code as a sentence when it has one; any other code is shown as it is. */
export const mergeBlockerText = (code: string) =>
  Object.hasOwn(mergeBlockerSentences, code)
    ? mergeBlockerSentences[code]!
    : code;

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
 * write skipped (the Status moved, Jira already shows it, or offers no single transition) says so instead of showing its code. A merge train
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
  `${a.caller === "service" && a.event ? `${statusMappingActionLabel} (${statusEventLabels[a.event]}) · ` : ""}${a.kind}: ${a.state} · ${(a.caller === "service" ? statusMappingActionNote(a.reason) : null) ?? (a.reason && mergeTrainNotes.get(a.reason)) ?? a.reason ?? "receipt recorded"} · operation ${a.operationId}`;

export const deliveryLevelLabels = {
  "not-set-up": "Not set up",
  custom: "Custom",
  "open-prs": "Open PRs",
  "merge-with-approval": "Merge with my approval",
  "merge-when-ready": "Merge when ready",
  unavailable: "Delivery level unavailable",
};
export const deliveryMergeWarning =
  "The lead will merge without asking once the merge gate reports no blockers. cab can't unmerge or revert a merge.";

export const mergeMethodLabels = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
} as const;
/** The methods cab can merge with on each code host; GitLab's rebase is a separate API cab does not call. */
export const codeHostMergeMethods = {
  github: ["merge", "squash", "rebase"],
  gitlab: ["merge", "squash"],
} as const;
/** The default branch's methods are guidance: a PR into another branch follows that branch's rules. */
export const defaultBranchMethodsNote = (
  allowed: readonly (keyof typeof mergeMethodLabels)[],
) =>
  `The default branch allows: ${
    allowed.length
      ? allowed
          .map((method) => mergeMethodLabels[method].toLowerCase())
          .join(", ")
      : "no method cab can use"
  }. Merges into other branches follow their own rules.`;
export const mergeMethodNotAllowedWarning = (
  method: keyof typeof mergeMethodLabels,
) =>
  `The default branch doesn't allow ${mergeMethodLabels[method].toLowerCase()}, so cab holds merges into it until the method or the branch's rules change.`;
export const mergeMethodUnsetNote =
  "No merge method is set, so cab holds every merge for this repository.";
const requirementUnavailable = {
  "credential-missing": "no credential can read them",
  "provider-error": "the last read failed",
  timeout: "the read took too long",
  unsupported: "cab can't read them for this repository",
} as const;
/** What the code host requires before a merge, as one line; the check names are listed separately. */
export function codeHostChecksSummary(
  codeHost: CodeHost | undefined,
  read:
    | { status: "live"; checks: readonly unknown[] }
    | { status: "unavailable"; reason: keyof typeof requirementUnavailable },
): string {
  const name = codeHostName(codeHost);
  if (read.status === "unavailable")
    return `${name}'s required checks are unavailable: ${requirementUnavailable[read.reason]}.`;
  return read.checks.length
    ? `${name} requires these checks before merging:`
    : `${name} requires no checks before merging.`;
}
export const noRequiredChecksWarning = (codeHost: CodeHost | undefined) =>
  `No required checks: neither ${codeHostName(codeHost)} nor cab requires a check, so cab holds every merge for this repository. Add an additional required check or a code-host rule.`;
export const unconfirmedChecksNote =
  "Whether any check is required can't be confirmed until the code host's requirements can be read.";

export const deliveryCredentialLimit =
  "Agents running as the same OS user can reach this host's GitHub CLI login.";
const deliveryCredentialReasons: Record<string, string> = {
  "missing-credential": "the service environment has no value for it",
  "invalid-credential-reference": "the saved reference is not valid",
  "gh-not-installed": "GitHub CLI is not installed on the service host",
  "gh-not-signed-in": "GitHub CLI is not signed in on the service host",
  "gh-unreadable": "the service cannot read the GitHub CLI login",
};
/** The saved GitHub delivery credential as one line, from the configuration read. */
export function deliveryCredentialSummary(
  configured: boolean,
  status:
    | {
        source: "env" | "gh" | null;
        usable: boolean;
        reason: string | null;
        gh: { state: string; login?: string };
      }
    | undefined,
): string {
  if (!configured) return "No delivery credential is configured.";
  if (!status) return "A delivery credential is configured.";
  const kind = status.source === "gh" ? "GitHub CLI" : "Environment variable";
  if (status.usable)
    return `${kind}${status.gh.login && status.source === "gh" ? ` · @${status.gh.login}` : ""} · usable`;
  return `${kind} · unavailable: ${(status.reason && deliveryCredentialReasons[status.reason]) ?? "status unavailable"}.`;
}
