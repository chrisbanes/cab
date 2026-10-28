import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ResetFacts,
  resetAvailability,
  type RestartRequestKind,
  type StartAgainFacts,
  startAgainAvailability,
} from "../../src/standalone/task-restart.js";
import {
  resetUnavailableText,
  startAgainUnavailableText,
} from "../../src/operator/task-restart-copy.js";

const request = (
  kind: RestartRequestKind,
  sequence = 1,
  workId = `w${sequence}`,
) => ({
  workId,
  sequence,
  kind,
});
const refused: StartAgainFacts = {
  taskState: "open",
  sourceHeld: false,
  nonStopHold: false,
  assignments: [
    { assignmentId: "a", held: false, request: request("refused") },
  ],
};

test("Start again names the refused request and the first reason that blocks it", () => {
  assert.deepEqual(startAgainAvailability(refused), {
    available: true,
    assignmentId: "a",
    workId: "w1",
  });
  const refusals: Array<[Partial<StartAgainFacts>, string]> = [
    [{ taskState: "done" }, "task-not-open"],
    [{ taskState: "cancelled", sourceHeld: true }, "task-not-open"],
    [{ sourceHeld: true }, "source-held"],
    [{ nonStopHold: true }, "execution-unresolved"],
    [{ assignments: [] }, "nothing-refused"],
    [
      {
        assignments: [
          { assignmentId: "a", held: false, request: request("settled") },
        ],
      },
      "nothing-refused",
    ],
    [{ assignments: [{ assignmentId: "a", held: false }] }, "nothing-refused"],
    [
      {
        assignments: [
          { assignmentId: "a", held: true, request: request("refused") },
        ],
      },
      "assignment-held",
    ],
    [
      {
        assignments: [
          { assignmentId: "a", held: false, request: request("interrupted") },
        ],
      },
      "submission-interrupted",
    ],
    [
      {
        assignments: [
          { assignmentId: "a", held: false, request: request("unresolved") },
        ],
      },
      "execution-unresolved",
    ],
  ];
  for (const [change, reason] of refusals)
    assert.deepEqual(startAgainAvailability({ ...refused, ...change }), {
      available: false,
      reason,
    });
  // Something that may still be live outranks another assignment's refusal.
  assert.deepEqual(
    startAgainAvailability({
      ...refused,
      assignments: [
        { assignmentId: "a", held: false, request: request("refused", 1) },
        { assignmentId: "b", held: false, request: request("interrupted", 2) },
      ],
    }),
    { available: false, reason: "submission-interrupted" },
  );
  assert.match(
    startAgainUnavailableText("source-held"),
    /^Start again unavailable: .*source review/,
  );
});

test("Start again targets the newest refused request", () => {
  assert.deepEqual(
    startAgainAvailability({
      ...refused,
      assignments: [
        { assignmentId: "a", held: false, request: request("refused", 1) },
        { assignmentId: "b", held: false, request: request("refused", 3) },
        { assignmentId: "c", held: false, request: request("settled", 5) },
      ],
    }),
    { available: true, assignmentId: "b", workId: "w3" },
  );
});

const open: ResetFacts = {
  taskState: "open",
  ready: true,
  leadConfigured: true,
  leadStarted: true,
  unresolvedExecution: false,
  held: false,
};

test("Reset is available only on an open, Ready task with a started lead and nothing unresolved", () => {
  assert.deepEqual(resetAvailability(open), { available: true });
  const refusals: Array<[Partial<ResetFacts>, string]> = [
    [{ taskState: "done" }, "task-not-open"],
    [{ ready: false }, "task-not-ready"],
    [{ leadConfigured: false }, "lead-unconfigured"],
    [{ leadStarted: false }, "nothing-to-reset"],
    [{ unresolvedExecution: true }, "execution-unresolved"],
    [{ held: true }, "task-held"],
    [{ unresolvedExecution: true, held: true }, "execution-unresolved"],
  ];
  for (const [change, reason] of refusals)
    assert.deepEqual(resetAvailability({ ...open, ...change }), {
      available: false,
      reason,
    });
  assert.match(resetUnavailableText("task-held"), /^Reset unavailable: /);
});
