import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatElapsed,
  planFill,
} from "../../web/src/composer-drafting-model.js";

const proposal = { title: "Proposed title", outcome: "Proposed outcome" };

test("a proposal fills empty fields and offers a choice beside typed text", () => {
  assert.deepEqual(planFill({ title: "", outcome: "  " }, proposal), {
    fill: { title: proposal.title, outcome: proposal.outcome },
    choices: [],
  });
  assert.deepEqual(planFill({ title: "Mine", outcome: "" }, proposal), {
    fill: { outcome: proposal.outcome },
    choices: [{ field: "title", proposed: proposal.title }],
  });
  // Text that already equals the proposal needs no second choice after a reload.
  assert.deepEqual(planFill(proposal, proposal), { fill: {}, choices: [] });
});

test("elapsed time reads as minutes and seconds", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(161.9), "2:41");
  assert.equal(formatElapsed(600), "10:00");
  assert.equal(formatElapsed(-3), "0:00");
});
