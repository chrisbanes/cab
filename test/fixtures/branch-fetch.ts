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
 * and imports it as the real fetch does. Every request is recorded in `requests`.
 */
export function localBranchFetch(remote: string) {
  const requests: FetchBranchRequest[] = [];
  const fetchBranch: FetchBranchFunction = async (request) => {
    requests.push(request);
    let branch = request.branch;
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
