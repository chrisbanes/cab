import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escalationDuration,
  sandboxEscalationCommand,
  sandboxEscalationOutcome,
  sandboxEscalationPlace,
  sandboxEscalationResultLine,
  sandboxEscalationWorkspaceLine,
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

test("the command and where it runs read the same on both surfaces, a cut command marked", () => {
  assert.equal(
    sandboxEscalationCommand({ command: "node x", truncated: false }),
    "node x",
  );
  assert.equal(
    sandboxEscalationCommand({ command: "node x", truncated: true }),
    "node x (cut to fit)",
  );
  assert.equal(
    sandboxEscalationCommand({ command: null, truncated: false }),
    "Command unavailable",
  );
  assert.equal(
    sandboxEscalationPlace({ cwd: ".", workspace: null }),
    "in . · Workspace state unknown",
  );
  assert.equal(
    sandboxEscalationPlace({ cwd: null, workspace: null }),
    "in an unavailable directory · Workspace state unknown",
  );
});
