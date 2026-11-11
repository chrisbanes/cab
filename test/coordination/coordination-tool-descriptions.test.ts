import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";

test("every coordination tool description fits the runtime's 1024-character limit", () => {
  for (const tool of coordinationTools)
    assert.ok(tool.description.length <= 1024, tool.name);
});

test("cab_ask_question directs decisions to structured forms", () => {
  const d = coordinationTools.find(
    (t) => t.name === "cab_ask_question",
  )!.description;
  assert.match(d, /\bform\b/);
  assert.match(d, /recommended/);
  assert.match(d, /one question per decision/i);
  assert.match(d, /open-ended/i);
  assert.match(d, /one plain sentence/i);
  assert.match(d, /`context`/);
  assert.match(d, /what choosing it causes/i);
  assert.match(d, /diagnose cab refusals/i);
});

test("cab_request_approval explains the headline rule and cab's wording for known kinds", () => {
  const d = coordinationTools.find(
    (t) => t.name === "cab_request_approval",
  )!.description;
  assert.match(d, /known delivery action kind/i);
  assert.match(d, /cab's own headline/);
  assert.match(d, /one plain sentence of at most 120 characters/);
});

test("cab_report_result asks for operator review only when a decision is needed", () => {
  const d = coordinationTools.find(
    (t) => t.name === "cab_report_result",
  )!.description;
  assert.match(d, /operatorReview/);
  assert.match(d, /only when the result needs an operator decision/);
  assert.match(d, /never for routine completion/);
  assert.match(d, /at most 120 characters/);
});

test("cab_withdraw_result_review is lead-only and defers to supersession", () => {
  const tool = coordinationTools.find(
    (t) => t.name === "cab_withdraw_result_review",
  )!;
  assert.match(tool.description, /Task lead only/);
  assert.match(tool.description, /newer result supersedes/i);
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, [
    "resultId",
    "reason",
  ]);
});
