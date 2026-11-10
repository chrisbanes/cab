import assert from "node:assert/strict";
import { test } from "node:test";
import {
  missingProjectSelectionWarning,
  projectFieldSelectionGap,
  projectFieldSelectionSummaryCause,
  selectionCountsText,
  unmetReason,
  zeroMatchWarning,
} from "../../src/operator/readiness-text.js";

const label = (name: string, operator: "has" | "lacks" = "has") => ({
  kind: "label" as const,
  operator,
  name,
});
const field: {
  kind: "project-field";
  projectNodeId: string;
  fieldNodeId: string;
  operator: "in" | "not-in";
  optionNodeIds: string[];
  fieldName?: string;
  optionNames?: Record<string, string>;
} = {
  kind: "project-field",
  projectNodeId: "P_1",
  fieldNodeId: "F_1",
  operator: "in",
  optionNodeIds: ["O_1"],
};
const rule = (
  mode: "all" | "any",
  ...conditions: (typeof field | ReturnType<typeof label>)[]
) => ({ kind: "rule" as const, mode, conditions });
const counts = (patch = {}) => ({
  observed: 149,
  open: 9,
  closedSkipped: 141,
  matching: 0,
  complete: true,
  ...patch,
});

test("selection counts name observed, open and matching items for every rule kind", () => {
  assert.equal(
    selectionCountsText(counts(), rule("all", label("ready"))),
    "149 observed (141 closed, not imported) · 9 open · 0 match label `ready`",
  );
  assert.equal(
    selectionCountsText(
      counts({ closedSkipped: 0, observed: 9, matching: 2 }),
      rule("any", label("a"), field),
    ),
    "9 observed · 9 open · 2 match any of label `a`, Project field F_1 = O_1",
  );
  assert.equal(
    selectionCountsText(
      counts({ closedSkipped: 0 }),
      rule("all", label("a"), label("b")),
    ),
    "149 observed · 9 open · 0 match label `a` and label `b`",
  );
  assert.equal(
    selectionCountsText(counts({ closedSkipped: 0 }), { kind: "none" }),
    "149 observed · 9 open · all 9 open match (no readiness rule)",
  );
  assert.equal(
    selectionCountsText(counts({ closedSkipped: 0, matching: null }), {
      kind: "unavailable",
    }),
    "149 observed · 9 open · readiness match unknown (rule unavailable)",
  );
  assert.equal(
    selectionCountsText(
      counts({ closedSkipped: 0, matching: null }),
      rule("all", label("a")),
    ),
    "149 observed · 9 open · readiness match unknown until the selection is previewed and read again",
  );
  assert.match(
    selectionCountsText(counts({ matching: null }), { kind: "none" }),
    /readiness match unknown until the selection is previewed and read again/,
  );
  assert.equal(
    zeroMatchWarning(counts({ matching: null }), rule("all", label("a"))),
    null,
  );
  assert.match(
    selectionCountsText(counts({ complete: false }), rule("all", label("a"))),
    / · partial read; counts may be incomplete$/,
  );
});

test("the zero-match warning needs a complete read, open items, no match and a known rule", () => {
  const ready = rule("all", label("ready"));
  assert.equal(
    zeroMatchWarning(counts(), ready),
    "No open item matches the readiness rule (label `ready`); imported tasks stay Draft until one does.",
  );
  assert.equal(zeroMatchWarning(counts({ complete: false }), ready), null);
  assert.equal(zeroMatchWarning(counts({ open: 0 }), ready), null);
  assert.equal(zeroMatchWarning(counts({ matching: 1 }), ready), null);
  assert.equal(zeroMatchWarning(counts(), { kind: "none" }), null);
  assert.equal(
    zeroMatchWarning(counts({ matching: null }), { kind: "unavailable" }),
    null,
  );
  assert.equal(zeroMatchWarning(null, ready), null);
});

test("missing Project selections describe all and any conditions accurately", () => {
  assert.equal(
    missingProjectSelectionWarning("all"),
    "This readiness rule can never match because its Project field condition has no corresponding GitHub Project selection in this draft. Add that Project as a selection or remove the condition.",
  );
  assert.equal(
    missingProjectSelectionWarning("any"),
    "This Project field condition never applies because its GitHub Project has no corresponding selection in this draft. Add that Project as a selection or remove the condition.",
  );
});

test("zero-match context names missing or inactive Project selections without guessing", () => {
  const missing = projectFieldSelectionGap(
    rule("all", field).conditions,
    [
      { kind: "repository", descriptor: "R_1", active: true },
      { kind: "search", descriptor: null, active: true },
      { kind: "project", descriptor: "P_2", active: true },
    ],
    true,
  );
  assert.deepEqual(missing, { projectNodeId: "P_1", inactive: false });
  assert.equal(
    projectFieldSelectionSummaryCause("all", missing!),
    "The readiness rule can never match: Project field condition references GitHub Project P_1 with no active selection. Add that Project as a selection.",
  );
  const inactive = projectFieldSelectionGap(
    rule("any", field).conditions,
    [{ kind: "project", descriptor: "P_1", active: false }],
    true,
  );
  assert.deepEqual(inactive, { projectNodeId: "P_1", inactive: true });
  assert.equal(
    projectFieldSelectionSummaryCause("any", inactive!),
    "A Project field condition never applies: Project field condition references inactive GitHub Project P_1. Activate that selection to supply fields.",
  );
  assert.equal(
    projectFieldSelectionGap(
      rule("all", field).conditions,
      [
        { kind: "project", descriptor: "P_1", active: false },
        { kind: "project", descriptor: "P_1", active: true },
      ],
      true,
    ),
    null,
  );
  assert.deepEqual(
    projectFieldSelectionGap(rule("all", field).conditions, [
      { kind: "project", descriptor: "P_2", active: true, removed: true },
    ]),
    { projectNodeId: "P_1", inactive: false },
  );
  assert.equal(
    projectFieldSelectionGap(
      rule("all", field).conditions,
      [{ kind: "project", descriptor: null, active: false, unknown: true }],
      true,
    ),
    null,
    "an opaque saved Project identity is not proof of absence",
  );
  assert.equal(
    projectFieldSelectionGap(
      rule("all", field).conditions,
      [
        { kind: "project", descriptor: "P_1", active: false },
        { kind: "project", descriptor: null, active: true, unknown: true },
      ],
      true,
    ),
    null,
    "an opaque Project identity might be the active matching selection",
  );
  assert.equal(
    projectFieldSelectionGap(rule("all", field).conditions, [
      { kind: "project", descriptor: "P_1", active: false },
    ]),
    null,
    "a matching Project in the draft counts before activation",
  );
  assert.match(
    zeroMatchWarning(counts(), rule("all", field), [
      { kind: "repository", descriptor: "R_1", active: true },
    ]) ?? "",
    /Project field condition references GitHub Project P_1 with no active selection/,
  );
  assert.match(
    zeroMatchWarning(counts(), rule("any", field), [
      { kind: "project", descriptor: "P_1", active: false },
    ]) ?? "",
    /Project field condition references inactive GitHub Project P_1/,
  );
  assert.equal(
    zeroMatchWarning(counts({ complete: false }), rule("all", field), []),
    null,
  );
  assert.equal(zeroMatchWarning(null, rule("all", field), []), null);
  assert.equal(
    projectFieldSelectionGap(
      rule("all", label("ready")).conditions,
      [{ kind: "jql", descriptor: "query", active: true }],
      true,
    ),
    null,
    "Jira sources do not supply GitHub Project fields",
  );
});

test("unmet reasons name the missing conditions and stay silent otherwise", () => {
  assert.equal(
    unmetReason({
      rule: rule("all", label("ready"), field),
      outcome: "unmet",
      unmet: [label("ready")],
    }),
    "Not Ready: needs label `ready`",
  );
  assert.equal(
    unmetReason({
      rule: rule("any", label("a"), label("b")),
      outcome: "unmet",
      unmet: [label("a"), label("b")],
    }),
    "Not Ready: needs any of label `a`, label `b`",
  );
  for (const outcome of ["matched", "not-evaluated"] as const)
    assert.equal(
      unmetReason({ rule: rule("all", label("a")), outcome, unmet: [] }),
      null,
    );
  assert.equal(
    unmetReason({ rule: { kind: "unavailable" }, outcome: "unmet", unmet: [] }),
    null,
  );
  assert.equal(unmetReason(undefined), null);
});

test("a Project field condition reads by its names, falling back to the node ID each lacks", () => {
  const named = {
    ...field,
    fieldName: "Status",
    optionNames: { O_1: "Ready" },
  };
  assert.equal(
    unmetReason({ rule: rule("all", named), outcome: "unmet", unmet: [named] }),
    "Not Ready: needs Status = Ready",
  );
  assert.equal(
    selectionCountsText(
      counts({ closedSkipped: 0 }),
      rule("all", { ...field, fieldName: "Status" }),
    ),
    "149 observed · 9 open · 0 match Status = O_1",
  );
});

test("every operator reads by its names, and a multi-option set lists them", () => {
  const status = { ...field, fieldName: "Status" };
  const names = { O_1: "Todo", O_2: "In Progress" };
  const text = (c: Parameters<typeof rule>[1]) =>
    unmetReason({ rule: rule("all", c), outcome: "unmet", unmet: [c] });
  assert.equal(
    text(label("blocked", "lacks")),
    "Not Ready: needs no label `blocked`",
  );
  assert.equal(
    text({
      ...status,
      optionNodeIds: ["O_1", "O_2"],
      optionNames: names,
    }),
    "Not Ready: needs Status is one of Todo, In Progress",
  );
  assert.equal(
    text({
      ...status,
      operator: "not-in",
      optionNodeIds: ["O_1", "O_3"],
      optionNames: names,
    }),
    "Not Ready: needs Status is not one of Todo, O_3",
  );
});
