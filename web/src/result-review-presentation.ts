import type { TaskRead } from "../../src/operator/contracts.js";
import { clockLabel } from "./presentation.js";

type Data = TaskRead["data"];
export type ResultReview = NonNullable<Data["resultReviews"]>[number];
type Result = Data["results"][number];

/** Who stands behind a fact in the review panel. */
export const reportedByLead = "Reported by the lead";
export const recordedByCab = "Recorded by cab";

/** The review's state in words; a pending review needs no banner. */
export function reviewStatus(review: ResultReview): string | null {
  switch (review.status) {
    case "pending":
      return null;
    case "responded":
      return review.response?.response === "feedback"
        ? "Feedback sent"
        : "Reviewed";
    case "superseded":
      return "Superseded by a newer result";
    case "withdrawn":
      return review.withdrawReason
        ? `Withdrawn by the lead: ${review.withdrawReason}`
        : "Withdrawn by the lead";
    case "closed":
      return "Closed with the task";
  }
}

/** An omitted list is not an empty one: neither is shown as "none". */
export function uncertaintyLines(uncertainties: ResultReview["uncertainties"]) {
  if (uncertainties === null)
    return { items: [], empty: "No remaining uncertainty recorded" };
  if (!uncertainties.length)
    return { items: [], empty: "The lead listed no remaining uncertainty" };
  return {
    items: uncertainties.map((u) => u ?? "Unavailable or redacted"),
    empty: null,
  };
}

/** A validation's checked head against the heads cab recorded for the result. */
export function resultHeadComparison(
  checkedHead: string | undefined,
  workspace: Result["workspace"],
) {
  if (!checkedHead || !workspace.length) return "Head comparison unknown";
  const match = workspace.find((w) => w.headCommit === checkedHead);
  if (!match)
    return "Checked a different head than the one recorded for this result";
  return match.dirty
    ? "Checked the head recorded for this result, which had uncommitted changes"
    : "Checked the head recorded for this result";
}

/** "R2 · work revision 2 · recorded 14:05": the result identity cab recorded. */
export function resultIdentity(data: Pick<Data, "results">, resultId: string) {
  const index = data.results.findIndex((r) => r.resultId === resultId),
    result = data.results[index];
  if (!result) return "Result unavailable";
  return `R${index + 1} · work revision ${result.workRevision} · recorded ${clockLabel(result.createdAt < 1e12 ? result.createdAt * 1000 : result.createdAt)}`;
}

/** When the lead supplied no review metadata, say so rather than show empty sections. */
export const missingEvidence = (
  data: Pick<Data, "review">,
  resultId: string,
) =>
  data.review?.results.some((r) => r.resultId === resultId)
    ? null
    : "The lead recorded no criteria, validations or artifacts for this result.";

/** The task's review requests still waiting on the operator. */
export const pendingReviews = (data: Pick<Data, "resultReviews">) =>
  (data.resultReviews ?? []).filter(
    (r) => r.status === "pending" && r.lifecycle?.status !== "dismissed",
  );
