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
