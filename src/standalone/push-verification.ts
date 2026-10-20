import { createHash } from "node:crypto";
import { runGit } from "./git-process.js";
import type { PushVerification } from "./github-delivery.js";
import { parseFilterDriverNames } from "./workspace-comparison.js";

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
/** Commits walked per ancestry proof; a longer history is unproved, never assumed. */
const maxWalkedCommits = 5_000;
const maxCommitObjectBytes = 64 * 1024 * 1024;
const oid = /^[0-9a-f]{40}$/;

export type Git = (
  args: string[],
  options?: { input?: Buffer; maxOutputBytes?: number },
) => ReturnType<typeof runGit>;

/**
 * Whether `older` is an ancestor of `newer` (or equal), proved from the commit objects themselves:
 * every commit on the walk is read raw and rehashed, so a forged commit-graph, a replace ref, a graft
 * or a loose object that lies about its content cannot manufacture ancestry. True or false is a proof;
 * null is "could not prove" (a missing or forged object, a failed command or a history beyond the bound).
 */
export async function provedAncestor(
  git: Git,
  older: string,
  newer: string,
): Promise<boolean | null> {
  if (!oid.test(older) || !oid.test(newer)) return null;
  const listed = await git([
    "rev-list",
    "--parents",
    `--max-count=${maxWalkedCommits + 1}`,
    newer,
    `^${older}`,
  ]);
  if (listed.status !== "ok") return null;
  const lines = listed.stdout.toString("utf8").split("\n").filter(Boolean);
  if (lines.length > maxWalkedCommits) return null;
  const ids = new Set<string>([older, newer]);
  for (const line of lines)
    for (const id of line.split(" ")) {
      if (!oid.test(id)) return null;
      ids.add(id);
    }
  const read = await git(["cat-file", "--batch"], {
    input: Buffer.from(`${[...ids].join("\n")}\n`),
    maxOutputBytes: maxCommitObjectBytes,
  });
  if (read.status !== "ok") return null;
  // Parents of each commit, keyed by the id its raw content hashes to.
  const parents = new Map<string, string[]>();
  const out = read.stdout;
  let at = 0;
  while (at < out.length) {
    const newline = out.indexOf(0x0a, at);
    if (newline < 0) return null;
    const [id, type, sizeText] = out.toString("utf8", at, newline).split(" ");
    const size = Number(sizeText);
    if (!id || type !== "commit" || !Number.isInteger(size) || size < 0)
      return null;
    const body = out.subarray(newline + 1, newline + 1 + size);
    if (body.length !== size) return null;
    const hash = createHash("sha1")
      .update(`commit ${size}\0`)
      .update(body)
      .digest("hex");
    if (hash !== id) return null;
    const header = body.toString("utf8").split("\n\n", 1)[0] ?? "";
    parents.set(
      id,
      header
        .split("\n")
        .filter((l) => l.startsWith("parent "))
        .map((l) => l.slice(7)),
    );
    at = newline + 1 + size + 1;
  }
  if (!parents.has(older) || !parents.has(newer)) return null;
  const seen = new Set<string>();
  const queue = [newer];
  while (queue.length) {
    const next = queue.pop() as string;
    if (next === older) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const parent of parents.get(next) ?? []) queue.push(parent);
  }
  return false;
}

/** Git for the verifier: object reads hardened against everything the agent can write in the repository. */
export function verifierGit(workspacePath: string, signal?: AbortSignal): Git {
  // Replace refs, grafts and the commit-graph live in the agent-writable repository and could fake
  // ancestry that the push (which reads none of them) would not send; these overrides only harden
  // object reads, never allow a transport.
  return (args, options) =>
    runGit({
      args: [
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.commitGraph=false",
        ...args,
      ],
      cwd: workspacePath,
      ...bounds,
      ...(options?.maxOutputBytes
        ? { maxOutputBytes: options.maxOutputBytes }
        : {}),
      ...(options?.input ? { input: options.input } : {}),
      environmentOverrides: {
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_GRAFT_FILE: "/dev/null",
      },
      ...(signal ? { signal } : {}),
    });
}

/**
 * Offline (no transport) proof that `commitSha` is the task's own work: reachable from the worktree's
 * `HEAD` and descended from the base commit the workspace was provisioned at, with every ancestry proved
 * from hash-verified commit objects. Null when it is not, or when Git cannot say. Uncommitted entries are
 * only counted; they are never pushed.
 */
export async function verifyTaskPush(
  workspace: PushWorkspace,
  commitSha: string,
  lastPushedSha: string | null,
  signal?: AbortSignal,
): Promise<PushVerification | null> {
  const { workspacePath, baseCommit } = workspace;
  const git = verifierGit(workspacePath, signal);
  if (!oid.test(commitSha) || !baseCommit) return null;
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (head.status !== "ok") return null;
  const headSha = head.stdout.toString("utf8").trim();
  if ((await provedAncestor(git, commitSha, headSha)) !== true) return null;
  if ((await provedAncestor(git, baseCommit, commitSha)) !== true) return null;
  // A last push Git cannot place (for example a missing object) is not a fast-forward.
  const descendsFromLastPushed =
    lastPushedSha === null
      ? null
      : (await provedAncestor(git, lastPushedSha, commitSha)) === true;
  const uncommitted = await countUncommitted(git);
  if (uncommitted === null) return null;
  return {
    workspacePath,
    uncommittedEntries: uncommitted,
    descendsFromLastPushed,
  };
}

/** `git status` with every configured clean/process filter driver neutralised, as workspace comparison does. */
async function countUncommitted(git: Git): Promise<number | null> {
  const drivers = async () => {
    const read = await git([
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process)$",
    ]);
    // Exit 1 is "no such key": no drivers.
    if (read.status === "exit" && read.exitCode === 1) return [];
    if (read.status !== "ok") return null;
    const parsed = parseFilterDriverNames(read.stdout);
    return parsed.ok ? parsed.drivers : null;
  };
  const before = await drivers();
  if (!before) return null;
  const overrides = before.flatMap((driver) => [
    "-c",
    `filter.${driver}.clean=`,
    "-c",
    `filter.${driver}.process=`,
    "-c",
    `filter.${driver}.required=false`,
  ]);
  const status = await git([...overrides, "status", "--porcelain=v1", "-z"]);
  if (status.status !== "ok") return null;
  // A driver that appeared while status ran could have run unneutralised.
  const after = await drivers();
  if (!after || JSON.stringify(after) !== JSON.stringify(before)) return null;
  return status.stdout.toString("utf8").split("\0").filter(Boolean).length;
}
