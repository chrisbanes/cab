import { z } from "zod";
import type { Readiness } from "./github-source-contracts.js";

const optionId = z.string().trim().min(1).max(512);
/** The cab work events that can move a task's Project Status, in precedence order of display. */
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

const eventsSchema = z
  .object({
    turnStarted: optionId.nullable(),
    handedBack: optionId.nullable(),
    held: optionId.nullable(),
    done: optionId.nullable(),
  })
  .strict();
/** A GitHub Project Status mapping; a stored mapping without `tracker` is this one. */
export const githubStatusMappingSchema = z
  .object({
    selectionId: optionId,
    projectNodeId: optionId,
    fieldNodeId: optionId,
    events: eventsSchema,
  })
  .strict();
/** A Jira mapping: target status IDs, bound to the project's Jira source (status IDs are site-wide). */
export const jiraStatusMappingSchema = z
  .object({ tracker: z.literal("jira"), events: eventsSchema })
  .strict();
export const statusMappingSchema = z.union([
  jiraStatusMappingSchema,
  githubStatusMappingSchema,
]);
export type GitHubStatusMapping = z.output<typeof githubStatusMappingSchema>;
export type JiraStatusMapping = z.output<typeof jiraStatusMappingSchema>;
export type StatusMapping = z.output<typeof statusMappingSchema>;
export const isJiraMapping = (m: StatusMapping): m is JiraStatusMapping =>
  "tracker" in m;

/** Whether the rule can still hold given each applicable condition's verdict (all: every one; any: one). */
const combine = (rule: Readiness | null, accepts: boolean[]) =>
  !accepts.length ||
  (rule?.mode === "all" ? accepts.every(Boolean) : accepts.some(Boolean));

/**
 * Whether the rule can still hold with the field at `option`: a rule with no condition on that
 * field does not depend on it; otherwise the option must satisfy the rule's conditions on the field
 * (all: every one; any: one). The save-time check; the write checks the task's real facts.
 */
export function readinessAccepts(
  rule: Readiness | null,
  projectNodeId: string,
  fieldNodeId: string,
  option: string,
): boolean {
  return combine(
    rule,
    (rule?.conditions ?? []).flatMap((c) =>
      c.kind === "project-field" &&
      c.projectNodeId === projectNodeId &&
      c.fieldNodeId === fieldNodeId
        ? [c.optionNodeIds.includes(option) === (c.operator === "in")]
        : [],
    ),
  );
}

/** The same save-time check for a Jira status: only the rule's `status` conditions depend on it. */
export function readinessAcceptsStatus(
  rule: Readiness | null,
  statusId: string,
): boolean {
  return combine(
    rule,
    (rule?.conditions ?? []).flatMap((c) =>
      c.kind === "status"
        ? [c.statusIds.includes(statusId) === (c.operator === "in")]
        : [],
    ),
  );
}
