import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";

type Snapshot = Extract<
  WorkspaceComparisonRead["data"],
  { state: "available" }
>["comparison"];
type Entry = Snapshot["entries"][number];
export type Hunk = Entry["hunks"][number];
export type Anchor = NonNullable<Hunk["leftAnchor"]>;
/** A hunk without anchors renders read-only. */
export type DiffHunkData = Pick<
  Hunk,
  "oldStart" | "oldLines" | "newStart" | "newLines" | "patch"
> &
  Partial<Pick<Hunk, "leftAnchor" | "rightAnchor">>;
export type Side = "left" | "right";
/** A line that can carry a review selection: its side, number, hunk and row within the hunk. */
export type Selectable = {
  side: Side;
  line: number;
  hunk: number;
  row: number;
};

/** Hunk body lines without the `@@` header or the trailing empty split. */
function bodyLines(hunk: DiffHunkData) {
  const lines = hunk.patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.filter((line) => !line.startsWith("@@"));
}

/**
 * One git-style patch for the file. Hunk headers are recounted from the body so a shortened hunk
 * (retained diffs cap their rows) still parses.
 */
export function filePatch(
  path: string,
  previousPath: string | undefined,
  hunks: readonly DiffHunkData[],
) {
  const from = previousPath ?? path;
  // Git headers, so the a/ and b/ prefixes are stripped rather than read as a rename.
  let patch = `diff --git a/${from} b/${path}\n`;
  if (from !== path) patch += `rename from ${from}\nrename to ${path}\n`;
  patch += `--- a/${from}\n+++ b/${path}\n`;
  for (const hunk of hunks) {
    const lines = bodyLines(hunk);
    const old = lines.filter((l) => l[0] === " " || l[0] === "-").length;
    const added = lines.filter((l) => l[0] === " " || l[0] === "+").length;
    patch += `@@ -${hunk.oldStart},${old} +${hunk.newStart},${added} @@\n`;
    patch += lines.map((line) => `${line}\n`).join("");
  }
  return patch;
}

/** Lines a review selection can land on, per side, in patch order; a side without an anchor has none. */
export function selectableLines(hunks: readonly DiffHunkData[]) {
  const result: Record<Side, Selectable[]> = { left: [], right: [] };
  hunks.forEach((hunk, index) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    bodyLines(hunk).forEach((line, row) => {
      const marker = line[0];
      if (marker === " " || marker === "-") {
        if (hunk.leftAnchor)
          result.left.push({ side: "left", line: oldLine, hunk: index, row });
        oldLine++;
      }
      if (marker === " " || marker === "+") {
        if (hunk.rightAnchor)
          result.right.push({ side: "right", line: newLine, hunk: index, row });
        newLine++;
      }
    });
  });
  return result;
}

const changeSetFolder: Partial<Record<string, string>> = {
  staged: "Staged",
  unstaged: "Unstaged",
};

/**
 * The file tree identifies rows by path, so an entry gains a repository folder when the comparison
 * spans repositories and a change-set folder when one path is both staged and unstaged. Any path
 * still repeated gets a numbered suffix, so every entry keeps its own row.
 */
export function treePaths(
  entries: ReadonlyArray<Pick<Entry, "path" | "repositoryId" | "changeSet">>,
  repositoryName: (id: string) => string,
) {
  const repositories = new Set(entries.map((entry) => entry.repositoryId));
  const keys = entries.map(
    (entry) => `${entry.repositoryId}\u0000${entry.path}`,
  );
  const repeated = new Set(keys).size < keys.length;
  const used = new Set<string>();
  return entries.map((entry) => {
    const parts: string[] = [];
    if (repositories.size > 1)
      parts.push(
        entry.repositoryId ? repositoryName(entry.repositoryId) : "Workspace",
      );
    const folder =
      repeated && entry.changeSet && changeSetFolder[entry.changeSet];
    if (folder) parts.push(folder);
    parts.push(entry.path);
    let path = parts.join("/");
    for (let copy = 2; used.has(path); copy++)
      path = `${parts.join("/")} (${copy})`;
    used.add(path);
    return path;
  });
}
