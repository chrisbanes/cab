import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeFilterCount,
  defaultTaskFilters,
  sharedTaskReasons,
  sharedTaskReasonText,
  readinessHiddenCounts,
  taskLeadLabel,
  taskReasonItems,
  taskVisibilityText,
} from "../../web/src/tasks.js";
import { summary } from "../fixtures/task-summary.js";

test("task visibility and shared readiness copy stay concise", () => {
  assert.equal(taskVisibilityText(5, 34), "5 Ready of 34 eligible tasks");
  assert.equal(activeFilterCount(defaultTaskFilters), 0);
  assert.equal(activeFilterCount({ ...defaultTaskFilters, ready: "no" }), 1);
  assert.equal(activeFilterCount({ ...defaultTaskFilters, ready: "any" }), 1);
  assert.deepEqual(
    readinessHiddenCounts([
      summary({ ready: false }),
      summary({ ready: false, state: "done" }),
      summary({ ready: false, state: "cancelled" }),
    ]),
    { drafts: 1, other: 2 },
  );
  const first = summary({
    ready: false,
    reasons: ["task-unready", "project-paused"],
  });
  const second = summary({ ready: false, reasons: ["task-unready"] });
  assert.deepEqual(sharedTaskReasons([first, second]), [
    ["Draft: not Ready", 2],
  ]);
  assert.equal(
    sharedTaskReasonText(2, "Draft: not Ready"),
    "2 tasks share this readiness/dependency reason: Draft: not Ready.",
  );
  assert.deepEqual(
    taskReasonItems(first).map((reason) => reason.text),
    ["Draft: not Ready", "Project paused"],
  );
  const unavailable = summary({ reasons: ["imported-blockers-unknown"] });
  assert.deepEqual(
    sharedTaskReasons([
      unavailable,
      summary({ reasons: ["imported-blockers-unknown"] }),
    ]),
    [["GitHub dependencies unavailable", 2]],
  );
  const sameLead = summary({ lead: "Mira" });
  sameLead.project.leadProfileId = sameLead.lead!.profileId;
  assert.equal(taskLeadLabel(sameLead), null);
  assert.equal(taskLeadLabel(summary()), "No lead configured");
  assert.equal(
    taskLeadLabel(summary({ lead: "Different lead" })),
    "Different lead",
  );
});
