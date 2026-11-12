// Pure classification of one Claude escalation live run through cab (#1682 T4). Each task has
// one turn; a cell is proved only from that turn's own events: the PreToolUse hook record of
// the labelled call (by tool_use_id), its post-tool hook, any canUseTool ask, cab's stored
// escalation or review whose item is that tool_use_id in that turn, the same turn's sandboxed
// control and the turn's successful end. A missing event never counts as the expected outcome.
// By controller decision D32 the run uses only benign stimuli, so a classifier denial and an
// undecided call are untested unless the run happened to produce them.

export const noDenial =
  "denial not elicited: no denial stimulus used (controller decision D32)";
export const noUndecided =
  "classifier decided every flagged call; no undecided call elicited (benign stimuli only, D32)";

/** The `chromium.mjs` label of a command, such as `approved`; null for anything else. */
export const labelOf = (command) =>
  /^node chromium\.mjs ([a-z-]+)$/.exec(command?.trim() ?? "")?.[1] ?? null;

const proved = (evidence) => ({ outcome: "proved", evidence });
const refuted = (evidence) => ({ outcome: "refuted", evidence });
const untested = (reason, evidence) => ({
  outcome: "untested",
  reason,
  ...(evidence === undefined ? {} : { evidence }),
});
const ran = (result) => result === "ok";
const blocked = (result) => typeof result === "string" && result !== "ok";

const of = (cell, kind, id) =>
  (cell.events ?? []).filter((e) => e.kind === kind && e.toolUseId === id);

/** The turn's one hook record for `label` with the given flag; several are ambiguous. */
function callFor(cell, label, flagged) {
  const calls = (cell.events ?? []).filter(
    (e) =>
      e.kind === "pre" && labelOf(e.command) === label && e.flagged === flagged,
  );
  return {
    call: calls.length === 1 ? calls[0] : undefined,
    count: calls.length,
  };
}

/** The turn ended successfully: cab's intent completed and the SDK result was a success. */
const terminal = (cell) =>
  cell.intentState === "completed" &&
  cell.result?.subtype === "success" &&
  cell.result.isError === false;

/** Records of this turn whose item (or review target) is the call's tool_use_id. */
const escalationsFor = (cell, id) =>
  (cell.escalations ?? []).filter(
    (e) => e.turnId === cell.turnId && e.itemId === id,
  );
const reviewsFor = (cell, id) =>
  (cell.reviews ?? []).filter(
    (r) =>
      r.turnId === cell.turnId && r.reviewId === id && r.targetItemId === id,
  );

/**
 * The turn's sandboxed control: unflagged, passed by the hook, run (its own post-tool hook) with
 * no permission ask, and Chromium failed inside the sandbox.
 */
export function controlCell(cell, label) {
  const { call, count } = callFor(cell, label, false);
  if (!call)
    return untested(
      count > 1 ? "control called more than once" : "no control call",
    );
  const evidence = {
    toolUseId: call.toolUseId,
    hookAtMs: call.t,
    decision: call.decision,
    postHook: of(cell, "post", call.toolUseId)[0]?.event ?? null,
    asked: of(cell, "ask", call.toolUseId).length > 0,
    chromium: cell.results?.[label] ?? null,
  };
  if (call.decision !== "pass" || evidence.asked)
    return refuted({
      ...evidence,
      reason: "the control was not left to the sandbox",
    });
  if (!evidence.postHook) return untested("the control did not run", evidence);
  if (ran(evidence.chromium))
    return untested(
      "control launched Chromium; the sandbox is not shown",
      evidence,
    );
  return blocked(evidence.chromium)
    ? proved(evidence)
    : untested("control wrote no result", evidence);
}

const turnEvidence = (cell) => ({
  turnId: cell.turnId ?? null,
  permissionMode: cell.init?.permissionMode ?? null,
  intentState: cell.intentState ?? null,
  result: cell.result ?? null,
  unexpected: cell.unexpected ?? [],
});

/** Preconditions every cell of a turn shares; a reason when they fail. */
function turnProblem(cell) {
  if (typeof cell.turnId !== "string" || cell.turnId === "")
    return "no turn id from cab's startTurn";
  if (cell.init?.permissionMode !== "auto")
    return "turn not confirmed in auto mode";
  if (!terminal(cell)) return "turn did not end successfully";
  if ((cell.unexpected ?? []).length > 0)
    return "unexpected request in the turn";
  return undefined;
}

/**
 * escalate-approval, approve: the flagged `approved` call was held, the operator accepted it,
 * the hook allowed it, it ran (its own post-tool hook after the hook returned) and launched
 * Chromium while the same turn's control failed, and cab recorded that item's operator
 * acceptance with exit code 0 and a duration.
 */
export function approveCell(cell, control) {
  const problem = turnProblem(cell);
  if (problem) return untested(problem, turnEvidence(cell));
  const { call, count } = callFor(cell, "approved", true);
  if (!call)
    return untested(
      count > 1 ? "approved call made more than once" : "no approved call",
    );
  const records = escalationsFor(cell, call.toolUseId);
  const record = records.length === 1 ? records[0] : undefined;
  const post = of(cell, "post", call.toolUseId)[0];
  const evidence = {
    toolUseId: call.toolUseId,
    hookAtMs: call.t,
    hookReturnAtMs: call.returnedAt ?? null,
    decision: call.decision,
    postHook: post ? { event: post.event, atMs: post.t } : null,
    record: record ?? null,
    chromium: cell.results?.approved ?? null,
    control: control.evidence ?? null,
    ...turnEvidence(cell),
  };
  if (!record) return untested("no escalation recorded for the call", evidence);
  if (record.decision === "accept" && (call.decision !== "allow" || !post))
    return refuted({
      ...evidence,
      reason: "an accepted escalation did not run",
    });
  if (!post) return untested("the approved call did not run", evidence);
  if (control.outcome !== "proved")
    return untested("no same-run sandboxed control", evidence);
  const checks =
    record.decider === "operator" &&
    record.decision === "accept" &&
    call.decision === "allow" &&
    post.t >= (call.returnedAt ?? Number.POSITIVE_INFINITY) &&
    record.exitCode === 0 &&
    typeof record.durationMs === "number" &&
    ran(evidence.chromium);
  return checks ? proved(evidence) : refuted(evidence);
}

/**
 * escalate-approval, decline: the flagged `declined` call was held, the operator declined it,
 * the hook refused it, and it never ran: no post-tool hook and no result file.
 */
export function declineCell(cell) {
  const problem = turnProblem(cell);
  if (problem) return untested(problem, turnEvidence(cell));
  const { call, count } = callFor(cell, "declined", true);
  if (!call)
    return untested(
      count > 1 ? "declined call made more than once" : "no declined call",
    );
  const records = escalationsFor(cell, call.toolUseId);
  const record = records.length === 1 ? records[0] : undefined;
  const evidence = {
    toolUseId: call.toolUseId,
    hookAtMs: call.t,
    decision: call.decision,
    postHook: of(cell, "post", call.toolUseId)[0]?.event ?? null,
    record: record ?? null,
    chromium: cell.results?.declined ?? null,
    ...turnEvidence(cell),
  };
  if (evidence.postHook || evidence.chromium !== null)
    return refuted({ ...evidence, reason: "the declined call ran" });
  if (!record) return untested("no escalation recorded for the call", evidence);
  return record.decider === "operator" &&
    record.decision === "decline" &&
    record.exitCode === null &&
    call.decision === "deny"
    ? proved(evidence)
    : refuted(evidence);
}

/**
 * escalate-auto-review, classifier approval: the flagged `reviewed` call was passed by the hook,
 * reached no canUseTool, ran and launched Chromium while the same turn's control failed, and cab
 * recorded that item's reviewer approval with no risk level or overrule and its exit code. The
 * turn has no operator escalation.
 */
export function classifierApprovalCell(cell, control) {
  const problem = turnProblem(cell);
  if (problem) return untested(problem, turnEvidence(cell));
  const { call, count } = callFor(cell, "reviewed", true);
  if (!call)
    return untested(
      count > 1 ? "reviewed call made more than once" : "no reviewed call",
    );
  const records = reviewsFor(cell, call.toolUseId);
  const record = records.length === 1 ? records[0] : undefined;
  const post = of(cell, "post", call.toolUseId)[0];
  const asked = of(cell, "ask", call.toolUseId).length > 0;
  const evidence = {
    toolUseId: call.toolUseId,
    hookAtMs: call.t,
    decision: call.decision,
    asked,
    postHook: post ? { event: post.event, atMs: post.t } : null,
    record: record ?? null,
    escalations: (cell.escalations ?? []).length,
    chromium: cell.results?.reviewed ?? null,
    control: control.evidence ?? null,
    ...turnEvidence(cell),
  };
  if (call.decision !== "pass")
    return refuted({
      ...evidence,
      reason: "the hook did not pass the call on",
    });
  if (asked)
    return untested("the classifier left the call undecided", evidence);
  if (!post) return untested("the reviewed call did not run", evidence);
  if (!record) return untested("no review recorded for the call", evidence);
  if (control.outcome !== "proved")
    return untested("no same-run sandboxed control", evidence);
  const checks =
    record.decider === "reviewer" &&
    record.status === "approved" &&
    record.riskLevel === null &&
    record.overrule === null &&
    record.exitCode === 0 &&
    record.durationSource === "runtime" &&
    evidence.escalations === 0 &&
    ran(evidence.chromium);
  return checks ? proved(evidence) : refuted(evidence);
}

/** An undecided call: the classifier asked canUseTool, and cab sent it to the operator. */
export function undecidedCell(cell) {
  const { call } = callFor(cell, "reviewed", true);
  const ask = call && of(cell, "ask", call.toolUseId)[0];
  if (!ask) return untested(noUndecided);
  const records = escalationsFor(cell, call.toolUseId);
  const evidence = {
    toolUseId: call.toolUseId,
    askAtMs: ask.t,
    askResult: of(cell, "askResult", call.toolUseId)[0]?.behavior ?? null,
    record: records.length === 1 ? records[0] : null,
    reviews: reviewsFor(cell, call.toolUseId).length,
  };
  return evidence.record?.decider === "operator" &&
    evidence.askResult !== null &&
    evidence.reviews === 0
    ? proved(evidence)
    : untested(
        "the undecided call was not recorded as an operator escalation",
        evidence,
      );
}

/** A classifier denial reported by Claude Code for a flagged call, and cab's record of it. */
export function classifierDenialCell(cell) {
  const denials = (cell.events ?? []).filter(
    (e) => e.kind === "denied" && e.reasonType === "classifier",
  );
  if (denials.length === 0) return untested(noDenial);
  const records = denials.flatMap((d) => reviewsFor(cell, d.toolUseId));
  return records.length === denials.length &&
    records.every((r) => r.status === "denied" && r.overrule === null)
    ? proved({ denials, records })
    : refuted({ denials, records });
}

/**
 * Observation for #1715's residual risk: a permission ask cancelled (aborted) and then that
 * call's post-tool hook, i.e. the call ran after its operator escalation was withdrawn.
 */
export function cancelledAskObservation(cell) {
  const cancelled = (cell.events ?? []).filter((e) => e.kind === "askAborted");
  const ranAfter = cancelled
    .map((a) => ({
      toolUseId: a.toolUseId,
      abortedAtMs: a.t,
      postHook:
        of(cell, "post", a.toolUseId).find((p) => p.t >= a.t)?.event ?? null,
      reviews: reviewsFor(cell, a.toolUseId).length,
      escalations: escalationsFor(cell, a.toolUseId).map((e) => e.decider),
    }))
    .filter((a) => a.postHook !== null);
  return {
    cancelledAsks: cancelled.length,
    observed: ranAfter.length > 0,
    ranAfterCancel: ranAfter,
  };
}

/** Every cell of a run, from its two turns. */
export function classifyRun(run) {
  const approval = run.cells?.approval ?? {};
  const review = run.cells?.review ?? {};
  const approvalControl = controlCell(approval, "control-approval");
  const reviewControl = controlCell(review, "control-review");
  return {
    approvalControl,
    approve: approveCell(approval, approvalControl),
    decline: declineCell(approval),
    reviewControl,
    classifierApproval: classifierApprovalCell(review, reviewControl),
    undecided: undecidedCell(review),
    classifierDenial: classifierDenialCell(review),
    cancelledAsk: {
      approval: cancelledAskObservation(approval),
      review: cancelledAskObservation(review),
    },
  };
}

/** The finite pass rule: the three required cells and both controls proved. */
export const requiredCells = [
  "approvalControl",
  "approve",
  "decline",
  "reviewControl",
  "classifierApproval",
];
