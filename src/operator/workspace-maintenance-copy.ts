import type { WorkspaceMaintenanceReason } from "../core/inbox-lifecycle.js";
import type { TaskWorkspaceRecords } from "./contracts.js";

type Removal = NonNullable<TaskWorkspaceRecords["removal"]>;
type Trim = NonNullable<TaskWorkspaceRecords["trim"]>;

/** What started a removal, as the task page and `task show` name it. */
export const removalTriggerLabels: Record<Removal["trigger"], string> = {
  manual: "manual",
  delivered: "delivered retention",
  merged: "merged retention",
  disk: "disk limit",
};
/** What started a trim. */
export const trimTriggerLabels: Record<Trim["trigger"], string> = {
  manual: "manual",
  idle: "idle limit",
  disk: "disk limit",
};

/** `Workspace removed <time> (<trigger>)`; `time` is already formatted for the surface. */
export const removalRecordText = (removal: Removal, time: string) =>
  `Workspace removed ${time} (${removalTriggerLabels[removal.trigger]})`;
/** `Trimmed <time> (<trigger>)`. */
export const trimRecordText = (trim: Trim, time: string) =>
  `Trimmed ${time} (${trimTriggerLabels[trim.trigger]})`;

/** The evidence that made one repository safe to remove: its pushed task branch, or its untouched base. */
export function removalEvidenceText(
  repository: Pick<
    Removal["repositories"][number],
    "kind" | "commit" | "branch"
  >,
  name: string,
): string {
  const branch = repository.branch ?? "[branch unavailable]";
  return repository.kind === "pushed"
    ? `${name}: pushed to ${branch} at ${repository.commit}`
    : `${name}: no task commits beyond ${branch} at ${repository.commit}`;
}

/** Each maintenance blocker's reason, as the Inbox, CLI and notifications name it. */
export const maintenanceReasonLabels: Record<
  WorkspaceMaintenanceReason,
  string
> = {
  "task-open": "The task is open, so its workspace can only be trimmed",
  unsettled: "Task execution is not settled or the workspace is held",
  uncommitted:
    "Uncommitted work remains: modified tracked files or untracked files that are not ignored",
  "pending-result":
    "A result's uncommitted changes are neither committed nor delivered",
  "push-refused": "Pushing committed work to the task branch was refused",
  history:
    "Its history does not provably follow the last push or base, or the task branch changed outside cab",
  "delivery-unsettled": "A delivery action's outcome is not settled",
  "maintenance-held":
    "Earlier maintenance stopped and is held for reconciliation",
  "project-read-only": "The project is archived or being deleted",
  "clock-unknown":
    "Its idle or retention time predates cab's records, so cab does not remove or rank it",
  unmeasured: "Its disk usage could not be measured",
  "removal-off": "Automatic removal is off: both retention limits are off",
  refused: "cab refused; the task page has the details",
};

export const maintenanceInboxHeadline = "Workspace maintenance needs attention";

/** Decimal gigabytes, as the disk cap is configured. */
export const gigabytes = (bytes: number) =>
  `${(bytes / 1_000_000_000).toFixed(1)} GB`;

/** The item's reason: what is still unresolved after the latest pass. */
export function maintenanceInboxReason(
  usage: { measuredBytes: number; capBytes: number } | null,
  retentionRefused: boolean,
): string {
  const parts = [
    usage
      ? `Task workspaces use ${gigabytes(usage.measuredBytes)}, over the ${gigabytes(usage.capBytes)} disk limit`
      : null,
    retentionRefused ? "a workspace past its retention was not removed" : null,
  ].filter((part): part is string => part !== null);
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
