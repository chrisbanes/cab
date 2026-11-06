import type { AgentPlan } from "./task-conversation-model.js";

type Status = NonNullable<AgentPlan["steps"]>[number]["status"];

export const planHeading = "Agent's plan";
export const planNote =
  "The lead's working plan, not a requirement or the brief.";
export const planStepsUnavailable =
  "Steps unavailable: they could not be redacted.";
export const currentPlanCaption = "Current plan";

export const planCountsLabel = (done: number, total: number) =>
  `${done}/${total} done`;

export const planUpdatedLabel = (done: number, total: number) =>
  `Plan updated · ${planCountsLabel(done, total)}`;

const statuses: Record<Status, { symbol: string; word: string }> = {
  pending: { symbol: "○", word: "Pending" },
  "in-progress": { symbol: "◐", word: "In progress" },
  done: { symbol: "✓", word: "Done" },
};

/** A step's status as a symbol and a word, never colour alone. */
export const planStepStatus = (status: Status) => statuses[status];

export const planOverflowLabel = (count: number) =>
  `+${count} more ${count === 1 ? "step" : "steps"} not kept`;

/** A step kept only by its status because its text was too long. */
export const planStepOmitted = "Step text too long to keep.";
