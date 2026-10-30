import type { z } from "zod";
import { jiraReadinessSchema as schema } from "../../src/core/github-source-contracts.js";
import { readinessCommandValue } from "../../src/operator/contracts.js";

type Rule = z.output<typeof schema>;
type Condition = Rule["conditions"][number];

/**
 * One condition per line, by Jira ID except labels:
 * `label has ready`, `status in 10001, 10002`, `customfield_10010 not-in 20`.
 */
export function conditionLine(c: Condition): string {
  if (c.kind === "label") return `label ${c.operator} ${c.name}`;
  return c.kind === "status"
    ? `status ${c.operator} ${c.statusIds.join(", ")}`
    : `${c.fieldId} ${c.operator} ${c.optionIds.join(", ")}`;
}

/** The editor text of a rule, empty for none. */
export const ruleLines = (rule: Rule | null): string =>
  rule ? rule.conditions.map(conditionLine).join("\n") : "";

/** A rule from the editor's mode and lines; blank lines are none, and an invalid line names itself. */
export function parseRule(
  mode: string,
  text: string,
): { rule: Rule | null } | { error: string } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { rule: null };
  const conditions: unknown[] = [];
  for (const line of lines) {
    const m = /^(\S+)\s+(has|lacks|in|not-in)\s+(.+)$/.exec(line);
    const [, subject = "", operator = "", rest = ""] = m ?? [];
    const ids = rest.split(",").map((id) => id.trim());
    conditions.push(
      subject === "label"
        ? { kind: "label", operator, name: rest.trim() }
        : subject === "status"
          ? { kind: "status", operator, statusIds: ids }
          : {
              kind: "select-field",
              fieldId: subject,
              operator,
              optionIds: ids,
            },
    );
    const parsed = schema.safeParse({ mode, conditions: [conditions.at(-1)] });
    if (!m || !parsed.success)
      return {
        error: `Cannot read “${line}”. Use label has|lacks NAME, status in|not-in ID, or customfield_N in|not-in ID.`,
      };
  }
  const parsed = schema.safeParse({ mode, conditions });
  return parsed.success
    ? { rule: parsed.data }
    : { error: "The readiness rule is not valid." };
}

/** The saved rule as the editor holds it; a rule the read withholds is not editable, so null. */
export const savedRule = (
  view: Parameters<typeof readinessCommandValue>[0],
): Rule | null => {
  const rule = schema.nullable().safeParse(readinessCommandValue(view));
  return rule.success ? rule.data : null;
};
