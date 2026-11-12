import {
  assignmentDistinction,
  type LabelledAssignment,
} from "./assignment-labels.js";

/** An assignment whose recovery page a hold line links; its name is null when withheld, as in Settings. */
export type RecoveryAssignment = LabelledAssignment;

/** One link label per assignment; repeated names gain the brief's first sentence, then the short id. */
export function recoveryEvidenceLabels(
  assignments: readonly RecoveryAssignment[],
): string[] {
  return assignments.map((a) => {
    const label = `${a.name ?? "Agent name unavailable"}: recovery evidence`;
    const parts = assignmentDistinction(a, assignments);
    return parts.length ? `${label} (${parts.join("; ")})` : label;
  });
}
