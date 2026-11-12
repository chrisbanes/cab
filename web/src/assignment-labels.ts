import { outcomeLine, shortId } from "./presentation.js";

/** An assignment as a label sees it; `name` is null when withheld or unknown. */
export interface LabelledAssignment {
  assignmentId: string;
  name: string | null;
  brief?: string | null | undefined;
}

/**
 * What tells an assignment apart from others with the same name, in the order to show it:
 * nothing for a unique name, else the brief's first sentence, plus the short ID only when
 * that sentence repeats too (or the brief is absent).
 */
export function assignmentDistinction(
  assignment: LabelledAssignment,
  assignments: readonly LabelledAssignment[],
): string[] {
  const same = assignments.filter((a) => a.name === assignment.name);
  if (same.length < 2) return [];
  const line = outcomeLine(assignment.brief ?? null).line;
  const repeated =
    same.filter((a) => outcomeLine(a.brief ?? null).line === line).length > 1;
  return [line, repeated ? shortId(assignment.assignmentId) : ""].filter(
    Boolean,
  );
}
