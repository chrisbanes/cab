import { randomUUID } from "node:crypto";
import {
  ProposalJournal,
  proposalStorageKey,
} from "../../web/src/instruction-proposal-model.js";
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

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
};
test("proposal journal keeps a reviewed run and its edit until the exact replacement settles", () => {
  const storage = memoryStorage(),
    projectId = randomUUID(),
    oldId = randomUUID(),
    nextId = randomUUID();
  const journal = new ProposalJournal(projectId, storage);
  journal.change({ runId: oldId });
  const oldRun = {
    projectId,
    runId: oldId,
    instructionTarget: run.instructionTarget,
  };
  journal.recovery(oldRun).write({
    values: { key: randomUUID(), instructions: "Edited old proposal" },
    command: null,
    receipt: null,
  });
  const previous = { ...journal.snapshot() };
  const pendingStart = {
    type: "instruction.draft.start" as const,
    key: randomUUID(),
    runId: nextId,
    projectId,
    expectedProjectVersion: 3,
    target: { kind: "project" as const },
    feedback: [{ kind: "message" as const, id: randomUUID() }],
    note: "Frozen request",
  };
  journal.change({
    runId: nextId,
    startKey: pendingStart.key,
    expectedProjectVersion: 3,
    pendingStart,
    previous: {
      runId: oldId,
      refs: previous.refs,
      target: previous.target,
      note: previous.note,
    },
  });
  const restored = new ProposalJournal(projectId, storage);
  assert.deepEqual(restored.snapshot().pendingStart, pendingStart);
  restored.refused(randomUUID());
  assert.equal(restored.snapshot().runId, nextId);
  restored.refused(nextId);
  assert.equal(restored.snapshot().runId, oldId);
  assert.equal(
    restored.recovery(oldRun).read()?.values.instructions,
    "Edited old proposal",
  );
  restored.change({
    runId: nextId,
    previous: { runId: oldId, refs: [], target: { kind: "project" }, note: "" },
  });
  restored.started(nextId);
  assert.deepEqual(restored.snapshot().drafts, {});
  restored.clear();
  restored.refused(nextId);
  assert.equal(restored.snapshot().runId, undefined);
});
test("proposal storage accepts legacy selection but rejects corrupt, oversized and foreign recovery identities", () => {
  const projectId = randomUUID(),
    storage = memoryStorage();
  const legacy = {
    refs: [],
    target: { kind: "project" },
    note: "Kept selection",
  };
  storage.setItem(proposalStorageKey(projectId), JSON.stringify(legacy));
  assert.equal(
    new ProposalJournal(projectId, storage).snapshot().note,
    "Kept selection",
  );
  for (const value of [
    "{",
    JSON.stringify({ ...legacy, note: "x".repeat(16001) }),
    JSON.stringify({
      ...legacy,
      drafts: {
        [randomUUID()]: {
          values: { instructions: "x" },
          command: null,
          receipt: null,
        },
      },
    }),
    JSON.stringify({ ...legacy, unknown: "private" }),
  ]) {
    storage.setItem(proposalStorageKey(projectId), value);
    assert.deepEqual(
      new ProposalJournal(projectId, storage).snapshot().refs,
      [],
    );
    assert.equal(new ProposalJournal(projectId, storage).snapshot().note, "");
  }
});
test("blocked storage keeps page state and purge prevents late draft writers recreating private data", () => {
  const projectId = randomUUID(),
    runId = randomUUID();
  const journal = new ProposalJournal(projectId, {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("blocked");
    },
    removeItem() {
      throw Error("blocked");
    },
  });
  journal.change({ runId, note: "In memory" });
  const writer = journal.recovery({
    projectId,
    runId,
    instructionTarget: run.instructionTarget,
  });
  writer.write({
    values: { instructions: "Private edited text" },
    command: null,
    receipt: null,
  });
  assert.equal(journal.available, false);
  assert.equal(
    journal.snapshot().drafts[runId]?.values.instructions,
    "Private edited text",
  );
  journal.purge();
  writer.write({
    values: { instructions: "Late private text" },
    command: null,
    receipt: null,
  });
  journal.change({ runId, note: "Late callback" });
  assert.deepEqual(journal.snapshot().drafts, {});
  assert.equal(journal.snapshot().note, "");
});
