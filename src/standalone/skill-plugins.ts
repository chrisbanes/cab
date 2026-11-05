import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  type ExecutionHarness,
  type InstalledPluginRef,
  type ProfilePlugin,
  type ProfileSkills,
  skillNameSchema,
} from "../core/execution-runtime.js";
import {
  enabledInstalledPlugins,
  InstalledPluginError,
  type InstalledToolStatus,
  type PluginTool,
  resolveInstalledPlugin,
} from "./installed-plugins.js";

/**
 * Bounds of a plugin's load scope (its manifests and enabled skills' directories), stated in
 * docs/SPEC.md. A tree past these is refused rather than hashed.
 */
export const maxPluginFiles = 2000;
export const maxPluginBytes = 16 * 1024 * 1024;
export const maxPluginDepth = 12;
const maxManifestBytes = 64 * 1024;

/** How long work waiting on an unavailable skill plugin waits before it is re-checked. */
export const skillPluginRetryMs = 30_000;

/** A plugin that cannot be loaded. The reason never contains a path. */
export class SkillPluginError extends Error {}

export interface LoadedPlugin {
  /** The directory the harness loads from; never shown or recorded in evidence. */
  path: string;
  /** The Claude manifest's plugin name, else the Codex manifest's, for display. */
  name: string;
  skills: string[];
  /** SHA-256 over the sorted relative paths and contents of the plugin's load scope. */
  digest: string;
}

/** What a turn records and the operator reads: no path. */
export interface TurnPlugin {
  name: string;
  skills: string[];
  digest: string;
}

/** The manifest fields cab reads; `skills` is paths relative to the plugin directory. */
const manifestSchema = z.object({
  name: z.string().min(1).max(128),
  skills: z
    .union([z.string().max(1024), z.array(z.string().max(1024)).max(256)])
    .optional(),
});

/** Longest all of a profile's plugins may take to inspect and digest together. A stuck read ends the wait but is not cancelled. */
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
      if (bytesRead === 0)
        throw new SkillPluginError("changed while it was read");
      onChunk(buffer.subarray(0, Math.min(bytesRead, info.size - position)));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** Where both runtimes look for a plugin's manifests, relative to its directory. */
const claudeManifest = join(".claude-plugin", "plugin.json");
const codexManifest = join(".codex-plugin", "plugin.json");
/** Codex App Server lists a `SKILL.md` up to this many directories below a skills root. */
const codexSkillDepth = 6;
/** Bytes of a `SKILL.md` read for its frontmatter name. */
const frontmatterBytes = 8 * 1024;

const inside = (root: string, path: string) => path.startsWith(root + sep);

/** The real path of a regular file or directory inside `root`, following links; else undefined. */
async function realInside(
  root: string,
  path: string,
  kind: "file" | "directory",
): Promise<string | undefined> {
  const real = await realpath(path).catch(() => undefined);
  if (real === undefined || !inside(root, real)) return undefined;
  const info = await stat(real).catch(() => undefined);
  return (kind === "file" ? info?.isFile() : info?.isDirectory())
    ? real
    : undefined;
}

/** The frontmatter `name` of a `SKILL.md`, read from its first bytes. */
async function frontmatterName(file: string): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const buffer = Buffer.alloc(frontmatterBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  // shortcut: reads a single-line `name:` scalar (plain, or quoted, with an optional comment)
  // rather than full YAML; enough for skill names, which `skillNameSchema` limits anyway.
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const value = block && /^name:[ \t]*(.*?)[ \t]*$/m.exec(block)?.[1];
  if (!value) return undefined;
  const quoted = /^(['"])(.*?)\1(?:[ \t]+#.*)?$/.exec(value);
  return (
    (quoted ? quoted[2] : value.replace(/(?:^|[ \t]+)#.*$/, "")) || undefined
  );
}

/** One skill of a plugin: its real directory and real `SKILL.md`. */
export interface PluginSkill {
  directory: string;
  file: string;
  /** Found by the Claude manifest's list or the flat scan, so the Claude CLI loads it too. */
  claude: boolean;
}

/** A plugin directory as both runtimes read it. */
export interface PluginLayout {
  /** The plugin directory's real path. */
  root: string;
  /** The Claude manifest's name, else the Codex manifest's. */
  name: string;
  /** Whether it has a Claude manifest, so the Claude CLI names it by that name. */
  claude: boolean;
  /** The manifests that exist: their names relative to the root and the real files read. */
  manifests: Array<{ name: string; real: string }>;
  /** Every discovered skill by name; more than one entry is an ambiguous name. */
  skills: Map<string, PluginSkill[]>;
}

/**
 * Reads a plugin's manifests and discovers its skills the way the runtimes do: the Claude
 * manifest's `skills` paths, the Codex manifest's `skills` directory (scanned
 * `codexSkillDepth` deep) and the one-level `skills/` scan. Undefined when the directory has
 * no valid manifest; a tree too large to scan throws a `SkillPluginError`.
 */
export async function readPlugin(
  path: string,
): Promise<PluginLayout | undefined> {
  const root = await realpath(path).catch(() => undefined);
  if (root === undefined || !(await stat(root)).isDirectory()) return undefined;
  const manifests: Array<{ name: string; real: string }> = [];
  const manifest = async (relativePath: string) => {
    const file = join(root, relativePath);
    if (!(await lstat(file).catch(() => undefined))) return undefined;
    // A manifest reached through a link is read only if it resolves inside the plugin.
    const real = await realInside(root, file, "file");
    if (!real) return null;
    manifests.push({ name: relativePath, real });
    const chunks: Buffer[] = [];
    const read = await readRegular(real, undefined, maxManifestBytes, (c) =>
      chunks.push(Buffer.from(c)),
    ).then(
      () => true,
      () => false,
    );
    if (!read) return null;
    try {
      const parsed = manifestSchema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const claude = await manifest(claudeManifest);
  const codex = await manifest(codexManifest);
  // A manifest that exists but cannot be read makes the plugin unreadable, not the other runtime's.
  if (claude === null || codex === null || (!claude && !codex))
    return undefined;
  const found = new Map<string, PluginSkill>();
  let visited = 0;
  const candidate = async (directory: string, claude: boolean) => {
    const file = await realInside(root, join(directory, "SKILL.md"), "file");
    const real = await realInside(root, directory, "directory");
    if (file && real)
      found.set(file, {
        directory: real,
        file,
        claude: claude || found.get(file)?.claude === true,
      });
    return file !== undefined;
  };
  /** Skill directories up to `depth` levels below `directory`, not descending into a skill. */
  const scan = async (
    directory: string,
    depth: number,
    claude: boolean,
  ): Promise<void> => {
    if (depth === 0) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (++visited > maxPluginFiles)
        throw new SkillPluginError("tree too large");
      const child = join(directory, entry.name);
      if (!(await candidate(child, claude)))
        await scan(child, depth - 1, claude);
    }
  };
  const listed = (entry: string) => {
    const resolved = resolve(root, entry);
    return resolved === root || inside(root, resolved) ? resolved : undefined;
  };
  const paths = (value: string | string[] | undefined) =>
    value === undefined ? [] : typeof value === "string" ? [value] : value;
  // A listed path is a skill directory, or a directory of skills as in the flat scan.
  for (const entry of paths(claude?.skills)) {
    const directory = listed(entry);
    if (directory && !(await candidate(directory, true)))
      await scan(directory, 1, true);
  }
  for (const entry of paths(codex?.skills)) {
    const directory = listed(entry);
    if (directory) await scan(directory, codexSkillDepth, false);
  }
  await scan(join(root, "skills"), 1, true);
  const skills = new Map<string, PluginSkill[]>();
  for (const skill of found.values()) {
    const name =
      (await frontmatterName(skill.file).catch(() => undefined)) ??
      basename(skill.directory);
    skills.set(name, [...(skills.get(name) ?? []), skill]);
  }
  return {
    root,
    name: (claude ?? codex)!.name,
    claude: claude !== undefined,
    manifests,
    skills,
  };
}

/**
 * The directory of each enabled skill, or a `SkillPluginError` naming the first that is
 * missing or ambiguous. For Claude, only skills the Claude CLI loads count: a nested skill
 * reached only through the Codex manifest is missing.
 */
export function enabledSkills(
  layout: PluginLayout,
  skills: readonly string[],
  harness?: ExecutionHarness,
): PluginSkill[] {
  return skills.map((name) => {
    const found = (layout.skills.get(name) ?? []).filter(
      (skill) => harness !== "claude" || skill.claude,
    );
    if (found.length !== 1)
      throw new SkillPluginError(
        found.length === 0
          ? `has no skill named ${name}`
          : `has more than one skill named ${name}`,
      );
    return found[0]!;
  });
}

/**
 * Digest of the plugin's manifests and every regular file under its enabled skills'
 * directories: nothing else reaches the agent. A symbolic link that resolves inside the
 * plugin directory is followed; one outside it, or a special file, is refused. The walk is
 * bounded in files, bytes and depth. Async and streamed, so the coordinating event loop is
 * never blocked on a large tree.
 */
export async function digestPlugin(
  path: string,
  skills: readonly string[],
): Promise<string> {
  const layout = await readPlugin(path);
  if (!layout) throw new SkillPluginError("not a plugin directory");
  const root = layout.root;
  /** Relative name → the real file read for it, and its size. */
  const files = new Map<string, { real: string; size: number }>();
  let bytes = 0;
  const add = async (name: string, real: string) => {
    if (files.has(name)) return;
    const size = (await lstat(real)).size;
    files.set(name, { real, size });
    bytes += size;
    if (files.size > maxPluginFiles || bytes > maxPluginBytes)
      throw new SkillPluginError("tree too large");
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxPluginDepth) throw new SkillPluginError("tree too deep");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      let real = full;
      let info: Awaited<ReturnType<typeof stat>> | undefined = entry.isFile()
        ? undefined
        : await lstat(full);
      if (entry.isSymbolicLink()) {
        real = await realpath(full).catch(() => "");
        if (!inside(root, real))
          throw new SkillPluginError(
            "contains a symbolic link outside the plugin",
          );
        info = await stat(real);
      }
      if (info?.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() || info?.isFile())
        await add(relative(root, full), real);
      else throw new SkillPluginError("contains a special file");
    }
  };
  for (const manifest of layout.manifests)
    await add(manifest.name, manifest.real);
  for (const skill of enabledSkills(layout, skills))
    await walk(skill.directory, 0);
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const { real, size } = files.get(name)!;
    hash.update(`${Buffer.byteLength(name)}:${name}\0`);
    hash.update(`${size}\0`);
    await readRegular(real, size, maxPluginBytes, (chunk) =>
      hash.update(chunk),
    );
  }
  return hash.digest("hex");
}

/** The directory an entry loads from now: its own path, or its tool's current install. */
const pluginDirectory = (
  plugin: ProfilePlugin,
  environment: NodeJS.ProcessEnv,
): Promise<string> =>
  "path" in plugin
    ? Promise.resolve(plugin.path)
    : resolveInstalledPlugin(plugin.plugin, environment);

/** The field a whole entry fails on. */
const entryField = (plugin: ProfilePlugin, index: number) =>
  `skills.plugins.${index}.${"path" in plugin ? "path" : "plugin"}`;

/**
 * Field paths a profile's skills fail on, empty when every plugin resolves and exists,
 * every enabled skill is one skill, no two entries are the same plugin (by manifest name)
 * and a Claude profile's plugins have a Claude manifest. Used to reject a profile change
 * before it is recorded.
 */
export const skillFieldErrors = (
  skills: ProfileSkills,
  harness: ExecutionHarness,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> =>
  withTimeout(fieldErrors(skills, harness, environment)).catch(() =>
    skills.plugins.map(entryField),
  );

async function fieldErrors(
  skills: ProfileSkills,
  harness: ExecutionHarness,
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  const fields: string[] = [];
  const names = new Set<string>();
  for (const [index, plugin] of skills.plugins.entries()) {
    const directory = await pluginDirectory(plugin, environment).catch(
      () => undefined,
    );
    const layout =
      directory === undefined
        ? undefined
        : await readPlugin(directory).catch(() => undefined);
    // The Claude CLI would name a manifest-less plugin after its directory.
    if (
      !directory ||
      !layout ||
      (harness === "claude" && !layout.claude) ||
      names.has(layout.name)
    ) {
      fields.push(entryField(plugin, index));
      continue;
    }
    names.add(layout.name);
    const unavailable = plugin.skills.flatMap((name, skill) => {
      try {
        enabledSkills(layout, [name], harness);
        return [];
      } catch {
        return [`skills.plugins.${index}.skills.${skill}`];
      }
    });
    if (unavailable.length > 0) {
      fields.push(...unavailable);
      continue;
    }
    // A tree that could never be digested is refused now, not when its work waits.
    const loadable = await digestPlugin(directory, plugin.skills).then(
      () => true,
      () => false,
    );
    if (!loadable) fields.push(entryField(plugin, index));
  }
  return fields;
}

/**
 * Loads the plugins a turn on `harness` runs with, resolving installed plugins to their
 * current install, and digests them. Throws a `SkillPluginError` whose message is safe to
 * show: a missing, disabled or unreadable plugin makes work wait, never fall back.
 */
export const loadProfilePlugins = (
  skills: ProfileSkills,
  harness: ExecutionHarness,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedPlugin[]> =>
  withTimeout(loadPlugins(skills, harness, environment));

async function loadPlugins(
  skills: ProfileSkills,
  harness: ExecutionHarness,
  environment: NodeJS.ProcessEnv,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const [index, plugin] of skills.plugins.entries()) {
    const label = "path" in plugin ? String(index + 1) : plugin.plugin;
    const directory = await pluginDirectory(plugin, environment).catch(
      (error: unknown) => {
        throw new SkillPluginError(
          error instanceof InstalledPluginError
            ? error.message
            : `Skill plugin ${label} cannot be resolved`,
        );
      },
    );
    const layout = await readPlugin(directory).catch((error: unknown) => {
      throw new SkillPluginError(
        `Skill plugin ${label} cannot be loaded: ${
          error instanceof SkillPluginError ? error.message : "unreadable"
        }`,
      );
    });
    if (!layout)
      throw new SkillPluginError(
        `Skill plugin ${label} is missing or has no plugin manifest`,
      );
    // The Claude CLI would name a manifest-less plugin after its directory.
    if (harness === "claude" && !layout.claude)
      throw new SkillPluginError(
        `Skill plugin ${layout.name} has no Claude plugin manifest`,
      );
    // Two plugins of one name would collide in the runtimes' skill names.
    if (loaded.some((other) => other.name === layout.name))
      throw new SkillPluginError(
        `Skill plugin ${layout.name} is enabled more than once`,
      );
    try {
      enabledSkills(layout, plugin.skills, harness);
      loaded.push({
        path: directory,
        name: layout.name,
        skills: [...plugin.skills],
        digest: await digestPlugin(directory, plugin.skills),
      });
    } catch (error) {
      throw new SkillPluginError(
        `Skill plugin ${label} cannot be loaded: ${
          error instanceof SkillPluginError ? error.message : "unreadable"
        }`,
      );
    }
  }
  return loaded;
}

export const turnPlugins = (loaded: readonly LoadedPlugin[]): TurnPlugin[] =>
  loaded.map(({ name, skills, digest }) => ({ name, skills, digest }));

/** An installed plugin as the profile editor offers it: no path. */
export interface InstalledPlugin {
  plugin: InstalledPluginRef;
  tool: PluginTool;
  name: string;
  /** Whether it has a Claude manifest, so a Claude profile can enable it. */
  claude: boolean;
  /** Its skills with exactly one directory; `claude` when the Claude CLI loads it too. */
  skills: Array<{ name: string; claude: boolean }>;
}

/**
 * Every plugin installed and enabled in Claude Code or Codex that resolves now and has at
 * least one skill, with each tool's record status. Bounded like a profile's inspection.
 */
export const listInstalledPlugins = (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  plugins: InstalledPlugin[];
  status: Record<PluginTool, InstalledToolStatus>;
}> =>
  withTimeout(
    (async () => {
      const { refs, status } = await enabledInstalledPlugins(environment);
      const plugins: InstalledPlugin[] = [];
      for (const ref of refs) {
        const directory = await resolveInstalledPlugin(ref, environment).catch(
          () => undefined,
        );
        const layout = directory
          ? await readPlugin(directory).catch(() => undefined)
          : undefined;
        if (!layout) continue;
        // Only names a profile can enable: one skill each, in the profile's name grammar.
        const skills = [...layout.skills.entries()]
          .filter(
            ([name, found]) =>
              found.length === 1 && skillNameSchema.safeParse(name).success,
          )
          .slice(0, 256)
          .map(([name, [skill]]) => ({ name, claude: skill!.claude }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        if (skills.length === 0 || plugins.length >= 256) continue;
        plugins.push({
          plugin: ref,
          tool: ref.startsWith("claude:") ? "claude" : "codex",
          name: layout.name,
          claude: layout.claude,
          skills,
        });
      }
      return { plugins, status };
    })(),
  );
