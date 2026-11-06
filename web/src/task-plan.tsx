import { Button } from "./components.js";
import type { AgentPlan } from "./task-conversation-model.js";
import type { TaskWorkspaceState } from "./task-workspace-state.js";
import {
  planCountsLabel,
  planHeading,
  planNote,
  planOverflowLabel,
  planStepOmitted,
  planStepStatus,
  planStepsUnavailable,
} from "./task-plan-model.js";

/** Kept in the workspace's expanded set: present while the card is collapsed. */
const collapsedKey = "plan:collapsed";

/** A plan's steps in order, each with its status symbol and word. */
export function PlanSteps({ plan }: { plan: AgentPlan }) {
  if (plan.steps === null)
    return <p className="muted">{planStepsUnavailable}</p>;
  return (
    <>
      <ol className="plan-steps">
        {plan.steps.map((step, index) => {
          const status = planStepStatus(step.status);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity but their place.
            <li key={index} data-status={step.status}>
              <span className="plan-status">
                <span aria-hidden="true">{status.symbol}</span> {status.word}
              </span>
              <span className={step.text === null ? "muted" : undefined}>
                {step.text ?? planStepOmitted}
              </span>
            </li>
          );
        })}
      </ol>
      {plan.omittedStepCount > 0 && (
        <p className="metadata muted">
          {planOverflowLabel(plan.omittedStepCount)}
        </p>
      )}
    </>
  );
}

/**
 * The assignment's latest plan, pinned above the composer; nothing while it has none. It is
 * open unless the operator collapses it, which the workspace state keeps.
 */
export function PlanCard({
  plans,
  assignmentId,
  state,
  changed,
}: {
  plans: readonly AgentPlan[];
  assignmentId: string | null;
  state: TaskWorkspaceState;
  changed: () => void;
}) {
  const plan = plans.find((p) => p.assignmentId === assignmentId);
  if (!plan) return null;
  const open = !state.expanded.has(collapsedKey);
  return (
    <section className="plan-card" aria-labelledby="plan-heading">
      <h3 id="plan-heading" className="section-heading">
        {planHeading}
      </h3>
      <p className="metadata muted">{planNote}</p>
      <Button
        variant="secondary"
        aria-label={`${planHeading} · ${planCountsLabel(plan.done, plan.total)}`}
        aria-expanded={open}
        onClick={() => {
          if (!state.expanded.delete(collapsedKey))
            state.expanded.add(collapsedKey);
          changed();
        }}
      >
        {planCountsLabel(plan.done, plan.total)}
      </Button>
      {open && <PlanSteps plan={plan} />}
    </section>
  );
}
