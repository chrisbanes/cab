import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";
import {
  comparisonEntryLimitSentence,
  comparisonObservationTimes,
  comparisonReasonSentence,
  isWorkspaceComparisonStale,
} from "../../web/src/inspection-changes-presentation.js";

type ComparisonData = WorkspaceComparisonRead["data"];
type Entry = Extract<
  ComparisonData,
  { state: "available" }
>["comparison"]["entries"][number];

const entry = (overrides: Partial<Entry>): Entry => ({
  path: "large.txt",
  repositoryId: "repo-alpha",
  change: "modified",
  state: "gap",
  hunks: [],
  ...overrides,
});

test("comparison reasons say what happened and offer a useful next step", () => {
  assert.match(
    comparisonReasonSentence("workspace-unavailable"),
    /Not read yet: workspace was unavailable/,
  );
  assert.match(comparisonReasonSentence("workspace-unavailable"), /Refresh/);
  const partialTurn = comparisonReasonSentence(
    "workspace-unavailable",
    "last-turn",
    true,
  );
  assert.match(partialTurn, /Last turn capture is partial/);
  assert.match(partialTurn, /Captured changes remain visible/);
  assert.match(partialTurn, /unavailable files stay marked as gaps/);
  assert.doesNotMatch(partialTurn, /Not read yet/);
  const emptyTurn = comparisonReasonSentence(
    "workspace-unavailable",
    "last-turn",
  );
  assert.match(emptyTurn, /No captured file changes are available/);
  assert.match(emptyTurn, /capture gap is recorded/);
  assert.doesNotMatch(emptyTurn, /Not read yet/);
  const partialCurrent = comparisonReasonSentence(
    "workspace-unavailable",
    "uncommitted",
    true,
  );
  assert.match(partialCurrent, /Available changes remain visible/);
  assert.doesNotMatch(partialCurrent, /Not read yet/);
  assert.match(
    comparisonReasonSentence("time-limit"),
    /A time limit stopped the comparison/,
  );
  assert.match(
    comparisonReasonSentence("time-limit"),
    /overall observation budget is 5 seconds/,
  );
  assert.match(
    comparisonReasonSentence("time-limit", "branch"),
    /reduce the comparison scope, then refresh/,
  );
  const output = comparisonReasonSentence("output-limit");
  assert.match(output, /2,048-lines-per-side/);
  assert.match(output, /1 MiB rendered-diff/);
  assert.match(output, /does not identify/);
  assert.match(
    comparisonReasonSentence("output-limit", "uncommitted"),
    /Reduce the comparison scope or inspect files locally/,
  );
  for (const reason of ["time-limit", "output-limit", "workspace-changed"]) {
    const historical = comparisonReasonSentence(reason, "last-turn");
    assert.match(historical, /Missing historical observations remain gaps/);
    assert.match(historical, /Refresh checks available capture state/);
    assert.match(historical, /does not rerun the capture/);
    assert.doesNotMatch(historical, /reduce the comparison scope/i);
    assert.doesNotMatch(historical, /Refresh to read it again/);
  }
  const historicalOutput = comparisonReasonSentence(
    "output-limit",
    "last-turn",
  );
  assert.match(historicalOutput, /2,048-lines-per-side/);
  assert.match(historicalOutput, /1 MiB rendered-diff/);
  assert.equal(comparisonReasonSentence(undefined), "");
});

test("a file names exceeded limits only when its observation proves them", () => {
  const lineLimited = comparisonEntryLimitSentence(
    entry({
      reason: "output-limit",
      left: { size: 30_000, lineCount: 2_049 },
      right: { size: 20_000, lineCount: 2_048 },
    }),
  );
  assert.match(lineLimited ?? "", /large\.txt/);
  assert.match(lineLimited ?? "", /2,048 lines on the Before side/);
  assert.match(lineLimited ?? "", /Inspect it locally/);
  assert.doesNotMatch(lineLimited ?? "", /reduce the comparison scope/i);

  const byteLimited = comparisonEntryLimitSentence(
    entry({ reason: "too-large", left: { size: 1_048_577, lineCount: null } }),
  );
  assert.match(byteLimited ?? "", /1 MiB file limit on the Before side/);

  const ambiguous = comparisonEntryLimitSentence(
    entry({
      reason: "output-limit",
      left: { size: 300_000, lineCount: 1_000 },
      right: { size: 300_000, lineCount: 1_000 },
    }),
  );
  assert.match(ambiguous ?? "", /cannot distinguish/);
  assert.match(ambiguous ?? "", /Inspect it locally/);
  assert.doesNotMatch(ambiguous ?? "", /reduce the comparison scope/i);

  const aggregateContentLimit = comparisonEntryLimitSentence(
    entry({ reason: "too-large", left: { size: 500_000, lineCount: null } }),
  );
  assert.doesNotMatch(aggregateContentLimit ?? "", /1 MiB/);
});

test("pending and finished turn observations contribute to staleness only when newer", () => {
  const pending = {
    state: "unsettled",
    pending: { observedAt: 12, beforeObservedAt: 13, afterObservedAt: 15 },
    latestFinished: { observedAt: 11 },
  } as unknown as ComparisonData;
  const observations = comparisonObservationTimes(pending);
  assert.deepEqual(observations, [12, 13, 15, 11]);
  assert.equal(isWorkspaceComparisonStale(10, observations), true);
  assert.equal(isWorkspaceComparisonStale(15, observations), false);
});
