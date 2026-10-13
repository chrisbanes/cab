import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { RepositoryVerificationError } from "../core/github-source.js";
import type {
  CheckoutVerification,
  FolderListing,
} from "../operator/contracts.js";
import { runGit } from "./git-process.js";
import type { DiscoveryReader } from "./github-discovery.js";
import {
  checkoutOrigin,
  verifiedRepository,
} from "./repository-verification.js";
import { isWithin } from "./workspace-inspection.js";

/** Test seams for guided setup: the home folder, the discovery reader factory and `gh`. */
export interface OperatorSetupSeams {
  home?: string;
  /** Receives the reference and its resolved token (undefined when the variable is unset). */
  discovery?: (
    credentialRef: string,
    token: string | undefined,
  ) => DiscoveryReader;
  /** The `gh` executable; defaults to `gh` on the service `PATH`. */
  ghExecutable?: string;
}

/** A folder request outside what the picker may list (400 malformed, 403 outside home, 404 missing). */
export class FolderAccessError extends Error {
  constructor(readonly status: 400 | 403 | 404) {
    super(`Folder access refused: ${status}`);
    this.name = "FolderAccessError";
  }
}

/** Expand `~` and `~/…` against the home folder; any other input is returned unchanged. */
export function resolveHomePath(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

const maxEntries = 200;
const probeConcurrency = 4;
const probeTimeout = 2000;

async function currentBranch(dir: string, timeoutMs: number) {
  const result = await runGit({
    args: ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"],
    timeoutMs,
    terminationGraceMs: 100,
    observationMs: 500,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.status !== "ok") return null;
  const branch = result.stdout.toString("utf8").trim();
  return branch && branch.length <= 255 ? branch : null;
}

/** Real paths on both sides: macOS temp and home folders can sit behind symlinks. */
async function insideHome(home: string, target: string) {
  const root = await realpath(home);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new FolderAccessError(404);
  }
  if (!isWithin(root, real)) throw new FolderAccessError(403);
  // A symlink may resolve into a dot-folder inside home; that is hidden too.
  if (
    real
      .slice(root.length)
      .split(sep)
      .some((segment) => segment.startsWith("."))
  )
    throw new FolderAccessError(403);
  return real;
}

/**
 * List subfolder names and Git status under the home folder. Never reads a file, lists
 * dot-folders or symlinks, or returns an absolute path. At most 200 entries are returned.
 */
export async function listHomeFolders(
  home: string,
  input: { path: string },
  /** Checkout marker probe; injectable so tests can count filesystem work. */
  probe: (path: string) => Promise<unknown> = lstat,
): Promise<FolderListing["data"]> {
  const segments =
    input.path === "~"
      ? []
      : input.path.startsWith("~/")
        ? input.path.slice(2).split("/")
        : null;
  if (
    !segments ||
    segments.some(
      // Dot-folders are never listed, so a typed hidden segment is refused too.
      (s) => !s || s.startsWith(".") || s.includes("\0") || s.includes("\\"),
    )
  )
    throw new FolderAccessError(400);
  const real = await insideHome(home, join(home, ...segments));
  if (!(await stat(real)).isDirectory()) throw new FolderAccessError(404);
  const folders = (await readdir(real, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  // Bound the page before probing: at most 200 children are ever stat-ed or run Git.
  const kept = folders.slice(0, maxEntries);
  const checkouts = new Set<string>();
  await pool(kept, probeConcurrency, async (name) => {
    try {
      await probe(join(real, name, ".git"));
      checkouts.add(name);
    } catch {}
  });
  kept.sort((a, b) =>
    checkouts.has(a) === checkouts.has(b)
      ? a.localeCompare(b)
      : checkouts.has(a)
        ? -1
        : 1,
  );
  const entries = kept.map((name) => ({
    name,
    kind: checkouts.has(name) ? ("git" as const) : ("folder" as const),
    origin: null as string | null,
    branch: null as string | null,
  }));
  await pool(entries, probeConcurrency, async (entry) => {
    if (entry.kind !== "git") return;
    const dir = join(real, entry.name);
    try {
      const origin = await checkoutOrigin(dir, probeTimeout);
      entry.origin = `${origin.owner}/${origin.name}`;
    } catch {}
    entry.branch = await currentBranch(dir, probeTimeout);
  });
  const path = segments.length ? `~/${segments.join("/")}` : "~";
  return {
    path,
    parent: segments.length
      ? segments.length === 1
        ? "~"
        : `~/${segments.slice(0, -1).join("/")}`
      : null,
    entries,
    truncated: folders.length > maxEntries,
  };
}

/** Check a chosen checkout against the expected `github.com` repository and ref. */
export async function verifyCheckout(
  home: string,
  input: {
    path: string;
    repository: { owner: string; name: string };
    ref: string;
  },
): Promise<CheckoutVerification["data"]> {
  try {
    const verified = await verifiedRepository(
      {
        repositoryId: "probe",
        path: resolveHomePath(input.path, home),
        ref: input.ref,
      },
      input.repository,
    );
    return {
      state: "verified",
      origin: `${input.repository.owner}/${input.repository.name}`,
      branch: await currentBranch(verified.path, probeTimeout),
    };
  } catch (error) {
    return error instanceof RepositoryVerificationError
      ? { state: "rejected", reason: error.reason, origin: error.actual }
      : { state: "rejected", reason: "unreadable", origin: null };
  }
}

async function pool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await work(item);
      }
    }),
  );
}
