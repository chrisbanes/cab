import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
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

const isRegular = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => undefined))?.isFile() === true;

/**
 * Digest of every regular file under the plugin directory. Symlinks and special files are
 * refused, and the walk is bounded in files, bytes and depth. Async and streamed, so the
 * coordinating event loop is never blocked on a large tree.
 */
export async function digestPlugin(path: string): Promise<string> {
  const files: string[] = [];
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
        bytes += (await lstat(full)).size;
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
    hash.update(`${(await lstat(file)).size}\0`);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
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
  if ((await lstat(manifest)).size > maxManifestBytes) return undefined;
  const parsed = manifestSchema.safeParse(
    await readFile(manifest, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined),
  );
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
    const found = await inspectPlugin(plugin.path, plugin.skills);
    if (!found) fields.push(`skills.plugins.${index}.path`);
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
    const found = await inspectPlugin(plugin.path, plugin.skills);
    if (!found || found.missing.length > 0)
      throw new SkillPluginError(
        `Skill plugin ${index + 1} is missing or no longer has its enabled skills`,
      );
    try {
      loaded.push({
        path: plugin.path,
        name: found.name,
        skills: [...plugin.skills],
        digest: await digestPlugin(plugin.path),
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
