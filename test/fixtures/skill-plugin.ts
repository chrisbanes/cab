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
