import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A minimal local plugin: a manifest and one `SKILL.md` per skill. Returns its directory. */
export function writeSkillPlugin(
  directory: string,
  skills: readonly string[] = ["probe-skill"],
  name = "unit-plugin",
): string {
  mkdirSync(join(directory, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(directory, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.0.1", description: "Unit plugin" }),
  );
  for (const skill of skills) {
    mkdirSync(join(directory, "skills", skill), { recursive: true });
    writeFileSync(
      join(directory, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Unit skill ${skill}.\n---\nDo nothing.\n`,
    );
  }
  return directory;
}

/**
 * A plugin in the layout Claude Code and Codex plugins use: skills under
 * `skills/<category>/<name>/`, listed in the Claude manifest's `skills` array when
 * `claude` is set, and a Codex manifest naming `./skills/` when `codex` is set.
 */
export function writeNestedSkillPlugin(
  directory: string,
  skills: Record<string, readonly string[]>,
  { name = "nested-plugin", claude = true, codex = true } = {},
): string {
  const listed: string[] = [];
  for (const [category, names] of Object.entries(skills))
    for (const skill of names) {
      const dir = join(directory, "skills", category, skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${skill}\ndescription: Unit skill ${skill}.\n---\nDo nothing.\n`,
      );
      listed.push(`./skills/${category}/${skill}`);
    }
  if (claude) {
    mkdirSync(join(directory, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(directory, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name, version: "0.0.1", skills: listed }),
    );
  }
  if (codex) {
    mkdirSync(join(directory, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(directory, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name, version: "0.0.1", skills: "./skills/" }),
    );
  }
  return directory;
}
