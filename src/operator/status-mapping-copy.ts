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
  done: "May remove readiness: the task then waits until it is Ready again.",
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
      return `${named}: the grant for this option needs approval, and Ensemble cannot ask for one. Change it to Allow.`;
    case "readiness":
      return `${named}: the readiness rule does not accept this option, so Ensemble's own write would make the task not Ready.`;
  }
};

export const statusMappingCaveat =
  "Ensemble writes only for tasks that are already Ready. If a Project filter excludes an in-flight Status, the task leaves the source on the next sync and is held.";

/** The label of a task's status-mapping write; the board is reflected, not driven. */
export const statusMappingActionLabel = "Status mapping";

/** The task-level wording of a mapped write that did not happen or is not proved. */
export const statusMappingActionNote = (reason: string | null) =>
  reason === projectFieldChangedReason
    ? "Skipped: Status changed on GitHub since Ensemble last saw it."
    : null;
