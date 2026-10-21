import { z } from "zod";
import type { Readiness } from "./github-source-contracts.js";

const optionId = z.string().trim().min(1).max(512);
/** The Ensemble work events that can move a task's Project Status, in precedence order of display. */
export const statusMappingEvents = [
  "turnStarted",
  "handedBack",
  "held",
  "done",
] as const;
export type StatusMappingEvent = (typeof statusMappingEvents)[number];
/** In-flight events must leave the task Ready; terminal events may remove readiness. */
export function isInFlightEvent(event: StatusMappingEvent): boolean {
  return event === "turnStarted" || event === "handedBack";
}

export const statusMappingSchema = z
  .object({
    selectionId: optionId,
    projectNodeId: optionId,
    fieldNodeId: optionId,
    events: z
      .object({
        turnStarted: optionId.nullable(),
        handedBack: optionId.nullable(),
        held: optionId.nullable(),
        done: optionId.nullable(),
      })
      .strict(),
  })
  .strict();
export type StatusMapping = z.output<typeof statusMappingSchema>;

/**
 * Whether the rule can still hold with the field at `option`: a rule with no condition on that
 * field does not depend on it; otherwise the option must be one the rule names (all: every
 * condition on the field names it; any: one does). The save-time check; the write checks the
 * task's real facts.
 */
export function readinessAccepts(
  rule: Readiness | null,
  projectNodeId: string,
  fieldNodeId: string,
  option: string,
): boolean {
  const named = (rule?.conditions ?? []).flatMap((c) =>
    c.kind === "project-field" &&
    c.projectNodeId === projectNodeId &&
    c.fieldNodeId === fieldNodeId
      ? [c.optionNodeId]
      : [],
  );
  if (!named.length) return true;
  return rule?.mode === "all"
    ? named.every((o) => o === option)
    : named.includes(option);
}
