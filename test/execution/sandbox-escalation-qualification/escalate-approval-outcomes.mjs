// Pure classification of one escalate-approval live run through cab. A cell is proved only
// from evidence that exists: a missing result file, escalation record or wire record never
// counts as the expected outcome.

/** The granular policy cab sends for an escalate-approval turn. */
export const ESCALATION_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: false,
    mcp_elicitations: false,
    skill_approval: false,
    request_permissions: false,
  },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The approve cell: the sandboxed control fails, the approved escalation runs Chromium, and
 * cab records operator, accept, an exit code and a duration with the policy it sent.
 */
export function approveCell(cell) {
  const e = cell.escalations?.find((x) => x.label === "escalated");
  const checks = {
    policySent:
      same(cell.wire?.approvalPolicy, ESCALATION_POLICY) &&
      cell.wire?.approvalsReviewer === "user" &&
      cell.wire?.sandboxType === "workspaceWrite",
    controlFailedInSandbox:
      typeof cell.results?.control === "string" &&
      cell.results.control !== "ok",
    escalatedRanOutside: cell.results?.escalated === "ok",
    recorded:
      e?.decider === "operator" &&
      e.decision === "accept" &&
      e.outcome === "approved" &&
      e.exitCode === 0 &&
      typeof e.durationMs === "number",
    // No unexpected-request report, unmatched resolutions included, in this cell.
    noAnomaly: Array.isArray(cell.unexpected) && cell.unexpected.length === 0,
  };
  return { checks, proved: Object.values(checks).every(Boolean) };
}

/**
 * The decline cell, a follow-up turn after a service restart: the thread resumes with the
 * persisted policy, the declined escalation writes nothing, and the turn completes.
 */
export function declineCell(cell) {
  const e = cell.escalations?.find((x) => x.label === "declined");
  const checks = {
    resumedWithPolicy:
      cell.resume?.ok === true &&
      (cell.resume.approvalPolicy === "never" ||
        same(cell.resume.approvalPolicy, ESCALATION_POLICY)),
    declinedWroteNothing:
      cell.results !== undefined && cell.results.declined === undefined,
    recorded:
      e?.decider === "operator" &&
      e.decision === "decline" &&
      e.outcome === "declined" &&
      e.exitCode === null,
    turnCompleted: cell.turnState === "completed",
    // No unexpected-request report, unmatched resolutions included, in this cell.
    noAnomaly: Array.isArray(cell.unexpected) && cell.unexpected.length === 0,
  };
  return { checks, proved: Object.values(checks).every(Boolean) };
}

/**
 * The interrupt cell is observation only: whether Codex resolves a pending request after a
 * Stop, and whether cab then reports an anomaly. Its absence is recorded, never a failure.
 */
export function interruptCell(cell) {
  const e = cell.escalations?.find((x) => x.label === "held");
  return {
    escalationObserved: e !== undefined,
    withdrawnObsolete: e?.outcome === "obsolete",
    resolvedAfterInterrupt: cell.resolvedAfterInterrupt ?? null,
    unmatchedResolutions: cell.unmatchedResolutions ?? 0,
  };
}

/** Per-item approval callbacks: more than one for an item means `approvalId` matters. */
export function approvalCallbacks(requests) {
  const perItem = new Map();
  for (const r of requests)
    perItem.set(r.itemId, (perItem.get(r.itemId) ?? 0) + 1);
  return {
    requests: requests.length,
    withApprovalId: requests.filter((r) => r.hasApprovalId).length,
    itemsWithSeveral: [...perItem.values()].filter((n) => n > 1).length,
  };
}
