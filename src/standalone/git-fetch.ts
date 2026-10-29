import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeBranchName } from "../core/delivery.js";
import {
  type TransportCodeHost,
  hostName,
  pushCredentialHelper,
  transportUsername,
} from "./git-push.js";
import { runGit } from "./git-process.js";
import { type Git, provedAncestor } from "./push-verification.js";

export type AdoptOutcome =
  /** The outside head was fetched, proved to descend from the base, and imported under a cab-owned ref. */
  | "adopted"
  /** Nothing reached the network (invalid request or setup failed). */
  | "not-attempted"
  /** The fetch failed, timed out or was cancelled. Nothing was imported. */
  | "fetch-failed"
  /** The fetch wrote more than the size bound to the scratch object store. It was stopped and nothing was imported. */
  | "too-large"
  /** The fetched head is provably not built on the task's provisioned base. */
  | "not-on-base"
  /** Git could not prove the head's ancestry, or could not import it. */
  | "unproved";

export interface AdoptRequest {
  /** The task worktree; only its object store and cab's own ref namespace are touched. */
  workspacePath: string;
  /** The commit the worktree was provisioned at; the outside head must descend from it. */
  baseCommit: string | null;
  /** The code host's lowercase DNS name, from the repository link. */
  host: string;
  /** The code host of `host`; GitHub when omitted. */
  codeHost?: TransportCodeHost;
  /** `owner/name` of the verified repository on `host`; the full project path on GitLab. */
  nameWithOwner: string;
  commitSha: string;
  branch: string;
  token: string;
  signal?: AbortSignal;
  /** Test-only override of the Git executable. */
  executable?: string;
  /** Test-only override of the size bound. */
  maxFetchBytes?: number;
}
export type AdoptFunction = (request: AdoptRequest) => Promise<AdoptOutcome>;

const oid = /^[0-9a-f]{40}$/;
const bounds = {
  timeoutMs: 120_000,
  terminationGraceMs: 5_000,
  observationMs: 5_000,
  maxOutputBytes: 64 * 1024,
};
// The fetch has no size limit of its own, so the parent measures what the child has written.
const defaultMaxFetchBytes = 512 * 1024 * 1024;
const sizeCheckMs = 200;
const proofBounds = {
  timeoutMs: 30_000,
  terminationGraceMs: 2_000,
  observationMs: 2_000,
  maxOutputBytes: 1024 * 1024,
};

/** Total bytes of the files under `dir`; files that vanish mid-walk count as zero. */
async function storedBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const size = await stat(join(entry.parentPath, entry.name)).then(
      (s) => s.size,
      () => 0,
    );
    total += size;
  }
  return total;
}

/**
 * Fetches one commit by its sha from the verified repository on the requested host over HTTPS, proves it descends
 * from the task's base, and imports its objects into the task worktree under
 * `refs/cab/adopted/<branch>`, and nothing else.
 *
 * The fetch runs in a scratch repository that reads the worktree's objects through an alternate, as
 * the push does, so no repository-local or user configuration applies and Git never runs in the
 * agent-writable repository while the token exists. The token exists only in the fetch child's
 * environment (and its credential helper's). The ancestry proof reads the scratch repository's hashed
 * objects. The worktree's `HEAD`, index, local commits and files are never touched.
 *
 * The fetch is bounded in size as well as time: while it runs, the bytes in the scratch object store
 * are polled and the child is stopped once they pass 512 MiB (approximately: by about one poll
 * interval of transfer), and the adoption is refused as `too-large`.
 */
export async function adoptOutsideHead(
  request: AdoptRequest,
): Promise<AdoptOutcome> {
  const {
    workspacePath,
    baseCommit,
    host,
    nameWithOwner,
    commitSha,
    branch,
    token,
  } = request;
  const username = transportUsername(request.codeHost, nameWithOwner);
  if (
    !token ||
    !baseCommit ||
    !oid.test(baseCommit) ||
    !hostName.test(host) ||
    !username ||
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
    scratch = await mkdtemp(join(tmpdir(), "cab-adopt-"));
    const dir = scratch;
    await mkdir(join(dir, "objects"));
    await mkdir(join(dir, "refs", "cab"), { recursive: true });
    await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dir, "config"), "");
    // The base is a negotiation "have", so only what the worktree lacks is sent.
    await writeFile(join(dir, "refs", "cab", "base"), `${baseCommit}\n`);
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
    const limit = request.maxFetchBytes ?? defaultMaxFetchBytes;
    const scratchObjects = join(dir, "objects");
    const stop = new AbortController();
    let oversize = false;
    let measuring = false;
    const watcher = setInterval(() => {
      if (measuring) return;
      measuring = true;
      storedBytes(scratchObjects)
        .then((bytes) => {
          if (bytes <= limit) return;
          oversize = true;
          stop.abort();
        })
        .catch(() => {})
        .finally(() => {
          measuring = false;
        });
    }, sizeCheckMs);
    const fetched = await runGit({
      ...common,
      ...bounds,
      signal: request.signal
        ? AbortSignal.any([request.signal, stop.signal])
        : stop.signal,
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
        `https://${host}/${nameWithOwner}.git`,
        `+${commitSha}:refs/cab/adopt`,
      ],
      cwd: dir,
      environmentOverrides: {
        ...scratchEnvironment,
        GIT_ALLOW_PROTOCOL: "https",
        CAB_PUSH_HOST: host,
        CAB_PUSH_PATH: `${nameWithOwner}.git`,
        CAB_PUSH_USERNAME: username,
        CAB_PUSH_TOKEN: token,
      },
    }).finally(() => clearInterval(watcher));
    // A fetch that finished between polls is measured once more; nothing is proved or imported.
    if (
      oversize ||
      (fetched.status === "ok" && (await storedBytes(scratchObjects)) > limit)
    )
      return "too-large";
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
        const aside = join(target, `tmp_cab_${randomUUID()}_${name}`);
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
        `refs/cab/adopted/${branch}`,
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
