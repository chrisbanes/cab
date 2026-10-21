import { z } from "zod";
import {
  evaluateReadiness,
  type Readiness,
} from "./github-source-contracts.js";

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
 * Whether some facts satisfy the rule with the field at `option`: every condition not
 * on that field is assumed to hold. The save-time check; the write checks the real facts.
 */
export function readinessAccepts(
  rule: Readiness | null,
  projectNodeId: string,
  fieldNodeId: string,
  option: string,
): boolean {
  if (!rule) return true;
  const others = rule.conditions.filter(
    (c) =>
      c.kind === "project-field" &&
      !(c.projectNodeId === projectNodeId && c.fieldNodeId === fieldNodeId),
  );
  return evaluateReadiness(rule, {
    labels: rule.conditions.flatMap((c) =>
      c.kind === "label" ? [c.name] : [],
    ),
    fields: [
      { projectNodeId, fieldNodeId, optionNodeId: option },
      ...others.flatMap((c) =>
        c.kind === "project-field"
          ? [
              {
                projectNodeId: c.projectNodeId,
                fieldNodeId: c.fieldNodeId,
                optionNodeId: c.optionNodeId,
              },
            ]
          : [],
      ),
    ],
  }).satisfied;
}
