import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRule, ruleLines } from "../../web/src/jira-readiness.js";

test("readiness lines round-trip every Jira condition kind", () => {
  const text = [
    "label has ready",
    "label lacks blocked",
    "status in 10001, 10002",
    "status not-in 10003",
    "customfield_10010 in 20",
    "customfield_10010 not-in 21, 22",
  ].join("\n");
  const parsed = parseRule("any", text);
  assert.ok("rule" in parsed && parsed.rule);
  assert.equal(parsed.rule.mode, "any");
  assert.deepEqual(parsed.rule.conditions[2], {
    kind: "status",
    operator: "in",
    statusIds: ["10001", "10002"],
  });
  assert.equal(ruleLines(parsed.rule), text);
});

test("blank text is no rule, and an unreadable line names itself", () => {
  assert.deepEqual(parseRule("all", " \n "), { rule: null });
  for (const line of [
    "status has 1",
    "priority in 1",
    "customfield_10010 in",
    "status in 1, 1",
    "nonsense",
  ]) {
    const parsed = parseRule("all", `label has ok\n${line}`);
    assert.ok("error" in parsed, line);
    assert.ok(parsed.error.includes(line), line);
  }
});
