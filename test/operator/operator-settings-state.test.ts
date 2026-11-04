import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { genericInvalidInputMessage } from "../../src/operator/contracts.js";
import { OperatorClient } from "../../web/src/api.js";
import {
  ConfigurationDraft,
  ConfigurationDrafts,
  outcomeCopy,
} from "../../web/src/settings-state.js";
test("unknown private configuration remains frozen after later rejection and deliberate reconciliation uses original bytes", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const client = new OperatorClient(async (_url, init) => {
    calls.push(String(init?.body));
    attempt++;
    if (attempt === 1) throw Error("lost");
    if (attempt === 2)
      return Response.json(
        { error: { code: "conflict", message: "Conflict" } },
        { status: 409 },
      );
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "profile.configure",
        resourceId: c.profileId,
        version: 4,
        revoked: false,
      },
    });
  });
  const draft = new ConfigurationDraft();
  draft.set("instructions", "PRIVATE NEW INSTRUCTIONS");
  const c = {
    type: "profile.configure" as const,
    key: randomUUID(),
    profileId: randomUUID(),
    expectedVersion: 3,
    instructions: "PRIVATE NEW INSTRUCTIONS",
  };
  await draft.submit(client, c, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.equal(draft.set("instructions", "changed"), false);
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "unknown");
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.deepEqual(JSON.parse(calls[0] ?? "null"), c);
  assert.deepEqual(calls, [calls[0], calls[0], calls[0]]);
  draft.purge();
  assert.equal(draft.frozen, null);
  assert.deepEqual(draft.values, {});
});
test("safe inline rejection preserves editable input and purge suppresses delayed command completion", async () => {
  const draft = new ConfigurationDraft();
  draft.set("name", "Entered name");
  draft.set("instructions", "PRIVATE");
  const c = {
    type: "profile.configure" as const,
    key: randomUUID(),
    profileId: randomUUID(),
    expectedVersion: 1,
    name: "Entered name",
    instructions: "PRIVATE",
  };
  const reject = new OperatorClient(async () =>
    Response.json(
      {
        error: {
          code: "invalid-input",
          message: "Check input",
          fieldPaths: ["name"],
        },
      },
      { status: 400 },
    ),
  );
  await draft.submit(reject, c, "csrf");
  assert.equal(draft.phase, "rejected");
  assert.equal(draft.values.instructions, "PRIVATE");
  assert.equal(draft.errors.name, "Check this field.");
  assert.equal(draft.set("name", "Corrected"), true);
  let finish!: (r: Response) => void;
  const slow = new OperatorClient(
    async () =>
      new Promise<Response>((r) => {
        finish = r;
      }),
  );
  const sending = draft.submit(slow, c, "csrf");
  draft.purge();
  finish(
    Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "profile.configure",
        resourceId: c.profileId,
        version: 2,
        revoked: false,
      },
    }),
  );
  await sending;
  assert.deepEqual(draft.values, {});
  assert.equal(draft.receipt, null);
  assert.equal(draft.frozen, null);
});
test("configuration cannot accept another command's otherwise valid recorded receipt", async () => {
  const c = {
    type: "project.configure" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    expectedVersion: 2,
    name: "Name",
  };
  for (const result of [
    {
      commandType: "project.configure",
      resourceId: randomUUID(),
      version: 3,
      paused: true,
      leadProfileId: null,
      instructionsRevision: 1,
    },
    {
      commandType: "project.configure",
      resourceId: c.projectId,
      version: 4,
      paused: true,
      leadProfileId: null,
      instructionsRevision: 1,
    },
    {
      commandType: "profile.configure",
      resourceId: c.projectId,
      version: 3,
      revoked: false,
    },
  ]) {
    const d = new ConfigurationDraft(),
      client = new OperatorClient(async () =>
        Response.json({
          kind: "configuration",
          key: c.key,
          recorded: true,
          result,
        }),
      );
    await d.submit(client, c, "csrf");
    assert.equal(d.phase, "unknown");
    assert.equal(d.set("name", "changed"), false);
  }
});
test("placement receipt must confirm the exact frozen chosen project", async () => {
  const command = {
    type: "github.place" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    chosenProjectId: randomUUID(),
    expectedVersion: 2,
  };
  let chosen = randomUUID();
  const sent: string[] = [];
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: command.key,
      recorded: true,
      result: {
        commandType: "github.place",
        resourceId: command.taskId,
        projectId: chosen,
        version: 3,
      },
    });
  });
  const draft = new ConfigurationDraft();
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.equal(draft.receipt, null);
  assert.equal(draft.set("chosenProjectId", randomUUID()), false);
  const original = draft.bytes;
  chosen = command.chosenProjectId;
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.deepEqual(sent, [original, original]);
});

test("one task placement keeps its initiating project separate from the immutable owner command", async () => {
  const drafts = new ConfigurationDrafts(),
    taskId = randomUUID(),
    owner = randomUUID(),
    origin = randomUUID();
  const draft = drafts.get(`github.place:${taskId}`, () => {}),
    key = randomUUID();
  draft.initialize({
    key,
    expectedVersion: "1",
    chosenProjectId: origin,
    placementOriginProjectId: origin,
  });
  draft.set("chosenProjectId", origin);
  const command = {
    type: "github.place" as const,
    key,
    projectId: owner,
    taskId,
    chosenProjectId: origin,
    expectedVersion: 1,
  };
  const sent: string[] = [];
  let attempt = 0;
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    if (++attempt === 1) throw Error("lost committed response");
    return Response.json({
      kind: "configuration",
      recorded: true,
      key,
      result: {
        commandType: "github.place",
        resourceId: taskId,
        projectId: origin,
        version: 2,
      },
    });
  });
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.deepEqual(drafts.unsettledPlacements(origin), [command]);
  assert.equal(drafts.unsettledPlacements(owner).length, 0);
  assert.equal(
    drafts.get(`github.place:${taskId}`, () => {}),
    draft,
  );
  assert.equal(draft.set("placementOriginProjectId", owner), false);
  assert.equal(draft.set("chosenProjectId", owner), false);
  assert.equal(
    draft.frozen?.type === "github.place" && draft.frozen.projectId,
    owner,
  );
  assert.equal(
    JSON.parse(draft.bytes ?? "null").placementOriginProjectId,
    undefined,
  );
  await draft.reconcile(client, "csrf");
  assert.deepEqual(JSON.parse(sent[0] ?? "null"), command);
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.deepEqual(drafts.recordedPlacements(origin), [draft]);
  assert.equal(drafts.recordedPlacements(owner).length, 0);
  assert.equal(draft.notice, "Saved.");
  assert.equal(draft.details.command, "github.place");
  assert.equal(draft.details.resource, taskId);
  drafts.purge();
  assert.deepEqual(draft.values, {});
  assert.equal(drafts.recordedPlacements(origin).length, 0);
});

test("placement adopts a loaded revision explicitly after definite conflict but never after unknown", async () => {
  const owner = randomUUID(),
    taskId = randomUUID(),
    chosen = randomUUID(),
    initialKey = randomUUID();
  const command = {
    type: "github.place" as const,
    key: initialKey,
    projectId: owner,
    taskId,
    chosenProjectId: chosen,
    expectedVersion: 1,
  };
  const draft = new ConfigurationDraft();
  draft.initialize({
    key: initialKey,
    expectedVersion: "1",
    chosenProjectId: "",
    placementOriginProjectId: chosen,
  });
  draft.set("chosenProjectId", chosen);
  let attempt = 0;
  const sent: string[] = [];
  const client = new OperatorClient(async (_url, init) => {
    sent.push(String(init?.body));
    if (++attempt === 1)
      return Response.json(
        { error: { code: "conflict", message: "Conflict" } },
        { status: 409 },
      );
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "github.place",
        resourceId: taskId,
        projectId: chosen,
        version: 3,
      },
    });
  });
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "conflict");
  draft.initialize({
    key: randomUUID(),
    expectedVersion: "2",
    chosenProjectId: "",
  });
  assert.equal(draft.values.expectedVersion, "1");
  assert.equal(draft.values.key, initialKey);
  assert.equal(draft.values.chosenProjectId, chosen);
  draft.adoptVersion(2);
  assert.equal(draft.phase, "editing");
  assert.equal(draft.values.expectedVersion, "2");
  assert.notEqual(draft.values.key, initialKey);
  assert.equal(draft.values.chosenProjectId, chosen);
  assert.equal(draft.values.placementOriginProjectId, chosen);
  await draft.submit(
    client,
    { ...command, key: draft.values.key, expectedVersion: 2 },
    "csrf",
  );
  assert.equal(draft.phase, "recorded");
  assert.equal(JSON.parse(sent[1] ?? "null").expectedVersion, 2);
  assert.equal(JSON.parse(sent[1] ?? "null").projectId, owner);
  const unknown = new ConfigurationDraft();
  unknown.initialize({
    key: initialKey,
    expectedVersion: "1",
    chosenProjectId: chosen,
    placementOriginProjectId: chosen,
  });
  const lost = new OperatorClient(async () => {
    throw Error("lost");
  });
  await unknown.submit(lost, command, "csrf");
  const bytes = unknown.bytes,
    frozen = structuredClone(unknown.frozen),
    values = structuredClone(unknown.values);
  const conflict = new OperatorClient(async () =>
    Response.json(
      { error: { code: "conflict", message: "Conflict" } },
      { status: 409 },
    ),
  );
  await unknown.reconcile(conflict, "csrf");
  unknown.adoptVersion(2);
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.bytes, bytes);
  assert.deepEqual(unknown.frozen, frozen);
  assert.deepEqual(unknown.values, values);
});
test("configuration frozen views cannot redirect placement identity or its origin projections", async () => {
  const drafts = new ConfigurationDrafts();
  const owner = randomUUID(),
    origin = randomUUID(),
    destination = randomUUID(),
    taskId = randomUUID();
  const command = {
    type: "github.place" as const,
    key: randomUUID(),
    projectId: owner,
    taskId: taskId,
    chosenProjectId: destination,
    expectedVersion: 1,
  };
  const draft = drafts.get(`github.place:${taskId}`, () => {});
  draft.initialize({
    placementOriginProjectId: origin,
    chosenProjectId: destination,
  });
  await draft.submit(
    new OperatorClient(async () => {
      throw Error("lost");
    }),
    command,
    "csrf",
  );
  const view = draft.frozen;
  assert.ok(view);
  if (view.type === "github.place") {
    view.projectId = origin;
    view.chosenProjectId = origin;
  }
  assert.deepEqual(draft.frozen, command);
  assert.deepEqual(drafts.unsettledPlacements(origin), [command]);
  assert.deepEqual(drafts.unsettledPlacements(owner), []);
  assert.deepEqual(drafts.unsettledPlacements(destination), []);
  assert.equal(
    JSON.parse(draft.bytes ?? "null").placementOriginProjectId,
    undefined,
  );
});
test("private uncertainty survives every later definite failure while edits adoption and new operations stay blocked", async () => {
  for (const [status, code] of [
    [400, "invalid-input"],
    [403, "forbidden"],
    [409, "conflict"],
  ] as const) {
    const draft = new ConfigurationDraft();
    draft.initialize({
      instructions: "PRIVATE",
      expectedVersion: "3",
      key: randomUUID(),
    });
    const command = {
      type: "profile.configure" as const,
      key: randomUUID(),
      profileId: randomUUID(),
      expectedVersion: 3,
      instructions: "PRIVATE",
    };
    const sent: string[] = [];
    let attempt = 0;
    const client = new OperatorClient(async (_url, init) => {
      sent.push(String(init?.body));
      if (++attempt === 1) throw Error("lost");
      return Response.json(
        { error: { code, message: "Safe failure" } },
        { status },
      );
    });
    await draft.submit(client, command, "csrf");
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "unknown");
    assert.equal(draft.set("instructions", "changed"), false);
    draft.adoptVersion(20);
    draft.startOperation({ instructions: "changed" });
    await draft.submit(client, { ...command, key: randomUUID() }, "csrf");
    assert.equal(draft.values.instructions, "PRIVATE");
    assert.equal(draft.frozen?.key, command.key);
    assert.deepEqual(JSON.parse(sent[0] ?? "null"), command);
    assert.deepEqual(sent, [sent[0], sent[0]]);
  }
});
test("complete configuration receipt predicates keep schema-valid mismatches unknown until exact replay", async () => {
  const projectId = randomUUID(),
    profileId = randomUUID();
  const cases = [
    {
      command: {
        type: "profile.create",
        key: randomUUID(),
        profileId,
        name: "New profile",
        instructions: "Synthetic",
        capabilities: "Coordinate",
      },
      result: {
        commandType: "profile.create",
        resourceId: profileId,
        version: 1,
        revoked: false,
      },
      changes: [{ version: 2 }, { resourceId: randomUUID() }],
    },
    {
      command: {
        type: "project.create",
        key: randomUUID(),
        projectId,
        name: "New project",
        leadProfileId: null,
      },
      result: {
        commandType: "project.create",
        resourceId: projectId,
        version: 1,
        paused: true,
        leadProfileId: null,
        instructionsRevision: 1,
      },
      changes: [{ version: 2 }, { resourceId: randomUUID() }],
    },
    {
      command: {
        type: "profile.configure",
        key: randomUUID(),
        profileId,
        expectedVersion: 3,
        name: "Name",
      },
      result: {
        commandType: "profile.configure",
        resourceId: profileId,
        version: 4,
        revoked: false,
      },
      changes: [
        { resourceId: randomUUID() },
        { version: 5 },
        { commandType: "profile.create", version: 1 },
      ],
    },
    {
      command: {
        type: "github.preview",
        key: randomUUID(),
        projectId,
        expectedVersion: 2,
        selectionId: "selection",
      },
      result: {
        commandType: "github.preview",
        resourceId: projectId,
        configVersion: 2,
        selectionId: "selection",
        active: true,
      },
      changes: [
        { selectionId: "another" },
        { configVersion: 3 },
        { active: false },
        { resourceId: randomUUID() },
      ],
    },
    {
      command: {
        type: "capacity.configure",
        key: randomUUID(),
        globalLimit: 4,
        projectOverrides: { [projectId]: null, [profileId]: 2 },
      },
      result: {
        commandType: "capacity.configure",
        resourceId: "system:capacity",
        globalLimit: 4,
        defaultProjectLimit: 2,
        projectOverrides: { [profileId]: 2 },
      },
      changes: [
        { resourceId: "system:other" },
        { globalLimit: 5 },
        { projectOverrides: { [projectId]: 1, [profileId]: 2 } },
        { projectOverrides: { [profileId]: 3 } },
      ],
    },
  ];
  for (const entry of cases) {
    for (const change of [
      ...entry.changes,
      { key: randomUUID() },
      { kind: "coordination" },
    ]) {
      const draft = new ConfigurationDraft();
      let mismatch = true;
      const client = new OperatorClient(async () => {
        const changed = mismatch ? change : {};
        if ("kind" in changed)
          return Response.json({
            kind: "coordination",
            key: entry.command.key,
            recorded: true,
            eventId: randomUUID(),
            taskId: randomUUID(),
            recipientAssignmentId: randomUUID(),
            eventType: "message",
            createdAt: 1,
          });
        return Response.json({
          kind: "configuration",
          key: "key" in changed ? changed.key : entry.command.key,
          recorded: true,
          result: { ...entry.result, ...("key" in changed ? {} : changed) },
        });
      });
      await draft.submit(client, entry.command, "csrf");
      assert.equal(draft.phase, "unknown", JSON.stringify(change));
      assert.equal(draft.receipt, null);
      mismatch = false;
      await draft.reconcile(client, "csrf");
      assert.equal(draft.phase, "recorded", JSON.stringify(entry.command));
    }
  }
});
test("the store remembers a recorded save until purge, and never an unknown outcome", async () => {
  const profileId = randomUUID();
  let lose = false;
  const client = new OperatorClient(async (_url, init) => {
    if (lose) throw Error("lost");
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "profile.configure",
        resourceId: profileId,
        version: c.expectedVersion + 1,
        revoked: false,
      },
    });
  });
  const command = () => ({
    type: "profile.configure" as const,
    key: randomUUID(),
    profileId,
    expectedVersion: 2,
    name: "Renamed",
  });
  const drafts = new ConfigurationDrafts();
  const draft = drafts.get("profile.configure:a", () => {});
  await draft.submit(client, command(), "csrf");
  assert.equal(draft.phase, "recorded");
  const saved = drafts.saved("profile.configure:a");
  assert.equal(typeof saved?.at, "number");
  assert.equal(saved?.receipt.key, draft.receipt?.key);
  draft.startOperation({ name: "Renamed" });
  assert.equal(draft.phase, "editing");
  assert.equal(drafts.saved("profile.configure:a"), saved);
  drafts.purge();
  assert.equal(drafts.saved("profile.configure:a"), undefined);
  lose = true;
  const unknown = drafts.get("profile.configure:b", () => {});
  await unknown.submit(client, command(), "csrf");
  assert.equal(unknown.phase, "unknown");
  assert.equal(drafts.saved("profile.configure:b"), undefined);
  assert.equal(unknown.set("name", "x"), false);
  unknown.startOperation({ name: "y" });
  assert.equal(unknown.phase, "unknown");
});
test("a saved record keeps the receipt of a source preview and no private form value", async () => {
  const projectId = randomUUID();
  const client = new OperatorClient(async (_url, init) => {
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result:
        c.type === "github.preview"
          ? {
              commandType: "github.preview",
              resourceId: projectId,
              selectionId: c.selectionId,
              configVersion: c.expectedVersion,
              active: true,
              alreadyActive: false,
            }
          : {
              commandType: "profile.configure",
              resourceId: projectId,
              version: c.expectedVersion + 1,
              revoked: false,
            },
    });
  });
  const drafts = new ConfigurationDrafts();
  const preview = drafts.get("github.preview:a", () => {});
  preview.initialize({ activeSelectionIds: ["S-1"], key: "k" });
  await preview.submit(
    client,
    {
      type: "github.preview",
      key: randomUUID(),
      projectId,
      selectionId: "S-1",
      expectedVersion: 2,
    },
    "csrf",
  );
  const recorded = drafts.saved("github.preview:a");
  assert.equal(
    recorded?.receipt.kind === "configuration" &&
      recorded.receipt.result.commandType === "github.preview" &&
      recorded.receipt.result.alreadyActive,
    false,
  );
  assert.doesNotMatch(JSON.stringify(recorded), /activeSelectionIds/);
  // The record outlives the draft starting over.
  preview.startOperation({ activeSelectionIds: [] });
  assert.equal(drafts.saved("github.preview:a"), recorded);
  // A private field of any other save is never retained in the record.
  const profile = drafts.get("profile.configure:p", () => {});
  profile.initialize({
    instructions: "PRIVATE-INSTRUCTIONS",
    guidance: "PRIVATE-GUIDANCE",
  });
  await profile.submit(
    client,
    {
      type: "profile.configure",
      key: randomUUID(),
      profileId: projectId,
      expectedVersion: 2,
      name: "Renamed",
    },
    "csrf",
  );
  assert.equal(profile.phase, "recorded");
  const record = drafts.saved("profile.configure:p");
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE/);
});
test("adopting a newer revision keeps edited fields and takes the latest for untouched ones", () => {
  const draft = new ConfigurationDraft();
  draft.initialize({
    name: "Atlas",
    paused: false,
    expectedVersion: "2",
    key: "k",
  });
  draft.set("name", "Atlas II");
  draft.adoptLatest(3, { name: "Atlas", paused: true, expectedVersion: "3" });
  assert.equal(draft.values.name, "Atlas II");
  assert.equal(draft.values.paused, true);
  assert.equal(draft.values.expectedVersion, "3");
  assert.notEqual(draft.values.key, "k");
  // A later adoption compares against the revision adopted last.
  draft.adoptLatest(4, { name: "Atlas", paused: false, expectedVersion: "4" });
  assert.equal(draft.values.paused, false);
  assert.equal(draft.values.name, "Atlas II");
  // Grouped fields move together: an edited mode keeps the operator's conditions too.
  const readiness = new ConfigurationDraft();
  readiness.initialize({ mode: "all", conditions: "[1]", ids: ["a", "b"] });
  readiness.set("mode", "any");
  readiness.set("ids", ["b", "a"]);
  readiness.adoptLatest(
    2,
    { mode: "all", conditions: "[1,2]", ids: ["a", "b", "c"] },
    [["mode", "conditions"]],
  );
  assert.equal(readiness.values.mode, "any");
  assert.equal(readiness.values.conditions, "[1]");
  // Reordering a set is not an edit, so the latest list is taken.
  assert.deepEqual(readiness.values.ids, ["a", "b", "c"]);
  // The closed-issue mode is its own group: an edited mode survives adoption of new readiness.
  const source = new ConfigurationDraft();
  source.initialize({ mode: "all", conditions: "[1]", closedIssues: "skip" });
  source.set("closedIssues", "done");
  source.adoptLatest(
    2,
    { mode: "any", conditions: "[2]", closedIssues: "skip" },
    [["mode", "conditions"], ["closedIssues"]],
  );
  assert.deepEqual(
    [source.values.mode, source.values.conditions, source.values.closedIssues],
    ["any", "[2]", "done"],
  );
});

test("source credential refusal is actionable only after a definite lifecycle disposition", async () => {
  const command = {
    type: "github.preview" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    selectionId: "S-1",
    expectedVersion: 2,
  };
  const fail = new OperatorClient(async () =>
    Response.json(
      {
        error: {
          code: "conflict",
          message: "private provider stderr",
          credentialReason: "gh-not-signed-in",
        },
      },
      { status: 409 },
    ),
  );
  const definite = new ConfigurationDraft();
  await definite.submit(fail, command, "csrf");
  assert.equal(definite.phase, "conflict");
  assert.match(definite.notice, /GitHub CLI is not signed in/);
  assert.ok(!definite.notice.includes("private provider stderr"));
  const unknown = new ConfigurationDraft();
  const lost = new OperatorClient(async () => {
    throw new Error("lost");
  });
  await unknown.submit(lost, command, "csrf");
  const bytes = unknown.bytes;
  await unknown.reconcile(fail, "csrf");
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.notice, outcomeCopy.unknown);
  assert.equal(unknown.bytes, bytes);
  const unrelated = new ConfigurationDraft();
  await unrelated.submit(
    fail,
    {
      type: "project.configure",
      key: randomUUID(),
      projectId: command.projectId,
      expectedVersion: 1,
      name: "Unrelated",
    },
    "csrf",
  );
  assert.equal(unrelated.notice, outcomeCopy.conflict);
  assert.equal(unrelated.credentialRefusal, false);
  assert.equal(definite.credentialRefusal, true);
});

test("every outcome reads in plain words and keeps the receipt fields for Details", async () => {
  const plain =
    /recorded|receipt|observation|admission|reconcile|submission|revision|\d|project\.|conflict|invalid/i;
  const projectId = randomUUID();
  const command = () => ({
    type: "project.configure" as const,
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    name: "Atlas",
  });
  const answer = (respond: (c: { key: string }) => Response) =>
    new OperatorClient(async (_url, init) =>
      respond(JSON.parse(String(init?.body))),
    );
  const run = async (client: OperatorClient, input: object = command()) => {
    const draft = new ConfigurationDraft();
    draft.set("name", "Atlas");
    await draft.submit(client, input, "csrf");
    return draft;
  };

  const saved = await run(
    answer((c) =>
      Response.json({
        kind: "configuration",
        key: c.key,
        recorded: true,
        result: {
          commandType: "project.configure",
          resourceId: projectId,
          version: 3,
          paused: false,
          leadProfileId: null,
          instructionsRevision: 1,
        },
      }),
    ),
  );
  assert.equal(saved.phase, "recorded");
  assert.equal(saved.notice, "Saved.");
  assert.equal(typeof saved.savedAt, "number");
  assert.deepEqual(saved.details, {
    command: "project.configure",
    requestKey: saved.receipt?.key,
    resource: projectId,
    version: 3,
  });
  // A re-read keeps the confirmation and its Details; the next edit retires both.
  saved.startOperation({ name: "Atlas", expectedVersion: "3" }, true);
  assert.equal(saved.phase, "editing");
  assert.equal(typeof saved.savedAt, "number");
  assert.equal(saved.details.version, 3);
  saved.set("name", "Atlas 2");
  assert.equal(saved.savedAt, null);
  saved.startOperation({ name: "Atlas" });
  assert.deepEqual(saved.details, {});

  const rejected = await run(
    answer(() =>
      Response.json(
        { error: { code: "invalid-input", message: "Bad", fieldPaths: [] } },
        { status: 400 },
      ),
    ),
  );
  assert.equal(rejected.phase, "rejected");
  assert.equal(rejected.notice, "Couldn't save. Your changes are still here.");
  assert.equal(rejected.details.code, "invalid-input");

  const highlighted = await run(
    answer(() =>
      Response.json(
        {
          error: {
            code: "invalid-input",
            message: "Bad",
            fieldPaths: ["name"],
          },
        },
        { status: 400 },
      ),
    ),
  );
  assert.equal(highlighted.notice, outcomeCopy.fields(1));

  const preflight = new ConfigurationDraft();
  await preflight.submit(
    new OperatorClient(async () => assert.fail("nothing is sent")),
    { type: "project.configure" },
    "csrf",
  );
  assert.equal(
    preflight.notice,
    outcomeCopy.fields(Object.keys(preflight.errors).length),
  );

  const conflict = await run(
    answer(() =>
      Response.json(
        { error: { code: "conflict", message: "C" } },
        { status: 409 },
      ),
    ),
  );
  assert.equal(conflict.phase, "conflict");
  assert.equal(conflict.notice, "A newer version was saved elsewhere.");
  assert.equal(conflict.details.code, "conflict");
  assert.equal(conflict.details.command, "project.configure");

  const lost = await run(
    new OperatorClient(async () => {
      throw Error("lost");
    }),
  );
  assert.equal(lost.phase, "unknown");
  assert.equal(lost.notice, "We couldn't confirm the save.");
  assert.equal(lost.details.code, "command-outcome-unknown");

  // The copy names no command, ID, key, number or service term; those live in Details.
  // The one number allowed is how many fields are highlighted.
  for (const draft of [saved, rejected, highlighted, preflight, conflict, lost])
    assert.doesNotMatch(
      draft.notice.replace(/^Fix the \d+ highlighted/, "Fix the highlighted"),
      plain,
      draft.notice,
    );
  for (const draft of [rejected, highlighted, preflight])
    assert.match(draft.notice, /Your changes are still here\.$/);
  for (const copy of Object.values(outcomeCopy)) {
    const text = typeof copy === "string" ? copy : copy(2);
    assert.ok(text.split(/(?<=\.)\s/).length <= 2, text);
  }
});

test("a save stays confirmed across a re-read of the same version, not across another writer's", async () => {
  const projectId = randomUUID();
  const client = new OperatorClient(async (_url, init) => {
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "project.configure",
        resourceId: projectId,
        version: 3,
        paused: false,
        leadProfileId: null,
        instructionsRevision: 1,
      },
    });
  });
  const draft = new ConfigurationDraft();
  draft.set("name", "Atlas");
  await draft.submit(
    client,
    {
      type: "project.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      name: "Atlas",
    },
    "csrf",
  );
  assert.equal(draft.phase, "recorded");
  // The first read after the save carries the saved version.
  draft.startOperation({ name: "Atlas", expectedVersion: "3" }, true);
  assert.equal(typeof draft.savedAt, "number");
  // A later read of the same version, with a fresh request key, is still this save.
  draft.initialize({ name: "Atlas", expectedVersion: "3", key: "next" });
  assert.equal(typeof draft.savedAt, "number");
  assert.equal(draft.details.version, 3);
  // A read of a version someone else saved no longer matches the confirmation.
  draft.initialize({ name: "Theirs", expectedVersion: "4", key: "later" });
  assert.equal(draft.savedAt, null);
  assert.deepEqual(draft.details, {});
  assert.equal(draft.values.name, "Theirs");
});

test("another writer committing before the first re-read means the save is not confirmed", async () => {
  const projectId = randomUUID();
  const saveAt = async (result: object, command: object) => {
    const client = new OperatorClient(async (_url, init) => {
      const c = JSON.parse(String(init?.body));
      return Response.json({
        kind: "configuration",
        key: c.key,
        recorded: true,
        result,
      });
    });
    const draft = new ConfigurationDraft();
    await draft.submit(client, { key: randomUUID(), ...command }, "csrf");
    assert.equal(draft.phase, "recorded");
    return draft;
  };
  const project = (version: number) =>
    saveAt(
      {
        commandType: "project.configure",
        resourceId: projectId,
        version,
        paused: false,
        leadProfileId: null,
        instructionsRevision: 1,
      },
      { type: "project.configure", projectId, expectedVersion: 2, name: "A" },
    );

  // The save produced version 3, but the first re-read already shows 4 from another writer.
  const raced = await project(3);
  raced.startOperation({ name: "Theirs", expectedVersion: "4" }, true);
  assert.equal(raced.phase, "editing");
  assert.equal(raced.savedAt, null);
  assert.deepEqual(raced.details, {});
  assert.equal(raced.values.name, "Theirs");
  // A later read of that version cannot bring the confirmation back.
  raced.initialize({ name: "Theirs", expectedVersion: "4", key: "later" });
  assert.equal(raced.savedAt, null);

  // The re-read of the version the save produced keeps it.
  const kept = await project(3);
  kept.startOperation({ name: "A", expectedVersion: "3" }, true);
  assert.equal(typeof kept.savedAt, "number");
  assert.equal(kept.details.version, 3);

  // A save without a version (a credential reference) cannot tell: the accepted limit.
  const credential = await saveAt(
    {
      commandType: "discovery.configure",
      resourceId: "system:discovery",
      configured: true,
    },
    { type: "discovery.configure", credentialRef: "gh:github.com" },
  );
  credential.startOperation({ key: "next" }, true);
  assert.equal(typeof credential.savedAt, "number");
});

test("a callback after render runs at once when nothing is waiting to show, else on the commit that shows the rejection", () => {
  const draft = new ConfigurationDraft();
  const runs: string[] = [];
  draft.afterRender(() => runs.push("fresh"));
  assert.deepEqual(runs, ["fresh"]);

  const before = draft.revision;
  draft.reject({ name: "Required" });
  assert.equal(draft.phase, "rejected");
  assert.ok(draft.revision > before);
  draft.afterRender(() => runs.push("rejected"));
  // A commit that predates the rejection does not show it.
  draft.committed(before);
  assert.deepEqual(runs, ["fresh"]);
  draft.committed(draft.revision);
  assert.deepEqual(runs, ["fresh", "rejected"]);
  // Each callback runs once, and a later commit has nothing left to run.
  draft.committed(draft.revision);
  assert.deepEqual(runs, ["fresh", "rejected"]);
  // With every change committed, the next callback runs at once.
  draft.afterRender(() => runs.push("settled"));
  assert.deepEqual(runs, ["fresh", "rejected", "settled"]);
});

test("schema rejections name each field's fix and keep project override keys", async () => {
  const offline = new OperatorClient(async () =>
    assert.fail("nothing is sent"),
  );
  const rejected = async (command: Record<string, unknown>) => {
    const draft = new ConfigurationDraft();
    await draft.submit(offline, { key: randomUUID(), ...command }, "csrf");
    assert.equal(draft.phase, "rejected");
    return draft;
  };
  const profile = await rejected({
    type: "profile.create",
    profileId: randomUUID(),
    name: " ",
    summary: "s".repeat(128),
    instructions: "",
    capabilities: "",
  });
  assert.deepEqual(profile.errors, {
    name: "Enter a profile name.",
    summary: "Keep the summary to 120 characters or fewer. It has 128.",
  });
  assert.equal(
    profile.notice,
    "Fix the 2 highlighted fields. Your changes are still here.",
  );
  const routing = await rejected({
    type: "routing.configure",
    projectId: randomUUID(),
    expectedVersion: 1,
    enabled: true,
    credentialRef: "env:typesafe-key",
    candidateProfileIds: [],
  });
  assert.deepEqual(routing.errors, {
    credentialRef:
      "Use env: followed by a capital letter, then capital letters, digits or underscores, such as env:TYPESAFE_API_KEY.",
  });
  assert.equal(
    routing.notice,
    "Fix the highlighted field. Your changes are still here.",
  );
  const projectId = randomUUID();
  const capacity = await rejected({
    type: "capacity.configure",
    globalLimit: 0,
    projectOverrides: { [projectId]: 2.5 },
  });
  assert.deepEqual(capacity.errors, {
    globalLimit: "Enter a whole number of 1 or more.",
    [`projectOverrides.${projectId}`]: "Enter a whole number of 1 or more.",
  });
});
const takenMessage = "Another project is named Atlas. Choose a different name.";
const rejectWith = (fieldPaths: string[], message = takenMessage) =>
  new OperatorClient(async () =>
    Response.json(
      { error: { code: "invalid-input", message, fieldPaths } },
      { status: 400 },
    ),
  );
const projectCreate = (name: string) => ({
  type: "project.create" as const,
  key: randomUUID(),
  projectId: randomUUID(),
  name,
  leadProfileId: null,
});
const projectConfigure = (name: string) => ({
  type: "project.configure" as const,
  key: randomUUID(),
  projectId: randomUUID(),
  expectedVersion: 1,
  name,
});
test("a refused project name shows the service's message under the name field", async () => {
  for (const command of [projectCreate("atlas"), projectConfigure("atlas")]) {
    const draft = new ConfigurationDraft();
    draft.set("name", "atlas");
    await draft.submit(rejectWith(["name"]), command, "csrf");
    assert.equal(draft.phase, "rejected", command.type);
    assert.deepEqual(draft.errors, { name: takenMessage }, command.type);
    assert.equal(draft.notice, outcomeCopy.fields(1), command.type);
    assert.equal(draft.values.name, "atlas", command.type);
  }
});
test("only a refused project name carries the service's message", async () => {
  const other = new ConfigurationDraft();
  await other.submit(
    rejectWith(["name"]),
    {
      type: "profile.create" as const,
      key: randomUUID(),
      profileId: randomUUID(),
      name: "Atlas",
      instructions: "Be brief",
      capabilities: "assign" as const,
    },
    "csrf",
  );
  assert.equal(other.phase, "rejected");
  assert.deepEqual(other.errors, { name: "Check this field." });
  for (const code of ["forbidden", "conflict"] as const) {
    const refused = new ConfigurationDraft();
    await refused.submit(
      new OperatorClient(async () =>
        Response.json(
          { error: { code, message: takenMessage, fieldPaths: ["name"] } },
          { status: code === "conflict" ? 409 : 403 },
        ),
      ),
      projectCreate("atlas"),
      "csrf",
    );
    assert.notEqual(refused.errors.name, takenMessage, code);
  }
  const several = new ConfigurationDraft();
  await several.submit(
    rejectWith(["name", "leadProfileId"]),
    projectCreate("atlas"),
    "csrf",
  );
  assert.deepEqual(several.errors, {
    name: "Check this field.",
    leadProfileId: "Check this field.",
  });
});
test("a refused project name is cleared by the retry that records", async () => {
  const draft = new ConfigurationDraft();
  draft.set("name", "atlas");
  await draft.submit(rejectWith(["name"]), projectCreate("atlas"), "csrf");
  assert.deepEqual(draft.errors, { name: takenMessage });
  draft.set("name", "Atlas 2");
  assert.equal(draft.values.name, "Atlas 2");
  const command = projectCreate("Atlas 2");
  const accept = new OperatorClient(async (_url, init) => {
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "project.create",
        resourceId: c.projectId,
        version: 1,
        paused: true,
        leadProfileId: null,
        instructionsRevision: 1,
      },
    });
  });
  await draft.submit(accept, command, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.deepEqual(draft.errors, {});
});
test("a refused status mapping or delivery policy puts the service's sentence in the outcome, and no other command does", async () => {
  const mapping = {
    type: "status-mapping.configure" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    expectedVersion: 1,
    mapping: null,
  };
  const delivery = {
    type: "delivery.configure" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    expectedVersion: 1,
    mode: "reviewable-pr" as const,
    grants: [],
    requiredChecks: [],
  };
  const cases = [
    [
      mapping,
      "mapping.events.turnStarted",
      "First turn started → Todo: the readiness rule does not accept it.",
    ],
    [
      delivery,
      "grants.0.fieldNodeId",
      "Project field grant requires exact field",
    ],
  ] as const;
  for (const [command, path, message] of cases) {
    const draft = new ConfigurationDraft();
    await draft.submit(rejectWith([path], message), command, "csrf");
    assert.equal(draft.phase, "rejected", command.type);
    assert.deepEqual(draft.errors, { [path]: message }, command.type);
    // A message without a closing period gets one, so the notice reads as two sentences.
    assert.equal(
      draft.notice,
      `${message.replace(/\.?$/, ".")} Your changes are still here.`,
      command.type,
    );
    assert.equal(draft.fieldRefusal, true, command.type);
  }
  // The generic line the service sends when it has no sentence of its own is not one.
  for (const command of [mapping, delivery]) {
    const generic = new ConfigurationDraft();
    await generic.submit(
      rejectWith(["grants.0.action"], genericInvalidInputMessage),
      command,
      "csrf",
    );
    assert.deepEqual(generic.errors, {
      "grants.0.action": "Check this field.",
    });
    assert.equal(generic.notice, outcomeCopy.fields(1));
    assert.equal(generic.fieldRefusal, false);
  }
  const other = new ConfigurationDraft();
  await other.submit(
    rejectWith(["leadProfileId"], "Safe"),
    projectCreate("atlas"),
    "csrf",
  );
  assert.equal(other.notice, outcomeCopy.fields(1));
  assert.equal(other.fieldRefusal, false);
  // No named field, or no message, keeps the generic outcome.
  const bare = new ConfigurationDraft();
  await bare.submit(rejectWith([], "Safe"), delivery, "csrf");
  assert.equal(bare.notice, outcomeCopy.rejected);
  assert.equal(bare.fieldRefusal, false);
});
test("a discovery credential save elsewhere is unsettled until it is confirmed", async () => {
  const drafts = new ConfigurationDrafts();
  const offer = drafts.get("discovery.configure:offer", () => {});
  const readiness = drafts.get("discovery.configure:readiness", () => {});
  const unrelated = drafts.get("getting-started.configure", () => {});
  let notified = 0;
  const unsubscribe = drafts.subscribe(() => notified++);
  let lost = true;
  const client = new OperatorClient(async (_url, init) => {
    if (lost) throw Error("lost");
    const c = JSON.parse(String(init?.body));
    return Response.json({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "discovery.configure",
        resourceId: "system:discovery",
        configured: true,
      },
    });
  });
  const command = {
    type: "discovery.configure" as const,
    key: randomUUID(),
    credentialRef: "gh:github.com",
  };
  assert.equal(
    drafts.discoveryUnsettled("discovery.configure:readiness"),
    false,
  );
  await offer.submit(client, command, "csrf");
  assert.equal(offer.phase, "unknown");
  assert.equal(notified, 2);
  assert.equal(
    drafts.discoveryUnsettled("discovery.configure:readiness"),
    true,
  );
  assert.equal(drafts.discoveryUnsettled("discovery.configure:offer"), false);
  assert.equal(readiness.phase, "editing");
  // A pending save of another kind of draft is not a discovery save.
  void unrelated.submit(
    new OperatorClient(() => new Promise<Response>(() => {})),
    { type: "getting-started.configure", key: randomUUID(), dismissed: true },
    "csrf",
  );
  assert.equal(unrelated.phase, "pending");
  assert.equal(
    drafts.discoveryUnsettled("discovery.configure:readiness"),
    true,
  );
  assert.equal(
    drafts.discoveryUnsettled(
      "discovery.configure:offer",
      "discovery.configure:readiness",
    ),
    false,
  );
  lost = false;
  await offer.reconcile(client, "csrf");
  assert.equal(offer.phase, "recorded");
  assert.equal(
    drafts.discoveryUnsettled("discovery.configure:readiness"),
    false,
  );
  unsubscribe();
  const seen = notified;
  offer.purge();
  assert.equal(notified, seen);
});

const deliverySave = () => ({
  type: "delivery.configure" as const,
  key: randomUUID(),
  projectId: randomUUID(),
  expectedVersion: 3,
  mode: "reviewable-pr" as const,
  grants: [],
  requiredChecks: [],
});
const deliveryReceipt = (command: ReturnType<typeof deliverySave>) => ({
  kind: "configuration" as const,
  key: command.key,
  recorded: true as const,
  result: {
    commandType: "delivery.configure" as const,
    resourceId: command.projectId,
    version: command.expectedVersion + 1,
    credentialConfigured: true,
  },
});
const recordedOperation = (receipt: unknown) => ({
  data: { state: "recorded", receipt },
  observedAt: 42,
});
const missingOperation = { data: { state: "not-recorded" }, observedAt: 42 };

test("delivery Check reads the original operation before any resend and records exactly one matching receipt", async () => {
  const command = deliverySave(),
    receipt = deliveryReceipt(command);
  const calls: { path: string; body: string | undefined }[] = [];
  let saved = 0;
  const draft = new ConfigurationDraft(
    () => {},
    (value) => {
      saved++;
      assert.deepEqual(value, receipt);
      assert.equal(draft.phase, "recorded");
      assert.deepEqual(draft.receipt, receipt);
      void draft.reconcile(client, "csrf");
    },
  );
  const client = new OperatorClient(async (path, init) => {
    calls.push({
      path: String(path),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (init?.method === "POST") throw Error("lost save response");
    assert.equal(init?.credentials, "same-origin");
    const query = new URL(String(path), "http://fixture").searchParams;
    assert.deepEqual(Object.fromEntries(query), {
      scope: `project:${command.projectId}`,
      type: command.type,
      key: command.key,
    });
    return Response.json(recordedOperation(receipt));
  });
  draft.set("credentialRef", "NEW PRIVATE INPUT");
  await draft.submit(client, command, "csrf");
  const bytes = draft.bytes;
  assert.equal(draft.phase, "unknown");
  await draft.reconcile(client, "csrf");
  await draft.reconcile(client, "csrf");
  assert.equal(saved, 1);
  assert.equal(draft.phase, "recorded");
  assert.equal(draft.notice, outcomeCopy.saved);
  assert.ok(draft.savedAt !== null);
  assert.equal(draft.details.version, command.expectedVersion + 1);
  assert.equal(draft.bytes, bytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.body, bytes);
  assert.equal(calls[1]?.body, undefined);
  let focus = 0;
  draft.afterRender(() => focus++);
  assert.equal(focus, 0);
  draft.committed(draft.revision);
  assert.equal(focus, 1);
});

test("delivery not-recorded permits only an identical frozen retry and later refusals keep uncertainty", async () => {
  for (const retry of [
    "recorded",
    "lost",
    "invalid-input",
    "conflict",
  ] as const) {
    const command = deliverySave(),
      receipt = deliveryReceipt(command);
    const calls: string[] = [],
      bodies: string[] = [];
    let posts = 0,
      reads = 0;
    const client = new OperatorClient(async (_path, init) => {
      if (init?.method === "POST") {
        calls.push("POST");
        bodies.push(String(init.body));
        if (++posts === 1 || retry === "lost") throw Error("lost");
        if (retry === "recorded") return Response.json(receipt);
        return Response.json(
          { error: { code: retry, message: "Refused" } },
          { status: retry === "conflict" ? 409 : 400 },
        );
      }
      calls.push("GET");
      return Response.json(
        ++reads === 1 ? missingOperation : recordedOperation(receipt),
      );
    });
    const draft = new ConfigurationDraft();
    draft.initialize({
      credentialRef: "PRIVATE ENTERED TEXT",
      expectedVersion: "3",
      key: command.key,
    });
    await draft.submit(client, command, "old-csrf");
    const bytes = draft.bytes;
    // A detached view or changed caller input cannot change the frozen retry.
    const view = draft.frozen;
    assert.ok(view?.type === "delivery.configure");
    view.expectedVersion = 99;
    command.expectedVersion = 88;
    await draft.reconcile(client, "fresh-csrf");
    assert.deepEqual(calls, ["POST", "GET", "POST"]);
    assert.deepEqual(bodies, [bytes, bytes]);
    assert.equal(draft.bytes, bytes);
    if (retry !== "recorded") {
      assert.equal(draft.phase, "unknown");
      assert.equal(draft.set("credentialRef", "changed"), false);
      draft.adoptVersion(30);
      draft.startOperation({ credentialRef: "changed" });
      assert.equal(draft.values.credentialRef, "PRIVATE ENTERED TEXT");
      assert.equal(draft.frozen?.key, command.key);
      await draft.reconcile(client, "csrf");
      assert.deepEqual(calls, ["POST", "GET", "POST", "GET"]);
    }
    assert.equal(draft.phase, "recorded");
  }
});

test("delivery Check failures malformed reads and schema-valid mismatches keep the original unknown save", async () => {
  const command = deliverySave(),
    receipt = deliveryReceipt(command);
  const wrongType = {
    ...receipt,
    result: {
      commandType: "project.configure",
      resourceId: command.projectId,
      version: 4,
      paused: false,
      leadProfileId: null,
      instructionsRevision: 1,
    },
  };
  const responses = [
    () => {
      throw Error("GET failed");
    },
    () => new Response("invalid JSON", { status: 200 }),
    () => Response.json({ data: { state: "not-recorded" } }),
    () =>
      Response.json(
        recordedOperation({
          ...receipt,
          result: {
            ...receipt.result,
            credentialRef: "env:UNEXPECTED_PRIVATE",
          },
        }),
      ),
    () => Response.json(recordedOperation({ ...receipt, key: randomUUID() })),
    () => Response.json(recordedOperation(wrongType)),
    () =>
      Response.json(
        recordedOperation({
          ...receipt,
          result: { ...receipt.result, resourceId: randomUUID() },
        }),
      ),
    () =>
      Response.json(
        recordedOperation({
          ...receipt,
          result: { ...receipt.result, version: 3 },
        }),
      ),
    () =>
      Response.json(
        recordedOperation({
          ...receipt,
          result: { ...receipt.result, version: 20 },
        }),
      ),
    ...[401, 403, 409, 503].map(
      (status) => () =>
        Response.json(
          {
            error: {
              code: status === 401 ? "unauthenticated" : "unavailable",
              message: "Unavailable",
            },
          },
          { status },
        ),
    ),
  ];
  for (const respond of responses) {
    let posts = 0,
      saved = 0;
    const draft = new ConfigurationDraft(
      () => {},
      () => saved++,
    );
    draft.set("credentialRef", "PRIVATE ENTERED INPUT");
    let complete = false;
    const client = new OperatorClient(async (_path, init) => {
      if (init?.method === "POST") {
        posts++;
        throw Error("lost");
      }
      return complete ? Response.json(recordedOperation(receipt)) : respond();
    });
    await draft.submit(client, command, "csrf");
    const bytes = draft.bytes;
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "unknown");
    assert.equal(draft.receipt, null);
    assert.equal(draft.savedAt, null);
    assert.equal(saved, 0);
    assert.equal(posts, 1);
    assert.equal(draft.bytes, bytes);
    assert.equal(draft.set("credentialRef", "changed"), false);
    draft.adoptVersion(20);
    assert.equal(draft.frozen?.key, command.key);
    assert.equal(draft.values.credentialRef, "PRIVATE ENTERED INPUT");
    complete = true;
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "recorded");
    assert.equal(saved, 1);
    assert.equal(posts, 1);
  }
});

test("delivery concurrent Check calls share one lookup and a saved callback purge cannot revive the draft", async () => {
  for (const purgeOnSaved of [false, true]) {
    const command = deliverySave(),
      receipt = deliveryReceipt(command);
    let finish!: (response: Response) => void;
    let reads = 0,
      posts = 0,
      saved = 0;
    const client = new OperatorClient(async (_path, init) => {
      if (init?.method === "POST") {
        posts++;
        throw Error("lost");
      }
      reads++;
      return new Promise<Response>((done) => {
        finish = done;
      });
    });
    const draft = new ConfigurationDraft(
      () => {},
      () => {
        saved++;
        if (purgeOnSaved) draft.purge();
      },
    );
    draft.set("credentialRef", "PRIVATE");
    await draft.submit(client, command, "csrf");
    const first = draft.reconcile(client, "csrf");
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "pending");
    assert.equal(draft.set("credentialRef", "changed"), false);
    assert.equal(reads, 1);
    finish(Response.json(recordedOperation(receipt)));
    await first;
    assert.equal(saved, 1);
    assert.equal(posts, 1);
    assert.equal(reads, 1);
    if (purgeOnSaved) {
      assert.equal(draft.phase, "editing");
      assert.deepEqual(draft.values, {});
      assert.equal(draft.frozen, null);
      assert.equal(draft.receipt, null);
      assert.equal(draft.savedAt, null);
      assert.equal(draft.notice, "");
    } else assert.equal(draft.phase, "recorded");
  }
});

test("delivery purged lookup completions cannot resend or settle a replacement private session draft", async () => {
  for (const completion of [
    "recorded",
    "not-recorded",
    "401",
    "malformed",
  ] as const) {
    const command = deliverySave(),
      receipt = deliveryReceipt(command);
    const drafts = new ConfigurationDrafts();
    const key = `delivery.configure:${command.projectId}`;
    const draft = drafts.get(key, () => {});
    let finish!: (response: Response) => void;
    let posts = 0,
      expired = 0;
    const client = new OperatorClient(
      async (_path, init) => {
        if (init?.method === "POST") {
          posts++;
          throw Error("lost");
        }
        return new Promise<Response>((done) => {
          finish = done;
        });
      },
      () => {
        expired++;
        drafts.purge();
      },
    );
    draft.set("credentialRef", "OLD PRIVATE");
    await draft.submit(client, command, "old-csrf");
    const checking = draft.reconcile(client, "old-csrf");
    client.invalidateAuthentication();
    drafts.purge();
    const replacement = drafts.get(key, () => {});
    replacement.set("credentialRef", "NEW PRIVATE");
    finish(
      completion === "recorded"
        ? Response.json(recordedOperation(receipt))
        : completion === "not-recorded"
          ? Response.json(missingOperation)
          : completion === "401"
            ? Response.json({}, { status: 401 })
            : Response.json({ invalid: true }),
    );
    await checking;
    assert.equal(posts, 1);
    assert.equal(expired, 0);
    assert.equal(draft.phase, "editing");
    assert.deepEqual(draft.values, {});
    assert.equal(draft.frozen, null);
    assert.equal(drafts.saved(key), undefined);
    assert.equal(replacement.values.credentialRef, "NEW PRIVATE");
    assert.equal(replacement.phase, "editing");
  }
});

test("delivery authentication changes without purge cannot accept old POST or GET authority or resend", async () => {
  for (const stage of ["POST", "GET-recorded", "GET-not-recorded"] as const) {
    const command = deliverySave(),
      receipt = deliveryReceipt(command);
    let finish!: (response: Response) => void;
    let posts = 0,
      saved = 0;
    const client = new OperatorClient(async (_path, init) => {
      if (init?.method === "POST") {
        if (++posts === 1 && stage !== "POST") throw Error("lost");
      }
      return new Promise<Response>((done) => {
        finish = done;
      });
    });
    const draft = new ConfigurationDraft(
      () => {},
      () => saved++,
    );
    const initial = draft.submit(client, command, "old-csrf");
    let pending = initial;
    if (stage !== "POST") {
      await initial;
      pending = draft.reconcile(client, "old-csrf");
    }
    client.invalidateAuthentication();
    finish(
      Response.json(
        stage === "POST"
          ? receipt
          : stage === "GET-recorded"
            ? recordedOperation(receipt)
            : missingOperation,
      ),
    );
    await pending;
    assert.equal(posts, 1);
    assert.equal(saved, 0);
    assert.equal(draft.phase, "unknown");
    assert.equal(draft.frozen?.key, command.key);
    assert.equal(draft.set("credentialRef", "changed"), false);
  }
});

test("delivery Check current-session expiry purges private input before a lookup can settle", async () => {
  const command = deliverySave();
  const drafts = new ConfigurationDrafts();
  const draft = drafts.get("delivery", () => {});
  let expired = 0,
    posts = 0;
  const client = new OperatorClient(
    async (_path, init) => {
      if (init?.method === "POST") {
        posts++;
        throw Error("lost");
      }
      return Response.json({}, { status: 401 });
    },
    () => {
      expired++;
      drafts.purge();
    },
  );
  draft.set("credentialRef", "PRIVATE");
  await draft.submit(client, command, "csrf");
  await draft.reconcile(client, "csrf");
  assert.equal(expired, 1);
  assert.equal(posts, 1);
  assert.equal(draft.phase, "editing");
  assert.deepEqual(draft.values, {});
  assert.equal(draft.frozen, null);
  assert.equal(draft.receipt, null);
});

test("delivery render-triggered purge prevents a pending Check from issuing a lookup", async () => {
  const command = deliverySave();
  let posts = 0;
  const client = new OperatorClient(async (_path, init) => {
    assert.equal(init?.method, "POST");
    posts++;
    throw Error("lost");
  });
  const draft = new ConfigurationDraft();
  await draft.submit(client, command, "csrf");
  draft.bind(() => {
    if (draft.phase === "pending") draft.purge();
  });
  await draft.reconcile(client, "csrf");
  assert.equal(posts, 1);
  assert.equal(draft.phase, "editing");
  assert.equal(draft.frozen, null);
});

test("delivery typed operation read recovers the original version after lost save later credential change and SQLite reopen", async (t) => {
  const { createOperatorFixture } = await import("../fixtures/operator-web.js");
  const { OperatorApi } = await import("../../src/standalone/operator-api.js");
  const f = await createOperatorFixture();
  t.after(() => f.close());
  let api = new OperatorApi(f.service, [f.directory]);
  const command = deliverySave();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId: command.projectId,
    name: "Delivery",
    leadProfileId: null,
  });
  const configure = (expectedVersion: number, credentialRef: string) => ({
    ...command,
    key: randomUUID(),
    expectedVersion,
    credentialRef,
  });
  await api.execute(configure(1, "env:ORIGINAL_DELIVERY"));
  command.expectedVersion = 2;
  const calls: string[] = [];
  let saved = 0;
  let refreshed:
    | ReturnType<InstanceType<typeof OperatorApi>["readProjectConfiguration"]>
    | undefined;
  const draft = new ConfigurationDraft(
    () => {},
    () => {
      saved++;
      refreshed = api.readProjectConfiguration(command.projectId);
    },
  );
  const client = new OperatorClient(async (path, init) => {
    assert.equal(init?.credentials, "same-origin");
    if (init?.method === "POST") {
      calls.push("POST");
      await api.execute(JSON.parse(String(init.body)));
      throw Error("saved response lost");
    }
    calls.push("GET");
    const query = new URL(String(path), "http://fixture").searchParams;
    return Response.json(await api.readOperation(query));
  });
  draft.initialize({
    key: command.key,
    expectedVersion: "2",
    credentialRef: "",
  });
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  const bytes = draft.bytes;
  await api.execute(configure(3, "env:LATER_DELIVERY"));
  await f.reopen();
  api = new OperatorApi(f.service, [f.directory]);
  await draft.reconcile(client, "csrf");
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.equal(saved, 1);
  assert.equal(draft.phase, "recorded");
  assert.equal(draft.details.version, 3);
  assert.equal(draft.bytes, bytes);
  assert.equal((await refreshed)?.data.delivery?.version, 4);
  assert.equal(
    f.service.delivery().configuration(command.projectId).version,
    4,
  );
  assert.equal(
    f.service.domain().deliveryCredentialReference(command.projectId),
    "env:LATER_DELIVERY",
  );
  assert.equal(f.runtime.turns, 0);
});

test("normalized source and link Check uses receipt readback first while explicit legacy forms still resend", async () => {
  const projectId = randomUUID();
  const reference = (section: "source" | "repositories") => ({
    savedRow: { projectId, section, version: 2, index: 0 },
    keep: true,
  });
  const cases = [
    {
      command: { type: "github.configure", selections: [reference("source")] },
      result: {
        commandType: "github.configure",
        credentialConfigured: true,
        selectionCount: 1,
      },
    },
    {
      command: { type: "jira.configure", selections: [reference("source")] },
      result: { commandType: "jira.configure", selectionCount: 1 },
    },
    {
      command: {
        type: "repositories.configure",
        repositories: [reference("repositories")],
      },
      result: { commandType: "repositories.configure", repositoryCount: 1 },
    },
  ];
  for (const entry of cases) {
    const command = {
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      ...entry.command,
    };
    const receipt = {
      kind: "configuration",
      key: command.key,
      recorded: true,
      result: { resourceId: projectId, version: 3, ...entry.result },
    };
    const calls: string[] = [],
      bodies: string[] = [];
    let recorded = false;
    const client = new OperatorClient(async (path, init) => {
      if (init?.method === "POST") {
        calls.push("POST");
        bodies.push(String(init.body));
        throw Error("unknown");
      }
      calls.push("GET");
      const query = new URL(String(path), "http://fixture").searchParams;
      assert.equal(query.get("type"), command.type);
      assert.equal(query.get("scope"), `project:${projectId}`);
      assert.equal(query.get("key"), command.key);
      return Response.json(
        recorded ? recordedOperation(receipt) : missingOperation,
      );
    });
    const draft = new ConfigurationDraft();
    await draft.submit(client, command, "csrf");
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "unknown");
    assert.deepEqual(calls, ["POST", "GET", "POST"]);
    assert.deepEqual(bodies, [draft.bytes, draft.bytes]);
    recorded = true;
    await draft.reconcile(client, "csrf");
    assert.equal(draft.phase, "recorded");
    assert.deepEqual(calls, ["POST", "GET", "POST", "GET"]);
  }
});

test("opaque source unknown save recovers original receipt after later replacement and SQLite restart without resolving the new ordinal", async (t) => {
  const { createOperatorFixture } = await import("../fixtures/operator-web.js");
  const { OperatorApi } = await import("../../src/standalone/operator-api.js");
  const f = await createOperatorFixture();
  t.after(() => f.close());
  let api = new OperatorApi(f.service, [f.directory]);
  const projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Source",
    leadProfileId: null,
  });
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    selections: [{ id: "original", kind: "search", query: "original query" }],
    readiness: null,
  });
  const command = {
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    selections: [
      {
        savedRow: { projectId, section: "source", version: 2, index: 0 },
        keep: true,
      },
    ],
  };
  const calls: string[] = [];
  const client = new OperatorClient(async (path, init) => {
    if (init?.method === "POST") {
      calls.push("POST");
      await api.execute(JSON.parse(String(init.body)));
      throw Error("lost");
    }
    calls.push("GET");
    return Response.json(
      await api.readOperation(
        new URL(String(path), "http://fixture").searchParams,
      ),
    );
  });
  const draft = new ConfigurationDraft();
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 3,
    selections: [{ id: "replacement", kind: "search", query: "later query" }],
    readiness: null,
  });
  await f.reopen();
  api = new OperatorApi(f.service, [f.directory]);
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.equal(draft.details.version, 3);
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.deepEqual(
    f.service.domain().githubConfiguration(projectId).selections,
    [{ id: "replacement", kind: "search", query: "later query" }],
  );
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 4);
  assert.equal(f.runtime.turns, 0);
});

test("delivery JSON row comparison ignores UI keys but retains optional presence, order and duplicates", () => {
  const d = new ConfigurationDraft();
  const grant = {
    action: "issue.comment",
    repositoryId: "r",
    mode: "approval",
    rowKey: "first",
  };
  d.initialize({
    key: randomUUID(),
    expectedVersion: "1",
    grants: JSON.stringify([grant, grant]),
    requiredChecks: JSON.stringify([
      { name: "Build", appId: "42", rowKey: "check" },
    ]),
  });
  d.set(
    "grants",
    JSON.stringify([
      { ...grant, rowKey: "new" },
      { ...grant, rowKey: "new-2" },
    ]),
  );
  d.set(
    "requiredChecks",
    JSON.stringify([{ rowKey: "other", appId: "42", name: "Build" }]),
  );
  assert.equal(d.dirty, false);
  d.set("grants", JSON.stringify([{ ...grant, optionNodeIds: [] }, grant]));
  assert.equal(d.dirty, true);
  d.set("grants", JSON.stringify([grant, grant]));
  assert.equal(d.dirty, false);
  d.set("grants", JSON.stringify([grant]));
  assert.equal(d.dirty, true);
});

test("archive read-only transition preserves frozen private configuration and checks only its original receipt", async () => {
  const projectId = randomUUID(),
    key = randomUUID();
  const requests: Array<{ url: string; method: string }> = [];
  let recorded = false;
  const client = new OperatorClient(async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({ url: String(url), method });
    if (method === "POST") throw Error("lost reply");
    return Response.json({
      observedAt: 1,
      data: recorded
        ? {
            state: "recorded",
            receipt: {
              kind: "configuration",
              key,
              recorded: true,
              result: {
                commandType: "project.configure",
                resourceId: projectId,
                version: 3,
                paused: true,
                leadProfileId: null,
                instructionsRevision: 3,
              },
            },
          }
        : { state: "not-recorded" },
    });
  });
  const draft = new ConfigurationDraft();
  draft.set("instructions", "Private unsent edit");
  await draft.submit(
    client,
    {
      type: "project.configure",
      key,
      projectId,
      expectedVersion: 2,
      instructions: "Private unsent edit",
    },
    "csrf",
  );
  assert.equal(draft.phase, "unknown");
  const frozen = draft.frozen;
  draft.readOnly = true;
  assert.equal(draft.set("instructions", "Replacement"), false);
  await draft.submit(
    client,
    {
      type: "project.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 4,
      instructions: "Replacement",
    },
    "csrf",
  );
  await draft.reconcile(client, "csrf");
  assert.deepEqual(draft.frozen, frozen);
  assert.equal(draft.phase, "unknown");
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
  const query = new URL(requests.at(-1)!.url, "http://fixture.invalid")
    .searchParams;
  assert.equal(query.get("key"), key);
  assert.equal(query.get("scope"), `project:${projectId}`);
  recorded = true;
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
});

test("read-only capacity recovery preserves the original system-scoped command and never retries a missing owner", async () => {
  const owner = randomUUID(),
    key = randomUUID();
  const command = {
    type: "capacity.configure" as const,
    key,
    globalLimit: 9,
    projectOverrides: { [owner]: 7 },
  };
  const requests: Array<{ method: string; url: string }> = [];
  let recorded = false;
  const client = new OperatorClient(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: String(url) });
    if (init?.method === "POST") throw Error("lost reply");
    return Response.json({
      observedAt: 1,
      data: recorded
        ? {
            state: "recorded",
            receipt: {
              kind: "configuration",
              key,
              recorded: true,
              result: {
                commandType: "capacity.configure",
                resourceId: "system:capacity",
                globalLimit: 9,
                defaultProjectLimit: 2,
                projectOverrides: { [owner]: 7 },
              },
            },
          }
        : { state: "not-recorded" },
    });
  });
  const d = new ConfigurationDraft();
  d.set("globalLimit", "9");
  d.set(`limit-${owner}`, "7");
  await d.submit(client, command, "csrf");
  assert.equal(d.phase, "unknown");
  const frozen = d.frozen,
    values = structuredClone(d.values);
  d.readOnly = true;
  await d.reconcile(client, "csrf");
  assert.equal(d.phase, "unknown");
  assert.deepEqual(d.frozen, frozen);
  assert.deepEqual(d.values, values);
  const query = new URL(requests[1]!.url, "http://fixture.invalid")
    .searchParams;
  assert.equal(query.get("scope"), "system:capacity");
  assert.equal(query.get("type"), "capacity.configure");
  assert.equal(query.get("key"), key);
  recorded = true;
  await d.reconcile(client, "csrf");
  assert.equal(d.phase, "recorded");
  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    1,
  );
});
