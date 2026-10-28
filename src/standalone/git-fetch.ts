import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeBranchName } from "../core/delivery.js";
import { pushCredentialHelper } from "./git-push.js";
import { runGit } from "./git-process.js";
import { type Git, provedAncestor } from "./push-verification.js";

export type AdoptOutcome =
  /** The outside head was fetched, proved to descend from the base, and imported under an Ensemble-owned ref. */
  | "adopted"
  /** Nothing reached the network (invalid request or setup failed). */
  | "not-attempted"
  /** The fetch failed, timed out or was cancelled. Nothing was imported. */
  | "fetch-failed"
  /** The fetched head is provably not built on the task's provisioned base. */
  | "not-on-base"
  /** Git could not prove the head's ancestry, or could not import it. */
  | "unproved";

export interface AdoptRequest {
  /** The task worktree; only its object store and Ensemble's own ref namespace are touched. */
  workspacePath: string;
  /** The commit the worktree was provisioned at; the outside head must descend from it. */
  baseCommit: string | null;
  /** `owner/name` of the verified github.com repository. */
  nameWithOwner: string;
  commitSha: string;
  branch: string;
  token: string;
  signal?: AbortSignal;
  /** Test-only override of the Git executable. */
  executable?: string;
}
export type AdoptFunction = (request: AdoptRequest) => Promise<AdoptOutcome>;

const repositoryPath = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const oid = /^[0-9a-f]{40}$/;
const bounds = {
  timeoutMs: 120_000,
  terminationGraceMs: 5_000,
  observationMs: 5_000,
  maxOutputBytes: 64 * 1024,
};
const proofBounds = {
  timeoutMs: 30_000,
  terminationGraceMs: 2_000,
  observationMs: 2_000,
  maxOutputBytes: 1024 * 1024,
};

/**
 * Fetches one commit by its sha from the verified github.com repository over HTTPS, proves it descends
 * from the task's base, and imports its objects into the task worktree under
 * `refs/ensemble/adopted/<branch>`, and nothing else.
 *
 * The fetch runs in a scratch repository that reads the worktree's objects through an alternate, as
 * the push does, so no repository-local or user configuration applies and Git never runs in the
 * agent-writable repository while the token exists. The token exists only in the fetch child's
 * environment (and its credential helper's). The ancestry proof reads the scratch repository's hashed
 * objects. The worktree's `HEAD`, index, local commits and files are never touched.
 */
export async function adoptOutsideHead(
  request: AdoptRequest,
): Promise<AdoptOutcome> {
  const { workspacePath, baseCommit, nameWithOwner, commitSha, branch, token } =
    request;
  if (
    !token ||
    !baseCommit ||
    !oid.test(baseCommit) ||
    !repositoryPath.test(nameWithOwner) ||
    !oid.test(commitSha) ||
    !safeBranchName(branch)
  )
    return "not-attempted";
  const common = {
    ...(request.executable ? { executable: request.executable } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
  const located = await runGit({
    ...common,
    ...bounds,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd: workspacePath,
    maxOutputBytes: 4096,
    timeoutMs: 30_000,
  });
  if (located.status !== "ok") return "not-attempted";
  const commonDir = located.stdout.toString("utf8").trim();
  const objects = join(commonDir, "objects");
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), "ensemble-adopt-"));
    const dir = scratch;
    await mkdir(join(dir, "objects"));
    await mkdir(join(dir, "refs", "ensemble"), { recursive: true });
    await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dir, "config"), "");
    // The base is a negotiation "have", so only what the worktree lacks is sent.
    await writeFile(join(dir, "refs", "ensemble", "base"), `${baseCommit}\n`);
    const scratchEnvironment = {
      GIT_DIR: dir,
      // Quoted as in git-push.ts: Git splits an unquoted value on `:`.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_GRAFT_FILE: "/dev/null",
      HOME: dir,
    };
    const fetched = await runGit({
      ...common,
      ...bounds,
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
        "-c",
        "http.proxy=",
        // Git never spawns a command in the agent-writable alternate to list its refs.
        "-c",
        "core.alternateRefsCommand=true",
        "-c",
        "transfer.fsckObjects=true",
        // Keep the objects as one pack, which is what is imported.
        "-c",
        "fetch.unpackLimit=1",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        `https://github.com/${nameWithOwner}.git`,
        `+${commitSha}:refs/ensemble/adopt`,
      ],
      cwd: dir,
      environmentOverrides: {
        ...scratchEnvironment,
        GIT_ALLOW_PROTOCOL: "https",
        ENSEMBLE_PUSH_PATH: `${nameWithOwner}.git`,
        ENSEMBLE_PUSH_TOKEN: token,
      },
    });
    if (fetched.status === "interrupted" && !fetched.spawned)
      return "not-attempted";
    if (fetched.status !== "ok") return "fetch-failed";

    // The proof reads only the scratch (with the worktree's objects as an alternate), with no
    // transport and no credential; every commit on the walk is rehashed.
    const scratchGit: Git = (args, options) =>
      runGit({
        ...common,
        ...proofBounds,
        args: ["-c", "core.commitGraph=false", ...args],
        cwd: dir,
        ...(options?.maxOutputBytes
          ? { maxOutputBytes: options.maxOutputBytes }
          : {}),
        ...(options?.input ? { input: options.input } : {}),
        environmentOverrides: scratchEnvironment,
      });
    const onBase = await provedAncestor(scratchGit, baseCommit, commitSha);
    if (onBase === false) return "not-on-base";
    if (onBase !== true) return "unproved";

    // Packs go in whole and atomically (copied aside, then renamed), `.pack` before the `.idx` that
    // makes Git find it, so a crash or a concurrent Git never sees half a file. Same name, same content.
    const packs = join(dir, "objects", "pack");
    // A head the worktree already has fetches nothing, and needs no import.
    const names = (await readdir(packs).catch(() => [])).filter(
      (n) => n.endsWith(".pack") || n.endsWith(".idx"),
    );
    const target = join(objects, "pack");
    await mkdir(target, { recursive: true });
    for (const extension of [".pack", ".idx"])
      for (const name of names.filter((n) => n.endsWith(extension))) {
        // A unique aside name: a leftover read-only file or a concurrent import never collides.
        const aside = join(target, `tmp_ensemble_${randomUUID()}_${name}`);
        try {
          await copyFile(join(packs, name), aside);
          await rename(aside, join(target, name));
        } catch (error) {
          await rm(aside, { force: true });
          throw error;
        }
      }
    // A ref keeps the imported objects from being pruned. Git runs without the worktree's hooks and
    // without a credential.
    const kept = await runGit({
      ...common,
      ...proofBounds,
      args: [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "update-ref",
        `refs/ensemble/adopted/${branch}`,
        commitSha,
      ],
      cwd: workspacePath,
    });
    return kept.status === "ok" ? "adopted" : "unproved";
  } catch {
    return "unproved";
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
