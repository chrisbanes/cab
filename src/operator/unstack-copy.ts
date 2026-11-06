import type { UnstackReceipt } from "./unstack-contracts.js";
export const unstackConfirmation =
  "GitHub removes all removable unmerged members of the captured provider stack, not just this pull request. Only this pull request is retargeted to the repository link’s base. A restack follows only after complete removal and exact retarget are confirmed. Merged layers are unaffected. Cab cannot undo merges or automatic adoption.";
const gitLabUnstackConfirmation =
  "GitLab Unstack retargets only this merge request to the repository link’s base. Merge requests stacked on it stay on its branch. A restack follows only after the retarget is confirmed. Merged layers are unaffected. Cab cannot undo merges or automatic adoption.";
/** What confirming Unstack does on the change request's code host. */
export const unstackConfirmationFor = (codeHost: "github" | "gitlab") =>
  codeHost === "gitlab" ? gitLabUnstackConfirmation : unstackConfirmation;
export const unstackRecovery =
  "If any captured unmerged member remains, even after this pull request was removed, the original operation stays unfinished and readback-only. Cab does not infer why it remains. No new key, repeated Unstack, queue cancellation, retarget or restack is allowed while that outcome is unproved. Later validated complete removal may continue under the original identity fences.";
export const cancelStackedConfirmation =
  "Cancel this task and prevent future work. Cab requests best-effort cancellation of active executions, keeps unresolved ownership, history and the workspace, and closes no external issue or pull request. This is separate from Stop and cannot be resumed. An unfinished Unstack remains held.";
export function unstackStatus(r: UnstackReceipt): string {
  if (r.phase === "confirmed")
    return "Unstack and retarget confirmed; one restack was queued under the existing branch policy.";
  if (r.phase === "failed")
    return "Unstack refused with definite no-effect evidence. The original receipt remains available.";
  return `Unstack unfinished (${r.phase}). The original operation remains held; check its status without resending.`;
}
