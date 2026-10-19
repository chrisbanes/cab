import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftingProposedPollMs,
  formatElapsed,
  planFill,
  proposedReadDelay,
  releaseBackoffMs,
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

test("a release that keeps not completing backs off to a minute and keeps retrying", () => {
  const waits = [1, 2, 3, 4, 5, 6, 50].map(releaseBackoffMs);
  assert.deepEqual(
    waits,
    [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000],
  );
});

test("elapsed time reads as minutes and seconds", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(161.9), "2:41");
  assert.equal(formatElapsed(600), "10:00");
  assert.equal(formatElapsed(-3), "0:00");
});

test("a waiting proposal is read again at its expiry or the slow interval, whichever is first", () => {
  assert.equal(proposedReadDelay(null, 0), draftingProposedPollMs);
  assert.equal(proposedReadDelay(10_000, 0), 10_500);
  assert.equal(proposedReadDelay(1_000_000, 0), draftingProposedPollMs);
  assert.equal(proposedReadDelay(100, 5_000), 500);
});
