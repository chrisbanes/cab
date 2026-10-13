import assert from "node:assert/strict";
import { test } from "node:test";
import { executionIntentStateSchema } from "../src/core/execution-runtime.js";
import {
  assignmentRecoverySchema,
  commandReceiptSchema,
  localReviewOperationReadSchema,
  operatorCommandSchema,
  materialSchema,
  workspaceComparisonReadSchema,
  workspaceSchema,
  taskSchema,
} from "../src/operator/contracts.js";
const key = "00000000-0000-4000-8000-000000000001";
const create = {
  type: "task.create",
  key,
  projectId: key,
  taskId: key,
  title: "Brief",
  outcome: "Outcome",
  ready: true,
};
test("operator commands accept supported inputs and reject authority or unrestricted payloads", () => {
  assert.equal(operatorCommandSchema.parse(create).type, "task.create");
  for (const extra of [
    { actor: "agent" },
    { credentialRef: "env:SECRET" },
    { payload: {} },
    { taskId: "bad" },
    { type: "imported-blockers.set" },
  ])
    assert.equal(
      operatorCommandSchema.safeParse({ ...create, ...extra }).success,
      false,
    );
  assert.equal(
    operatorCommandSchema.safeParse({
      type: "assignment.apply",
      key,
      projectId: key,
      assignmentId: key,
      expectedVersion: 0,
    }).success,
    false,
  );
});
test("read envelopes reject row fields and invalid states", () => {
  const runtime = { state: "available" };
  assert.deepEqual(
    workspaceSchema.parse({
      data: { projects: [], profiles: [], runtime, harnesses: [] },
      observedAt: 1,
    }).data.projects,
    [],
  );
  assert.deepEqual(
    workspaceSchema.parse({
      data: {
        projects: [],
        profiles: [],
        runtime: { state: "unavailable", since: 5 },
        harnesses: [
          {
            harness: "codex",
            state: "unavailable",
            since: 5,
            policy: { lines: ["a"], limits: [] },
            settings: null,
          },
          {
            harness: "claude",
            state: "not-configured",
            policy: null,
            settings: { models: [{ model: "default", efforts: ["high"] }] },
          },
        ],
      },
      observedAt: 1,
    }).data.runtime,
    { state: "unavailable", since: 5 },
  );
  for (const invalid of [
    undefined,
    { state: "unavailable" },
    { state: "available", since: 5 },
    { state: "unavailable", since: -1 },
    { state: "unavailable", since: 5, error: "secret" },
  ])
    assert.equal(
      workspaceSchema.safeParse({
        data: { projects: [], profiles: [], runtime: invalid, harnesses: [] },
        observedAt: 1,
      }).success,
      false,
    );
  for (const invalid of [
    { harness: "codex", state: "unavailable", policy: null, settings: null },
    {
      harness: "codex",
      state: "not-configured",
      since: 5,
      policy: null,
      settings: null,
    },
    { harness: "pi", state: "available", policy: null, settings: null },
    {
      harness: "claude",
      state: "unavailable",
      since: 5,
      error: "secret",
      policy: null,
      settings: null,
    },
    { harness: "claude", state: "available", settings: null },
    {
      harness: "claude",
      state: "available",
      policy: null,
      settings: { models: [{ model: "a b", efforts: [] }] },
    },
  ])
    assert.equal(
      workspaceSchema.safeParse({
        data: { projects: [], profiles: [], runtime, harnesses: [invalid] },
        observedAt: 1,
      }).success,
      false,
    );
  assert.equal(
    workspaceSchema.safeParse({
      data: {
        projects: [],
        profiles: [],
        runtime,
        harnesses: [],
        credentialRef: "secret",
      },
      observedAt: 1,
    }).success,
    false,
  );
  assert.equal(
    taskSchema.safeParse({
      data: { task: { state: "fictional" } },
      observedAt: 1,
    }).success,
    false,
  );
});

test("all supported command variants validate exact revisions and bounded material without completion convenience", () => {
  const base = { key, taskId: key };
  for (const command of [
    { ...create, ready: false },
    {
      type: "task.configure",
      ...base,
      projectId: key,
      expectedVersion: 1,
      ready: true,
    },
    {
      type: "dependency.add",
      ...base,
      projectId: key,
      blockerTaskId: key,
      expectedVersion: 1,
    },
    {
      type: "dependency.remove",
      ...base,
      projectId: key,
      blockerTaskId: key,
      expectedVersion: 1,
    },
    {
      type: "assignment.apply",
      key,
      projectId: key,
      assignmentId: key,
      expectedVersion: 1,
    },
    {
      type: "message",
      ...base,
      recipientAssignmentId: key,
      expectedAssignmentVersion: 1,
      message: "Retained",
    },
    {
      type: "question.answer",
      ...base,
      interactionId: key,
      expectedRevision: 1,
      answer: "A",
    },
    {
      type: "approval.decide",
      ...base,
      interactionId: key,
      expectedRevision: 1,
      decision: "denied",
      action: "Publish",
    },
    {
      type: "approval.decide",
      ...base,
      interactionId: key,
      expectedRevision: 1,
      decision: "approved",
      action: "Publish",
      material: { version: "next" },
    },
    {
      type: "result.recipient",
      ...base,
      resultId: key,
      expectedRevision: 1,
      recipientAssignmentId: key,
    },
  ])
    assert.equal(operatorCommandSchema.safeParse(command).success, true);
  assert.equal(
    operatorCommandSchema.safeParse({
      type: "task.configure",
      ...base,
      projectId: key,
      expectedVersion: 1,
      state: "done",
    }).success,
    false,
  );
  assert.equal(materialSchema.safeParse("😀".repeat(3000)).success, false);
  let deep: unknown = "value";
  for (let i = 0; i < 13; i++) deep = [deep];
  assert.equal(materialSchema.safeParse(deep).success, false);
});

test("receipts record a resumed lead only as a literal true", () => {
  const coordination = {
    kind: "coordination",
    key,
    recorded: true,
    eventId: key,
    taskId: key,
    recipientAssignmentId: key,
    eventType: "assignment-follow-up",
    createdAt: 1,
  };
  const review = {
    kind: "local-review-operation",
    key,
    taskId: key,
    reviewId: key,
    state: "recorded",
    eventId: key,
    recipientAssignmentId: key,
  };
  const operation = {
    data: {
      operationId: key,
      taskId: key,
      reviewId: key,
      state: "recorded",
      eventId: key,
      recipientAssignmentId: key,
      recordedAt: 1,
    },
    observedAt: 1,
  };
  for (const receipt of [coordination, review]) {
    assert.equal(commandReceiptSchema.safeParse(receipt).success, true);
    assert.equal(
      commandReceiptSchema.safeParse({ ...receipt, resumedLead: true }).success,
      true,
    );
    assert.equal(
      commandReceiptSchema.safeParse({ ...receipt, resumedLead: false })
        .success,
      false,
    );
  }
  assert.equal(
    localReviewOperationReadSchema.safeParse(operation).success,
    true,
  );
  assert.equal(
    localReviewOperationReadSchema.safeParse({
      ...operation,
      data: { ...operation.data, resumedLead: true },
    }).success,
    true,
  );
  assert.equal(
    localReviewOperationReadSchema.safeParse({
      ...operation,
      data: { ...operation.data, resumedLead: false },
    }).success,
    false,
  );
});

test("capacity commands accept an optional strict expectedCurrent", () => {
  const capacity = {
    type: "capacity.configure",
    key,
    globalLimit: 3,
    projectOverrides: { [key]: null },
  };
  const parsed = operatorCommandSchema.parse(capacity);
  assert.ok(!("expectedCurrent" in parsed));
  assert.deepEqual(
    operatorCommandSchema.parse({
      ...capacity,
      expectedCurrent: { globalLimit: 4 },
    }),
    { ...capacity, expectedCurrent: { globalLimit: 4, projectOverrides: {} } },
  );
  for (const expectedCurrent of [
    { globalLimit: 0 },
    { globalLimit: 4, projectOverrides: { nope: 1 } },
    { globalLimit: 4, projectOverrides: { [key]: 0 } },
    { globalLimit: 4, version: 1 },
    {},
  ])
    assert.equal(
      operatorCommandSchema.safeParse({ ...capacity, expectedCurrent }).success,
      false,
      JSON.stringify(expectedCurrent),
    );
});

test("recovery records accept each persisted intent state plus the operator-only unknown", () => {
  const intentState =
    assignmentRecoverySchema.shape.data.shape.records.element.shape.intentState;
  assert.ok(
    !(executionIntentStateSchema.options as string[]).includes("unknown"),
  );
  for (const state of [...executionIntentStateSchema.options, "unknown"])
    assert.equal(intentState.safeParse(state).success, true, state);
  assert.equal(intentState.safeParse("bogus").success, false);
});

test("project.create shares one setup repositories schema with both refinements", () => {
  const repo = (repositoryId: string, owner: string, name: string) => ({
    repositoryId,
    owner,
    name,
    path: `/work/${repositoryId}`,
    ref: "main",
  });
  const project = (repositories: unknown[]) => ({
    type: "project.create",
    key,
    projectId: key,
    name: "Project",
    leadProfileId: null,
    repositories,
  });
  const messages = (repositories: unknown[]) => {
    const parsed = operatorCommandSchema.safeParse(project(repositories));
    return parsed.success ? null : parsed.error.issues.map((i) => i.message);
  };
  assert.equal(
    messages([repo("a", "acme", "app"), repo("b", "acme", "web")]),
    null,
  );
  assert.deepEqual(
    messages([repo("a", "acme", "app"), repo("a", "acme", "web")]),
    ["Repository IDs must be unique"],
  );
  assert.deepEqual(
    messages([repo("a", "Acme", "App"), repo("b", "acme", "app")]),
    ["Repositories must be unique"],
  );
  assert.notEqual(
    messages(
      Array.from({ length: 21 }, (_, i) => repo(`r${i}`, "acme", `app${i}`)),
    ),
    null,
  );
});

test("review.anchor.stage types its anchors and keeps every selection rule", () => {
  const contentSha256 = "a".repeat(64);
  const file = {
    taskId: key,
    repositoryId: null,
    path: "src/a.ts",
    sourceKind: "workspace-file",
    context: "workspace",
    side: "file",
    startLine: 1,
    endLine: 2,
    contentSha256,
  };
  const side = {
    ...file,
    sourceKind: "comparison-side",
    context: "branch",
    comparisonId: key,
    side: "left",
  };
  const stage = (anchors: unknown[]) => ({
    type: "review.anchor.stage",
    key,
    taskId: key,
    expectedDraftVersion: 0,
    anchors,
  });
  const accepted = (anchors: unknown[]) =>
    operatorCommandSchema.safeParse(stage(anchors)).success;
  assert.equal(accepted([file, side]), true);
  const { contentSha256: _hash, ...unhashed } = file;
  for (const [name, anchors] of [
    ["missing hash", [unhashed]],
    ["inverted range", [{ ...file, startLine: 3, endLine: 2 }]],
    ["workspace file on a comparison side", [{ ...file, side: "left" }]],
    ["turn without thread", [{ ...side, context: "turn", workId: "w" }]],
    ["unknown key", [{ ...file, extra: true }]],
    ["no anchors", []],
  ] as const)
    assert.equal(accepted([...anchors]), false, name);
});

test("workspace comparison reads stay stricter than persistence at every nested level", () => {
  const sha256 = "a".repeat(64);
  const comparisonId = "00000000-0000-4000-8000-000000000002";
  const content = { sha256, size: 4, lineCount: 2, modifiedAt: 5 };
  const anchor = (side: "left" | "right") => ({
    taskId: key,
    repositoryId: "repo",
    path: "a.txt",
    comparisonId,
    context: "branch",
    side,
    startLine: 1,
    endLine: 2,
    contentSha256: sha256,
  });
  const repository = {
    comparisonId,
    taskId: key,
    repositoryId: "repo",
    target: "branch",
    state: "available",
    observedAt: 7,
    baseline: { kind: "merge-base", branch: "main", commit: "c".repeat(40) },
    availableBaseBranches: ["main"],
    entries: [
      {
        path: "a.txt",
        change: "modified",
        state: "text",
        left: content,
        right: content,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            patch: "@@",
            leftAnchor: anchor("left"),
            rightAnchor: anchor("right"),
          },
        ],
      },
    ],
    truncated: false,
  };
  const turn = {
    comparisonId: "00000000-0000-4000-8000-000000000003",
    taskId: key,
    target: "turn",
    state: "available",
    outcome: "completed",
    startedAt: 1,
    observedAt: 2,
    workId: "w",
    workRevision: 1,
    requestSequence: 1,
    assignmentId: "a",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    profileId: key,
    entries: [],
    truncated: false,
  };
  const read = (comparison: unknown) => ({
    data: {
      taskId: key,
      target: "branch",
      state: "available",
      comparisonId,
      comparison,
    },
    observedAt: 1,
  });
  const unsettled = (pending: unknown) => ({
    data: {
      taskId: key,
      target: "last-turn",
      state: "unsettled",
      pending,
    },
    observedAt: 1,
  });
  const accepts = (value: unknown) =>
    workspaceComparisonReadSchema.safeParse(value).success;
  assert.equal(accepts(read(repository)), true);
  assert.equal(accepts(read(turn)), true);

  const hunk = repository.entries[0]!.hunks[0]!;
  const withEntry = (patch: object) => ({
    ...repository,
    entries: [{ ...repository.entries[0]!, ...patch }],
  });
  const withAnchor = (patch: object) =>
    withEntry({
      hunks: [{ ...hunk, leftAnchor: { ...hunk.leftAnchor, ...patch } }],
    });
  for (const [name, comparison] of [
    ["snapshot taskId", { ...repository, taskId: "legacy-task" }],
    [
      "baseline branch",
      {
        ...repository,
        baseline: { kind: "head", branch: "", commit: "c".repeat(40) },
      },
    ],
    [
      "branch name length",
      { ...repository, availableBaseBranches: ["b".repeat(256)] },
    ],
    ["entry path length", withEntry({ path: "p".repeat(2049) })],
    ["content modifiedAt", withEntry({ left: { ...content, modifiedAt: -1 } })],
    ["anchor taskId", withAnchor({ taskId: "legacy-task" })],
    ["anchor path length", withAnchor({ path: "p".repeat(2049) })],
    ["anchor range", withAnchor({ startLine: 2, endLine: 1 })],
    ["unknown snapshot key", { ...repository, extra: true }],
    ["unknown anchor key", withAnchor({ extra: true })],
    ["turn profileId", { ...turn, profileId: "legacy-profile" }],
    ["turn workId length", { ...turn, workId: "w".repeat(513) }],
  ] as const)
    assert.equal(accepts(read(comparison)), false, name);

  const identity = {
    taskId: key,
    workId: "w",
    workRevision: 1,
    requestSequence: 1,
    assignmentId: "a",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    profileId: key,
  };
  const pending = {
    comparisonId: turn.comparisonId,
    identity,
    captureState: "pending",
    outcome: "running",
    startedAt: 1,
    observedAt: 2,
    reason: "capture-store-failed",
  };
  assert.equal(accepts(unsettled(pending)), true);
  for (const [name, value] of [
    [
      "identity profileId",
      { ...pending, identity: { ...identity, profileId: "legacy-profile" } },
    ],
    [
      "identity taskId",
      { ...pending, identity: { ...identity, taskId: "legacy-task" } },
    ],
    ["reason", { ...pending, reason: "not-a-reason" }],
  ] as const)
    assert.equal(accepts(unsettled(value)), false, name);
});
