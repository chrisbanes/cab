import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DraftTurnFacts,
  draftTurnAvailability,
  draftTurnInstruction,
  draftTurnToolDecision,
  draftTurnUnavailableText,
} from "../../src/standalone/draft-turn.js";

const open: DraftTurnFacts = {
  taskState: "open",
  ready: false,
  lead: { state: "pending", revoked: false },
  draftTurnActive: false,
};

test("a draft turn is available only on an open, unready task with a waiting lead", () => {
  assert.deepEqual(draftTurnAvailability(open), { available: true });
  const refused: Array<[Partial<DraftTurnFacts>, string]> = [
    [{ taskState: "done" }, "task-not-open"],
    [{ taskState: "cancelled", ready: true }, "task-not-open"],
    [{ ready: true }, "task-ready"],
    [{ lead: null }, "lead-unconfigured"],
    [{ lead: { state: "pending", revoked: true } }, "lead-revoked"],
    [{ lead: { state: "held", revoked: false } }, "lead-unavailable"],
    [{ lead: { state: "completed", revoked: false } }, "lead-unavailable"],
    [{ lead: { state: "running", revoked: false } }, "lead-unavailable"],
    [{ draftTurnActive: true }, "draft-turn-active"],
  ];
  for (const [change, reason] of refused)
    assert.deepEqual(draftTurnAvailability({ ...open, ...change }), {
      available: false,
      reason,
    });
  assert.match(
    draftTurnUnavailableText("task-ready"),
    /^Draft turn unavailable: task is Ready$/,
  );
});

test("a draft turn allows questions, approvals and only issue comments and labels", () => {
  const allowed: Array<[string, unknown]> = [
    ["ensemble_ask_question", {}],
    ["ensemble_request_approval", {}],
    ["ensemble_external_action", { action: { kind: "issue.comment" } }],
    ["ensemble_external_action", { action: { kind: "issue.labels" } }],
  ];
  for (const [tool, args] of allowed)
    assert.deepEqual(draftTurnToolDecision(tool, args), { allowed: true });
  const refused: Array<[string, unknown]> = [
    ["ensemble_delegate", {}],
    ["ensemble_register_pr", {}],
    ["ensemble_report_result", {}],
    ["ensemble_request_follow_up", {}],
    ["ensemble_request_completion", {}],
    ["ensemble_external_action", { action: { kind: "pr.create" } }],
    ["ensemble_external_action", { action: { kind: "pr.merge" } }],
    ["ensemble_external_action", { action: { kind: "issue.close" } }],
    ["ensemble_external_action", {}],
    ["ensemble_external_action", null],
    ["unknown_tool", {}],
  ];
  for (const [tool, args] of refused) {
    const decision = draftTurnToolDecision(tool, args);
    assert.equal(decision.allowed, false, `${tool} ${JSON.stringify(args)}`);
    if (!decision.allowed) assert.match(decision.text, /^Draft turn: /);
  }
});

test("the draft turn instruction states limits and no triage meaning", () => {
  assert.match(draftTurnInstruction, /not Ready/);
  assert.doesNotMatch(
    draftTurnInstruction,
    /triage|label meaning|readiness proposal/i,
  );
});
