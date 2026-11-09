import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useRef, type CSSProperties } from "react";
import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";
import { entryLineCounts, type FileChange } from "./file-change-markers.js";

type Snapshot = Extract<
  WorkspaceComparisonRead["data"],
  { state: "available" }
>["comparison"];
type Entry = Snapshot["entries"][number];

const gitStatus: Record<FileChange, GitStatus> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  "type-changed": "modified",
};
/** The changed files of one comparison. Its options are read once: remount it when they change. */
export default function ChangesTree({
  entries,
  paths,
  selectedIndex,
  listView,
  phone,
  onSelect,
}: {
  entries: readonly Entry[];
  /** One unique tree path per entry (`treePaths`); a change needs a remount. */
  paths: readonly string[];
  selectedIndex: number;
  /** Phone list view: the open entry is not shown as selected, so tapping it reopens it. */
  listView: boolean;
  /** Phones get 44px rows; read once, so remount when it changes. */
  phone: boolean;
  onSelect: (entry: Entry, index: number) => void;
}) {
  const counts = entries.map(entryLineCounts);
  const index = new Map(paths.map((path, at) => [path, at]));
  const select = useRef(onSelect);
  select.current = onSelect;
  const current = useRef(selectedIndex);
  current.current = listView ? -1 : selectedIndex;
  const selectedPath = listView ? undefined : paths[selectedIndex];
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    ...(phone ? { itemHeight: 44 } : {}),
    flattenEmptyDirectories: true,
    ...(selectedPath ? { initialSelectedPaths: [selectedPath] } : {}),
    gitStatus: entries.map((entry, at) => ({
      path: paths[at]!,
      status: gitStatus[entry.change],
    })),
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      const at = path === undefined ? undefined : index.get(path);
      // Re-choosing the open entry would clear its line selection.
      if (at !== undefined && at !== current.current)
        select.current(entries[at]!, at);
    },
    renderRowDecoration: ({ item }) => {
      const at = item.kind === "file" ? index.get(item.path) : undefined;
      if (at === undefined || entries[at]?.state !== "text") return null;
      const { added, removed } = counts[at]!;
      return {
        text: `+${added} −${removed}`,
        title: `${added} added, ${removed} removed lines`,
      };
    },
  });
  // Keep the tree's selection in step when the entry is chosen elsewhere.
  useEffect(() => {
    const shown = model.getSelectedPaths();
    if (selectedPath && shown.length === 1 && shown[0] === selectedPath) return;
    for (const path of shown) model.getItem(path)?.deselect();
    if (selectedPath) model.getItem(selectedPath)?.select();
  }, [model, selectedPath]);
  // Every file and folder row, so the tree has a definite height when it is not filling a panel.
  const folders = new Set(
    paths.flatMap((path) =>
      path
        .split("/")
        .slice(0, -1)
        .map((_, at, parts) => parts.slice(0, at + 1).join("/")),
    ),
  );
  return (
    <FileTree
      model={model}
      className="changes-tree"
      style={
        { "--changes-tree-rows": paths.length + folders.size } as CSSProperties
      }
      aria-label="Workspace comparison files"
    />
  );
}
