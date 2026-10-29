import type { z } from "zod";
import type {
  readinessRuleViewSchema,
  selectionCountsSchema,
  taskReadinessSchema,
} from "./contracts.js";

/**
 * The one wording of readiness counts, the zero-match warning and unmet reasons, shared
 * by the web app, the HTML fallback and the CLI. Matching the rule never means Ready or
 * admissible, so no text here claims either.
 */
type RuleView = z.infer<typeof readinessRuleViewSchema>;
type Counts = z.infer<typeof selectionCountsSchema>;
type Condition = Extract<RuleView, { kind: "rule" }>["conditions"][number];

export function conditionText(c: Condition) {
  if (c.kind === "label")
    return c.operator === "has"
      ? `label \`${c.name}\``
      : `no label \`${c.name}\``;
  if (c.kind === "status")
    return `Jira status is ${c.operator === "in" ? "one of" : "not one of"} ${c.statusIds.map((id) => c.statusNames?.[id] ?? id).join(", ")}`;
  if (c.kind === "select-field")
    return `${c.fieldId} is ${c.operator === "in" ? "one of" : "not one of"} ${c.optionIds.map((id) => c.optionNames?.[id] ?? id).join(", ")}`;
  const [only, ...rest] = c.optionNodeIds;
  const name = (id: string) => c.optionNames?.[id] ?? id;
  if (c.operator === "in" && only !== undefined && !rest.length)
    return projectFieldText({
      ...c,
      optionNodeId: only,
      optionName: c.optionNames?.[only],
    });
  return `${c.fieldName ?? `Project field ${c.fieldNodeId}`} is ${c.operator === "in" ? "one of" : "not one of"} ${c.optionNodeIds.map(name).join(", ")}`;
}

/** "Status = Ready", or the node ID of a field or option no complete read has named. */
export const projectFieldText = (f: {
  fieldNodeId: string;
  optionNodeId: string;
  fieldName?: string | undefined;
  optionName?: string | undefined;
}) =>
  `${f.fieldName ?? `Project field ${f.fieldNodeId}`} = ${f.optionName ?? f.optionNodeId}`;

/** What a source without a readiness rule admits, in every surface's settings. */
export const noRuleText =
  "No readiness rule: open issues in active selections are not filtered by label or Project field.";

export function ruleText(rule: RuleView) {
  if (rule.kind === "none") return "no readiness rule";
  if (rule.kind === "unavailable") return "rule unavailable";
  const parts = rule.conditions.map(conditionText);
  return rule.mode === "all"
    ? parts.join(" and ")
    : `any of ${parts.join(", ")}`;
}

/** Ready follows a changed rule only once the selection is previewed and read again. */
const staleMatch =
  "readiness match unknown until the selection is previewed and read again";

/** "149 observed (141 closed, not imported) · 9 open · 0 match label `ready`". */
export function selectionCountsText(counts: Counts, rule: RuleView) {
  const match =
    rule.kind === "unavailable"
      ? "readiness match unknown (rule unavailable)"
      : counts.matching === null
        ? staleMatch
        : rule.kind === "none"
          ? `all ${counts.open} open match (no readiness rule)`
          : `${counts.matching} match ${ruleText(rule)}`;
  return [
    `${counts.observed} observed${counts.closedSkipped ? ` (${counts.closedSkipped} closed, not imported)` : ""}`,
    `${counts.open} open`,
    match,
    ...(counts.complete ? [] : ["partial read; counts may be incomplete"]),
  ].join(" · ");
}

/** Only a complete read with open items and none matching a known rule warns. */
export function zeroMatchWarning(counts: Counts | null, rule: RuleView) {
  return counts?.complete &&
    counts.open > 0 &&
    counts.matching === 0 &&
    rule.kind === "rule"
    ? `No open item matches the readiness rule (${ruleText(rule)}); imported tasks stay Draft until one does.`
    : null;
}

/** "needs label `ready`" or "needs any of …"; null unless the rule is known and unmet. */
export function unmetText(r: z.infer<typeof taskReadinessSchema> | undefined) {
  if (r?.outcome !== "unmet" || r.rule.kind !== "rule" || !r.unmet.length)
    return null;
  const parts = r.unmet.map(conditionText).join(", ");
  return r.rule.mode === "all" ? `needs ${parts}` : `needs any of ${parts}`;
}

export function unmetReason(
  r: z.infer<typeof taskReadinessSchema> | undefined,
) {
  const text = unmetText(r);
  return text && `Not Ready: ${text}`;
}
