import type { TaskRead } from "./contracts.js";

export type ExecutionAllowance = NonNullable<
  TaskRead["data"]["executionAllowance"]
>;

/** The fixed disclosure: work that never charges a task's allowance. */
export const allowanceExcludedText =
  "Direct work and project drafting runs are not charged to a task.";

/** One summary of the task's execution allowance, shared by the operator UI and the CLI. */
export function allowanceSummary(a: ExecutionAllowance): string {
  if (a.state === "off") return `Off; ${a.charged} charged`;
  if (a.state === "history-unavailable")
    return "Off; it cannot be turned on because this task has admissions from before cab recorded charges";
  const held = a.heldWorkIds.length
    ? "; new turns are held, admitted work may continue"
    : "";
  if (a.state === "inconsistent")
    return `On, total ${a.total}; accounting unavailable${held}`;
  return [
    `${a.charged} of ${a.total} charged, ${a.remaining} remaining`,
    a.provisional ? `, ${a.provisional} provisional` : "",
    a.overBy ? `; ${a.overBy} over the total` : "",
    held,
  ].join("");
}
