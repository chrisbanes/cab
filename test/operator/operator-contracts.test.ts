import assert from "node:assert/strict";
import { test } from "node:test";
import { executionIntentStateSchema } from "../../src/core/execution-runtime.js";
import {
  assignmentRecoverySchema,
  commandReceiptSchema,
  interactionSchema,
  localReviewOperationReadSchema,
  operatorCommandSchema,
  operationScopeSchema,
  materialSchema,
  workspaceComparisonReadSchema,
  workspaceSchema,
  taskSchema,
  readinessRuleViewSchema,
  selectionCountsSchema,
} from "../../src/operator/contracts.js";
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
      data: {
        projects: [],
        profiles: [],
        runtime,
        harnesses: [],
        gettingStarted: { turnStarted: false, dismissed: false },
      },
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
            enabled: true,
            state: "unavailable",
            since: 5,
            policy: { lines: ["a"], limits: [] },
            settings: null,
          },
          {
            harness: "claude",
            enabled: false,
            state: "not-configured",
            reason: "disabled",
            policy: null,
            settings: { models: [{ model: "default", efforts: ["high"] }] },
          },
        ],
        gettingStarted: { turnStarted: false, dismissed: false },
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
        data: {
          projects: [],
          profiles: [],
          runtime: invalid,
          harnesses: [],
          gettingStarted: { turnStarted: false, dismissed: false },
        },
        observedAt: 1,
      }).success,
      false,
    );
  for (const invalid of [
    {
      harness: "codex",
      enabled: true,
      state: "not-configured",
      policy: null,
      settings: null,
    },
    {
      harness: "codex",
      state: "available",
      policy: null,
      settings: null,
    },
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
  const repositoryComparisonId = "00000000-0000-4000-8000-000000000002";
  const turnComparisonId = "00000000-0000-4000-8000-000000000003";
  const content = { sha256, size: 4, lineCount: 2, modifiedAt: 5 };
  const anchor = (
    comparisonId: string,
    side: "left" | "right",
    over: object,
  ) => ({
    taskId: key,
    repositoryId: "repo",
    path: "a.txt",
    comparisonId,
    context: "branch",
    side,
    startLine: 1,
    endLine: 2,
    contentSha256: sha256,
    ...over,
  });
  const entry = (comparisonId: string, over: object, anchorOver: object) => ({
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
        leftAnchor: anchor(comparisonId, "left", anchorOver),
        rightAnchor: anchor(comparisonId, "right", anchorOver),
      },
    ],
    ...over,
  });
  const repository = (over: object = {}) => ({
    comparisonId: repositoryComparisonId,
    taskId: key,
    repositoryId: "repo",
    target: "branch",
    state: "available",
    observedAt: 7,
    baseline: { kind: "merge-base", branch: "main", commit: "c".repeat(40) },
    availableBaseBranches: ["main"],
    entries: [entry(repositoryComparisonId, {}, {})],
    truncated: false,
    ...over,
  });
  const turn = (
    over: object = {},
    entryOver: object = {},
    anchorOver = {},
  ) => ({
    comparisonId: turnComparisonId,
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
    threadId: "th",
    turnId: "tu",
    entries: [
      entry(
        turnComparisonId,
        { repositoryId: null, ...entryOver },
        {
          context: "turn",
          repositoryId: null,
          workId: "w",
          threadId: "th",
          turnId: "tu",
          ...anchorOver,
        },
      ),
    ],
    truncated: false,
    ...over,
  });
  const read = (comparison: unknown) => ({
    data: {
      taskId: key,
      target: "branch",
      state: "available",
      comparisonId: repositoryComparisonId,
      comparison,
    },
    observedAt: 1,
  });
  const identity = (over: object = {}) => ({
    taskId: key,
    workId: "w",
    workRevision: 1,
    requestSequence: 1,
    assignmentId: "a",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    profileId: key,
    ...over,
  });
  const unsettled = (over: object = {}) => ({
    data: {
      taskId: key,
      target: "last-turn",
      state: "unsettled",
      pending: {
        comparisonId: turnComparisonId,
        identity: identity(),
        captureState: "pending",
        outcome: "running",
        startedAt: 1,
        observedAt: 2,
        reason: "capture-store-failed",
        ...over,
      },
    },
    observedAt: 1,
  });
  const accepts = (value: unknown) =>
    workspaceComparisonReadSchema.safeParse(value).success;
  const long = (length: number) => "p".repeat(length);

  // Every valid baseline must be accepted, so each rejection below is caused by
  // exactly the one field it changes. Field-bound cases use documents without
  // hunks: the anchor cross-check would otherwise reject them first and hide a
  // missing override.
  assert.equal(accepts(read(repository())), true);
  assert.equal(accepts(read(turn())), true);
  assert.equal(accepts(unsettled()), true);

  const snapshot = (over: object) => read(repository({ entries: [], ...over }));
  const repoEntry = (over: object) =>
    read(
      repository({
        entries: [entry(repositoryComparisonId, { hunks: [], ...over }, {})],
      }),
    );
  const turnSnapshot = (over: object) => read(turn({ entries: [], ...over }));
  const turnEntry = (over: object) => read(turn({}, { hunks: [], ...over }));

  for (const [name, doc] of [
    // snapshot and baseline
    ["snapshot taskId", snapshot({ taskId: "legacy-task" })],
    ["snapshot repositoryId", snapshot({ repositoryId: long(513) })],
    [
      "baseline branch",
      snapshot({
        baseline: { kind: "head", branch: "", commit: "c".repeat(40) },
      }),
    ],
    [
      "branch name length",
      snapshot({ availableBaseBranches: ["b".repeat(256)] }),
    ],
    ["unknown snapshot key", snapshot({ extra: true })],
    // entry and content
    ["entry path", repoEntry({ path: long(2049) })],
    ["entry previousPath", repoEntry({ previousPath: long(2049) })],
    ["entry repositoryId", repoEntry({ repositoryId: long(513) })],
    [
      "left content modifiedAt",
      repoEntry({ left: { ...content, modifiedAt: -1 } }),
    ],
    [
      "right content modifiedAt",
      repoEntry({ right: { ...content, modifiedAt: -1 } }),
    ],
    // anchors, on both sides. Their taskId, path and repositoryId are also
    // forced equal to the bounded snapshot and entry values, so only the
    // cross-check (not the anchor's own bound) is observable for those.
    ...(["leftAnchor", "rightAnchor"] as const).flatMap((side) => {
      const withAnchor = (over: object) => {
        const e = entry(repositoryComparisonId, {}, {});
        e.hunks[0] = {
          ...e.hunks[0]!,
          [side]: { ...e.hunks[0]![side], ...over },
        };
        return read(repository({ entries: [e] }));
      };
      return [
        [`${side} taskId mismatch`, withAnchor({ taskId: "legacy-task" })],
        [`${side} path mismatch`, withAnchor({ path: long(2049) })],
        [`${side} resultId`, withAnchor({ resultId: long(513) })],
        [`${side} workId`, withAnchor({ workId: long(513) })],
        [`${side} threadId`, withAnchor({ threadId: long(513) })],
        [`${side} turnId`, withAnchor({ turnId: long(513) })],
        [`${side} range`, withAnchor({ startLine: 2, endLine: 1 })],
        [`${side} unknown key`, withAnchor({ extra: true })],
      ] as const;
    }),
    // turn comparison and its nested entries
    ["turn taskId", turnSnapshot({ taskId: "legacy-task" })],
    ["turn profileId", turnSnapshot({ profileId: "legacy-profile" })],
    ["turn workId", turnSnapshot({ workId: long(513) })],
    ["turn assignmentId", turnSnapshot({ assignmentId: long(513) })],
    ["turn threadId", turnSnapshot({ threadId: long(513) })],
    ["turn turnId", turnSnapshot({ turnId: long(513) })],
    ["turn entry path", turnEntry({ path: long(2049) })],
    [
      "turn entry modifiedAt",
      turnEntry({ right: { ...content, modifiedAt: -1 } }),
    ],
    ["turn anchor range", read(turn({}, {}, { startLine: 2, endLine: 1 }))],
    [
      "turn anchor taskId mismatch",
      read(turn({}, {}, { taskId: "legacy-task" })),
    ],
    // pending capture identity and reason
    [
      "identity taskId",
      unsettled({ identity: identity({ taskId: "legacy-task" }) }),
    ],
    [
      "identity profileId",
      unsettled({ identity: identity({ profileId: "legacy-profile" }) }),
    ],
    [
      "identity workId",
      unsettled({ identity: identity({ workId: long(513) }) }),
    ],
    [
      "identity assignmentId",
      unsettled({ identity: identity({ assignmentId: long(513) }) }),
    ],
    ["pending reason", unsettled({ reason: "not-a-reason" })],
    [
      "pending comparison entries",
      unsettled({ comparison: turn({}, { hunks: [], path: long(2049) }) }),
    ],
  ] as const)
    assert.equal(accepts(doc), false, name);
});

test("runtime enablement receipts and commands name a known harness", () => {
  const receipt = {
    kind: "configuration",
    key: "00000000-0000-4000-8000-000000000001",
    recorded: true,
    result: {
      commandType: "runtime.configure",
      resourceId: "system:runtime:claude",
      harness: "claude",
      enabled: false,
    },
  };
  assert.equal(commandReceiptSchema.safeParse(receipt).success, true);
  for (const result of [
    { ...receipt.result, harness: "pi" },
    { ...receipt.result, resourceId: "system:runtime:pi" },
    { ...receipt.result, confirmed: true },
  ])
    assert.equal(
      commandReceiptSchema.safeParse({ ...receipt, result }).success,
      false,
    );
  assert.equal(
    operationScopeSchema.safeParse("system:runtime:claude").success,
    true,
  );
  assert.equal(
    operationScopeSchema.safeParse("system:runtime:pi").success,
    false,
  );
});

test("readiness rule views and selection counts are strict", () => {
  for (const view of [
    { kind: "none" },
    { kind: "unavailable" },
    {
      kind: "rule",
      mode: "any",
      conditions: [{ kind: "label", operator: "has", name: "a" }],
    },
  ])
    assert.equal(readinessRuleViewSchema.safeParse(view).success, true);
  for (const view of [
    { kind: "none", conditions: [] },
    { kind: "unavailable", mode: "all" },
    { kind: "rule", mode: "all", conditions: [] },
  ])
    assert.equal(readinessRuleViewSchema.safeParse(view).success, false);
  const counts = {
    observed: 2,
    open: 1,
    closedSkipped: 1,
    matching: null,
    complete: true,
  };
  assert.equal(selectionCountsSchema.safeParse(counts).success, true);
  assert.equal(
    selectionCountsSchema.safeParse({ ...counts, open: -1 }).success,
    false,
  );
  assert.equal(
    selectionCountsSchema.safeParse({ ...counts, total: 2 }).success,
    false,
  );
});

test("an approval's compare link comes with its code host, and a GitHub link stays on github.com", () => {
  const approval = {
    interactionId: key,
    taskId: key,
    requestingAssignmentId: key,
    requestingWorkId: "w",
    requestingWorkRevision: 1,
    requestingAssignmentVersion: 1,
    conversationRevision: 1,
    kind: "approval",
    status: "open",
    prompt: null,
    action: null,
    target: null,
    materialHash: null,
    material: null,
    approvable: false,
    materialUnavailable: true,
    response: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const ok = (extra: Record<string, unknown>) =>
    interactionSchema.safeParse({ ...approval, ...extra }).success;
  assert.equal(ok({}), true);
  assert.equal(
    ok({
      compareUrl: "https://github.com/acme/app/commit/abc",
      compareCodeHost: "github",
    }),
    true,
  );
  assert.equal(
    ok({
      compareUrl: "https://gitlab.example.com/g/app/-/commit/abc",
      compareCodeHost: "gitlab",
    }),
    true,
  );
  for (const bad of [
    { compareUrl: "https://github.com/acme/app/commit/abc" },
    { compareCodeHost: "gitlab" },
    {
      compareUrl: "https://gitlab.example.com/g/app/-/commit/abc",
      compareCodeHost: "github",
    },
    {
      compareUrl: "http://gitlab.example.com/g/app/-/commit/abc",
      compareCodeHost: "gitlab",
    },
  ])
    assert.equal(ok(bad), false, JSON.stringify(bad));
});
