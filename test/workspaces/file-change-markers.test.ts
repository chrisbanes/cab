import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";
import {
  changeLineCounts,
  changeMarkers,
} from "../../web/src/file-change-markers.js";

const taskId = "cee1f027-8169-46de-84a6-9c7e70ef91e3";
const comparisonId = "f6d207ea-dd9d-423a-ae70-cde35c65f1f1";

type Entry = WorkspaceComparisonRead["data"] extends infer D
  ? D extends { comparison: { entries: Array<infer E> } }
    ? E
    : never
  : never;

const entry = (
  path: string,
  change: Entry["change"],
  extra: Partial<Entry> = {},
): Entry => ({ path, change, state: "text", hunks: [], ...extra });

function read(
  entries: Entry[],
  overrides: Record<string, unknown> = {},
  repositoryId = "alpha",
) {
  return {
    taskId,
    target: "branch",
    state: "available",
    comparisonId,
    comparison: {
      taskId,
      repositoryId,
      target: "branch",
      state: "available",
      comparisonId,
      observedAt: 1791475034722,
      baseline: { kind: "merge-base", branch: "main", commit: "a".repeat(40) },
      availableBaseBranches: ["main"],
      entries,
      truncated: false,
      ...overrides,
    },
  } as WorkspaceComparisonRead["data"];
}

test("a nested change marks its file and every ancestor directory", () => {
  const data = read([entry("src/components/menu.ts", "modified")]);
  const root = changeMarkers(data, "alpha", []);
  assert.ok(root);
  assert.deepEqual([...root.directories], ["src"]);
  assert.equal(root.files.size, 0);
  assert.deepEqual(root.deleted, []);
  const nested = changeMarkers(data, "alpha", ["src", "components"]);
  assert.ok(nested);
  assert.equal(nested.files.get("menu.ts"), "modified");
  assert.equal(nested.directories.size, 0);
  // A sibling directory with the same prefix is not part of the subtree.
  const sibling = changeMarkers(data, "alpha", ["src-other"]);
  assert.ok(sibling);
  assert.equal(sibling.files.size, 0);
  assert.equal(sibling.directories.size, 0);
});

test("added and deleted files at the root keep their kind; a deleted file is listed apart", () => {
  const markers = changeMarkers(
    read([entry("added.md", "added"), entry("gone.txt", "deleted")]),
    "alpha",
    [],
  );
  assert.ok(markers);
  assert.equal(markers.files.get("added.md"), "added");
  assert.equal(markers.files.has("gone.txt"), false);
  assert.deepEqual(markers.deleted, [{ name: "gone.txt", directory: false }]);
});

test("a folder emptied by deletion is listed as a deleted folder", () => {
  const markers = changeMarkers(
    read([entry("old/a.txt", "deleted"), entry("old/b.txt", "deleted")]),
    "alpha",
    [],
  );
  assert.ok(markers);
  assert.deepEqual(markers.deleted, [{ name: "old", directory: true }]);
  assert.deepEqual([...markers.directories], ["old"]);
});

test("a rename marks the new path only, and type-changed is its own kind", () => {
  const markers = changeMarkers(
    read([
      entry("new-name.txt", "renamed", { previousPath: "old-name.txt" }),
      entry("link", "type-changed"),
    ]),
    "alpha",
    [],
  );
  assert.ok(markers);
  assert.equal(markers.files.get("new-name.txt"), "renamed");
  assert.equal(markers.files.get("link"), "type-changed");
  assert.equal(markers.files.has("old-name.txt"), false);
  assert.deepEqual(markers.deleted, []);
});

test("an empty comparison yields empty markers, and the bound is reported", () => {
  const markers = changeMarkers(read([], { truncated: true }), "alpha", []);
  assert.ok(markers);
  assert.equal(markers.files.size, 0);
  assert.equal(markers.directories.size, 0);
  assert.equal(markers.truncated, true);
  assert.equal(markers.baseBranch, "main");
});

test("a read that is not a complete Branch comparison of this repository yields no markers", () => {
  const entries = [entry("a.txt", "modified")];
  assert.equal(changeMarkers(undefined, "alpha", []), null);
  assert.equal(
    changeMarkers(
      { ...read(entries), state: "gap" } as WorkspaceComparisonRead["data"],
      "alpha",
      [],
    ),
    null,
  );
  assert.equal(
    changeMarkers(read(entries, { state: "gap", reason: "gap" }), "alpha", []),
    null,
  );
  assert.equal(
    changeMarkers(
      read(entries, { state: "unavailable", reason: "no-merge-base" }),
      "alpha",
      [],
    ),
    null,
  );
  // Never another repository's snapshot, nor a different target.
  assert.equal(changeMarkers(read(entries, {}, "beta"), "alpha", []), null);
  assert.equal(
    changeMarkers(read(entries, { target: "uncommitted" }), "alpha", []),
    null,
  );
});

const withPatch = (
  patch: string,
  state: "text" | "binary" | "unsupported" | "gap" = "text",
) => ({ state, hunks: [{ patch }] });

test("the heading counts files and the added and removed lines of every hunk", () => {
  const entries = [
    withPatch("@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four"),
    withPatch("@@ -0,0 +1 @@\n+new"),
  ];
  assert.deepEqual(changeLineCounts(entries, false), {
    files: 2,
    added: 3,
    removed: 1,
  });
});

test("a no-newline marker and a binary entry add no lines", () => {
  const entries = [
    withPatch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b"),
    { state: "binary" as const, hunks: [] },
  ];
  assert.deepEqual(changeLineCounts(entries, false), {
    files: 2,
    added: 1,
    removed: 1,
  });
});

test("a truncated, gapped or unsupported comparison shows the file count alone", () => {
  const text = withPatch("@@ -0,0 +1 @@\n+new");
  assert.deepEqual(changeLineCounts([text], true), { files: 1 });
  for (const state of ["gap", "unsupported"] as const)
    assert.deepEqual(changeLineCounts([text, withPatch("", state)], false), {
      files: 2,
    });
});
