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
import {
  runGit,
  gitChildExited,
  type GitChildObserver,
  type GitRunOptions,
} from "./git-process.js";
import { proveUnchangedRebase } from "./rebase-proof.js";
import type { RebaseProof } from "../core/rebase-proof.js";
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

export interface FixtureGitFetchBoundary extends GitChildObserver {
  scratchParent: string;
  commonDirectory: string;
  beforeEffect(
    phase:
      | "locate"
      | "scratch"
      | "fetch"
      | "proof"
      | "import"
      | "retain"
      | "teardown",
  ): Promise<void>;
}

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
  fixtureBoundary?: FixtureGitFetchBoundary;
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
  return fetchAndProveOutsideHead(request);
}

export async function proveOutsideRebase(
  request: AdoptRequest & { oldBase: string; oldHead: string },
): Promise<RebaseProof | null> {
  if (!oid.test(request.oldBase) || !oid.test(request.oldHead)) return null;
  let proof: RebaseProof | null = null;
  const outcome = await fetchAndProveOutsideHead(
    request,
    async (git) => {
      proof = await proveUnchangedRebase(
        git,
        request.oldBase,
        request.oldHead,
        request.baseCommit!,
        request.commitSha,
        request.signal,
        request.fixtureBoundary && request.executable
          ? {
              scratchParent: request.fixtureBoundary.scratchParent,
              executable: request.executable,
              beforeEffect: (teardown) =>
                request.fixtureBoundary!.beforeEffect(
                  teardown ? "teardown" : "proof",
                ),
              children: request.fixtureBoundary,
            }
          : undefined,
      );
      return proof !== null;
    },
    request.oldBase,
  );
  return outcome === "adopted" ? proof : null;
}

type GitRun = typeof runGit;

/** The Git runner of one fetch: the fixture boundary observes each child, and an unsettled child keeps the scratch. */
function fetchRunner(request: {
  executable?: string;
  signal?: AbortSignal;
  fixtureBoundary?: FixtureGitFetchBoundary;
}) {
  const state = { unsettledChild: false };
  const boundary = request.fixtureBoundary;
  const gitRun: GitRun = boundary
    ? async (options: GitRunOptions) => {
        const sequence = await boundary.beforeChild();
        const result = await runGit({ ...options, observeSettlement: true });
        if (!gitChildExited(result)) state.unsettledChild = true;
        await boundary.afterChild(sequence, result);
        return result;
      }
    : runGit;
  const common = {
    ...(request.executable ? { executable: request.executable } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
  return { gitRun, common, state };
}

/** A scratch repository reading `objects` through an alternate, with no user or system configuration. */
async function createScratch(
  parent: string | undefined,
  prefix: string,
  objects: string,
  have: string | null,
) {
  const dir = await mkdtemp(join(parent ?? tmpdir(), prefix));
  await mkdir(join(dir, "objects"));
  await mkdir(join(dir, "refs", "cab"), { recursive: true });
  await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, "config"), "");
  // A negotiation "have", so only what the destination lacks is sent.
  if (have) await writeFile(join(dir, "refs", "cab", "base"), `${have}\n`);
  const environment = {
    GIT_DIR: dir,
    // Quoted as in git-push.ts: Git splits an unquoted value on `:`.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    HOME: dir,
  };
  return { dir, environment };
}

/** The `-c` options of every networked Git child: HTTPS only, cab's credential helper, no redirects or proxies. */
const transportOptions = [
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
];

type Transport = {
  host: string;
  nameWithOwner: string;
  username: string;
  token: string;
};
const transportEnvironment = (t: Transport) => ({
  GIT_ALLOW_PROTOCOL: "https",
  CAB_PUSH_HOST: t.host,
  CAB_PUSH_PATH: `${t.nameWithOwner}.git`,
  CAB_PUSH_USERNAME: t.username,
  CAB_PUSH_TOKEN: t.token,
});
const transportUrl = (t: Transport) =>
  `https://${t.host}/${t.nameWithOwner}.git`;

/**
 * Fetches `refspec` into the scratch, stopping the child once the scratch object store passes
 * `limit` bytes (approximately: by about one poll interval of transfer).
 */
async function boundedFetch(
  run: ReturnType<typeof fetchRunner>,
  scratch: Awaited<ReturnType<typeof createScratch>>,
  transport: Transport,
  refspec: string,
  limit: number,
  signal: AbortSignal | undefined,
  boundary: FixtureGitFetchBoundary | undefined,
): Promise<"ok" | "too-large" | "not-attempted" | "fetch-failed"> {
  const scratchObjects = join(scratch.dir, "objects");
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
  let fetched: Awaited<ReturnType<GitRun>>;
  try {
    if (boundary) await boundary.beforeEffect("fetch");
    fetched = await run.gitRun({
      ...run.common,
      ...bounds,
      signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
      args: [
        ...transportOptions,
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
        transportUrl(transport),
        refspec,
      ],
      cwd: scratch.dir,
      environmentOverrides: {
        ...scratch.environment,
        ...transportEnvironment(transport),
      },
    });
  } finally {
    clearInterval(watcher);
  }
  // A fetch that finished between polls is measured once more; nothing is proved or imported.
  if (
    oversize ||
    (fetched.status === "ok" && (await storedBytes(scratchObjects)) > limit)
  )
    return "too-large";
  if (fetched.status === "interrupted" && !fetched.spawned)
    return "not-attempted";
  return fetched.status === "ok" ? "ok" : "fetch-failed";
}

/**
 * Packs go in whole and atomically (copied aside, then renamed), `.pack` before the `.idx` that
 * makes Git find it, so a crash or a concurrent Git never sees half a file. Same name, same content.
 */
async function importPacks(
  scratchDir: string,
  objects: string,
  boundary: FixtureGitFetchBoundary | undefined,
) {
  const packs = join(scratchDir, "objects", "pack");
  // A head the destination already has fetches nothing, and needs no import.
  const names = (await readdir(packs).catch(() => [])).filter(
    (n) => n.endsWith(".pack") || n.endsWith(".idx"),
  );
  if (boundary) await boundary.beforeEffect("import");
  const target = join(objects, "pack");
  await mkdir(target, { recursive: true });
  for (const extension of [".pack", ".idx"])
    for (const name of names.filter((n) => n.endsWith(extension))) {
      // A unique aside name: a leftover read-only file or a concurrent import never collides.
      if (boundary) await boundary.beforeEffect("import");
      const aside = join(target, `tmp_cab_${randomUUID()}_${name}`);
      try {
        await copyFile(join(packs, name), aside);
        await rename(aside, join(target, name));
      } catch (error) {
        await rm(aside, { force: true });
        throw error;
      }
    }
}

/** Git reading only the scratch (with the destination's objects as an alternate), with no transport and no credential. */
const scratchGitFor =
  (
    run: ReturnType<typeof fetchRunner>,
    scratch: Awaited<ReturnType<typeof createScratch>>,
    boundary: FixtureGitFetchBoundary | undefined,
  ): Git =>
  async (args, options) => {
    if (boundary) await boundary.beforeEffect("proof");
    return run.gitRun({
      ...run.common,
      ...proofBounds,
      args: ["-c", "core.commitGraph=false", ...args],
      cwd: scratch.dir,
      ...(options?.maxOutputBytes
        ? { maxOutputBytes: options.maxOutputBytes }
        : {}),
      ...(options?.input ? { input: options.input } : {}),
      environmentOverrides: scratch.environment,
    });
  };

async function fetchAndProveOutsideHead(
  request: AdoptRequest,
  prove?: (git: Git) => Promise<boolean>,
  negotiationBase = request.baseCommit,
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
  const run = fetchRunner(request);
  if (request.fixtureBoundary)
    await request.fixtureBoundary.beforeEffect("locate");
  const located = await run.gitRun({
    ...run.common,
    ...bounds,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd: workspacePath,
    maxOutputBytes: 4096,
    timeoutMs: 30_000,
  });
  if (located.status !== "ok") return "not-attempted";
  const commonDir = located.stdout.toString("utf8").trim();
  if (
    request.fixtureBoundary &&
    commonDir !== request.fixtureBoundary.commonDirectory
  )
    throw Error("fixture-git-common-directory");
  const objects = join(commonDir, "objects");
  let scratch: Awaited<ReturnType<typeof createScratch>> | undefined;
  try {
    if (request.fixtureBoundary)
      await request.fixtureBoundary.beforeEffect("scratch");
    scratch = await createScratch(
      request.fixtureBoundary?.scratchParent,
      "cab-adopt-",
      objects,
      negotiationBase,
    );
    const fetched = await boundedFetch(
      run,
      scratch,
      { host, nameWithOwner, username, token },
      `+${commitSha}:refs/cab/adopt`,
      request.maxFetchBytes ?? defaultMaxFetchBytes,
      request.signal,
      request.fixtureBoundary,
    );
    if (fetched !== "ok") return fetched;

    // Every commit on the proof's walk is rehashed.
    const scratchGit = scratchGitFor(run, scratch, request.fixtureBoundary);
    if (request.fixtureBoundary)
      await request.fixtureBoundary.beforeEffect("proof");
    const onBase = await provedAncestor(scratchGit, baseCommit, commitSha);
    if (onBase === false) return "not-on-base";
    if (onBase !== true) return "unproved";
    if (prove && !(await prove(scratchGit))) return "unproved";

    await importPacks(scratch.dir, objects, request.fixtureBoundary);
    // A ref keeps the imported objects from being pruned. Git runs without the worktree's hooks and
    // without a credential.
    if (request.fixtureBoundary)
      await request.fixtureBoundary.beforeEffect("retain");
    const kept = await run.gitRun({
      ...run.common,
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
    if (scratch && !run.state.unsettledChild) {
      if (request.fixtureBoundary)
        await request.fixtureBoundary.beforeEffect("teardown");
      await rm(scratch.dir, { recursive: true, force: true });
    }
  }
}

export interface FetchBranchRequest {
  /**
   * The repository whose objects the fetch reads through an alternate and, when `retainPrefix` is
   * set, imports into: cab's managed repository, or a legacy binding's source, which is only read.
   */
  commonDirectory: string;
  /** The branch to fetch; null resolves the code host's default branch. */
  branch: string | null;
  /** Imports the objects and keeps `<retainPrefix>/<branch>` at the fetched commit; null imports nothing. */
  retainPrefix: "refs/cab/remote" | "refs/cab/target" | null;
  /** A commit the destination already has, sent as a negotiation "have". */
  have: string | null;
  host: string;
  codeHost?: TransportCodeHost;
  nameWithOwner: string;
  token: string;
  signal?: AbortSignal;
  /** Test-only override of the Git executable. */
  executable?: string;
  /** Test-only override of the size bound. */
  maxFetchBytes?: number;
  fixtureBoundary?: FixtureGitFetchBoundary;
}
export type FetchBranchResult =
  | { kind: "fetched"; branch: string; commit: string }
  /** The branch, or the default branch's identity, is not on the code host. */
  | { kind: "unavailable" }
  /** As `AdoptOutcome`; nothing was imported. */
  | { kind: "not-attempted" | "fetch-failed" | "too-large" | "unproved" };
/** What a caller supplies; the code host adds the verified identity and its credential. */
export type BranchFetch = Pick<
  FetchBranchRequest,
  "commonDirectory" | "branch" | "retainPrefix" | "have"
>;
export type FetchBranchFunction = (
  request: FetchBranchRequest,
) => Promise<FetchBranchResult>;

/**
 * Fetches a branch of the verified repository over HTTPS into a scratch repository, with the
 * transport isolation, bounds and credential confinement of the adopt fetch, and optionally imports
 * its objects into `commonDirectory` under `<retainPrefix>/<branch>`. The code host's default branch is read from
 * `ls-remote --symref` over the same transport. Nothing else in the destination is written.
 */
export async function fetchBranchHead(
  request: FetchBranchRequest,
): Promise<FetchBranchResult> {
  const { host, nameWithOwner, token } = request;
  const username = transportUsername(request.codeHost, nameWithOwner);
  if (
    !token ||
    !hostName.test(host) ||
    !username ||
    (request.branch !== null && !safeBranchName(request.branch)) ||
    (request.have !== null && !oid.test(request.have))
  )
    return { kind: "not-attempted" };
  const run = fetchRunner(request);
  const objects = join(request.commonDirectory, "objects");
  const transport = { host, nameWithOwner, username, token };
  let scratch: Awaited<ReturnType<typeof createScratch>> | undefined;
  try {
    if (request.fixtureBoundary)
      await request.fixtureBoundary.beforeEffect("scratch");
    scratch = await createScratch(
      request.fixtureBoundary?.scratchParent,
      "cab-fetch-",
      objects,
      null,
    );
    const scratchGit = scratchGitFor(run, scratch, request.fixtureBoundary);
    // An unknown "have" is skipped: a ref to a missing object would fail the fetch.
    if (
      request.have &&
      (await scratchGit(["cat-file", "-e", `${request.have}^{commit}`]))
        .status === "ok"
    )
      await writeFile(
        join(scratch.dir, "refs", "cab", "base"),
        `${request.have}\n`,
      );
    if (request.fixtureBoundary)
      await request.fixtureBoundary.beforeEffect("fetch");
    const listed = await run.gitRun({
      ...run.common,
      ...bounds,
      args: [
        ...transportOptions,
        "ls-remote",
        ...(request.branch === null ? ["--symref"] : []),
        transportUrl(transport),
        request.branch === null ? "HEAD" : `refs/heads/${request.branch}`,
      ],
      cwd: scratch.dir,
      environmentOverrides: {
        ...scratch.environment,
        ...transportEnvironment(transport),
      },
    });
    if (listed.status === "interrupted" && !listed.spawned)
      return { kind: "not-attempted" };
    if (listed.status !== "ok") return { kind: "fetch-failed" };
    const lines = listed.stdout.toString("utf8").split("\n");
    const branch =
      request.branch ??
      lines
        .map((line) => /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line)?.[1])
        .find((name) => name !== undefined) ??
      null;
    if (
      branch === null ||
      !safeBranchName(branch) ||
      (request.branch !== null &&
        !lines.some((line) => line.endsWith(`\trefs/heads/${branch}`)))
    )
      return { kind: "unavailable" };
    const fetched = await boundedFetch(
      run,
      scratch,
      transport,
      `+refs/heads/${branch}:refs/cab/fetch`,
      request.maxFetchBytes ?? defaultMaxFetchBytes,
      request.signal,
      request.fixtureBoundary,
    );
    if (fetched !== "ok") return { kind: fetched };
    const resolved = await scratchGit([
      "rev-parse",
      "--verify",
      "refs/cab/fetch^{commit}",
    ]);
    const commit =
      resolved.status === "ok" ? resolved.stdout.toString("utf8").trim() : "";
    if (!oid.test(commit)) return { kind: "unproved" };
    if (request.retainPrefix !== null) {
      await importPacks(scratch.dir, objects, request.fixtureBoundary);
      // Without hooks or a credential; only the cab-owned ref moves.
      if (request.fixtureBoundary)
        await request.fixtureBoundary.beforeEffect("retain");
      const kept = await run.gitRun({
        ...run.common,
        ...proofBounds,
        args: [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "update-ref",
          `${request.retainPrefix}/${branch}`,
          commit,
        ],
        cwd: request.commonDirectory,
        environmentOverrides: { GIT_DIR: request.commonDirectory },
      });
      if (kept.status !== "ok") return { kind: "unproved" };
    }
    return { kind: "fetched", branch, commit };
  } catch {
    return { kind: "unproved" };
  } finally {
    if (scratch && !run.state.unsettledChild) {
      if (request.fixtureBoundary)
        await request.fixtureBoundary.beforeEffect("teardown");
      await rm(scratch.dir, { recursive: true, force: true });
    }
  }
}

/**
 * Runs `use` with Git over a scratch repository that reads `commonDirectory`'s objects through an
 * alternate and nothing else from it: no configuration, attributes, hooks, refs or merge drivers an
 * agent could have written there. Objects Git writes stay in the scratch, which is then removed.
 */
export async function withScratchGit<T>(
  commonDirectory: string,
  use: (git: Git) => Promise<T>,
  options: { executable?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const run = fetchRunner(options);
  const scratch = await createScratch(
    undefined,
    "cab-scratch-",
    join(commonDirectory, "objects"),
    null,
  );
  try {
    return await use(scratchGitFor(run, scratch, undefined));
  } finally {
    await rm(scratch.dir, { recursive: true, force: true });
  }
}

/**
 * A temporary bare repository reading `objects` through its alternates file, for a fetch whose
 * objects must not be written to the repository that owns `objects`. The caller removes it.
 */
export async function temporaryRepository(objects: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cab-target-"));
  await mkdir(join(dir, "objects", "info"), { recursive: true });
  await mkdir(join(dir, "refs"));
  await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, "config"), "");
  await writeFile(join(dir, "objects", "info", "alternates"), `${objects}\n`);
  return dir;
}
