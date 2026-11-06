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
});
