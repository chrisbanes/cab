import { runGit } from "./git-process.js";
import type { PushVerification } from "./github-delivery.js";

/** The repository's task worktree and the commit its configured base ref resolved to at provisioning. */
export interface PushWorkspace {
  workspacePath: string;
  baseCommit: string | null;
}

const bounds = {
  timeoutMs: 30_000,
  terminationGraceMs: 2_000,
  observationMs: 2_000,
  maxOutputBytes: 1024 * 1024,
};

/**
 * Offline (no transport) proof that `commitSha` is the task's own work: reachable from the worktree's
 * `HEAD` and descended from the base commit the workspace was provisioned at. Null when it is not, or
 * when Git cannot say. Uncommitted entries are only counted; they are never pushed.
 */
export async function verifyTaskPush(
  workspace: PushWorkspace,
  commitSha: string,
  lastPushedSha: string | null,
  signal?: AbortSignal,
): Promise<PushVerification | null> {
  const { workspacePath, baseCommit } = workspace;
  const git = (args: string[]) =>
    runGit({
      args,
      cwd: workspacePath,
      ...bounds,
      ...(signal ? { signal } : {}),
    });
  // Exit 0 is yes and 1 is no; anything else (including a missing object) proves nothing.
  const ancestor = async (older: string, newer: string) => {
    const result = await git(["merge-base", "--is-ancestor", older, newer]);
    return result.status === "ok"
      ? true
      : result.status === "exit" && result.exitCode === 1
        ? false
        : null;
  };
  if (!/^[0-9a-f]{40}$/.test(commitSha) || !baseCommit) return null;
  if ((await ancestor(commitSha, "HEAD")) !== true) return null;
  if ((await ancestor(baseCommit, commitSha)) !== true) return null;
  const descendsFromLastPushed =
    lastPushedSha === null ? null : await ancestor(lastPushedSha, commitSha);
  const status = await git(["status", "--porcelain=v1", "-z"]);
  if (status.status !== "ok") return null;
  return {
    workspacePath,
    uncommittedEntries: status.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean).length,
    // A last push Git cannot place (for example a missing object) is not a fast-forward.
    descendsFromLastPushed:
      descendsFromLastPushed === null && lastPushedSha !== null
        ? false
        : descendsFromLastPushed,
  };
}
