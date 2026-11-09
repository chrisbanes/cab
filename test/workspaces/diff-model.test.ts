import assert from "node:assert/strict";
import test from "node:test";
import {
  filePatch,
  selectableLines,
  treePaths,
  type Anchor,
} from "../../web/src/diff-model.js";
import { entryLineCounts } from "../../web/src/file-change-markers.js";

const anchor = { path: "a.ts" } as Anchor;

test("filePatch writes git headers and recounts each hunk from its body", () => {
  const patch = filePatch("src/b.ts", "src/a.ts", [
    // Retained diffs cap their rows, so the declared counts can overstate the body.
    {
      oldStart: 1,
      oldLines: 40,
      newStart: 1,
      newLines: 41,
      patch: " keep\n-old\n+new\n+added",
    },
    {
      oldStart: 9,
      oldLines: 1,
      newStart: 10,
      newLines: 1,
      patch: "@@ -9,1 +10,1 @@\n-x\n\\ No newline at end of file\n+y\n",
    },
  ]);
  assert.equal(
    patch,
    [
      "diff --git a/src/a.ts b/src/b.ts",
      "rename from src/a.ts",
      "rename to src/b.ts",
      "--- a/src/a.ts",
      "+++ b/src/b.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+added",
      "@@ -9,1 +10,1 @@",
      "-x",
      "\\ No newline at end of file",
      "+y",
      "",
    ].join("\n"),
  );
  assert.ok(!filePatch("same.ts", undefined, []).includes("rename"));
});

test("selectableLines numbers each side and skips a side without an anchor", () => {
  const hunks = [
    {
      oldStart: 4,
      oldLines: 3,
      newStart: 4,
      newLines: 3,
      patch: "@@ -4,3 +4,3 @@\n ctx\n-gone\n+here\n tail\n",
      leftAnchor: anchor,
      rightAnchor: anchor,
    },
    {
      oldStart: 20,
      oldLines: 0,
      newStart: 21,
      newLines: 1,
      patch: "+only after\n",
      rightAnchor: anchor,
    },
  ];
  const lines = selectableLines(hunks);
  assert.deepEqual(
    lines.left.map(({ line, hunk, row }) => [line, hunk, row]),
    [
      [4, 0, 0],
      [5, 0, 1],
      [6, 0, 3],
    ],
  );
  assert.deepEqual(
    lines.right.map(({ line, hunk, row }) => [line, hunk, row]),
    [
      [4, 0, 0],
      [5, 0, 2],
      [6, 0, 3],
      [21, 1, 0],
    ],
  );
  assert.deepEqual(
    selectableLines([{ ...hunks[0]!, leftAnchor: undefined }]).left,
    [],
  );
});

test("treePaths keeps one row per entry", () => {
  const name = (id: string) => `repo-${id}`;
  assert.deepEqual(
    treePaths(
      [
        { path: "a.ts", repositoryId: "x", changeSet: "branch" },
        { path: "b/c.ts", repositoryId: "x", changeSet: "branch" },
      ],
      name,
    ),
    ["a.ts", "b/c.ts"],
  );
  // One path both staged and unstaged gains change-set folders.
  assert.deepEqual(
    treePaths(
      [
        { path: "a.ts", repositoryId: "x", changeSet: "staged" },
        { path: "a.ts", repositoryId: "x", changeSet: "unstaged" },
        { path: "b.ts", repositoryId: "x", changeSet: "unstaged" },
      ],
      name,
    ),
    ["Staged/a.ts", "Unstaged/a.ts", "Unstaged/b.ts"],
  );
  // Several repositories gain repository folders; a label collision still gets its own row.
  assert.deepEqual(
    treePaths(
      [
        { path: "a.ts", repositoryId: "x" },
        { path: "a.ts", repositoryId: "y" },
        { path: "a.ts" },
      ],
      () => "same",
    ),
    ["same/a.ts", "same/a.ts (2)", "Workspace/a.ts"],
  );
});

test("entryLineCounts counts added and removed lines only", () => {
  assert.deepEqual(
    entryLineCounts({
      hunks: [
        {
          patch:
            "@@ -1,2 +1,2 @@\n ctx\n-a\n+b\n+c\n\\ No newline at end of file\n",
        },
      ],
    }),
    { added: 2, removed: 1 },
  );
});
