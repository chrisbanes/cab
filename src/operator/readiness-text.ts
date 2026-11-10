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

export type ProjectSelection = {
  kind: string;
  descriptor?: string | null;
  active?: boolean;
  removed?: boolean;
  unknown?: boolean;
};

/** A known project-field reference that is absent or inactive in the supplied selections. */
export function projectFieldSelectionGap(
  conditions: readonly { kind: string; projectNodeId?: unknown }[],
  selections: readonly ProjectSelection[],
  activeOnly = false,
) {
  const projects = selections.filter(
    (selection) => selection.kind === "project" && !selection.removed,
  );
  for (const condition of conditions) {
    if (
      condition.kind !== "project-field" ||
      typeof condition.projectNodeId !== "string" ||
      !condition.projectNodeId
    )
      continue;
    const matching = projects.filter(
      (selection) => selection.descriptor === condition.projectNodeId,
    );
    if (matching.some((selection) => !activeOnly || selection.active)) continue;
    if (
      projects.some(
        (selection) => selection.unknown ?? selection.descriptor == null,
      )
    )
      return null;
    if (matching.length)
      return { projectNodeId: condition.projectNodeId, inactive: true };
    return { projectNodeId: condition.projectNodeId, inactive: false };
  }
  return null;
}

/** Explain a Project field condition whose corresponding Project is not in this draft. */
export function missingProjectSelectionWarning(mode: "all" | "any") {
  return mode === "all"
    ? "This readiness rule can never match because its Project field condition has no corresponding GitHub Project selection in this draft. Add that Project as a selection or remove the condition."
    : "This Project field condition never applies because its GitHub Project has no corresponding selection in this draft. Add that Project as a selection or remove the condition.";
}

export function projectFieldSelectionSummaryCause(
  mode: "all" | "any",
  gap: { projectNodeId: string; inactive: boolean },
) {
  const cause = gap.inactive
    ? `Project field condition references inactive GitHub Project ${gap.projectNodeId}. Activate that selection to supply fields.`
    : `Project field condition references GitHub Project ${gap.projectNodeId} with no active selection. Add that Project as a selection.`;
  return mode === "all"
    ? `The readiness rule can never match: ${cause}`
    : `A Project field condition never applies: ${cause}`;
}

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
export function zeroMatchWarning(
  counts: Counts | null,
  rule: RuleView,
  projectSelections?: readonly ProjectSelection[],
) {
  if (
    !(
      counts?.complete &&
      counts.open > 0 &&
      counts.matching === 0 &&
      rule.kind === "rule"
    )
  )
    return null;
  const gap = projectSelections
    ? projectFieldSelectionGap(rule.conditions, projectSelections, true)
    : null;
  return gap
    ? `No open item matches the readiness rule (${ruleText(rule)}); ${projectFieldSelectionSummaryCause(rule.mode, gap)} Imported tasks stay Draft until one does.`
    : `No open item matches the readiness rule (${ruleText(rule)}); imported tasks stay Draft until one does.`;
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
