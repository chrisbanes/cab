import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escalationDuration,
  sandboxEscalationOutcome,
  sandboxEscalationPlace,
  sandboxEscalationResultLine,
  sandboxEscalationWorkspaceLine,
  sandboxOverruleOutcome,
  sandboxReviewOutcome,
  sandboxReviewPlace,
  sandboxReviewResultLine,
} from "../../src/operator/sandbox-escalation-copy.js";

test("an escalation's outcome follows its decider, decision and delivery", () => {
  const outcome = (
    decider: "operator" | "expiry" | "obsolete" | null,
    decision: "accept" | "decline" | null,
    delivered: boolean | null,
  ) => sandboxEscalationOutcome({ decider, decision, delivered });
  assert.equal(outcome(null, null, null), "pending");
  assert.equal(outcome("operator", "accept", true), "approved");
  // Claimed but not yet confirmed still reads as the decision.
  assert.equal(outcome("operator", "accept", null), "approved");
  assert.equal(outcome("operator", "decline", true), "declined");
  assert.equal(outcome("expiry", "decline", true), "expired");
  assert.equal(outcome("obsolete", null, null), "obsolete");
  assert.equal(outcome("operator", "accept", false), "not-delivered");
  assert.equal(outcome("expiry", "decline", false), "not-delivered");
});

test("each outcome reads as one line, with an approved command's exit code and duration", () => {
  const line = (
    outcome: Parameters<typeof sandboxEscalationResultLine>[0]["outcome"],
    rest: Partial<Parameters<typeof sandboxEscalationResultLine>[0]> = {},
  ) =>
    sandboxEscalationResultLine({
      outcome,
      decider: null,
      decision: null,
      exitCode: null,
      durationMs: null,
      completedAt: null,
      ...rest,
    });
  assert.equal(line("pending"), "Waiting for an operator answer");
  assert.equal(
    line("approved", { exitCode: 3, durationMs: 1234, completedAt: 1 }),
    "Approved by the operator · exit code 3 · 1.2 s",
  );
  assert.equal(
    line("approved", { exitCode: null, completedAt: 1 }),
    "Approved by the operator · no exit code",
  );
  assert.equal(
    line("approved"),
    "Approved by the operator; no completion recorded",
  );
  assert.equal(line("declined"), "Declined by the operator");
  assert.equal(line("expired"), "Declined after 15 minutes without an answer");
  assert.equal(
    line("obsolete"),
    "Withdrawn: the request ended before it was answered",
  );
  assert.equal(
    line("not-delivered", { decider: "operator", decision: "accept" }),
    "Approved by the operator; the answer was not delivered",
  );
  // An expiry whose decline was not delivered is still the expiry's, never the operator's.
  assert.equal(
    line("not-delivered", { decider: "expiry", decision: "decline" }),
    "Declined after 15 minutes without an answer; the answer was not delivered",
  );
  assert.equal(escalationDuration(250), "250 ms");
  assert.equal(escalationDuration(1234), "1.2 s");
  assert.equal(escalationDuration(59_960), "1 min 0 s");
  assert.equal(escalationDuration(119_600), "2 min 0 s");
  assert.equal(escalationDuration(125_000), "2 min 5 s");
});

test("the workspace line names HEAD, branch and uncommitted changes, or says it is unknown", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(
    sandboxEscalationWorkspaceLine({ head, branch: "main", dirty: true }),
    "HEAD 0123456789ab · on main · uncommitted changes",
  );
  assert.equal(
    sandboxEscalationWorkspaceLine({ head, branch: null, dirty: false }),
    "HEAD 0123456789ab · detached · no uncommitted changes",
  );
  assert.equal(
    sandboxEscalationWorkspaceLine({ head: null, branch: null, dirty: null }),
    "Workspace state unknown",
  );
  assert.equal(sandboxEscalationWorkspaceLine(null), "Workspace state unknown");
});

test("where the command runs reads the same on both surfaces, a cut request marked", () => {
  assert.equal(
    sandboxEscalationPlace({ cwd: ".", workspace: null, truncated: false }),
    "in . · Workspace state unknown",
  );
  assert.equal(
    sandboxEscalationPlace({ cwd: null, workspace: null, truncated: false }),
    "in an unavailable directory · Workspace state unknown",
  );
  // The mark names the request, since the cwd or reason may be what was cut.
  assert.equal(
    sandboxEscalationPlace({ cwd: ".", workspace: null, truncated: true }),
    "in . · Workspace state unknown · request cut to fit the approval limit",
  );
});

test("a reviewer decision's outcome follows its status, and a review its turn outlived is obsolete", () => {
  for (const [status, running, outcome] of [
    ["inProgress", true, "reviewing"],
    ["inProgress", false, "obsolete"],
    ["approved", false, "approved"],
    ["denied", true, "denied"],
    ["timedOut", true, "timed-out"],
    ["aborted", false, "aborted"],
  ] as const)
    assert.equal(sandboxReviewOutcome({ status, running }), outcome, status);
});

test("an overrule's outcome follows its decider, decision and delivery", () => {
  const outcome = (
    decider: "operator" | "obsolete" | null,
    decision: "accept" | "decline" | null,
    delivered: boolean | null,
  ) => sandboxOverruleOutcome({ decider, decision, delivered });
  assert.equal(outcome(null, null, null), "offered");
  assert.equal(outcome("obsolete", null, null), "withdrawn");
  assert.equal(outcome("operator", "decline", null), "declined");
  assert.equal(outcome("operator", "accept", null), "approved");
  assert.equal(outcome("operator", "accept", true), "sent");
  assert.equal(outcome("operator", "accept", false), "not-delivered");
});

test("each reviewer decision reads as one line, with risk, an approved command's result and a denial's overrule", () => {
  const base = {
    riskLevel: null,
    exitCode: null,
    durationMs: null,
    completedAt: null,
    overrule: null,
  } as const;
  const line = (r: Partial<Parameters<typeof sandboxReviewResultLine>[0]>) =>
    sandboxReviewResultLine({ ...base, outcome: "approved", ...r });
  assert.equal(
    line({ riskLevel: "low", exitCode: 0, durationMs: 516, completedAt: 1 }),
    "Approved by the reviewer · low risk · exit code 0 · 516 ms",
  );
  assert.equal(
    line({ riskLevel: "low" }),
    "Approved by the reviewer · low risk · no completion recorded",
  );
  assert.equal(
    line({ completedAt: 1 }),
    "Approved by the reviewer · no exit code",
  );
  assert.equal(
    line({
      outcome: "denied",
      riskLevel: "high",
      overrule: { outcome: "offered" },
    }),
    "Denied by the reviewer · high risk · overrule offered in the Inbox",
  );
  for (const [outcome, text] of [
    ["approved", "overrule approved"],
    ["sent", "overruled by the operator; any retry is reviewed again"],
    ["not-delivered", "overrule approved but not delivered"],
    ["declined", "overrule declined"],
    ["withdrawn", "overrule withdrawn: the turn ended"],
  ] as const)
    assert.equal(
      line({ outcome: "denied", overrule: { outcome } }),
      `Denied by the reviewer · ${text}`,
    );
  // No overrule: the command was outside the workspace or the turn ended first.
  assert.equal(line({ outcome: "denied" }), "Denied by the reviewer");
  assert.equal(line({ outcome: "reviewing" }), "Being reviewed");
  assert.equal(
    line({ outcome: "obsolete" }),
    "Withdrawn: the turn ended before the review completed",
  );
  assert.equal(
    line({ outcome: "timed-out" }),
    "Declined: the review timed out",
  );
  assert.equal(
    line({ outcome: "aborted" }),
    "Declined: the review was aborted",
  );
});

test("where a reviewed command runs is shown, with a cut review marked", () => {
  assert.equal(
    sandboxReviewPlace({ cwd: null, workspace: null, truncated: true }),
    "in an unavailable directory · Workspace state unknown · review cut to its recorded limit",
  );
  assert.equal(
    sandboxReviewPlace({
      cwd: ".",
      workspace: { head: "a".repeat(40), branch: "main", dirty: false },
      truncated: false,
    }),
    "in . · HEAD aaaaaaaaaaaa · on main · no uncommitted changes",
  );
});
