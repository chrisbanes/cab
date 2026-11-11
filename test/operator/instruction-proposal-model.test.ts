import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptBlock,
  impactLines,
  restoreLine,
  savedLine,
  selectionSummary,
} from "../../web/src/instruction-proposal-model.js";

test("the selection counts items and characters and refuses past 20 items or 64,000 characters", () => {
  assert.deepEqual(selectionSummary(["abc", "de"]), {
    line: "2 of 20 selected · 5 of 64,000 characters",
    over: false,
    sendable: true,
  });
  assert.equal(selectionSummary([]).sendable, false);
  assert.equal(selectionSummary(Array(21).fill("x")).over, true);
  assert.equal(selectionSummary(Array(20).fill("x")).sendable, true);
  assert.equal(selectionSummary(["x".repeat(64_001)]).sendable, false);
  assert.equal(selectionSummary(["x".repeat(64_000)]).sendable, true);
});

const run = {
  state: "proposed" as const,
  proposalWithheld: false,
  instructionTarget: {
    kind: "project" as const,
    profileId: null,
    name: "Atlas",
    observedVersion: 3,
    observedInstructions: "Keep changes small.",
  },
  targetCurrent: { version: 3, unchanged: true },
};

test("Accept is offered only for a shown proposal against unchanged instructions with changed text", () => {
  assert.equal(acceptBlock(run, "Keep changes small.\nMore."), null);
  assert.match(
    acceptBlock(
      { ...run, targetCurrent: { version: 4, unchanged: false } },
      "Keep changes small.\nMore.",
    ) ?? "",
    /changed since.*Redraft/,
  );
  assert.match(
    acceptBlock(run, "Keep changes small.") ?? "",
    /same as the current/,
  );
  assert.match(
    acceptBlock({ ...run, proposalWithheld: true }, "Other") ?? "",
    /cannot be shown/,
  );
  assert.match(
    acceptBlock({ ...run, state: "accepted" }, "Other") ?? "",
    /no proposal/,
  );
});

test("an agent target names every project using it; existing assignments keep their revision", () => {
  const lines = impactLines({
    instructionTarget: {
      kind: "profile",
      profileId: "00000000-0000-4000-8000-000000000001",
      name: "Rae",
      observedVersion: 2,
      observedInstructions: "Review.",
    },
    impact: {
      projects: [
        {
          projectId: "00000000-0000-4000-8000-000000000002",
          name: "Atlas",
          role: "permitted",
        },
        {
          projectId: "00000000-0000-4000-8000-000000000003",
          name: "Beta",
          role: "lead",
        },
      ],
      openAssignments: 1,
    },
  });
  assert.equal(
    lines[0],
    "Saving creates agent Rae's next revision, used by 2 projects: Atlas (permitted agent), Beta (lead). New assignments in each use it.",
  );
  assert.equal(
    lines[1],
    "1 open-task assignment uses the current revision and keeps it until you choose Apply current instructions on it.",
  );
  assert.match(
    impactLines({ ...run, impact: { projects: [], openAssignments: 2 } })[0] ??
      "",
    /this project's next instructions revision/,
  );
});

test("restore and saved lines name the existing workflow and the new revision", () => {
  assert.match(
    restoreLine("project"),
    /cab project prepare --restore-revision N/,
  );
  assert.match(
    restoreLine("profile"),
    /cab profile prepare --restore-revision N/,
  );
  assert.equal(savedLine(5), "Saved as instructions revision 5.");
});
