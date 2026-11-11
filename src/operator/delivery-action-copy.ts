// A type-only import: the web bundle must not take the delivery store.
import type { actionKinds } from "../core/delivery.js";

type ActionKind = (typeof actionKinds)[number];

/**
 * The one wording for a delivery action kind. The grant editor, the task's delivery actions and
 * the CLI import it, so every surface reads the same. Stored grants keep the kind.
 */
export const deliveryActionCopy: Record<
  ActionKind,
  { label: string; description: string }
> = {
  "issue.comment": {
    label: "Comment on issues",
    description: "Post comments on issues of the repository.",
  },
  "issue.labels": {
    label: "Change issue labels",
    description: "Add or remove labels on issues of the repository.",
  },
  "issue.edit": {
    label: "Edit issues",
    description: "Change the title or body of issues of the repository.",
  },
  "issue.create": {
    label: "Create issues",
    description: "Open new issues in the repository.",
  },
  "project.item.add": {
    label: "Add issues to a Project",
    description: "Add issues of the repository to one GitHub Project.",
  },
  "project.field": {
    label: "Set a Project field",
    description:
      "Set one GitHub Project field to one of the chosen options on issues of the repository.",
  },
  "pr.create": {
    label: "Open pull requests",
    description: "Open pull requests in the repository.",
  },
  "pr.edit": {
    label: "Edit pull requests",
    description: "Change the title or body of pull requests in the repository.",
  },
  "pr.ready": {
    label: "Mark pull requests ready",
    description: "Take draft pull requests in the repository out of draft.",
  },
  "pr.merge": {
    label: "Merge pull requests",
    description:
      "Merge pull requests in the repository; a merge cannot be undone.",
  },
  "pr.update-branch": {
    label: "Update pull request branches",
    description:
      "Bring a pull request that is behind its base up to date on the code host.",
  },
  "issue.close": {
    label: "Close issues",
    description: "Close issues of the repository.",
  },
  "pr.thread.reply": {
    label: "Reply to review threads",
    description: "Reply to review threads on pull requests in the repository.",
  },
  "pr.thread.resolve": {
    label: "Resolve review threads",
    description:
      "Mark review threads on pull requests in the repository resolved.",
  },
  "branch.push": {
    label: "Push branches",
    description: "Push cab's branches to the repository.",
  },
  "branch.force-push": {
    label: "Force-push branches",
    description:
      "Overwrite cab's branches in the repository; commits can be lost.",
  },
  "branch.adopt": {
    label: "Adopt existing branches",
    description:
      "Continue work on a branch that already exists in the repository; always needs approval.",
  },
};

/** The Request headline cab writes for an approval of a known delivery action kind. */
export const approvalHeadlines: Record<ActionKind, string> = {
  "issue.comment": "Comment on the issue",
  "issue.labels": "Change the issue's labels",
  "issue.edit": "Edit the issue",
  "issue.create": "Create an issue",
  "project.item.add": "Add the issue to the Project",
  "project.field": "Set a Project field on the issue",
  "pr.create": "Open the pull request",
  "pr.edit": "Edit the pull request",
  "pr.ready": "Mark the pull request ready for review",
  "pr.merge": "Merge the pull request",
  "pr.update-branch": "Update the pull request branch from its base",
  "issue.close": "Close the issue",
  "pr.thread.reply": "Reply to a review thread",
  "pr.thread.resolve": "Resolve a review thread",
  "branch.push": "Push the task branch",
  "branch.force-push": "Force-push the task branch",
  "branch.adopt": "Adopt the existing branch",
};

/** The kinds in the core's order; the keys of the record above are the core's `actionKinds`, which a test pins. */
export const deliveryActionKinds = Object.keys(
  deliveryActionCopy,
) as ActionKind[];

/** Kinds the service records but no grant covers, so they are not in the grant editor's list. */
const recordedOnlyLabels: Record<string, string> = {
  "issue.status": "Move Jira issues to a status",
};

/** The label of a known kind; a recorded action can carry any text, which is shown as it is. */
export const deliveryActionLabel = (kind: string) =>
  Object.hasOwn(deliveryActionCopy, kind)
    ? deliveryActionCopy[kind as ActionKind].label
    : (recordedOnlyLabels[kind] ?? kind);

/**
 * Plain words for a merge blocker about the PR's base branch, naming it; undefined for any other code.
 * The CLI, the Delivery tab and the lead's feedback share it.
 */
export function mergeBlockerSentence(
  code: string,
  {
    codeHost,
    baseRef,
  }: {
    codeHost?: "github" | "gitlab" | undefined;
    baseRef?: string | null | undefined;
  },
): string | undefined {
  const base = baseRef || "its base branch",
    host = codeHost === "gitlab" ? "GitLab" : "GitHub";
  if (code === "strict-head-behind")
    return `Behind ${base}: the branch rules require an up-to-date branch, and this PR is behind ${base}. Update the branch on ${host}, or the lead can request pr.update-branch.`;
  if (code === "base-ref-missing")
    return `Base branch missing: ${host} can't read ${base}, the branch this PR targets, so the merge is held until it can.`;
  return undefined;
}

/** What a grant's IDs are called, where a read supplied the name; `options` follows `optionNodeIds`. */
export type GrantNames = {
  repository?: string | undefined;
  project?: string | undefined;
  field?: string | undefined;
  options?: readonly (string | undefined)[] | undefined;
};

const named = (id: string, name: string | undefined) =>
  name || (id ? `${id} (name not found)` : "(not chosen)");
const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** A grant as one sentence of names; display only, the IDs stay the identity. */
export function grantSentence(
  grant: {
    action: ActionKind;
    repositoryId: string;
    mode: "allow" | "approval";
    projectNodeId?: string | undefined;
    fieldNodeId?: string | undefined;
    optionNodeIds?: readonly string[] | undefined;
  },
  names: GrantNames = {},
) {
  const repository = named(grant.repositoryId, names.repository);
  const project = named(grant.projectNodeId ?? "", names.project);
  const label = lower(deliveryActionCopy[grant.action].label);
  const what =
    grant.action === "project.field"
      ? `set ${named(grant.fieldNodeId ?? "", names.field)} to ${
          (grant.optionNodeIds ?? [])
            .map((id, i) => named(id, names.options?.[i]))
            .join(", ") || "(not chosen)"
        } on Project ${project} for issues in ${repository}`
      : grant.action === "project.item.add"
        ? `add issues in ${repository} to Project ${project}`
        : grant.action.startsWith("branch.")
          ? `${label} to ${repository}`
          : `${label} in ${repository}`;
  return `${grant.mode === "allow" ? "Allow" : "Require approval"}: ${what}`;
}
