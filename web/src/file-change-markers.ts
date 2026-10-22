import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";

export type FileChange =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "type-changed";

/** The one letter shown beside a changed file, and the word a screen reader gets. */
export const changeLetter: Record<FileChange, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  "type-changed": "T",
};

export const changeWord: Record<FileChange, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  "type-changed": "type changed",
};

export type ChangeMarkers = {
  /** Changed files directly in this directory, by name. */
  files: Map<string, FileChange>;
  /** Directories in this one whose subtree holds a changed path. */
  directories: Set<string>;
  /** Deleted names in this directory that no longer list: files, or a folder emptied by deletion. */
  deleted: Array<{ name: string; directory: boolean }>;
  /** The comparison stopped at its entry bound, so some changes may not be marked. */
  truncated: boolean;
  observedAt: number;
  baseBranch: string | undefined;
};

/**
 * Markers for one directory of `repositoryId` from a Branch comparison the Changes tab already
 * read. Null when that read cannot be used: it is not a complete Branch comparison of this
 * repository, so no marker is claimed.
 */
export function changeMarkers(
  read: WorkspaceComparisonRead["data"] | undefined,
  repositoryId: string,
  path: readonly string[],
): ChangeMarkers | null {
  if (read?.state !== "available" || read.target !== "branch") return null;
  const snapshot = read.comparison;
  if (
    snapshot.state !== "available" ||
    snapshot.target !== "branch" ||
    snapshot.repositoryId !== repositoryId
  )
    return null;
  const markers: ChangeMarkers = {
    files: new Map(),
    directories: new Set(),
    deleted: [],
    truncated: snapshot.truncated,
    observedAt: snapshot.observedAt,
    baseBranch: snapshot.baseline?.branch ?? snapshot.baseBranch,
  };
  for (const entry of snapshot.entries) {
    const segments = entry.path.split("/");
    if (
      segments.length <= path.length ||
      path.some((part, index) => segments[index] !== part)
    )
      continue;
    const name = segments[path.length] as string;
    const direct = segments.length === path.length + 1;
    if (direct) {
      if (entry.change === "deleted")
        markers.deleted.push({ name, directory: false });
      else markers.files.set(name, entry.change);
    } else {
      markers.directories.add(name);
      if (
        entry.change === "deleted" &&
        !markers.deleted.some((item) => item.name === name)
      )
        markers.deleted.push({ name, directory: true });
    }
  }
  return markers;
}

/**
 * The totals the Changes rail heading shows. Line counts follow the diff view's rule (every `+` and
 * `-` line of every hunk) and appear only when the comparison is complete: a truncated one, one that
 * is not `available`, or one with a gap or unsupported entry shows the file count alone, so a partial
 * total never reads as whole.
 */
export function changeLineCounts(comparison: {
  state: "available" | "unavailable" | "gap";
  truncated: boolean;
  entries: ReadonlyArray<{
    state: "text" | "binary" | "unsupported" | "gap";
    hunks: ReadonlyArray<{ patch: string }>;
  }>;
}): { files: number; added?: number; removed?: number } {
  const { entries } = comparison;
  const files = entries.length;
  if (
    comparison.truncated ||
    comparison.state !== "available" ||
    entries.some(
      (entry) => entry.state === "gap" || entry.state === "unsupported",
    )
  )
    return { files };
  let added = 0;
  let removed = 0;
  for (const entry of entries)
    for (const hunk of entry.hunks)
      for (const line of hunk.patch.split("\n")) {
        if (line.startsWith("@@") || line.startsWith("\\ No newline")) continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
  return { files, added, removed };
}
