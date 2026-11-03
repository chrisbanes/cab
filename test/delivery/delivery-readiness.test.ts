import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareInputs,
  type ReadinessInputs,
} from "../../src/core/delivery-readiness.js";

const inputs = (
  components: ReadinessInputs["components"],
  over: Partial<ReadinessInputs> = {},
): ReadinessInputs => ({
  item: "github|github.com|I1",
  rule: '{"mode":"any"}',
  components,
  ...over,
});
const label = (present: boolean) => ({
  id: "label:ready",
  value: present ? ["present"] : [],
});
const status = (id: string | null) => ({
  id: "status",
  value: id === null ? null : [id],
});

test("inputs compare by value: a changed set, rule or item differs; an unobserved one is unknown", () => {
  const frozen = inputs([label(true), { id: "pf:A:B", value: ["x", "y"] }]);
  assert.equal(compareInputs(frozen, structuredClone(frozen)), "same");
  assert.equal(
    compareInputs(frozen, inputs([label(false), frozen.components[1]!])),
    "changed",
  );
  assert.equal(
    compareInputs(
      frozen,
      inputs([label(true), { id: "pf:A:B", value: ["x"] }]),
    ),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(true), { id: "pf:A:B", value: null }])),
    "unknown",
  );
  assert.equal(
    compareInputs(frozen, { ...frozen, rule: '{"mode":"all"}' }),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, { ...frozen, item: "github|github.com|I2" }),
    "changed",
  );
});

test("only the close's own target status is exempt, and never a label or field in the same read", () => {
  const frozen = inputs([label(true), status("4")]);
  assert.equal(
    compareInputs(frozen, inputs([label(true), status("9")]), "9"),
    "same",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(true), status("9")])),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(true), status("10")]), "9"),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(false), status("9")]), "9"),
    "changed",
  );
});
