// Delivery wording for the Changes tab.
import {
  statusEventLabels,
  statusMappingActionLabel,
  statusMappingActionNote,
} from "../../src/operator/status-mapping-copy.js";
import type { StatusMappingEvent } from "../../src/core/status-mapping-contracts.js";
import {
  deliveryActionLabel,
  grantSentence,
  mergeBlockerSentence,
} from "../../src/operator/delivery-action-copy.js";
import type {
  DeliveryPolicyValues,
  RepositoryDeliveryRead,
} from "./delivery-policy-draft.js";
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

const mergeBlockerSentences = (
  codeHost: CodeHost | undefined,
): Record<string, string> => ({
  "no-required-checks":
    "No required checks: neither the code host nor cab requires a check, so the merge is held.",
  "merge-method-not-configured":
    "No merge method: this repository has no configured merge method the code host allows, so the merge is held.",
  "pr-base-change-held": `Base changed: ${codeHostName(codeHost)} moved this ${codeHost === "gitlab" ? "merge request" : "pull request"} to a base cab has not accepted, so its actions are held until it is restored or the branch it was stacked on merges.`,
});
/** A merge-gate code as a sentence when it has one; any other code is shown as it is. */
export const mergeBlockerText = (
  code: string,
  codeHost?: CodeHost,
  baseRef?: string | null,
) =>
  mergeBlockerSentence(code, { codeHost, baseRef }) ??
  (Object.hasOwn(mergeBlockerSentences(codeHost), code)
    ? mergeBlockerSentences(codeHost)[code]!
    : code);

export const reviewHeadComparison = (matches: boolean, codeHost?: CodeHost) =>
  `${matches ? "Matches" : "Checked an earlier head than"} the current ${codeHost === "gitlab" ? "merge request" : "pull request"} head`;

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
  refusalReasons?: readonly string[] | undefined;
  operationId: string;
}) =>
  `${a.caller === "service" && a.event ? `${statusMappingActionLabel} (${statusEventLabels[a.event]}) · ` : ""}${deliveryActionLabel(a.kind)}: ${a.state} · ${(a.caller === "service" ? statusMappingActionNote(a.reason) : null) ?? (a.reason && mergeTrainNotes.get(a.reason)) ?? a.reason ?? "receipt recorded"}${a.refusalReasons?.length ? ` (${a.refusalReasons.join(", ")})` : ""} · operation ${a.operationId}`;

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

export function repositoryCredentialState(
  saved: {
    credentialConfigured: boolean;
    credential?: { usable: boolean } | undefined;
  },
  host: CodeHost,
  read: RepositoryDeliveryRead | undefined,
  intent: "preserve" | "clear" | "set" = "preserve",
): "usable" | "unusable" | "unknown" {
  if (host === "gitlab")
    return read?.codeHost.status === "live"
      ? "usable"
      : read?.codeHost.reason === "credential-missing"
        ? "unusable"
        : "unknown";
  if (intent === "clear") return "unusable";
  if (intent === "set") return "unknown";
  return !saved.credentialConfigured || saved.credential?.usable === false
    ? "unusable"
    : saved.credential?.usable
      ? "usable"
      : "unknown";
}

/** Setup guidance only: the actual PR's permissions and branch rules remain runtime gates. */
export function repositoryDeliveryNeeds(
  policy: DeliveryPolicyValues,
  repositoryId: string,
  host: CodeHost,
  credential: "usable" | "unusable" | "unknown",
  read: RepositoryDeliveryRead | undefined,
) {
  const has = (action: string) =>
    policy.grants.some(
      (g) =>
        "action" in g && g.repositoryId === repositoryId && g.action === action,
    );
  const needs: {
    met: boolean;
    text: string;
    fix:
      | "credential"
      | "settings"
      | "refresh"
      | "grants"
      | "mode"
      | "method"
      | "checks";
  }[] = [
    {
      met: credential === "usable",
      fix: host === "gitlab" ? "settings" : "credential",
      text:
        credential === "usable"
          ? "Delivery credential is usable; write permissions are checked when acting."
          : credential === "unusable"
            ? `Delivery credential is missing or unusable. ${host === "gitlab" ? "Configure the installation's GitLab credential in Settings." : "Set a usable credential in Delivery."}`
            : "Delivery credential usability is unconfirmed. Save credential changes and Refresh to check it.",
    },
    {
      met: read?.codeHost.status === "live",
      fix: "refresh",
      text:
        read?.codeHost.status === "live"
          ? `${codeHostName(host)} requirements were read. Branch rules and permissions are checked again when acting.`
          : `${codeHostName(host)} requirements are unavailable${read?.codeHost.status === "unavailable" ? ` (${requirementUnavailable[read.codeHost.reason]})` : ""}. Check the credential, repository link and host access, then Refresh.`,
    },
  ];
  for (const [action, label] of [
    ["branch.push", "push branches"],
    ["pr.create", "open pull requests"],
  ] as const)
    needs.push({
      met: has(action),
      fix: policy.grants.some((g) => "savedRow" in g) ? "refresh" : "grants",
      text: has(action)
        ? `Grant to ${label} is present.`
        : policy.grants.some((g) => "savedRow" in g)
          ? `Grant to ${label} is unconfirmed. Refresh with access to the unavailable grant details.`
          : `Cannot ${label}. Apply Open PRs or add the missing grant below.`,
    });
  if (has("pr.merge")) {
    needs.push({
      met: policy.mode === "through-merge",
      fix: "mode",
      text:
        policy.mode === "through-merge"
          ? "Completion mode permits merging."
          : "Merging is refused in Reviewable PR mode. Change Completion mode to Through merge.",
    });
    const row = policy.repositories?.find(
      (r) => r.repositoryId === repositoryId,
    );
    const method = row?.mergeMethod;
    needs.push({
      met: Boolean(
        method &&
          read?.codeHost.status === "live" &&
          read.codeHost.allowedMethods.includes(method),
      ),
      fix:
        !row || (method && read?.codeHost.status !== "live")
          ? "refresh"
          : "method",
      text: !method
        ? row
          ? "Choose a merge method below before cab can merge."
          : "Repository merge settings are unavailable. Refresh or update the service to configure a merge method."
        : read?.codeHost.status !== "live"
          ? "Allowed merge methods are unconfirmed. Restore host access and Refresh."
          : !read.codeHost.allowedMethods.includes(method)
            ? `${mergeMethodNotAllowedWarning(method)} Choose an allowed method below or change the host rules.`
            : "The selected merge method is allowed on the default branch; other branches follow their own rules.",
    });
    const checks = row?.additionalChecks ?? policy.requiredChecks;
    const configuredCheck = checks.some(
      (c) => "savedRow" in c || ("name" in c && Boolean(c.name.trim())),
    );
    const checksMet =
      configuredCheck ||
      Boolean(read?.codeHost.status === "live" && read.codeHost.checks.length);
    needs.push({
      met: checksMet,
      fix: row ? "checks" : "refresh",
      text: checksMet
        ? "Required checks are configured; each merge must pass its actual gate."
        : read?.codeHost.status === "live"
          ? noRequiredChecksWarning(host)
          : "Required checks are unconfirmed. Add an additional required check below or restore host access and Refresh.",
    });
  }
  if (policy.grants.some((g) => "savedRow" in g))
    needs.push({
      met: false,
      fix: "refresh",
      text: "Some grants are unavailable. Refresh with access to their details before relying on this summary.",
    });
  return needs;
}

/** First matching grant wins at runtime; retain each Project scope's sentence. */
export function repositoryAuthorityGroups(
  grants: DeliveryPolicyValues["grants"],
  repositoryId: string,
  credential: "usable" | "unusable" | "unknown",
  sentences?: readonly (string | undefined)[],
) {
  const seen = new Set<string>();
  const opaque = grants.some((g) => "savedRow" in g);
  return (["Branch", "PR", "Merge", "Project/status"] as const).map((group) => {
    // An opaque row may precede any visible grant, so effective precedence is unknown.
    if (opaque)
      return {
        group,
        lines: [
          "Effective authority is unconfirmed because some grants are unavailable. Refresh with access to their details.",
        ],
      };
    const lines = grants.flatMap((g, i) => {
      if ("savedRow" in g || g.repositoryId !== repositoryId) return [];
      const target = g.action.startsWith("branch.")
        ? "Branch"
        : g.action === "pr.merge"
          ? "Merge"
          : g.action.startsWith("pr.")
            ? "PR"
            : g.action.startsWith("project.")
              ? "Project/status"
              : null;
      if (target !== group) return [];
      const identity = JSON.stringify([
        g.action,
        ...(g.action.startsWith("project.")
          ? [
              g.projectNodeId,
              g.action === "project.field" ? g.fieldNodeId : null,
            ]
          : []),
      ]);
      const prefix =
        credential === "usable"
          ? ""
          : credential === "unusable"
            ? "Unavailable until credential is fixed · "
            : "Credential unconfirmed · ";
      if (g.action === "project.field") {
        if (!g.projectNodeId || !g.fieldNodeId || !g.optionNodeIds?.length)
          return [
            "Incomplete Project field grant. Choose its Project, field and options below.",
          ];
        // The first matching grant wins for each option, including overlapping scopes.
        const options = g.optionNodeIds.filter((option) => {
          const key = JSON.stringify([identity, option]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!options.length) return [];
        const sentence =
          options.length === g.optionNodeIds.length
            ? sentences?.[i]
            : undefined;
        return [
          `${prefix}${sentence ?? grantSentence({ ...g, optionNodeIds: options })}`,
        ];
      }
      if (seen.has(identity)) return [];
      seen.add(identity);
      const alwaysApproval =
        g.action === "branch.adopt" || g.action === "issue.edit";
      const configuredLine = sentences?.[i] ?? grantSentence(g);
      const line = alwaysApproval
        ? configuredLine.replace(/^Allow:/, "Require approval:")
        : configuredLine;
      return [
        g.action === "project.item.add"
          ? `${line} (operator publication only).`
          : `${prefix}${line}${
              alwaysApproval
                ? " (always requires approval)"
                : g.action === "branch.force-push"
                  ? " (recovery from an outside change always requires approval)"
                  : ""
            }`,
      ];
    });
    return {
      group,
      lines: lines.length
        ? lines
        : [
            group === "Project/status"
              ? "No Project grants. Status mapping has separate authority; see its summary above."
              : "No grants.",
          ],
    };
  });
}
