import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationTarget,
  linkNamesInspector,
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
    "execution",
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
    ["execution", "execution"],
    ["context", "overview"],
    ["history", "overview"],
    ["unknown", "overview"],
  ] as const)
    assert.equal(tabForSection(section), tab, section);
});

test("tabForLocation chooses the initial tab from the query and fragment", () => {
  for (const [path, tab] of [
    ["/tasks/x?section=history", "overview"],
    ["/tasks/x?section=context", "overview"],
    ["/tasks/x#history", "overview"],
    ["/tasks/x?section=local-review", "review"],
    ["/tasks/x?section=execution", "execution"],
    ["/tasks/x#execution", "execution"],
    ["/tasks/x?assignment=a#history", "overview"],
    ["/tasks/x?assignment=a", "overview"],
    ["/tasks/x?path=docs/a.md&repository=r", "files"],
    ["/tasks/x?target=branch", "changes"],
    ["/tasks/x?review=k", "review"],
    ["/tasks/x?result=r&source=s", "overview"],
    ["/tasks/x#files", "files"],
    ["/tasks/x?section=files&assignment=a", "files"],
    ["/tasks/x?section=review&assignment=a&result=r", "overview"],
    ["/tasks/x?result=r&source=s&assignment=a", "overview"],
    ["/tasks/x", null],
  ] as const)
    assert.equal(tabForLocation(path), tab, path);
  assert.equal(tabForLocation("/tasks/x", "#changes"), "changes");
});

test("conversationTarget reads the conversation place a link names", () => {
  for (const [path, target] of [
    ["/tasks/x#history", { kind: "latest" }],
    ["/tasks/x#conversation", { kind: "latest" }],
    ["/tasks/x?section=history", { kind: "latest" }],
    ["/tasks/x?assignment=a", { kind: "assignment", id: "a" }],
    ["/tasks/x?assignment=a#history", { kind: "assignment", id: "a" }],
    ["/tasks/x?request=q#history", { kind: "request", id: "q" }],
    ["/tasks/x?request=q#conversation", { kind: "request", id: "q" }],
    // Without a place, ?request= opens the attention card form.
    ["/tasks/x?request=q", null],
    ["/tasks/x?section=context", null],
    ["/tasks/x?section=files&assignment=a", null],
    ["/tasks/x?section=review&assignment=a&result=r", null],
    ["/tasks/x?result=r&assignment=a", null],
    ["/tasks/x", null],
  ] as const)
    assert.deepEqual(conversationTarget(path), target, path);
  assert.deepEqual(conversationTarget("/tasks/x", "#history"), {
    kind: "latest",
  });
});

test("linkNamesInspector is true only for links to what the inspector shows", () => {
  for (const path of [
    "/t?section=brief",
    "/t?section=assignments",
    "/t?section=context",
    "/t?section=review",
    "/t?section=result-evidence",
    "/t#context",
    "/t?result=r",
    "/t?evidence=e&result=r",
    "/t?source=s",
    "/t?record=x",
    "/t?inspectAssignment=a",
  ])
    assert.equal(linkNamesInspector(path), true, path);
  for (const path of [
    "/tasks/x",
    "/t?section=changes",
    "/t?section=changes&result=r",
    "/t?section=files",
    "/t?section=execution",
    "/t?section=reply",
    "/t?section=conversation",
    "/t#conversation",
    "/t?assignment=a",
    "/t?request=q#conversation",
    "/t?path=a.md",
    "/t?section=decisions",
  ])
    assert.equal(linkNamesInspector(path), false, path);
  assert.equal(linkNamesInspector("/t", "#brief"), true);
});
