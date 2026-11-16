import { lstat, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The Git arguments whose output `ignoredTrimPaths` reads. `traditional` with
 * `--untracked-files=all` names every ignored file individually; Git reports a
 * directory only when it did not enumerate it, which is a nested repository.
 * Tracked files are never reported as ignored, even under an ignored parent.
 */
export const trimStatusArguments = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--ignored=traditional",
  "--untracked-files=all",
  "--no-renames",
  "--ignore-submodules=all",
] as const;

/** `dirty`: a tracked change or a non-ignored untracked file, which removal must not discard. */
export type TrimScan =
  | { ok: true; ignored: string[]; dirty: boolean }
  | { ok: false; reason: string };

/** Ignored untracked file paths, or a refusal when any entry cannot be proved disposable. */
export function ignoredTrimPaths(output: Buffer): TrimScan {
  if (output.length === 0) return { ok: true, ignored: [], dirty: false };
  const text = output.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(output))
    return { ok: false, reason: "Git reported a path that is not UTF-8" };
  const entries = text.split("\0");
  if (entries.pop() !== "")
    return { ok: false, reason: "Git status output was incomplete" };
  const ignored: string[] = [];
  let dirty = false;
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (entry[2] !== " " || !path || /[RC]/.test(code))
      return { ok: false, reason: "Git status output was not understood" };
    if (code !== "!!") dirty = true;
    if (code !== "!!" && code !== "??") continue;
    // Only a directory Git declined to enumerate appears with a trailing slash.
    if (path.endsWith("/"))
      return { ok: false, reason: "it contains a nested Git repository" };
    if (code === "??") continue;
    if (!safeRelativePath(path))
      return { ok: false, reason: "Git reported an unsafe ignored path" };
    ignored.push(path);
  }
  return { ok: true, ignored, dirty };
}

/** A relative path with no empty, `.`, `..` or `.git` component. */
export function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git",
      )
  );
}

/** Git's gitlink mode: a submodule's ignored files are not reported by its parent. */
export function hasGitlink(modes: Buffer): boolean {
  return modes
    .toString("utf8")
    .split("\0")
    .some((mode) => mode === "160000");
}

export class TrimPathError extends Error {}

/**
 * Unlinks one ignored entry without following it. Every ancestor below `root`
 * must be a real directory; an entry that became a directory is refused, never
 * removed recursively. Returns false when the entry is already absent.
 */
export async function unlinkIgnored(
  root: string,
  relative: string,
): Promise<boolean> {
  if (!safeRelativePath(relative))
    throw new TrimPathError("Ignored path is unsafe");
  const parts = relative.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstatIfExists(current);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new TrimPathError("An ignored path's parent is not a directory");
  }
  const target = join(root, relative);
  const info = await lstatIfExists(target);
  if (!info) return false;
  if (info.isDirectory())
    throw new TrimPathError("An ignored path became a directory");
  // shortcut: lstat-then-unlink is not atomic against a concurrent parent swap (settled ownership
  // excludes cab writers), upgrade to a directory-fd unlinkat if untrusted writers can race a trim.
  await unlink(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  return true;
}

/** Removes only ancestors of `removed` below `root` that are now empty, deepest first. */
export async function pruneEmptyParents(
  root: string,
  removed: readonly string[],
): Promise<void> {
  const parents = new Set<string>();
  for (const path of removed)
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
      parents.add(parent);
  const ordered = [...parents].sort(
    (a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1),
  );
  for (const parent of ordered) {
    const path = join(root, parent);
    const info = await lstatIfExists(path);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    await rmdir(path).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT")
        throw error;
    });
  }
}

/** Deletes everything inside scratch, never following links, and keeps scratch itself. */
export async function clearScratch(
  scratch: string,
  cancelled: () => void,
): Promise<void> {
  await assertRealDirectory(scratch);
  for (const name of await readdir(scratch)) {
    cancelled();
    await assertRealDirectory(scratch);
    // `rm` lstats each entry, so a link is unlinked rather than followed.
    // shortcut: `rm` walks a child directory by path, so a directory swapped for a link inside it
    // mid-walk is not detected (settled ownership excludes cab writers), upgrade to an fd-relative
    // walk if untrusted writers can race a trim.
    await rm(join(scratch, name), { recursive: true });
  }
  await assertRealDirectory(scratch);
  if ((await readdir(scratch)).length > 0)
    throw new TrimPathError("Scratch contents remained after trimming");
}

/** The scratch path must be a real directory, never a link or another entry. */
export async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new TrimPathError("Task scratch path is not a real directory");
}

export async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
