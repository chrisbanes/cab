import type { StackFacts, StackReason } from "../core/stacked-dependencies.js";

/**
 * The one wording for a project's stacking setting and a task's stack facts (ADR-1023). The CLI
 * and the web import it, so every surface reads the same.
 */
export const stackingDisclosure =
  "Dependents start on their blocker's unmerged work, and a merge cannot be undone.";

/** Turning stacking on or off changes only dependents that have not started. */
export const stackingAppliesNote =
  "Applies to dependents that have not started; a dependent already stacked stays stacked.";

export const stackingLine = (enabled: boolean) =>
  enabled
    ? "Stacking is on: a dependent with a single blocker in the same repository starts on the blocker's open change request."
    : "Stacking is off: dependents wait until their blockers are Done.";

export const stackReasonLabels: Record<StackReason, string> = {
  "stacking-off": "stacking is off for this project",
  "multiple-blockers": "it has more than one blocker",
  "sibling-stacked": "another task is already stacked on its blocker",
  "cross-repository": "its blocker works in a repository this task does not",
  "outside-project": "its blocker is not a task in this project",
  "dependent-started": "it started before it could stack",
  "blocker-unpublished":
    "its blocker has no open change request at its last push",
  "blocker-unknown": "its blocker's change request or state is unknown",
};

/** A task's stack facts as one sentence; null when stacking does not apply. */
export function stackSummary(
  stack: StackFacts | null | undefined,
): string | null {
  if (!stack) return null;
  const base = stack.parentHead ? ` at ${stack.parentHead.slice(0, 12)}` : "";
  const restack =
    stack.restack === "pending"
      ? "; a restack onto the new head is pending"
      : "";
  if (stack.state === "stacked")
    return stack.reason
      ? `Stacked on its blocker${base}; waiting because ${stackReasonLabels[stack.reason]}${restack}.`
      : `Stacked on its blocker${base}${restack}.`;
  const reason = stack.reason ?? "stacking-off";
  return reason === "blocker-unpublished" || reason === "blocker-unknown"
    ? `Will start stacked on its blocker; waiting because ${stackReasonLabels[reason]}.`
    : `Not stacked: waits until its blocker is Done because ${stackReasonLabels[reason]}.`;
}
