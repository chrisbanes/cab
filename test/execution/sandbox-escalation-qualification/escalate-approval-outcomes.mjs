// Pure classification of one escalate-approval live run through cab. A cell is proved only
// from evidence that exists, and every proof cites the runtime event it rests on: the
// approval request Codex sent for the labelled command and the completion of that request's
// command item. A missing result file, escalation record, request or completion never counts
// as the expected outcome. Each cell is proved, refuted or untested.

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

/** The `chromium.mjs` label of a command, such as `escalated`; null for anything else. */
export const labelOf = (command) =>
  /chromium\.mjs ([a-z-]+)/.exec(command ?? "")?.[1] ?? null;

/** The cell's one approval request for `label`, and the completion of its command item. */
function runtimeEvents(cell, label) {
  const requests = (cell.requests ?? []).filter(
    (r) => labelOf(r.command) === label,
  );
  const request = requests.length === 1 ? requests[0] : undefined;
  const completion = request
    ? (cell.completions ?? []).find((c) => c.itemId === request.itemId)
    : undefined;
  return { requests: requests.length, request, completion };
}

const outcome = (checks, refuted, untested) =>
  refuted
    ? "refuted"
    : untested
      ? "untested"
      : Object.values(checks).every(Boolean)
        ? "proved"
        : "refuted";

/**
 * The approve cell: the sandboxed control fails, Codex asks for the escalated command, the
 * operator's approval is recorded, and that request's own item completes and runs Chromium,
 * with the exit code and duration cab recorded.
 */
export function approveCell(cell) {
  const e = cell.escalations?.find((x) => x.label === "escalated");
  const { requests, request, completion } = runtimeEvents(cell, "escalated");
  const checks = {
    policySent:
      same(cell.wire?.approvalPolicy, ESCALATION_POLICY) &&
      cell.wire?.approvalsReviewer === "user" &&
      cell.wire?.sandboxType === "workspaceWrite",
    controlFailedInSandbox:
      typeof cell.results?.control === "string" &&
      cell.results.control !== "ok",
    requestObserved: request !== undefined,
    escalatedItemCompleted:
      completion?.status === "completed" && completion.exitCode === 0,
    escalatedRanOutside: cell.results?.escalated === "ok",
    recorded:
      e?.decider === "operator" &&
      e.decision === "accept" &&
      e.outcome === "approved" &&
      e.exitCode === completion?.exitCode &&
      typeof e.durationMs === "number",
    // No unexpected-request report, unmatched resolutions included, in this cell.
    noAnomaly: Array.isArray(cell.unexpected) && cell.unexpected.length === 0,
  };
  const result = outcome(
    checks,
    // The approved request's item was declined or failed: approval did not run it.
    completion !== undefined && completion.status !== "completed",
    // Without its own request and completion, nothing shows what ran.
    requests !== 1 || completion === undefined,
  );
  return { checks, outcome: result, proved: result === "proved" };
}

/**
 * The decline cell, a follow-up turn after a service restart: the thread resumes with an
 * accepted policy, Codex asks for the declined command, the operator's decline is recorded,
 * and that request's own item completes `declined` and writes nothing. An item that ran
 * refutes the refusal; no completion at all leaves it untested.
 */
export function declineCell(cell) {
  const e = cell.escalations?.find((x) => x.label === "declined");
  const { requests, request, completion } = runtimeEvents(cell, "declined");
  const checks = {
    resumedWithPolicy:
      cell.resume?.ok === true &&
      (cell.resume.approvalPolicy === "never" ||
        same(cell.resume.approvalPolicy, ESCALATION_POLICY)),
    requestObserved: request !== undefined,
    declinedItemCompletion: completion?.status === "declined",
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
  const result = outcome(
    checks,
    // The declined command ran anyway.
    (completion !== undefined && completion.status !== "declined") ||
      cell.results?.declined !== undefined,
    requests !== 1 || completion === undefined,
  );
  return { checks, outcome: result, proved: result === "proved" };
}

/**
 * The interrupt cell is observation only: whether Codex resolves a pending request after a
 * Stop, and whether cab then reports an anomaly. The escalation counts as observed only with
 * Codex's own request for it, and as withdrawn only when its item never ran.
 */
export function interruptCell(cell) {
  const e = cell.escalations?.find((x) => x.label === "held");
  const { request, completion } = runtimeEvents(cell, "held");
  const observed = request !== undefined && e !== undefined;
  return {
    escalationObserved: observed,
    withdrawnObsolete:
      observed &&
      e.outcome === "obsolete" &&
      (completion === undefined || completion.status !== "completed"),
    resolvedAfterInterrupt: observed
      ? (cell.resolvedAfterInterrupt ?? null)
      : null,
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
