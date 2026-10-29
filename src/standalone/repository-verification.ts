import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type ExpectedOrigin,
  type LinkedRepository,
  parseGitHubOrigin,
  parseGitLabOrigin,
  RepositoryVerificationError,
  type RepositoryVerifier,
} from "../core/github-source.js";
import { runGit } from "./git-process.js";

/** Trimmed stdout of one bounded Git call, or null when it did not exit 0. */
async function gitOutput(args: string[], timeoutMs: number) {
  const result = await runGit({
    args,
    timeoutMs,
    terminationGraceMs: 100,
    observationMs: 500,
    maxOutputBytes: 1024 * 1024,
  });
  return result.status === "ok" ? result.stdout.toString("utf8").trim() : null;
}

async function originUrl(path: string, timeout: number) {
  const url = await gitOutput(
    ["-C", path, "remote", "get-url", "origin"],
    timeout,
  );
  if (url === null) throw new RepositoryVerificationError("origin-missing");
  return url;
}

/** The `owner/name` of a checkout's origin, or the verification reason it fails with. */
export async function checkoutOrigin(
  path: string,
  timeout = 5000,
): Promise<{ owner: string; name: string }> {
  const origin = parseGitHubOrigin(await originUrl(path, timeout));
  if (!origin) throw new RepositoryVerificationError("origin-provider");
  return origin;
}

async function assertOrigin(path: string, expected: ExpectedOrigin) {
  if ("owner" in expected) {
    const actual = await checkoutOrigin(path);
    if (
      actual.owner.toLowerCase() !== expected.owner.toLowerCase() ||
      actual.name.toLowerCase() !== expected.name.toLowerCase()
    )
      throw new RepositoryVerificationError(
        "origin-mismatch",
        `${actual.owner}/${actual.name}`,
      );
    return;
  }
  const actual = parseGitLabOrigin(await originUrl(path, 5000), expected.host);
  if (actual === null) throw new RepositoryVerificationError("origin-provider");
  if (actual.toLowerCase() !== expected.projectPath.toLowerCase())
    throw new RepositoryVerificationError("origin-mismatch", actual);
}

/**
 * Verify a local checkout. With `expectedOrigin`, its `origin` remote must be that
 * `github.com` repository, or that GitLab host and full project path (case-insensitive). Failures are `RepositoryVerificationError`s.
 */
export const verifiedRepository: RepositoryVerifier = async (
  input,
  expectedOrigin,
): Promise<LinkedRepository> => {
  if (!isAbsolute(input.path))
    throw new RepositoryVerificationError("path-invalid");
  let path: string;
  try {
    path = await realpath(input.path);
  } catch {
    throw new RepositoryVerificationError("path-invalid");
  }
  const common = await gitOutput(
    ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    5000,
  );
  if (common === null) throw new RepositoryVerificationError("not-checkout");
  if (expectedOrigin) await assertOrigin(path, expectedOrigin);
  const ref = await gitOutput(
    // Setup requires the ref to name a commit; configured links keep their check.
    [
      "-C",
      path,
      "rev-parse",
      "--verify",
      expectedOrigin ? `${input.ref}^{commit}` : input.ref,
    ],
    5000,
  );
  if (ref === null || !/^[0-9a-f]{40,64}$/.test(ref))
    throw new RepositoryVerificationError("ref-unavailable");
  return { ...input, path, gitCommonDirectory: await realpath(common) };
};
