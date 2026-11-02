import type { Execution, TaskRead } from "../../src/operator/contracts.js";
import { type HoldLine, holdLines } from "../../src/operator/wait-reasons.js";
import { reasonLabels } from "./tasks.js";

type Data = TaskRead["data"];
type Holds = Execution["holds"];
type Recovery = NonNullable<Data["executionRecovery"]>;

const stateLabels: Record<Execution["state"], string> = {
  idle: "No active execution is reported",
  selected: "Selected; waiting for admission",
  queued: "Queued; waiting for capacity admission",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  paused: "Paused; no new admission",
  stopping: "Stopping; effects may continue",
  uncertain: "Uncertain or held; recovery is required",
  "not-started": "Not started; refused before it ran",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** States that need no recovery; any recorded hold beside one still means recovery. */
const settled = new Set<Execution["state"]>([
  "idle",
  "selected",
  "queued",
  "waiting",
  "paused",
  "not-started",
  "completed",
  "cancelled",
]);

/** The holds `execution` reports or any task record keeps, an omitted one included. */
export function taskHolds(execution: Execution, recovery?: Recovery): Holds {
  const recorded = recovery?.holds;
  return {
    stop: execution.holds.stop || Boolean(recorded?.stop),
    writer: execution.holds.writer || Boolean(recorded?.writer),
    capacity: execution.holds.capacity || Boolean(recorded?.capacity),
    uncertainty: execution.holds.uncertainty || Boolean(recorded?.uncertainty),
    task: execution.holds.task || Boolean(recorded?.task),
  };
}

/** Said when the task-wide recovery read is withheld: holds only older records keep are unknown. */
export const holdsUnreadable =
  "Holds from older records can't be read here; open each assignment's recovery.";

/**
 * The task's execution status in the task read's own order, and whether recovery is required.
 * A hold the status does not show is named, so a held execution never reads as idle or queued;
 * without the task-wide recovery read the status is never presented as safe either.
 */
export function executionStatus(execution: Execution, recovery?: Recovery) {
  const holds = taskHolds(execution, recovery);
  const label =
    execution.state === "uncertain" &&
    execution.reasonCodes.includes("runtime-unconfirmed")
      ? "Admitted; runtime state is not confirmed"
      : execution.state === "waiting" &&
          execution.reasonCodes.includes("admission-blocked")
        ? "Waiting; blocked from admission"
        : stateLabels[execution.state];
  // A running turn owns its writer and capacity; any other hold, or one left behind, is held.
  const leftover =
    Object.values(holds).some(Boolean) && settled.has(execution.state);
  return {
    label,
    held:
      !recovery ||
      leftover ||
      holds.stop ||
      holds.uncertainty ||
      holds.task ||
      ["stopping", "uncertain"].includes(execution.state),
    note:
      [
        leftover &&
          "Execution holds are still recorded; recovery is required before another writer.",
        !recovery && holdsUnreadable,
      ]
        .filter(Boolean)
        .join(" ") || null,
  };
}

/** One line per active hold, Stop first, in the wording the wait reasons use. */
export function executionHoldLines(
  execution: Execution,
  taskHold: Data["taskHold"],
  recovery?: Recovery,
): HoldLine[] {
  const holds = taskHolds(execution, recovery);
  return holdLines(holds, taskHold ?? (holds.task ? { reason: null } : null));
}

export const admissionLine = (admission: Data["admission"]) =>
  admission.eligible
    ? "Task admission gates are clear"
    : `Task admission blocked: ${admission.reasons.map((r) => reasonLabels[r]).join(", ")}`;

export const evidenceWarning =
  "Recorded identities, observations, receipts and dispositions are evidence only; they do not prove that a process has terminated or that all effects have been released.";
export const resumeWarning =
  "Effects may continue while an execution is stopping. Resume clears only the Stop. Elapsed time, interruption acknowledgement and Resume do not resolve writer ownership; use independent recovery evidence before allowing another writer.";

/** What the evidence list says above its records: unavailable, none, or how many are omitted. */
export function evidenceNotice(recovery: Recovery | undefined): string | null {
  if (!recovery)
    return "Recovery evidence is withheld for this task (its history can't be shown safely) or the service does not report it.";
  if (!recovery.evidenceAvailable)
    return "No recovery records are recorded for this task. That is not evidence of release.";
  return recovery.omittedCount
    ? `Showing the newest ${recovery.records.length} of ${recovery.records.length + recovery.omittedCount} recorded recovery records; ${recovery.omittedCount} older ${recovery.omittedCount === 1 ? "record is" : "records are"} omitted.`
    : null;
}

/** One record's facts in a line; identities are evidence, not proof of termination. */
export function recordLine(record: Recovery["records"][number]): string {
  const holds = Object.entries(record.holds)
    .filter(([, on]) => on)
    .map(([kind]) => kind);
  return [
    `Intent ${record.intentState}`,
    `request ${record.requestState ?? "not recorded"}`,
    holds.length ? `holds: ${holds.join(", ")}` : "no holds recorded",
    record.receiptRecorded
      ? `receipt recorded; workspace ${record.workspace}`
      : "no receipt",
    `${record.pendingEffectCount} pending ${record.pendingEffectCount === 1 ? "effect" : "effects"}`,
  ].join(" · ");
}

/** Which captured revisions are behind the current ones; empty when the row is current. */
export function staleRevisions(a: Data["assignments"][number]): string[] {
  // A first turn takes the revisions current when it is admitted: nothing to apply yet.
  if (a.started === false) return [];
  return [
    a.instructionsRevision !== a.currentInstructionsRevision &&
      `instructions ${a.instructionsRevision} → ${a.currentInstructionsRevision}`,
    a.profileRevision !== a.currentProfileRevision &&
      `profile ${a.profileRevision} → ${a.currentProfileRevision}`,
  ].filter((v): v is string => Boolean(v));
}
