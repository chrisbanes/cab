import { outcomeLine, shortId } from "./presentation.js";

/** An assignment whose recovery page a hold line links. */
export interface RecoveryAssignment {
  assignmentId: string;
  /** Null when the profile name is withheld, as in Settings. */
  name: string | null;
  brief?: string | null | undefined;
}

/** One link label per assignment; repeated names gain the brief's first sentence, then the short id. */
export function recoveryEvidenceLabels(
  assignments: readonly RecoveryAssignment[],
): string[] {
  const count = <T>(xs: T[]) => {
    const m = new Map<T, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const names = count(assignments.map((a) => a.name));
  const briefs = count(
    assignments.map((a) => `${a.name}\n${outcomeLine(a.brief ?? null).line}`),
  );
  return assignments.map((a) => {
    const label = `${a.name ?? "Agent name unavailable"}: recovery evidence`;
    if ((names.get(a.name) ?? 0) < 2) return label;
    const line = outcomeLine(a.brief ?? null).line;
    const repeated = (briefs.get(`${a.name}\n${line}`) ?? 0) > 1;
    const parts = [line, repeated ? shortId(a.assignmentId) : ""].filter(
      Boolean,
    );
    return parts.length ? `${label} (${parts.join("; ")})` : label;
  });
}
