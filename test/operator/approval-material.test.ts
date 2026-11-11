import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalMaterialView } from "../../src/operator/approval-material.js";

const target = { repositoryId: "R1", nodeId: "I1", number: 7 };

test("an issue edit with its expected text reads as title and body diffs", () => {
  const view = approvalMaterialView({
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
    approvalMaterialView({ kind: "pr.edit", target, fields: { body: "x" } })
      .texts,
    [{ label: "Body", text: "x" }],
  );
});

test("an issue create reads as its title, labels and body", () => {
  const view = approvalMaterialView({
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
    approvalMaterialView({
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
    approvalMaterialView({
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

test("material that is not an action is unrecognized", () => {
  for (const material of [{ scope: "fixture" }, null, "text", { kind: "x" }])
    assert.equal(approvalMaterialView(material).unrecognized, true);
});
