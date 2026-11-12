// Pure classification of one escalate-auto-review live run through cab. A cell is proved only
// from evidence of its own turn: the review's started and completed notifications, sharing a
// reviewId, in the turn cab started; the completion of the item whose id is that review's
// targetItemId; the turn's successful end; and cab's recorded review with the same reviewId.
// A missing event never counts as the expected outcome. By controller decision D32 the run uses
// no denial stimulus, so the denial and overrule cells are untested.

/** The granular policy cab sends for an escalate-auto-review turn. */
export const ESCALATION_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: false,
    mcp_elicitations: false,
    skill_approval: false,
    request_permissions: false,
  },
};
export const noDenial =
  "denial not elicited: no denial stimulus used (controller decision D32)";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The `chromium.mjs` label of a command, such as `reviewed`; null for anything else. */
export const labelOf = (command) =>
  /chromium\.mjs ([a-z-]+)/.exec(command ?? "")?.[1] ?? null;

/**
 * The approval cell's own events: its turn, the paired approved review of the `reviewed`
 * command in that turn, the completion of the review's target item, and the turn's end.
 */
function ownEvents(cell) {
  const turnId = cell.turnId ?? null;
  const reviews = (cell.reviews ?? []).filter(
    (r) => r.turnId === turnId && labelOf(r.command) === "reviewed",
  );
  const completed = reviews.filter((r) => r.phase === "completed");
  const review = completed.length === 1 ? completed[0] : undefined;
  const started =
    review &&
    reviews.find(
      (r) =>
        r.phase === "started" &&
        r.reviewId === review.reviewId &&
        r.targetItemId === review.targetItemId,
    );
  const completion =
    review && typeof review.targetItemId === "string"
      ? (cell.completions ?? []).find(
          (c) => c.turnId === turnId && c.itemId === review.targetItemId,
        )
      : undefined;
  const end = (cell.turnEnds ?? []).find((t) => t.turnId === turnId);
  const recorded =
    review && (cell.recorded ?? []).find((r) => r.reviewId === review.reviewId);
  return { completed, review, started, completion, end, recorded };
}

const cite = ({ review, completion, end }) => ({
  reviewId: review?.reviewId ?? null,
  turnId: review?.turnId ?? null,
  targetItemId: review?.targetItemId ?? null,
  itemStatus: completion?.status ?? null,
  exitCode: completion?.exitCode ?? null,
  turnStatus: end?.status ?? null,
});

/**
 * The approval cell: the sandboxed control fails, the reviewer approves the escalated command
 * in this turn, that review's own target item completes and runs Chromium, the turn completes,
 * and cab records the reviewer's decision with that item's exit code and a duration.
 */
export function approvalCell(cell) {
  const events = ownEvents(cell);
  const { completed, review, started, completion, end, recorded } = events;
  const checks = {
    policySent:
      same(cell.wire?.approvalPolicy, ESCALATION_POLICY) &&
      cell.wire?.approvalsReviewer === "auto_review" &&
      cell.wire?.sandboxType === "workspaceWrite",
    controlFailedInSandbox:
      typeof cell.results?.control === "string" &&
      cell.results.control !== "ok",
    reviewPaired: started !== undefined && review?.actionType === "command",
    reviewApproved: review?.status === "approved",
    targetItemCompleted:
      completion?.status === "completed" && completion.exitCode === 0,
    ranOutsideSandbox: cell.results?.reviewed === "ok",
    turnCompleted: end?.status === "completed",
    recorded:
      recorded?.decider === "reviewer" &&
      recorded.decision === "accept" &&
      recorded.outcome === "approved" &&
      recorded.riskLevel === review?.riskLevel &&
      recorded.exitCode === completion?.exitCode &&
      typeof recorded.durationMs === "number",
    noClientEscalation: (cell.clientRequests ?? []).length === 0,
    noAnomaly: Array.isArray(cell.unexpected) && cell.unexpected.length === 0,
  };
  // Missing evidence leaves the cell untested; only present, contradicting evidence refutes it.
  const untested =
    completed.length !== 1
      ? "no single completed review of the escalated command in this turn"
      : started === undefined
        ? "no started review with the completed reviewId"
        : review.status !== "approved"
          ? `the reviewer ${review.status} the benign command`
          : completion === undefined
            ? "no completion of the review's target item"
            : end === undefined
              ? "the turn's end was not observed"
              : recorded === undefined
                ? "no recorded review with this reviewId"
                : null;
  const outcome = untested
    ? "untested"
    : Object.values(checks).every(Boolean)
      ? "proved"
      : "refuted";
  return {
    outcome,
    ...(untested ? { reason: untested } : {}),
    checks,
    evidence: cite(events),
  };
}

/** By D32 nothing elicits a denial; a denial the reviewer made anyway is recorded, not used. */
export function denialCells(cell) {
  const denials = (cell.reviews ?? []).filter(
    (r) => r.phase === "completed" && r.status === "denied",
  );
  const observed = denials.map((r) => ({
    reviewId: r.reviewId,
    command: r.command,
  }));
  return {
    denial: { outcome: "untested", reason: noDenial, observed },
    overrule: { outcome: "untested", reason: noDenial },
    // F9: whether a re-review after an overrule reuses the denial's reviewId needs an overrule.
    reusedReviewId: { outcome: "untested", reason: noDenial },
  };
}

/**
 * Whether a denial of this command would be offered an overrule: cab records the working
 * directory relative to the task workspace when it lies inside it.
 */
export function cwdEligibility(cell) {
  const { recorded } = ownEvents(cell);
  if (!recorded || recorded.cwd === null || recorded.cwd === undefined)
    return { observed: false };
  return {
    observed: true,
    cwd: recorded.cwd,
    insideWorkspace: !recorded.cwd.startsWith("/"),
  };
}
