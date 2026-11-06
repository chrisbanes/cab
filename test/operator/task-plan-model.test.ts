import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentPlanCaption,
  planCountsLabel,
  planHeading,
  planNote,
  planOverflowLabel,
  planStepStatus,
  planStepsUnavailable,
  planUpdatedLabel,
} from "../../web/src/task-plan-model.js";

test("plan wording names the agent's plan, its counts and every status by symbol and word", () => {
  assert.equal(planCountsLabel(3, 7), "3/7 done");
  assert.equal(planUpdatedLabel(0, 0), "Plan updated · 0/0 done");
  assert.equal(planUpdatedLabel(1, 3), "Plan updated · 1/3 done");
  assert.deepEqual(planStepStatus("pending"), { symbol: "○", word: "Pending" });
  assert.deepEqual(planStepStatus("in-progress"), {
    symbol: "◐",
    word: "In progress",
  });
  assert.deepEqual(planStepStatus("done"), { symbol: "✓", word: "Done" });
  assert.equal(planHeading, "Agent's plan");
  assert.match(planNote, /working plan, not a requirement or the brief/);
  assert.equal(currentPlanCaption, "Current plan");
  assert.equal(
    planStepsUnavailable,
    "Steps unavailable: they could not be redacted.",
  );
  assert.equal(planOverflowLabel(1), "+1 more step not kept");
  assert.equal(planOverflowLabel(4), "+4 more steps not kept");
});
