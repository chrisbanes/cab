import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeBranchName } from "../core/delivery.js";
import { runGit } from "./git-process.js";

/**
 * Answers Git's credential request only for the exact repository over HTTPS on github.com, with
 * the token from the child's environment; any other host, protocol or path gets no answer.
 */
export const pushCredentialHelper = `!f() { test "$1" = get || exit 0; while IFS== read -r k v; do case "$k" in protocol) p=$v;; host) h=$v;; path) q=$v;; esac; done; test "$p" = https && test "$h" = github.com && test "$q" = "$ENSEMBLE_PUSH_PATH" || exit 0; echo username=x-access-token; echo "password=$ENSEMBLE_PUSH_TOKEN"; }; f`;

export type PushOutcome =
  /** Nothing reached the network (setup failed or the child never started). */
  | "not-attempted"
  | "pushed"
  | "rejected-non-fast-forward"
  | "rejected-lease"
  | "rejected-remote"
  /** The child timed out, was cancelled or exited unobserved, or failed in a way that says nothing. */
  | "uncertain";

export interface PushRequest {
  /** The task worktree; only its object store is read. */
  workspacePath: string;
  /** `owner/name` of the verified github.com repository. */
  nameWithOwner: string;
  commitSha: string;
  branch: string;
  /** Force-with-lease against exactly this remote commit; absent for a fast-forward push. */
  lease?: string;
  token: string;
  signal?: AbortSignal;
  /** Test-only override of the Git executable. */
  executable?: string;
}

const repositoryPath = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const bounds = {
  timeoutMs: 120_000,
  terminationGraceMs: 5_000,
  observationMs: 5_000,
  maxOutputBytes: 64 * 1024,
};

/**
 * Pushes one commit to `refs/heads/<branch>` over HTTPS with the delivery token, and nothing else.
 *
 * Git runs in a scratch repository that reads the task worktree's objects through an alternate, so
 * no repository-local or user configuration (`url.*`, `http.*`, `credential.*`, `include`, hooks)
 * applies; the only configuration is the explicit command line below. The token exists only in the
 * push child's environment (and its credential helper's), never in argv, config or files.
 */
export async function pushTaskCommit(
  request: PushRequest,
): Promise<PushOutcome> {
  const { workspacePath, nameWithOwner, commitSha, branch, lease, token } =
    request;
  if (
    !token ||
    !repositoryPath.test(nameWithOwner) ||
    !/^[0-9a-f]{40}$/.test(commitSha) ||
    (lease !== undefined && !/^[0-9a-f]{40}$/.test(lease)) ||
    !safeBranchName(branch)
  )
    return "not-attempted";
  const common = {
    ...(request.executable ? { executable: request.executable } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...bounds,
  };
  const located = await runGit({
    ...common,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd: workspacePath,
    maxOutputBytes: 4096,
    timeoutMs: 30_000,
  });
  if (located.status !== "ok") return "not-attempted";
  const objects = join(located.stdout.toString("utf8").trim(), "objects");
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), "ensemble-push-"));
    await mkdir(join(scratch, "objects"));
    await mkdir(join(scratch, "refs"));
    await writeFile(join(scratch, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(scratch, "config"), "");
    const result = await runGit({
      ...common,
      args: [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${pushCredentialHelper}`,
        "-c",
        "credential.useHttpPath=true",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.followRedirects=false",
        "push",
        "--porcelain",
        "--no-verify",
        ...(lease === undefined
          ? []
          : [`--force-with-lease=refs/heads/${branch}:${lease}`]),
        `https://github.com/${nameWithOwner}.git`,
        `${commitSha}:refs/heads/${branch}`,
      ],
      cwd: scratch,
      environmentOverrides: {
        GIT_DIR: scratch,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "https",
        HOME: scratch,
        ENSEMBLE_PUSH_PATH: `${nameWithOwner}.git`,
        ENSEMBLE_PUSH_TOKEN: token,
      },
    });
    if (result.status === "ok") return "pushed";
    if (result.status === "interrupted")
      return result.spawned ? "uncertain" : "not-attempted";
    if (!result.childExitObserved) return "uncertain";
    // `--porcelain` reports each ref's outcome on stdout; stderr is not captured.
    const report = result.stdout.toString("utf8");
    if (/\(stale info\)/.test(report)) return "rejected-lease";
    if (/\[remote rejected\]/.test(report)) return "rejected-remote";
    if (/\[rejected\]/.test(report)) return "rejected-non-fast-forward";
    return "uncertain";
  } catch {
    return "not-attempted";
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
