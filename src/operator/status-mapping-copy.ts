import type { StatusMappingEvent } from "../core/status-mapping-contracts.js";
import { projectFieldChangedReason } from "./github-reasons.js";

/**
 * The one wording for the status mapping (SPEC "Status mapping"). The server refusal, the web
 * editor and the task's delivery actions import it, so every surface reads the same.
 */
export const statusEventLabels: Record<StatusMappingEvent, string> = {
  turnStarted: "First turn started",
  handedBack: "PR handed back for review",
  held: "Stopped, uncertain or blocked",
  done: "Done",
};

export const statusEventHints: Record<StatusMappingEvent, string> = {
  turnStarted: "In flight: the Status must still make the task Ready.",
  handedBack: "In flight: the Status must still make the task Ready.",
  held: "May remove readiness: the task then waits until it is Ready again.",
  done: "Written while the task is Ready, or once it is done and its issue is closed. May remove readiness.",
};

/** Why a mapped option cannot be saved, naming the event and the option. */
export const statusMappingRefusalSentence = (
  reason: "no-selection" | "ungranted" | "approval-only" | "readiness",
  event: StatusMappingEvent | null,
  option: string,
  tracker: "github" | "jira" = "github",
) => {
  const jira = tracker === "jira";
  const named = `${event ? statusEventLabels[event] : "The mapping"} → ${option}`;
  switch (reason) {
    case "no-selection":
      return jira
        ? "The mapping needs a Jira source of this project. Add one first."
        : "The mapping needs a GitHub Project source of this project. Add one first.";
    case "ungranted":
      return jira
        ? `${named}: no issue status grant covers this status. Allow it in the delivery policy first.`
        : `${named}: no project field grant covers this option. Allow it in the delivery policy first.`;
    case "approval-only":
      return `${named}: the grant for this ${jira ? "status" : "option"} needs approval, and cab cannot ask for one. Change it to Allow.`;
    case "readiness":
      return `${named}: the readiness rule does not accept this ${jira ? "status" : "option"}, so cab's own write would make the task not Ready.`;
  }
};

/** What the mapping does and does not do, beside its editor. */
export const statusMappingBoundary = [
  "cab writes the Status, not an agent. Each mapped option needs an Allow grant for that Project field; options without one are marked (no grant).",
  "It writes only for tasks that are already Ready, or Done once the task is done and its issue is closed, and never makes a task Ready. In-flight events must name an option the readiness rule accepts.",
  "Immediately before writing it reads the Status again. If the card moved on GitHub since cab last saw it, the write is skipped and the task says so.",
  "A write whose result is not proved shows on the task but does not hold it or block the next write.",
];

/** The Jira variant of the boundary. */
export const jiraStatusMappingBoundary = [
  "cab moves the issue, not an agent. Each mapped status ID needs an Allow issue status grant; IDs without one are marked (no grant).",
  "It writes only for tasks that are already Ready, or Done once the task is done and its issue is closed, and never makes a task Ready. In-flight events must name a status the readiness rule accepts.",
  "Immediately before writing it reads the issue and its transitions. The write is skipped, and the task says so, if the status changed in Jira since cab last saw it, the issue is already there, or not exactly one transition reaches the status.",
  "A write whose result is not proved shows on the task but does not hold it or block the next write.",
];

export const statusMappingCaveat =
  "cab writes only for tasks that are already Ready, except Done on a closed issue. If a Project filter excludes an in-flight Status, the task leaves the source on the next sync and is held.";

export const jiraStatusMappingCaveat =
  "cab writes only for tasks that are already Ready, except Done on a closed issue. If a query excludes an in-flight status, the task leaves the source on the next sync and is held.";

/** The label of a task's status-mapping write; the board is reflected, not driven. */
export const statusMappingActionLabel = "Status mapping";

/** The reasons a Jira status write is skipped: nothing is sent. */
export const jiraStatusSkipReasons = {
  changed: "provider-issue-status-changed",
  current: "provider-issue-status-current",
  unavailable: "provider-transition-unavailable",
  ambiguous: "provider-transition-ambiguous",
} as const;

const statusSkipNotes = new Map<string, string>([
  [
    projectFieldChangedReason,
    "Skipped: Status changed on GitHub since cab last saw it.",
  ],
  [
    jiraStatusSkipReasons.changed,
    "Skipped: the status changed in Jira since cab last saw it.",
  ],
  [
    jiraStatusSkipReasons.current,
    "Skipped: the issue is already in the mapped status.",
  ],
  [
    jiraStatusSkipReasons.unavailable,
    "Skipped: no available transition reaches the mapped status.",
  ],
  [
    jiraStatusSkipReasons.ambiguous,
    "Skipped: several transitions reach the mapped status.",
  ],
]);

/** The task-level wording of a mapped write that did not happen or is not proved. */
export const statusMappingActionNote = (reason: string | null) =>
  (reason && statusSkipNotes.get(reason)) || null;
