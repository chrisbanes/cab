import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";

type ComparisonData = WorkspaceComparisonRead["data"];
type ComparisonEntry = NonNullable<
  Extract<
    ComparisonData,
    { state: "available" }
  >["comparison"]["entries"][number]
>;

export function comparisonReasonSentence(reason: string | undefined) {
  switch (reason) {
    case "workspace-unavailable":
      return "Not read yet: workspace was unavailable. Refresh to read it again.";
    case "time-limit":
      return "A time limit stopped the comparison. The overall observation budget is 5 seconds; reduce the comparison scope, then refresh.";
    case "output-limit":
      return "The comparison stopped at a bounded output limit. The recorded reason does not identify which limit; it may include the 2,048-lines-per-side or 1 MiB rendered-diff bound. Reduce the comparison scope or inspect files locally.";
    case "base-branch-required":
      return "The configured ref is not a local branch. Select a local branch; none is inferred or checked out.";
    case "base-branch-unavailable":
      return "The selected local branch is not available. Select another local branch.";
    case "no-merge-base":
      return "The selected local branch has no usable merge base.";
    case "workspace-changed":
      return "The workspace changed while this comparison was read. Refresh to read it again.";
    default:
      return reason ? "The comparison could not be read completely." : "";
  }
}

export function comparisonObservationTimes(read: ComparisonData): number[] {
  const times: number[] = [];
  if ("comparison" in read && read.comparison)
    times.push(read.comparison.observedAt);
  if (read.state === "unsettled") {
    times.push(read.pending.observedAt);
    if (read.pending.beforeObservedAt !== undefined)
      times.push(read.pending.beforeObservedAt);
    if (read.pending.afterObservedAt !== undefined)
      times.push(read.pending.afterObservedAt);
    if (read.latestFinished) times.push(read.latestFinished.observedAt);
  }
  return times;
}

export function isWorkspaceComparisonStale(
  snapshotObservedAt: number,
  knownObservationTimes: readonly number[],
) {
  return knownObservationTimes.some(
    (observedAt) => observedAt > snapshotObservedAt,
  );
}

export function comparisonEntryLimitSentence(
  entry: ComparisonEntry,
): string | null {
  if (entry.reason === "too-large") {
    const oversizedSides = (["Before", "After"] as const).filter((side) => {
      const content = side === "Before" ? entry.left : entry.right;
      return (content?.size ?? 0) > 1024 * 1024;
    });
    return oversizedSides.length
      ? `${entry.path} exceeds the 1 MiB file limit on the ${oversizedSides.join(" and ")} side${oversizedSides.length === 1 ? "" : "s"}. Inspect it locally or reduce the comparison scope.`
      : `${entry.path} exceeded a comparison content limit. Inspect it locally or reduce the comparison scope.`;
  }
  if (entry.reason !== "output-limit") return null;

  const oversizedSides = (["Before", "After"] as const).filter((side) => {
    const content = side === "Before" ? entry.left : entry.right;
    return (content?.lineCount ?? 0) > 2048;
  });
  if (oversizedSides.length)
    return `${entry.path} exceeds 2,048 lines on the ${oversizedSides.join(" and ")} side${oversizedSides.length === 1 ? "" : "s"}. Inspect it locally or reduce the comparison scope.`;

  return `${entry.path} exceeded a comparison bound. The available reason cannot distinguish the 1 MiB rendered-diff limit from another bounded diff limit. Inspect it locally or reduce the comparison scope.`;
}
