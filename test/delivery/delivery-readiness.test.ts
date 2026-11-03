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
    compareInputs(frozen, inputs([label(true), status("9")]), {
      statusId: "9",
    }),
    "same",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(true), status("9")])),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(true), status("10")]), {
      statusId: "9",
    }),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, inputs([label(false), status("9")]), {
      statusId: "9",
    }),
    "changed",
  );
});

test("an own close exempts a Project field moved to an option the rule does not accept, and nothing else", () => {
  const rule = JSON.stringify({
    mode: "any",
    conditions: [
      {
        kind: "project-field",
        projectNodeId: "P",
        fieldNodeId: "F",
        operator: "in",
        optionNodeIds: ["todo", "review"],
      },
    ],
  });
  const field = (value: string[]) => ({ id: "project-field:P:F", value });
  const at = (components: ReadinessInputs["components"]) =>
    inputs(components, { rule });
  const frozen = at([label(true), field(["todo"])]);
  const close = {};
  // Status -> Done, which the rule does not accept.
  assert.equal(
    compareInputs(frozen, at([label(true), field(["done"])]), close),
    "same",
  );
  assert.equal(
    compareInputs(frozen, at([label(true), field(["done"])])),
    "changed",
  );
  // A move to an option the rule accepts, or to a set holding one, is still a change.
  assert.equal(
    compareInputs(frozen, at([label(true), field(["review"])]), close),
    "changed",
  );
  assert.equal(
    compareInputs(frozen, at([label(true), field(["done", "review"])]), close),
    "changed",
  );
  // As is a label in the same read.
  assert.equal(
    compareInputs(frozen, at([label(false), field(["done"])]), close),
    "changed",
  );
});
