// Pure classification of a group's trace into proved / refuted / untested per sub-contract.
// A leg counts only when its evidence exists: a missing result file or notification is
// never read as a refusal or as "nothing reached the client".
export const SUB_CONTRACTS = {
  "codex-user": [
    "requestFields",
    "acceptRunsOutsideSandbox",
    "declineRefuses",
    "otherKindsRefused",
  ],
  "codex-auto-review": [
    "reviewNotifications",
    "clientEscalationsRecorded",
    "overruleAfterDenial",
    "retryReviewedAgain",
  ],
  "codex-timing": ["withholdFifteenMinutes", "turnContinuesAfterDecline"],
  "claude-sandbox": [
    "unsandboxedCommandRunsOutside",
    "hookSeesFlagFirst",
    "hookDenyPrevents",
  ],
  "claude-auto": [
    "autoModeAvailable",
    "hookDenyWins",
    "hookBeforeClassifier",
    "observableDecisions",
    "undecidedReachCanUseTool",
  ],
  "claude-timing": [
    "ceilingAboveDefault",
    "envClampsLargerRequest",
    "sixtyMinuteBoundary",
  ],
};

const proved = (evidence) => ({ outcome: "proved", evidence });
const refuted = (evidence) => ({ outcome: "refuted", evidence });
const untested = (reason, evidence) => ({
  outcome: "untested",
  reason,
  ...(evidence === undefined ? {} : { evidence }),
});
const commandApproval = "item/commandExecution/requestApproval";
const ran = (result) => result?.chromium === "ok";
const blocked = (result) =>
  typeof result?.chromium === "string" && result.chromium !== "ok";

function codexUser(trace) {
  const { events, results } = trace;
  const requests = events.filter((e) => e.kind === "request");
  const escalated = requests.find(
    (r) => r.method === commandApproval && r.command?.includes("escalated"),
  );
  const declined = requests.find(
    (r) => r.method === commandApproval && r.command?.includes("declined"),
  );
  const out = {};
  if (escalated) {
    const fields = {
      command: escalated.command,
      cwd: escalated.cwd,
      reason: escalated.reason,
    };
    out.requestFields =
      escalated.command && escalated.cwd === trace.workspace && escalated.reason
        ? proved(fields)
        : refuted(fields);
    const legs = { control: results.control, escalated: results.escalated };
    if (escalated.answer === "accept" && results.escalated)
      out.acceptRunsOutsideSandbox =
        blocked(results.control) && ran(results.escalated)
          ? proved(legs)
          : ran(results.control)
            ? untested("sandboxed control also launched Chromium", legs)
            : refuted(legs);
  }
  if (declined?.answer === "decline") {
    const item = events.find(
      (e) =>
        e.kind === "item" &&
        e.type === "commandExecution" &&
        e.command?.includes("declined"),
    );
    const evidence = {
      resultFile: results.declined ?? null,
      itemStatus: item?.status,
    };
    out.declineRefuses = results.declined
      ? refuted(evidence)
      : item?.status === "declined"
        ? proved(evidence)
        : untested("no declined command item observed", evidence);
  }
  const others = requests.filter((r) => r.method !== commandApproval);
  const attempts = events.filter(
    (e) =>
      e.kind === "item" &&
      e.turn === 3 &&
      !["userMessage", "agentMessage", "reasoning"].includes(e.type),
  );
  const reply = events.findLast(
    (e) => e.kind === "item" && e.turn === 3 && e.type === "agentMessage",
  )?.text;
  if (others.length > 0)
    out.otherKindsRefused = refuted({
      reachedClient: others.map((r) => r.method),
    });
  else if (attempts.length > 0)
    out.otherKindsRefused = proved({
      attemptItems: attempts.map((e) => e.type),
      reachedClient: [],
    });
  else if (events.some((e) => e.kind === "turn" && e.turn === 3))
    out.otherKindsRefused = untested(
      "model made no permission-request attempt",
      { reply },
    );
  return out;
}

function codexAutoReview(trace) {
  const { events, results } = trace;
  const reviews = (turn, phase) =>
    events.filter(
      (e) => e.kind === "review" && e.turn === turn && e.phase === phase,
    );
  const turnDone = (turn) =>
    events.some((e) => e.kind === "turn" && e.turn === turn);
  const out = {};
  const [started] = reviews(1, "started");
  const [completed] = reviews(1, "completed");
  if (started && completed?.riskLevel && completed.rationale)
    out.reviewNotifications = proved({
      started: { reviewId: started.reviewId },
      completed: {
        status: completed.status,
        riskLevel: completed.riskLevel,
        rationale: completed.rationale,
      },
    });
  else if (started || completed)
    out.reviewNotifications = refuted({
      started: Boolean(started),
      completed: completed ?? null,
    });
  else if (ran(results.reviewed))
    out.reviewNotifications = refuted({
      reason: "escalated command ran without review notifications",
      result: results.reviewed,
    });
  else if (turnDone(1))
    out.reviewNotifications = untested("no escalation observed in turn 1", {
      result: results.reviewed ?? null,
    });
  if (turnDone(1)) {
    const reached = events.filter((e) => e.kind === "request");
    out.clientEscalationsRecorded = proved({
      requestsReachingClient: reached.length,
      methods: reached.map((r) => r.method),
    });
  }
  const denial = reviews(2, "completed").find((e) => e.status === "denied");
  const overrule = events.find((e) => e.kind === "overrule");
  if (!denial) {
    if (turnDone(2)) {
      const reason = "denial not elicited";
      const evidence = {
        turn2Reviews: reviews(2, "completed").map((e) => e.status),
      };
      out.overruleAfterDenial = untested(reason, evidence);
      out.retryReviewedAgain = untested(reason, evidence);
    }
    return out;
  }
  if (overrule)
    out.overruleAfterDenial = overrule.ok
      ? proved({ shape: overrule.shape, response: overrule.response })
      : refuted({ attempts: overrule.attempts });
  if (overrule?.ok && turnDone(3)) {
    const fresh = reviews(3, "started").filter(
      (e) => e.reviewId !== denial.reviewId,
    );
    const retried = events.some(
      (e) =>
        e.kind === "item" &&
        e.turn === 3 &&
        e.type === "commandExecution" &&
        e.command?.includes("probe.invalid"),
    );
    out.retryReviewedAgain =
      fresh.length > 0
        ? proved({
            freshReviews: reviews(3, "completed").map((e) => ({
              status: e.status,
              riskLevel: e.riskLevel,
            })),
          })
        : retried
          ? refuted({ reason: "retry ran without a fresh review" })
          : untested("model did not retry after the overrule");
  }
  return out;
}

function codexTiming(trace) {
  const { events } = trace;
  const request = events.find(
    (e) => e.kind === "request" && e.method === commandApproval,
  );
  if (!request) return {};
  const out = {};
  const answeredAt = request.answeredAt;
  const early = events.filter(
    (e) =>
      e.t >= request.t &&
      (answeredAt === undefined || e.t < answeredAt) &&
      ((e.kind === "resolved" && e.requestId === request.id) ||
        e.kind === "turn"),
  );
  const evidence = {
    heldMs: answeredAt === undefined ? null : answeredAt - request.t,
    answer: request.answer ?? null,
    duringHold: early.map((e) => e.kind),
  };
  if (early.length > 0) out.withholdFifteenMinutes = refuted(evidence);
  else if (answeredAt !== undefined && evidence.heldMs >= trace.holdMs)
    out.withholdFifteenMinutes = proved(evidence);
  const after = events.find(
    (e) => e.kind === "turn" && answeredAt !== undefined && e.t >= answeredAt,
  );
  if (after && early.length === 0)
    out.turnContinuesAfterDecline =
      after.status === "completed"
        ? proved({ turnStatus: after.status })
        : refuted({ turnStatus: after.status });
  return out;
}

const preHooks = (events, query) =>
  events.filter(
    (e) =>
      e.kind === "hook" &&
      e.event === "PreToolUse" &&
      (query === undefined || e.query === query),
  );

function claudeSandbox(trace) {
  const { events, results } = trace;
  const out = {};
  const pre = preHooks(events);
  const escalated = pre.find((e) => e.command?.includes("escalated"));
  if (escalated?.decision === "allow") {
    const legs = { control: results.control, escalated: results.escalated };
    out.unsandboxedCommandRunsOutside = !results.escalated
      ? untested("escalated call wrote no result", legs)
      : ran(results.control)
        ? untested("sandboxed control also launched Chromium", legs)
        : blocked(results.control) && ran(results.escalated)
          ? proved(legs)
          : refuted(legs);
  }
  const flagged = events.find(
    (e) =>
      e.kind === "toolUse" &&
      e.dangerouslyDisableSandbox &&
      e.command?.includes("escalated"),
  );
  if (escalated?.dangerouslyDisableSandbox)
    out.hookSeesFlagFirst = proved({
      hookInput: {
        command: escalated.command,
        dangerouslyDisableSandbox: true,
      },
      hookAtMs: escalated.t,
    });
  else if (escalated || flagged)
    out.hookSeesFlagFirst = refuted({
      hookSawFlag: escalated?.dangerouslyDisableSandbox ?? null,
      toolUseHadFlag: Boolean(flagged),
    });
  const denied = pre.find(
    (e) => e.command?.includes("hook-deny") && e.decision === "deny",
  );
  if (denied)
    out.hookDenyPrevents = results["hook-deny"]
      ? refuted({ result: results["hook-deny"] })
      : proved({
          dangerouslyDisableSandbox: denied.dangerouslyDisableSandbox,
          resultFile: null,
        });
  return out;
}

function claudeAuto(trace) {
  const { events, queries } = trace;
  const init = events.find(
    (e) => e.kind === "message" && e.type === "system" && e.subtype === "init",
  );
  const query = queries[0];
  const out = {};
  if (init?.permissionMode === "auto" && !query?.error)
    out.autoModeAvailable = proved({
      permissionMode: init.permissionMode,
      model: init.model,
    });
  else if (init || query?.error) {
    const evidence = {
      permissionMode: init?.permissionMode ?? null,
      model: init?.model ?? null,
      error: query?.error ?? null,
    };
    out.autoModeAvailable = refuted(evidence);
    for (const key of SUB_CONTRACTS["claude-auto"].slice(1))
      out[key] = untested("auto mode unavailable", evidence);
    return out;
  }
  const pre = preHooks(events);
  const asked = events.filter((e) => e.kind === "canUseTool");
  const resultFor = (id) =>
    events.find((e) => e.kind === "toolResult" && e.toolUseId === id);
  const denied = pre.find(
    (e) => e.command?.includes("probe-hook-deny") && e.decision === "deny",
  );
  if (denied) {
    const result = resultFor(denied.toolUseId);
    const evidence = {
      toolResult: result ?? null,
      canUseTool: asked.some((e) => e.toolUseId === denied.toolUseId),
    };
    out.hookDenyWins =
      result?.isError && !evidence.canUseTool
        ? proved(evidence)
        : result || evidence.canUseTool
          ? refuted(evidence)
          : untested("no tool result for the denied call", evidence);
  }
  if (asked.length > 0) {
    const order = asked.map((e) => ({
      toolUseId: e.toolUseId,
      hookAtMs: pre.find((h) => h.toolUseId === e.toolUseId)?.t ?? null,
      canUseToolAtMs: e.t,
    }));
    out.hookBeforeClassifier = order.every(
      (o) => o.hookAtMs !== null && o.hookAtMs <= o.canUseToolAtMs,
    )
      ? proved({ order })
      : refuted({ order });
    out.undecidedReachCanUseTool = proved({
      commands: asked.map((e) => e.command),
    });
  } else if (query?.done) {
    out.hookBeforeClassifier = untested(
      "no classifier signal observable separately from the hook",
    );
    out.undecidedReachCanUseTool = untested(
      "classifier decided every call; no undecided call elicited",
    );
  }
  const passed = pre.filter((e) => e.decision === "pass");
  const decisions = passed.map((e) => ({
    command: e.command,
    toolResult: resultFor(e.toolUseId) ?? null,
    postHook:
      events.find(
        (h) =>
          h.kind === "hook" &&
          h.event !== "PreToolUse" &&
          h.toolUseId === e.toolUseId,
      )?.event ?? null,
    canUseTool: asked.some((a) => a.toolUseId === e.toolUseId),
  }));
  if (decisions.some((d) => d.toolResult))
    out.observableDecisions = proved({
      decisions,
      streamMessageTypes: [
        ...new Set(
          events
            .filter((e) => e.kind === "message")
            .map((e) => [e.type, e.subtype].filter(Boolean).join(":")),
        ),
      ],
    });
  else if (query?.done)
    out.observableDecisions = untested("no pass-through call reached a result");
  return out;
}

function sleepCall(events, query) {
  const pre = preHooks(events, query).find((e) => e.command?.includes("sleep"));
  if (!pre) return null;
  const post = events.find(
    (e) =>
      e.kind === "hook" &&
      e.event !== "PreToolUse" &&
      e.toolUseId === pre.toolUseId,
  );
  const result = events.find(
    (e) => e.kind === "toolResult" && e.toolUseId === pre.toolUseId,
  );
  if (!post && !result) return null;
  const end = post?.t ?? result.t;
  const output = `${post?.response ?? ""} ${result?.text ?? ""}`;
  return {
    requestedTimeout: pre.timeout ?? null,
    elapsedMs: end - pre.t,
    exitedZero: output.includes("probe-exit=0"),
    response: post?.response ?? result?.text,
  };
}

function claudeTiming(trace) {
  const out = {
    sixtyMinuteBoundary: untested(
      "inferred from the two bounded parts; a full 60-minute wait is out of budget",
    ),
  };
  const first = sleepCall(trace.events, 1);
  if (first)
    out.ceilingAboveDefault =
      first.elapsedMs > 600_000 && first.exitedZero
        ? proved(first)
        : refuted(first);
  const second = sleepCall(trace.events, 2);
  if (second)
    out.envClampsLargerRequest =
      !second.exitedZero &&
      second.elapsedMs >= 100_000 &&
      second.elapsedMs < 170_000
        ? proved(second)
        : refuted(second);
  return out;
}

const classifiers = {
  "codex-user": codexUser,
  "codex-auto-review": codexAutoReview,
  "codex-timing": codexTiming,
  "claude-sandbox": claudeSandbox,
  "claude-auto": claudeAuto,
  "claude-timing": claudeTiming,
};

export function classify(group, trace) {
  const decided = classifiers[group](trace);
  const reason = trace.deadline
    ? "deadline"
    : trace.failure
      ? `harness failure: ${trace.failure}`
      : "not observed";
  return Object.fromEntries(
    SUB_CONTRACTS[group].map((key) => [key, decided[key] ?? untested(reason)]),
  );
}

/** JSON with the token, fixture root and home directory replaced, in that order. */
export function sanitize(value, { token, root, home }) {
  let text = JSON.stringify(value, null, 2);
  for (const [needle, replacement] of [
    [token, "<redacted-token>"],
    [root, "<fixture>"],
    [home, "~"],
  ])
    if (needle) text = text.replaceAll(needle, replacement);
  return text;
}
