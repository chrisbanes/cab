import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jiraEditorState,
  parseRule,
  ruleLines,
} from "../../web/src/jira-readiness.js";

test("only an explicit empty Jira setup site unlocks site selection; withheld reads retain saved readiness", () => {
  const readiness = {
    kind: "rule" as const,
    mode: "any" as const,
    conditions: [
      { kind: "label" as const, operator: "has" as const, name: "ready" },
    ],
  };
  for (const instance of ["example.atlassian.net", null, undefined]) {
    const state = jiraEditorState({ tracker: "jira", instance, readiness });
    assert.equal(state.saved, true);
    assert.equal(state.unconfigured, false);
    assert.deepEqual(parseRule(state.rule!.mode, ruleLines(state.rule)), {
      rule: { mode: "any", conditions: readiness.conditions },
    });
    const hidden = jiraEditorState({
      tracker: "jira",
      instance,
      readiness: { kind: "unavailable" },
    });
    assert.equal(hidden.withheld, true);
    assert.equal(hidden.saved, true);
    assert.equal(hidden.unconfigured, false);
  }
  assert.deepEqual(
    jiraEditorState({
      tracker: "jira",
      instance: "",
      readiness: { kind: "none" },
    }),
    { saved: true, unconfigured: true, rule: null, withheld: false },
  );
});

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
