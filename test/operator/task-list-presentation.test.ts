import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sharedReadinessReasons,
  taskReasonItems,
  taskVisibilityText,
} from "../../web/src/tasks.js";
import { summary } from "../fixtures/task-summary.js";

test("task visibility and shared readiness copy stay concise", () => {
  assert.equal(taskVisibilityText(5, 34), "5 Ready of 34 eligible tasks");
  const first = summary({
    ready: false,
    reasons: ["task-unready", "project-paused"],
  });
  const second = summary({ ready: false, reasons: ["task-unready"] });
  assert.deepEqual(sharedReadinessReasons([first, second]), [
    ["Draft: not Ready", 2],
  ]);
  assert.deepEqual(
    taskReasonItems(first).map((reason) => reason.text),
    ["Draft: not Ready", "Project paused"],
  );
});
