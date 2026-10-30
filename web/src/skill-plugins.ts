import {
  type ProfileSkills,
  profileSkillsSchema,
} from "../../src/core/execution-runtime.js";

/** One plugin per line: `/absolute/plugin/dir: skill-a, skill-b`. */
export const skillsToText = (skills: ProfileSkills): string =>
  skills.plugins.map((p) => `${p.path}: ${p.skills.join(", ")}`).join("\n");

export const skillsFormat =
  "One plugin per line: /absolute/plugin/dir: skill-a, skill-b";

/** The draft text as skills, or null when a line does not have that form. */
export function parseSkills(text: string): ProfileSkills | null {
  const plugins = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const split = line.lastIndexOf(": ");
    if (split < 0) return null;
    plugins.push({
      path: line.slice(0, split).trim(),
      skills: line
        .slice(split + 2)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  const parsed = profileSkillsSchema.safeParse({ plugins });
  return parsed.success ? parsed.data : null;
}

/** Operator-facing messages for the server's `skills.*` field errors, by line. */
export function skillErrorMessages(errors: Record<string, string>): string[] {
  const messages: string[] = [];
  for (const field of Object.keys(errors)) {
    const path = /^skills\.plugins\.(\d+)\.path$/.exec(field);
    const skill = /^skills\.plugins\.(\d+)\.skills\.(\d+)$/.exec(field);
    // The form's own format error is stored under `skills` too; only the server's is this one.
    if (field === "skills") {
      if (errors.skills !== skillsFormat)
        messages.push(
          "Only Claude profiles load skill plugins: clear this field.",
        );
    } else if (path)
      messages.push(
        `Plugin ${Number(path[1]) + 1}: not a plugin directory on the service host.`,
      );
    else if (skill)
      messages.push(
        `Plugin ${Number(skill[1]) + 1}: skill ${Number(skill[2]) + 1} is not in the plugin.`,
      );
  }
  return messages;
}

export const skillsSummary = (skills: ProfileSkills): string =>
  skills.plugins.length === 0
    ? "none"
    : `${skills.plugins.length} plugin${skills.plugins.length === 1 ? "" : "s"}, ${skills.plugins.reduce((n, p) => n + p.skills.length, 0)} skill${skills.plugins.reduce((n, p) => n + p.skills.length, 0) === 1 ? "" : "s"}`;
