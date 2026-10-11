import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import {
  checkoutOrigin,
  RepositoryVerificationError,
  verifiedRepository,
} from "../core/github-source.js";
import type {
  CheckoutVerification,
  FolderListing,
} from "../operator/contracts.js";
import type { DiscoveryReader } from "./github-discovery.js";

/** Test seams for guided setup: the home folder and the discovery reader factory. */
export interface OperatorSetupSeams {
  home?: string;
  discovery?: (credentialRef: string) => DiscoveryReader;
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

const execFileAsync = promisify(execFile);
const probeEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
});
const maxEntries = 200;
const probeConcurrency = 4;
const probeTimeout = 2000;

async function currentBranch(dir: string, timeout: number) {
  try {
    const branch = (
      await execFileAsync(
        "git",
        ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"],
        { encoding: "utf8", timeout, env: probeEnv() },
      )
    ).stdout.trim();
    return branch && branch.length <= 255 ? branch : null;
  } catch {
    return null;
  }
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
  if (real !== root && !real.startsWith(root + sep))
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
      (s) =>
        !s || s === "." || s === ".." || s.includes("\0") || s.includes("\\"),
    )
  )
    throw new FolderAccessError(400);
  const real = await insideHome(home, join(home, ...segments));
  if (!(await stat(real)).isDirectory()) throw new FolderAccessError(404);
  const folders = (await readdir(real, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
  const checkouts = new Set<string>();
  await pool(folders, probeConcurrency, async (name) => {
    try {
      await lstat(join(real, name, ".git"));
      checkouts.add(name);
    } catch {}
  });
  const sorted = folders.sort((a, b) =>
    checkouts.has(a) === checkouts.has(b)
      ? a.localeCompare(b)
      : checkouts.has(a)
        ? -1
        : 1,
  );
  const kept = sorted.slice(0, maxEntries);
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
      const origin = await checkoutOrigin(dir, probeEnv(), probeTimeout);
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
    truncated: sorted.length > maxEntries,
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
