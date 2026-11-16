import type { TaskRead } from "../../src/operator/contracts.js";
import {
  removalEvidenceText,
  removalRecordText,
  trimRecordText,
} from "../../src/operator/workspace-maintenance-copy.js";

type Data = TaskRead["data"];

/** A record's local date and time: removal and trim records can be days old. */
const recordTime = (at: number) =>
  new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** The Remove workspace confirmation: exactly what goes and what stays. */
export const workspaceRemovalCopy = {
  trigger: "Remove workspace…",
  title: (task: string) => `Remove the workspace of ${task}?`,
  goes: [
    "Each repository's worktree, with its ignored files such as dependencies and build output",
    "The scratch directory",
    "Other files at the workspace root",
    "The workspace's Claude temporary directory",
  ],
  stays: [
    "The task branch at its pushed commit in each repository",
    "Change requests",
    "Results, readable from their commits",
    "Conversations and task records",
  ],
  irreversible:
    "Removal cannot be undone. cab checks again before deleting anything and refuses if work could be lost. A later turn gets a new workspace.",
  confirm: "Remove workspace",
  sending: "Removing…",
  recorded:
    "Workspace removed. The task branch, results and conversations remain.",
  conflict: "Not removed: the task or its workspace changed since it was read.",
  stale:
    "This confirmation was for an earlier workspace. Close it and review the current one.",
} as const;

/**
 * Whether Remove workspace… is offered: a done or cancelled task whose current workspace is
 * not already removed. The service still derives every safety check after confirmation.
 */
export function workspaceRemovalOffered(data: Data): boolean {
  const workspace = data.workspace;
  return (
    (data.task.state === "done" || data.task.state === "cancelled") &&
    !!workspace?.workspaceId &&
    workspace.state !== "removed" &&
    workspace.state !== "removing"
  );
}

/** The task's latest removal (with each repository's evidence) and latest trim, newest records first. */
export function workspaceRecordRows(
  data: Data,
  clock: (at: number) => string = recordTime,
): { text: string; evidence: string[] }[] {
  const records = data.workspace;
  if (!records) return [];
  const names = new Map(
    (data.repositoryNames ?? []).map((r) => [r.repositoryId, r.name]),
  );
  return [
    ...(records.removal
      ? [
          {
            text: removalRecordText(records.removal, clock(records.removal.at)),
            evidence: records.removal.repositories.map((r) =>
              removalEvidenceText(
                r,
                names.get(r.repositoryId) ?? r.repositoryId,
              ),
            ),
          },
        ]
      : []),
    ...(records.trim
      ? [
          {
            text: trimRecordText(records.trim, clock(records.trim.at)),
            evidence: [],
          },
        ]
      : []),
  ];
}
