import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  TaskRead,
  TaskWorkspaceRecords,
} from "../../src/operator/contracts.js";
import {
  workspaceRecordRows,
  workspaceRemovalCopy,
  workspaceRemovalOffered,
} from "../../web/src/workspace-removal-presentation.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const pushed = "a".repeat(40);
const base = "b".repeat(40);

const task = (
  state: "open" | "done" | "cancelled",
  workspace: TaskWorkspaceRecords | undefined,
) =>
  ({
    task: { state },
    workspace,
    repositoryNames: [{ repositoryId: "R1", name: "acme/app" }],
  }) as unknown as TaskRead["data"];

const records = (
  over: Partial<TaskWorkspaceRecords> = {},
): TaskWorkspaceRecords => ({
  workspaceId: A,
  state: "ready",
  trim: null,
  removal: null,
  ...over,
});

test("the removal confirmation states exactly what goes, what stays and that it cannot be undone", () => {
  assert.deepEqual(workspaceRemovalCopy.goes, [
    "Each repository's worktree, with its ignored files such as dependencies and build output",
    "The scratch directory",
    "Other files at the workspace root",
    "The workspace's Claude temporary directory",
  ]);
  assert.deepEqual(workspaceRemovalCopy.stays, [
    "The task branch at its pushed commit in each repository",
    "Change requests",
    "Results, readable from their commits",
    "Conversations and task records",
  ]);
  assert.equal(
    workspaceRemovalCopy.irreversible,
    "Removal cannot be undone. cab checks again before deleting anything and refuses if work could be lost. A later turn gets a new workspace.",
  );
  assert.equal(
    workspaceRemovalCopy.title("Ship it"),
    "Remove the workspace of Ship it?",
  );
  for (const text of [
    ...workspaceRemovalCopy.goes,
    ...workspaceRemovalCopy.stays,
    workspaceRemovalCopy.irreversible,
  ])
    assert.doesNotMatch(text, /archiv/i);
});

test("removal is offered for a done or cancelled task's current workspace only", () => {
  assert.equal(workspaceRemovalOffered(task("done", records())), true);
  assert.equal(workspaceRemovalOffered(task("cancelled", records())), true);
  assert.equal(workspaceRemovalOffered(task("open", records())), false);
  assert.equal(
    workspaceRemovalOffered(task("done", records({ state: "removed" }))),
    false,
  );
  assert.equal(
    workspaceRemovalOffered(task("done", records({ workspaceId: null }))),
    false,
  );
  // An older service says nothing about the workspace: nothing is offered.
  assert.equal(workspaceRemovalOffered(task("done", undefined)), false);
});

test("records name the time and trigger, and tell a pushed branch from an untouched base", () => {
  const clock = (at: number) => `T${at}`;
  const removal = (trigger: "manual" | "delivered" | "merged" | "disk") =>
    records({
      workspaceId: B,
      removal: {
        workspaceId: A,
        at: 5,
        trigger,
        repositories: [
          {
            repositoryId: "R1",
            kind: "pushed",
            branch: "cab/ship",
            commit: pushed,
          },
          { repositoryId: "R2", kind: "base", branch: "main", commit: base },
          { repositoryId: "R3", kind: "pushed", branch: null, commit: pushed },
        ],
      },
      trim: { workspaceId: B, at: 9, trigger: "idle" },
    });
  assert.deepEqual(
    workspaceRecordRows(task("done", removal("manual")), clock),
    [
      {
        text: "Workspace removed T5 (manual)",
        evidence: [
          `acme/app: pushed to cab/ship at ${pushed}`,
          `R2: no task commits beyond main at ${base}`,
          `R3: pushed to [branch unavailable] at ${pushed}`,
        ],
      },
      { text: "Trimmed T9 (idle limit)", evidence: [] },
    ],
  );
  assert.deepEqual(
    (["delivered", "merged", "disk"] as const).map(
      (trigger) =>
        workspaceRecordRows(task("done", removal(trigger)), clock)[0]?.text,
    ),
    [
      "Workspace removed T5 (delivered retention)",
      "Workspace removed T5 (merged retention)",
      "Workspace removed T5 (disk limit)",
    ],
  );
  assert.deepEqual(
    workspaceRecordRows(
      task(
        "open",
        records({ trim: { workspaceId: A, at: 1, trigger: "disk" } }),
      ),
      clock,
    ),
    [{ text: "Trimmed T1 (disk limit)", evidence: [] }],
  );
  assert.deepEqual(workspaceRecordRows(task("open", records()), clock), []);
});
