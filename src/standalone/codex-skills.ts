import { realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";
import {
  enabledSkills as enabledPluginSkills,
  type PluginSkill,
  readPlugin,
} from "./skill-plugins.js";

/** A plugin as the Codex runtime receives it: an absolute directory and its enabled skills. */
export interface SkillPluginSettings {
  path: string;
  skills: readonly string[];
}

/** One skill App Server lists (`skills/list`): where its `SKILL.md` is. */
export interface ListedSkill {
  name: string;
  path: string;
}

/** A profile's skills cannot be scoped for Codex; the message names no path, so it can be a hold reason. */
export class SkillScopeError extends Error {
  constructor() {
    super("A skill the profile enables could not be loaded by Codex");
  }
}

/** Each plugin's enabled skills and every discovered skill, from its layout, or a `SkillScopeError`. */
async function discoveredSkills(
  plugins: readonly SkillPluginSettings[],
): Promise<{ enabled: PluginSkill[]; all: PluginSkill[] }> {
  const found = await Promise.all(
    plugins.map(async (plugin) => {
      const layout = await readPlugin(plugin.path).catch(() => undefined);
      if (!layout) throw new SkillScopeError();
      try {
        return {
          enabled: enabledPluginSkills(layout, plugin.skills),
          all: [...layout.skills.values()].flat(),
        };
      } catch {
        throw new SkillScopeError();
      }
    }),
  );
  return {
    enabled: found.flatMap((f) => f.enabled),
    all: found.flatMap((f) => f.all),
  };
}

/**
 * The extra skills roots for a profile, the parent of each enabled skill's directory so
 * App Server lists that skill one level down whatever the plugin's layout, and the resolved
 * `SKILL.md` of every skill its plugins have, which a link can place outside those roots.
 * Resolved, deduplicated and sorted.
 */
export async function pluginSkillScope(
  plugins: readonly SkillPluginSettings[],
): Promise<{ roots: string[]; files: string[] }> {
  const { enabled, all } = await discoveredSkills(plugins);
  return {
    roots: [
      ...new Set(enabled.map((skill) => dirname(skill.directory))),
    ].sort(),
    files: [...new Set(all.map((skill) => skill.file))].sort(),
  };
}

/** The resolved `SKILL.md` paths of every skill the profile enables. */
export async function enabledSkillFiles(
  plugins: readonly SkillPluginSettings[],
): Promise<Set<string>> {
  return new Set(
    (await discoveredSkills(plugins)).enabled.map((skill) => skill.file),
  );
}

/**
 * The `skills.config` disables for one thread, as App Server thread config. With enabled
 * skills, every listed skill (bundled and repository skills included) except those is
 * disabled. Without, only skills from cab's plugin roots are disabled, so a profile that
 * enables none sees what it saw before and never another profile's plugins. `undefined`
 * when nothing needs disabling, so the call keeps its earlier shape.
 */
export async function skillScopeConfig(input: {
  listed: readonly ListedSkill[];
  knownRoots: ReadonlySet<string>;
  /** Resolved `SKILL.md` of every skill of cab's plugins, including linked ones outside a root. */
  knownFiles: ReadonlySet<string>;
  plugins: readonly SkillPluginSettings[];
}): Promise<
  { skills: { config: Array<{ path: string; enabled: false }> } } | undefined
> {
  const enabled =
    input.plugins.length > 0
      ? await enabledSkillFiles(input.plugins)
      : undefined;
  const disabled: string[] = [];
  const found = new Set<string>();
  for (const skill of input.listed) {
    const file = await realpath(skill.path).catch(() => skill.path);
    found.add(file);
    const fromPlugin =
      input.knownFiles.has(file) ||
      [...input.knownRoots].some(
        (root) =>
          file.startsWith(root + sep) || skill.path.startsWith(root + sep),
      );
    if (enabled ? !enabled.has(file) : fromPlugin) disabled.push(skill.path);
  }
  // Claude accepts a skill Codex may reject (for instance without frontmatter); never run without it.
  if (enabled && [...enabled].some((file) => !found.has(file)))
    throw new SkillScopeError();
  return disabled.length === 0
    ? undefined
    : {
        skills: {
          config: [...new Set(disabled)].sort().map((path) => ({
            path,
            enabled: false as const,
          })),
        },
      };
}
