// Pure state for the Publish to GitHub panel of a local task.
import type { CommandReceipt, TaskRead } from "../../src/operator/contracts.js";

/** The task read's `publication` field. */
export type PublicationPolicy = NonNullable<TaskRead["data"]["publication"]>;
export type PublicationTarget = PublicationPolicy["targets"][number];
export type PublicationLatest = NonNullable<PublicationPolicy["latest"]>;
/** The review the service recorded: the destination, the text that becomes the issue and what it writes. */
export type PublicationReview = Extract<
  CommandReceipt,
  { kind: "publication-review" }
>;
export type PublicationReceipt = Extract<
  CommandReceipt,
  { kind: "publication" }
>;

export type PublishView =
  | "unavailable"
  | "choose"
  | "reviewing"
  | "sending"
  | "waiting"
  | "uncertain"
  | "published"
  | "failed"
  | "abandoned";

/** What the operator did in this session; the server's `latest` is the durable truth. */
export interface PublishLocal {
  review: PublicationReview | null;
  sending: boolean;
  /** The last publication this session ended, until it is dismissed. */
  ended: "published" | "failed" | "abandoned" | null;
}

export const emptyLocal: PublishLocal = {
  review: null,
  sending: false,
  ended: null,
};

/** The task has a publication whose steps are unresolved, so the panel has work to show again after a reload. */
export const hasPublishWork = (policy: PublicationPolicy) =>
  policy.latest?.state === "sending";

/** The create is the one step whose outcome matters most: an unknown one holds the task. */
export function createStep(latest: PublicationLatest | null) {
  return latest?.steps.find((s) => s.kind === "issue.create");
}

export function publishView(
  policy: PublicationPolicy,
  local: PublishLocal,
): PublishView {
  const latest = policy.latest;
  if (latest?.state === "sending")
    return createStep(latest)?.state === "uncertain" ? "uncertain" : "waiting";
  if (local.sending) return "sending";
  if (local.review) return "reviewing";
  if (local.ended) return local.ended;
  return policy.available ? "choose" : "unavailable";
}

/** The target a choice starts on: the first one that can take the task. */
export const firstEnabled = (policy: PublicationPolicy) =>
  policy.targets.find((t) => t.enabled)?.id ?? null;

export const publishCopy = {
  intro:
    "Create a GitHub issue from this task. The task becomes that issue: its title and description are then owned by GitHub, and the next sync matches it instead of importing a second task.",
  irreversible: (repository: string) =>
    `This creates a public issue in ${repository}. cab can’t delete it or take it back; closing the issue on GitHub is the only recovery.`,
  guard:
    "cab records the request before sending it. If GitHub doesn’t confirm the result, the task is held and nothing is sent again.",
  hidden:
    "Part of this task’s text can’t be shown in full here, so it can’t be published.",
  moved:
    "That didn’t apply: the task, the project’s grants or the issue changed, or the issue doesn’t carry this request’s marker. Check the state shown and try again.",
  unknown:
    "cab couldn’t tell whether that was recorded. Check below before trying again.",
  waiting:
    "Publishing is in progress. Nothing is sent again; this updates when GitHub answers.",
  uncertain:
    "GitHub didn’t confirm that the issue was created, and cab can’t tell whether it exists. The task is held and nothing is sent again.",
  linkHelp:
    "If you can find the issue on GitHub, link it by number. cab checks that it carries this request’s marker before turning the task into it.",
  abandonWarning:
    "Abandoning returns the task to a local task, but GitHub may still have created the issue. If it did, the next sync imports it as a second, unrelated task. This can’t be undone.",
  published: "Published. The task is now the GitHub issue below.",
  failed:
    "GitHub didn’t create the issue. Nothing changed, and the task is still local.",
  abandoned:
    "Abandoned. The task is local again. If GitHub created the issue anyway, the next sync imports it as a separate task.",
} as const;

/** Why a command was rejected, in a sentence the panel can show. */
export function rejectionSentence(code: string): string {
  return code === "forbidden" ? publishCopy.hidden : publishCopy.moved;
}

export function targetSummary(target: PublicationTarget) {
  const kind =
    target.selectionKind === "project" ? "GitHub Project" : "Repository";
  return `${target.repository ?? "Repository hidden"} · ${kind}`;
}

/** Whether publishing here keeps the task Ready, or leaves it a Draft. */
export const readyWord = (ready: boolean) => (ready ? "Ready" : "Draft");

const stepStates: Record<string, string> = {
  prepared: "recorded, not sent yet",
  attempting: "in progress",
  uncertain: "outcome unknown",
  "confirmed-success": "done",
  "confirmed-failure": "failed",
  denied: "refused",
};

/** A step's state in words; only a failure the server marks as retrying is "waiting to retry". */
export function stepStateWord(step: PublicationLatest["steps"][number]) {
  return step.state === "confirmed-failure" && step.retrying
    ? "waiting to retry"
    : (stepStates[step.state] ?? step.state);
}
