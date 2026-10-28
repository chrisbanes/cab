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
) => {
  const named = `${event ? statusEventLabels[event] : "The mapping"} → ${option}`;
  switch (reason) {
    case "no-selection":
      return "The mapping needs a GitHub Project source of this project. Add one first.";
    case "ungranted":
      return `${named}: no project field grant covers this option. Allow it in the delivery policy first.`;
    case "approval-only":
      return `${named}: the grant for this option needs approval, and cab cannot ask for one. Change it to Allow.`;
    case "readiness":
      return `${named}: the readiness rule does not accept this option, so cab's own write would make the task not Ready.`;
  }
};

/** What the mapping does and does not do, beside its editor. */
export const statusMappingBoundary = [
  "cab writes the Status, not an agent. Each mapped option needs an Allow grant for that Project field; options without one are marked (no grant).",
  "It writes only for tasks that are already Ready, or Done once the task is done and its issue is closed, and never makes a task Ready. In-flight events must name an option the readiness rule accepts.",
  "Immediately before writing it reads the Status again. If the card moved on GitHub since cab last saw it, the write is skipped and the task says so.",
  "A write whose result is not proved shows on the task but does not hold it or block the next write.",
];

export const statusMappingCaveat =
  "cab writes only for tasks that are already Ready, except Done on a closed issue. If a Project filter excludes an in-flight Status, the task leaves the source on the next sync and is held.";

/** The label of a task's status-mapping write; the board is reflected, not driven. */
export const statusMappingActionLabel = "Status mapping";

/** The task-level wording of a mapped write that did not happen or is not proved. */
export const statusMappingActionNote = (reason: string | null) =>
  reason === projectFieldChangedReason
    ? "Skipped: Status changed on GitHub since cab last saw it."
    : null;
