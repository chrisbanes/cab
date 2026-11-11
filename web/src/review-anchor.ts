import type {
  ReviewAnchorCandidate,
  TaskChangeSelection,
  TaskFileTabState,
} from "./task-workspace-state.js";

type LineRange = { startLine: number; endLine: number };

/** Current-file lines; the caller supplies the sha256 of the bytes it displays. */
export function workspaceFileAnchor(
  taskId: string,
  tab: Pick<TaskFileTabState, "scope" | "path">,
  range: LineRange,
  contentSha256: string,
): ReviewAnchorCandidate {
  return {
    taskId,
    repositoryId:
      tab.scope.kind === "repository" ? tab.scope.repositoryId : null,
    path: tab.path.join("/"),
    sourceKind: "workspace-file",
    context: "workspace",
    side: "file",
    ...range,
    contentSha256,
  };
}

/** Lines on one side of an observed comparison. */
export function comparisonSideAnchor(
  taskId: string,
  selection: TaskChangeSelection,
): ReviewAnchorCandidate {
  return {
    taskId,
    repositoryId: selection.repositoryId,
    path: selection.path,
    sourceKind: "comparison-side",
    context: selection.context,
    comparisonId: selection.comparisonId,
    side: selection.side,
    startLine: selection.startLine,
    endLine: selection.endLine,
    contentSha256: selection.contentSha256,
    ...(selection.workId ? { workId: selection.workId } : {}),
    ...(selection.threadId ? { threadId: selection.threadId } : {}),
    ...(selection.turnId ? { turnId: selection.turnId } : {}),
  };
}
