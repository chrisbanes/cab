import {
  type ExecutionHarness,
  noProfileSkills,
  normalizeProfileSkills,
  type ProfilePlugin,
  type ProfileSkills,
  pluginToolLabels,
  profileSkillsSchema,
} from "../../src/core/execution-runtime.js";
import type { InstalledPlugins } from "../../src/operator/contracts.js";

export type InstalledPlugin = InstalledPlugins["plugins"][number];
/** A profile enables at most this many skills of one plugin. */
export const maxEnabledSkills = 32;

/** The draft holds the agent's entries as JSON. */
export const skillsDraft = (skills: ProfileSkills): string =>
  JSON.stringify(skills);

/** The draft's entries, or null when they are not valid profile skills. */
export function parseSkillsDraft(
  text: string | undefined,
): ProfileSkills | null {
  if (text === undefined || text === "") return noProfileSkills;
  try {
    // Apply precedence during explicit draft edits, so replacements are visible before save.
    const parsed = profileSkillsSchema.in.safeParse(JSON.parse(text));
    return parsed.success
      ? {
          plugins: parsed.data.plugins,
          ...(parsed.data.global?.length ? { global: parsed.data.global } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

const toolOf = (ref: string): ExecutionHarness =>
  ref.startsWith("claude:") ? "claude" : "codex";

/** A row's title: an installed plugin's name and tool, or a local directory. */
export function entryLabel(
  entry: ProfilePlugin,
  installed: readonly InstalledPlugin[] | undefined,
): string {
  if ("path" in entry) return entry.path;
  const name =
    installed?.find((p) => p.plugin === entry.plugin)?.name ??
    entry.plugin.slice(entry.plugin.indexOf(":") + 1);
  return `${name} · ${pluginToolLabels[toolOf(entry.plugin)]}`;
}

/** A saved installed entry the listing no longer offers: uninstalled or disabled now. */
export const entryUnavailable = (
  entry: ProfilePlugin,
  installed: readonly InstalledPlugin[] | undefined,
): boolean =>
  installed !== undefined &&
  "plugin" in entry &&
  !installed.some((p) => p.plugin === entry.plugin);

/** The skills of an installed plugin a profile on `harness` can enable. */
export const selectableSkills = (
  plugin: InstalledPlugin,
  harness: ExecutionHarness,
): string[] =>
  plugin.skills
    .filter((skill) => harness !== "claude" || skill.claude)
    .map((skill) => skill.name);

/**
 * Installed plugins the add select offers: not added already, by entry or by plugin name
 * (the same plugin from the other tool is one plugin), and on a Claude profile only those
 * with a Claude manifest and a skill the Claude CLI loads.
 */
export function offeredPlugins(
  installed: readonly InstalledPlugin[],
  harness: ExecutionHarness,
  skills: ProfileSkills,
): InstalledPlugin[] {
  const refs = new Set(
    skills.plugins.flatMap((e) => ("plugin" in e ? [e.plugin] : [])),
  );
  const names = new Set(
    installed.filter((p) => refs.has(p.plugin)).map((p) => p.name),
  );
  return installed.filter(
    (p) =>
      !refs.has(p.plugin) &&
      !names.has(p.name) &&
      (harness !== "claude" || p.claude) &&
      selectableSkills(p, harness).length > 0,
  );
}

/** Skill names containing the filter text, ignoring case. */
export const filterSkills = (names: readonly string[], query: string) => {
  const q = query.trim().toLowerCase();
  return q ? names.filter((n) => n.toLowerCase().includes(q)) : [...names];
};

/** Whether every shown skill is selected. */
export const allSelected = (
  shown: readonly string[],
  selected: readonly string[],
) => shown.every((n) => selected.includes(n));

/** Selects the shown skills, or clears them when all are selected; hidden selections stay, in offered order. */
export const toggleShown = (
  names: readonly string[],
  shown: readonly string[],
  selected: readonly string[],
) => {
  const clear = allSelected(shown, selected);
  return names.filter((n) =>
    shown.includes(n) ? !clear : selected.includes(n),
  );
};

/** Skill names typed for a local directory, comma separated. */
export const typedSkills = (text: string): string[] => [
  ...new Set(
    text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/** The entries with `entry` replacing the one at `index`, or appended. */
export const withEntry = (
  skills: ProfileSkills,
  entry: ProfilePlugin,
  index?: number,
): ProfileSkills =>
  normalizeProfileSkills({
    ...skills,
    plugins:
      index === undefined
        ? [...skills.plugins, entry]
        : skills.plugins.map((e, i) => (i === index ? entry : e)),
  });

export const withoutEntry = (
  skills: ProfileSkills,
  index: number,
): ProfileSkills => ({
  ...skills,
  plugins: skills.plugins.filter((_, i) => i !== index),
});

/** Operator-facing messages for the server's field errors on the entry at `index`. */
export function entryErrors(
  errors: Record<string, string>,
  index: number,
  entry: ProfilePlugin,
): string[] {
  const messages: string[] = [];
  for (const field of Object.keys(errors)) {
    const match = /^skills\.plugins\.(\d+)\.(path|plugin|skills\.(\d+))$/.exec(
      field,
    );
    if (!match || Number(match[1]) !== index) continue;
    if (match[2] === "path")
      messages.push(
        "Not a loadable plugin directory on the service host, without a Claude manifest for a Claude agent, or the same plugin as another entry.",
      );
    else if (match[2] === "plugin")
      messages.push(
        "Not installed and enabled for the service user now, not loadable, without a Claude manifest for a Claude agent, or the same plugin as another entry.",
      );
    else
      messages.push(
        `Skill ${entry.skills[Number(match[3])] ?? Number(match[3]) + 1} is not in the plugin.`,
      );
  }
  return messages;
}

/** Why the select offers nothing from a tool, when its records were not read. */
export function installedStatusNotes(
  status: InstalledPlugins["status"],
): string[] {
  return (["claude", "codex"] as const).flatMap((tool) =>
    status[tool] === "unreadable"
      ? [`${pluginToolLabels[tool]}'s plugin records could not be read.`]
      : [],
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const skillsSummary = (skills: ProfileSkills): string =>
  [
    ...(skills.plugins.length
      ? [
          `${count(skills.plugins.length, "plugin")}, ${count(
            skills.plugins.reduce((n, p) => n + p.skills.length, 0),
            "skill",
          )}`,
        ]
      : []),
    ...(skills.global?.length
      ? [count(skills.global.length, "global skill")]
      : []),
  ].join(", ") || "none";

export const globalSkillsLabel = "Global skills (~/.agents/skills)";

/** Saved selections remain visible even when their source cannot be read. */
export function globalChoices(
  source: InstalledPlugins["global"] | undefined,
  skills: ProfileSkills,
) {
  const replaced = new Set(skills.plugins.flatMap((p) => p.skills));
  const available = new Set(
    source?.status === "available"
      ? source.skills.filter((s) => s.available).map((s) => s.name)
      : [],
  );
  const names = [
    ...new Set([
      ...(source?.skills.map((s) => s.name) ?? []),
      ...(skills.global ?? []),
    ]),
  ];
  return names
    .filter((name) => !replaced.has(name))
    .map((name) => ({
      name,
      available: available.has(name),
    }));
}

export const withGlobals = (
  skills: ProfileSkills,
  global: string[],
): ProfileSkills => normalizeProfileSkills({ ...skills, global });
