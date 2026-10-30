import assert from "node:assert/strict";
import { test } from "node:test";
import {
  tabForLocation,
  tabForSection,
  tabIds,
} from "../../web/src/task-tabs.js";

test("tabForSection maps every task section to the panel that holds it", () => {
  assert.deepEqual(tabIds, [
    "overview",
    "files",
    "changes",
    "review",
    "history",
  ]);
  for (const [section, tab] of [
    ["decisions", "overview"],
    ["brief", "overview"],
    ["review", "overview"],
    ["assignments", "overview"],
    ["reply", "overview"],
    ["files", "files"],
    ["changes", "changes"],
    ["local-review", "review"],
    ["context", "overview"],
    ["history", "history"],
    ["unknown", "overview"],
  ] as const)
    assert.equal(tabForSection(section), tab, section);
});

test("tabForLocation chooses the initial tab from the query and fragment", () => {
  for (const [path, tab] of [
    ["/app/tasks/x?section=history", "history"],
    ["/app/tasks/x?section=local-review", "review"],
    ["/app/tasks/x?assignment=a#history", "history"],
    ["/app/tasks/x?assignment=a", "history"],
    ["/app/tasks/x?path=docs/a.md&repository=r", "files"],
    ["/app/tasks/x?target=branch", "changes"],
    ["/app/tasks/x?review=k", "review"],
    ["/app/tasks/x?result=r&source=s", "overview"],
    ["/app/tasks/x#files", "files"],
    ["/app/tasks/x?section=files&assignment=a", "files"],
    ["/app/tasks/x?section=review&assignment=a&result=r", "overview"],
    ["/app/tasks/x?result=r&source=s&assignment=a", "overview"],
    ["/app/tasks/x", null],
  ] as const)
    assert.equal(tabForLocation(path), tab, path);
  assert.equal(tabForLocation("/app/tasks/x", "#changes"), "changes");
});
