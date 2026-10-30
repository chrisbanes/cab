import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationTarget,
  tabForLocation,
  tabForSection,
  tabIds,
} from "../../web/src/task-tabs.js";

test("tabForSection maps every task section to the panel that holds it", () => {
  assert.deepEqual(tabIds, ["overview", "files", "changes", "review"]);
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
    ["history", "overview"],
    ["unknown", "overview"],
  ] as const)
    assert.equal(tabForSection(section), tab, section);
});

test("tabForLocation chooses the initial tab from the query and fragment", () => {
  for (const [path, tab] of [
    ["/app/tasks/x?section=history", "overview"],
    ["/app/tasks/x?section=context", "overview"],
    ["/app/tasks/x#history", "overview"],
    ["/app/tasks/x?section=local-review", "review"],
    ["/app/tasks/x?assignment=a#history", "overview"],
    ["/app/tasks/x?assignment=a", "overview"],
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

test("conversationTarget reads the conversation place a link names", () => {
  for (const [path, target] of [
    ["/app/tasks/x#history", { kind: "latest" }],
    ["/app/tasks/x#conversation", { kind: "latest" }],
    ["/app/tasks/x?section=history", { kind: "latest" }],
    ["/app/tasks/x?assignment=a", { kind: "assignment", id: "a" }],
    ["/app/tasks/x?assignment=a#history", { kind: "assignment", id: "a" }],
    ["/app/tasks/x?request=q#history", { kind: "request", id: "q" }],
    ["/app/tasks/x?request=q#conversation", { kind: "request", id: "q" }],
    // Without a place, ?request= opens the attention card form.
    ["/app/tasks/x?request=q", null],
    ["/app/tasks/x?section=context", null],
    ["/app/tasks/x?section=files&assignment=a", null],
    ["/app/tasks/x?section=review&assignment=a&result=r", null],
    ["/app/tasks/x?result=r&assignment=a", null],
    ["/app/tasks/x", null],
  ] as const)
    assert.deepEqual(conversationTarget(path), target, path);
  assert.deepEqual(conversationTarget("/app/tasks/x", "#history"), {
    kind: "latest",
  });
});
