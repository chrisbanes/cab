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

/** Each plugin's enabled skills as discovered from its layout, or a `SkillScopeError`. */
async function enabledSkills(
  plugins: readonly SkillPluginSettings[],
): Promise<PluginSkill[]> {
  const found = await Promise.all(
    plugins.map(async (plugin) => {
      const layout = await readPlugin(plugin.path).catch(() => undefined);
      if (!layout) throw new SkillScopeError();
      try {
        return enabledPluginSkills(layout, plugin.skills);
      } catch {
        throw new SkillScopeError();
      }
    }),
  );
  return found.flat();
}

/**
 * The extra skills roots for a profile: the parent of each enabled skill's directory, so
 * App Server lists that skill one level down whatever the plugin's layout. Resolved,
 * deduplicated and sorted.
 */
export async function pluginSkillRoots(
  plugins: readonly SkillPluginSettings[],
): Promise<string[]> {
  const skills = await enabledSkills(plugins);
  return [...new Set(skills.map((skill) => dirname(skill.directory)))].sort();
}

/** The resolved `SKILL.md` paths of every skill the profile enables. */
export async function enabledSkillFiles(
  plugins: readonly SkillPluginSettings[],
): Promise<Set<string>> {
  return new Set((await enabledSkills(plugins)).map((skill) => skill.file));
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
    const underKnownRoot = [...input.knownRoots].some((root) =>
      file.startsWith(root + sep),
    );
    if (enabled ? !enabled.has(file) : underKnownRoot)
      disabled.push(skill.path);
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
