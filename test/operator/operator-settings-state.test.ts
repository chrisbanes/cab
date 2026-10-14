import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
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
  // The form values at save time stay with the record after the draft starts over.
  const snap = drafts.get("profile.configure:snap", () => {});
  snap.set("wasActive", true);
  await snap.submit(client, command(), "csrf");
  assert.equal(drafts.saved("profile.configure:snap")?.values.wasActive, true);
  snap.startOperation({ wasActive: false });
  assert.equal(drafts.saved("profile.configure:snap")?.values.wasActive, true);
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
  assert.equal(highlighted.notice, outcomeCopy.fields);

  const preflight = new ConfigurationDraft();
  await preflight.submit(
    new OperatorClient(async () => assert.fail("nothing is sent")),
    { type: "project.configure" },
    "csrf",
  );
  assert.equal(preflight.notice, outcomeCopy.fields);

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
  for (const draft of [saved, rejected, highlighted, preflight, conflict, lost])
    assert.doesNotMatch(draft.notice, plain, draft.notice);
  for (const draft of [rejected, highlighted, preflight])
    assert.match(draft.notice, /Your changes are still here\.$/);
  for (const text of Object.values(outcomeCopy))
    assert.ok(text.split(/(?<=\.)\s/).length <= 2, text);
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
