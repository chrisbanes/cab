export const archivedProjectNotice =
  "This project is archived. Tasks and history are read-only. Restore keeps it paused.";
export const projectDeletionWarning =
  "Delete permanently removes this project's tasks, configuration and history, and force-discards current captured worktree contents, including dirty, untracked and unpushed work. There is no undo.";
export const projectExternalRetention =
  "Source checkouts, local and remote branches, PRs, tracker items and retained conversation archive files are kept. Cleanup can remain pending after deletion.";

export function retainedProjectLine(row: {
  codeHost: string;
  repositoryId: string | null;
  branch: string | null;
  changeRequestId: string | null;
}): string {
  return `Retained ${row.codeHost}: ${row.repositoryId ?? "repository unavailable"}; branch ${row.branch ?? "unavailable"}; PR ${row.changeRequestId ?? "none"}.`;
}
