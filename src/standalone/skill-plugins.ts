import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProfileSkills } from "../core/execution-runtime.js";

/**
 * Bounds of a plugin directory walk, stated in docs/SPEC.md. A plugin is skills, instructions
 * and scripts; a tree past these is refused rather than hashed.
 */
export const maxPluginFiles = 2000;
export const maxPluginBytes = 16 * 1024 * 1024;
export const maxPluginDepth = 12;
const maxManifestBytes = 64 * 1024;

/** A plugin that cannot be loaded. The reason never contains a path. */
export class SkillPluginError extends Error {}

export interface LoadedPlugin {
  /** The directory the harness loads from; never shown or recorded in evidence. */
  path: string;
  /** The manifest's plugin name, for display. */
  name: string;
  skills: string[];
  /** SHA-256 over the sorted relative paths and contents of the plugin's files. */
  digest: string;
}

/** What a turn records and the operator reads: no path. */
export interface TurnPlugin {
  name: string;
  skills: string[];
  digest: string;
}

const manifestSchema = z.object({ name: z.string().min(1).max(128) });

/** Longest a plugin may take to inspect and digest; a stuck read waits the work, never the scheduler. */
const inspectionTimeoutMs = 30_000;
const withTimeout = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SkillPluginError("took too long to read")),
        inspectionTimeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Reads at most `size` bytes of a regular file opened without following links or blocking on
 * a pipe, and checks the opened handle (not the path) is that regular file of that size.
 */
async function readRegular(
  path: string,
  expectedSize: number | undefined,
  maxBytes: number,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SkillPluginError("contains a special file");
    if (
      info.size > maxBytes ||
      (expectedSize !== undefined && info.size !== expectedSize)
    )
      throw new SkillPluginError("changed while it was read");
    let position = 0;
    const buffer = Buffer.alloc(Math.min(65536, Math.max(info.size, 1)));
    while (position < info.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      onChunk(buffer.subarray(0, Math.min(bytesRead, info.size - position)));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

const isRegular = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => undefined))?.isFile() === true;

/**
 * Digest of every regular file under the plugin directory. Symlinks and special files are
 * refused, and the walk is bounded in files, bytes and depth. Async and streamed, so the
 * coordinating event loop is never blocked on a large tree.
 */
export async function digestPlugin(path: string): Promise<string> {
  const files: string[] = [];
  const sizes = new Map<string, number>();
  let bytes = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxPluginDepth) throw new SkillPluginError("tree too deep");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new SkillPluginError("contains a symbolic link");
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const size = (await lstat(full)).size;
        sizes.set(full, size);
        bytes += size;
        if (files.push(full) > maxPluginFiles || bytes > maxPluginBytes)
          throw new SkillPluginError("tree too large");
      } else throw new SkillPluginError("contains a special file");
    }
  };
  const root = await lstat(path).catch(() => undefined);
  if (!root?.isDirectory()) throw new SkillPluginError("not a directory");
  await walk(path, 0);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) {
    const relative = file.slice(path.length + 1);
    hash.update(`${Buffer.byteLength(relative)}:${relative}\0`);
    const size = sizes.get(file) ?? 0;
    hash.update(`${size}\0`);
    await readRegular(file, size, maxPluginBytes, (chunk) =>
      hash.update(chunk),
    );
  }
  return hash.digest("hex");
}

/**
 * Checks one plugin directory: a real directory with a Claude plugin manifest and each
 * enabled skill's `SKILL.md`. Returns the manifest name, or the indexes of missing skills.
 */
export async function inspectPlugin(
  path: string,
  skills: readonly string[],
): Promise<{ name: string; missing: number[] } | undefined> {
  const root = await lstat(path).catch(() => undefined);
  if (!root?.isDirectory()) return undefined;
  const manifest = join(path, ".claude-plugin", "plugin.json");
  if (!(await isRegular(manifest))) return undefined;
  const chunks: Buffer[] = [];
  const read = await readRegular(manifest, undefined, maxManifestBytes, (c) =>
    chunks.push(Buffer.from(c)),
  ).then(
    () => true,
    () => false,
  );
  if (!read) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    json = undefined;
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const missing: number[] = [];
  for (const [index, skill] of skills.entries())
    if (!(await isRegular(join(path, "skills", skill, "SKILL.md"))))
      missing.push(index);
  return { name: parsed.data.name, missing };
}

/**
 * Field paths a profile's skills fail on, empty when every plugin and enabled skill
 * exists. Used to reject a profile change before it is recorded.
 */
export async function skillFieldErrors(
  skills: ProfileSkills,
): Promise<string[]> {
  const fields: string[] = [];
  for (const [index, plugin] of skills.plugins.entries()) {
    const found = await withTimeout(
      inspectPlugin(plugin.path, plugin.skills),
    ).catch(() => undefined);
    // A tree that could never be digested is refused now, not when its work waits.
    const loadable =
      found !== undefined &&
      (await withTimeout(digestPlugin(plugin.path)).then(
        () => true,
        () => false,
      ));
    if (!found || !loadable) fields.push(`skills.plugins.${index}.path`);
    else
      for (const skill of found.missing)
        fields.push(`skills.plugins.${index}.skills.${skill}`);
  }
  return fields;
}

/**
 * Loads the plugins a turn runs with and digests them. Throws a `SkillPluginError` whose
 * message is safe to show: a missing or unreadable plugin makes work wait, never fall back.
 */
export async function loadProfilePlugins(
  skills: ProfileSkills,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const [index, plugin] of skills.plugins.entries()) {
    const found = await withTimeout(
      inspectPlugin(plugin.path, plugin.skills),
    ).catch(() => undefined);
    if (!found || found.missing.length > 0)
      throw new SkillPluginError(
        `Skill plugin ${index + 1} is missing or no longer has its enabled skills`,
      );
    try {
      loaded.push({
        path: plugin.path,
        name: found.name,
        skills: [...plugin.skills],
        digest: await withTimeout(digestPlugin(plugin.path)),
      });
    } catch (error) {
      throw new SkillPluginError(
        `Skill plugin ${index + 1} cannot be loaded: ${
          error instanceof SkillPluginError ? error.message : "unreadable"
        }`,
      );
    }
  }
  return loaded;
}

export const turnPlugins = (loaded: readonly LoadedPlugin[]): TurnPlugin[] =>
  loaded.map(({ name, skills, digest }) => ({ name, skills, digest }));
