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
  // Replace refs and grafts live in the agent-writable repository and could fake ancestry that the
  // push (which reads neither) would not send; these overrides only harden, never allow a transport.
  const git = (args: string[]) =>
    runGit({
      args: ["--no-replace-objects", "-c", "core.fsmonitor=false", ...args],
      cwd: workspacePath,
      ...bounds,
      environmentOverrides: {
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_GRAFT_FILE: "/dev/null",
      },
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
  // A last push Git cannot place (for example a missing object) is not a fast-forward.
  const descendsFromLastPushed =
    lastPushedSha === null
      ? null
      : (await ancestor(lastPushedSha, commitSha)) === true;
  const status = await git(["status", "--porcelain=v1", "-z"]);
  if (status.status !== "ok") return null;
  return {
    workspacePath,
    uncommittedEntries: status.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean).length,
    descendsFromLastPushed,
  };
}
