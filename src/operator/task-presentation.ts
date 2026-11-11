import { nextAttention, type AttentionCode } from "./attention.js";
import type { TaskListSummary, TaskRead } from "./contracts.js";

/** The task State/Next rules, shared by the operator UI and the CLI. */
export const columns = [
  "Ready",
  "Running",
  "Waiting",
  "Paused",
  "Stopping",
  "Uncertain",
  "Not started",
  "Draft",
  "Done",
  "Cancelled",
] as const;
export type TaskColumn = (typeof columns)[number];
export function taskColumn(task: TaskListSummary): TaskColumn {
  const s = task.execution.state;
  if (s === "stopping") return "Stopping";
  if (s === "uncertain") return "Uncertain";
  if (s === "not-started") return "Not started";
  if (s === "running" || s === "starting") return "Running";
  if (task.state === "done") return "Done";
  if (task.state === "cancelled") return "Cancelled";
  // Closed on GitHub without own delivery: paused until resolved, never Draft or Ready.
  if (
    task.project.paused ||
    s === "paused" ||
    task.source?.closure === "held" ||
    task.source?.closure === "unattributed"
  )
    return "Paused";
  if (!task.ready) return "Draft";
  if (!task.admission.eligible || s === "waiting" || task.execution.holds.task)
    return "Waiting";
  return "Ready";
}
/**
 * Who acts next, from the attention codes in the shared precedence and the task's column: one
 * rule for the List and the task detail.
 */
export function nextActor(
  codes: readonly AttentionCode[],
  column: TaskColumn,
): { code?: AttentionCode; text: string; operator: boolean } {
  const next = nextAttention(codes, column === "Uncertain");
  if (next) return next;
  const text =
    column === "Done"
      ? "Next: none · no decision"
      : column === "Cancelled"
        ? "Next: none · history retained"
        : "No operator decision";
  return { text, operator: false };
}
/** The task's Board column from its own read, in `taskColumn`'s precedence. */
export function taskColumnOf(
  data: Pick<TaskRead["data"], "task" | "execution" | "admission" | "source">,
): TaskColumn {
  const { task, execution } = data,
    s = execution.state;
  if (execution.holds.stop || s === "stopping") return "Stopping";
  if (execution.holds.uncertainty || s === "uncertain") return "Uncertain";
  if (s === "not-started") return "Not started";
  if (s === "running" || s === "starting") return "Running";
  if (task.state === "done") return "Done";
  if (task.state === "cancelled") return "Cancelled";
  if (
    s === "paused" ||
    data.source?.closure === "held" ||
    data.source?.closure === "unattributed" ||
    data.admission.reasons.includes("project-paused")
  )
    return "Paused";
  if (!task.ready) return "Draft";
  if (!data.admission.eligible || s === "waiting" || execution.holds.task)
    return "Waiting";
  return "Ready";
}

/** The workspace state a result recorded, one line per repository; shared by the operator UI and the CLI. */
export function resultWorkspaceLines(
  workspace: TaskRead["data"]["results"][number]["workspace"],
): string[] {
  if (workspace.length === 0) return ["Workspace state was not recorded"];
  return workspace.map(
    (w) =>
      `${w.repositoryId}: recorded at ${w.headCommit.slice(0, 7)} on ${w.branch ?? "detached HEAD"}${w.dirty ? ", with uncommitted changes" : ""}`,
  );
}
