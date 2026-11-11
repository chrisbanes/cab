import { execFileSync } from "node:child_process";
import type {
  FetchBranchFunction,
  FetchBranchRequest,
} from "../../src/standalone/git-fetch.js";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/**
 * A `FetchBranchFunction` that reads the branch from a local repository in place of the code host
 * and imports it as the real fetch does. A branch the fake code host received by push resolves
 * through `pushed` to that commit, whose objects the workspace repository already has. Every
 * request is recorded in `requests`.
 */
export function localBranchFetch(
  remote: string,
  pushed: (branch: string) => string | undefined = () => undefined,
) {
  const requests: FetchBranchRequest[] = [];
  const fetchBranch: FetchBranchFunction = async (request) => {
    requests.push(request);
    let branch = request.branch;
    const known = branch === null ? undefined : pushed(branch);
    if (branch !== null && known) return { kind: "fetched", branch, commit: known };
    let commit: string;
    try {
      branch ??= run(remote, "symbolic-ref", "--short", "HEAD");
      commit = run(remote, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    } catch {
      return { kind: "unavailable" };
    }
    if (request.retainPrefix)
      run(
        remote,
        `--git-dir=${request.commonDirectory}`,
        "fetch",
        "-q",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        `+refs/heads/${branch}:${request.retainPrefix}/${branch}`,
      );
    return { kind: "fetched", branch, commit };
  };
  return { fetchBranch, requests };
}

/**
 * For tests whose subject is not the target check: the target is reported at the proposed commit
 * itself (the request's "have"), which merges trivially without running Git.
 */
export const unchangedTargetFetch: FetchBranchFunction = async (request) => ({
  kind: "fetched",
  branch: request.branch ?? "main",
  commit: request.have ?? "",
});

/** A ready task workspace for `unchangedTargetFetch`, whose check never reads it. */
export const syntheticWorkspace = {
  workspacePath: "/synthetic/workspace",
  baseCommit: null,
  commonDirectory: "/synthetic/repository",
  managed: true,
  baseBranch: null,
};
