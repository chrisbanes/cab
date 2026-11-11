import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "../../src/operator/contracts.js";
import { approvalMaterialView } from "../../src/operator/approval-material.js";

// A delivery approval's action is its material's kind.
const read = (material: { kind: string } & { [key: string]: JsonValue }) =>
  approvalMaterialView(material, material.kind);

const target = { repositoryId: "R1", nodeId: "I1", number: 7 };

test("an issue edit with its expected text reads as title and body diffs", () => {
  const view = read({
    kind: "issue.edit",
    target,
    fields: { title: "New", body: "a\nc" },
    expected: { title: "Old", body: "a\nb" },
  });
  assert.deepEqual(view.diffs, [
    { label: "Title", before: "Old", after: "New" },
    { label: "Body", before: "a\nb", after: "a\nc" },
  ]);
  assert.deepEqual(view.texts, []);
  assert.equal(view.unrecognized, false);
  // Without the replaced text, the proposed text is shown whole.
  assert.deepEqual(
    read({ kind: "pr.edit", target, fields: { body: "x" } }).texts,
    [{ label: "Body", text: "x" }],
  );
});

test("an issue create reads as its title, labels and body", () => {
  const view = read({
    kind: "issue.create",
    target: { repositoryId: "R1" },
    title: "T",
    body: "B",
    labels: ["bug", "ui"],
  });
  assert.deepEqual(view.texts, [
    { label: "Title", text: "T" },
    { label: "Body", text: "B" },
  ]);
  assert.deepEqual(view.facts, [{ label: "Labels", value: "bug, ui" }]);
});

test("a merge and a recovery read as named facts", () => {
  assert.deepEqual(
    read({
      kind: "pr.merge",
      target: { ...target, number: 12 },
      method: "squash",
      reviewedResultIds: ["r1", "r2"],
    }).facts,
    [
      { label: "Pull request", value: "#12" },
      { label: "Merge method", value: "squash" },
      { label: "Reviewed results", value: "2" },
    ],
  );
  assert.deepEqual(
    read({
      kind: "branch.force-push",
      target: { repositoryId: "R1" },
      commitSha: "c".repeat(40),
      branch: "cab/x",
      outsideHeadSha: "b".repeat(40),
      lastPushedSha: null,
    }).facts.map(({ label, value }) => `${label}=${value}`),
    [
      "Branch=cab/x",
      `Commit=${"c".repeat(40)}`,
      `Outside head=${"b".repeat(40)}`,
      "Last pushed=never",
    ],
  );
});

test("material that is not the approval's action is unrecognized", () => {
  for (const material of [{ scope: "fixture" }, null, "text", { kind: "x" }])
    assert.equal(approvalMaterialView(material, "x").unrecognized, true);
  // An approval for another action cannot borrow an action's presentation.
  assert.equal(
    approvalMaterialView(
      { kind: "issue.comment", body: "hi", also: "hidden" },
      "Post a comment",
    ).unrecognized,
    true,
  );
});
