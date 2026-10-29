import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted structurally
type Json = Record<string, any>;

test("operation readback returns the POST receipt for every configuration type", async (t) => {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  const write = (await s.issue("read-write", "ops-rw")).token;
  const read = (await s.issue("read", "ops-ro")).token;
  const d = s.f.service.domain();
  const post = async (command: Json) => {
    const r = await s.bearer(write, "/api/operator/commands", {
      method: "POST",
      body: command,
    });
    const body = (await r.json()) as Json;
    assert.equal(r.status, 200, JSON.stringify(body));
    return body;
  };
  const operation = (token: string, query: string) =>
    s.bearer(token, `/api/operator/operations?${query}`);
  const readBack = async (scope: string, type: string, key: string) => {
    const r = await operation(
      read,
      `scope=${encodeURIComponent(scope)}&type=${type}&key=${key}`,
    );
    assert.equal(r.status, 200);
    return ((await r.json()) as Json).data;
  };

  const profileId = randomUUID(),
    projectId = randomUUID();
  const cases: [string, Json][] = [];
  const add = async (scope: string, command: Json) => {
    const key = randomUUID();
    const receipt = await post({ ...command, key });
    cases.push([scope, { type: command.type, key, receipt }]);
    return receipt;
  };
  await add(`profile:${profileId}`, {
    type: "profile.create",
    profileId,
    name: "Reviewer",
    instructions: `Review ${instructionSecret}`,
    capabilities: "review",
  });
  await add(`profile:${profileId}`, {
    type: "profile.configure",
    profileId,
    expectedVersion: 1,
    summary: "Reviews",
  });
  await add(`project:${projectId}`, {
    type: "project.create",
    projectId,
    name: "Gamma",
    leadProfileId: profileId,
    instructions: `Gamma ${instructionSecret}`,
  });
  await add(`project:${projectId}`, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await add(`project:${projectId}`, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: true,
    guidance: `Route ${instructionSecret}`,
    candidateProfileIds: [profileId],
  });
  await add("system:capacity", {
    type: "capacity.configure",
    globalLimit: 5,
    projectOverrides: { [projectId]: 3 },
  });
  await add(`project:${seed.projectA}`, {
    type: "assignment.apply",
    projectId: seed.projectA,
    assignmentId: seed.assignmentA,
    expectedVersion: Number(d.assignment(seed.assignmentA).version),
  });
  assert.equal(cases.length, 7);
  for (const [scope, { type, key, receipt }] of cases)
    assert.deepEqual(await readBack(scope, type, key), {
      state: "recorded",
      receipt,
    });

  const [, profileCase] = cases[0] ?? [];
  const [, routingCase] = cases[4] ?? [];
  assert.deepEqual(
    await readBack(`profile:${profileId}`, "profile.create", randomUUID()),
    { state: "not-recorded" },
  );
  // A stored routing result read as a project change does not match its shape.
  const mismatch = await operation(
    read,
    `scope=project:${projectId}&type=project.configure&key=${routingCase?.key}`,
  );
  assert.equal(mismatch.status, 409);
  // The command type is bound: creation and change receipts never cross-read.
  const assignmentKey = randomUUID();
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: assignmentKey,
    projectId: seed.projectA,
    taskId: seed.taskA,
    assignmentId: randomUUID(),
    profileId: seed.profileId,
    brief: "Helper",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  for (const [scope, type, key] of [
    [`profile:${profileId}`, "profile.configure", cases[0]?.[1].key],
    [`profile:${profileId}`, "profile.create", cases[1]?.[1].key],
    [`project:${projectId}`, "project.configure", cases[2]?.[1].key],
    [`project:${projectId}`, "project.create", cases[3]?.[1].key],
    [`project:${seed.projectA}`, "assignment.apply", assignmentKey],
  ])
    assert.equal(
      (await operation(read, `scope=${scope}&type=${type}&key=${key}`)).status,
      409,
      `${type} ${key}`,
    );

  // One UUID used as a key in two scopes reads back each scope's own receipt.
  const shared = randomUUID();
  const sharedProject = await post({
    type: "project.configure",
    key: shared,
    projectId: seed.projectA,
    expectedVersion: Number(d.project(seed.projectA).version),
    name: "Alpha renamed",
  });
  const sharedProfile = await post({
    type: "profile.configure",
    key: shared,
    profileId: seed.profileId,
    expectedVersion: Number(d.profile(seed.profileId).version),
    summary: "Shared",
  });
  assert.deepEqual(
    await readBack(`project:${seed.projectA}`, "project.configure", shared),
    { state: "recorded", receipt: sharedProject },
  );
  assert.deepEqual(
    await readBack(`profile:${seed.profileId}`, "profile.configure", shared),
    { state: "recorded", receipt: sharedProfile },
  );
  assert.deepEqual(
    await readBack(`project:${seed.projectB}`, "project.configure", shared),
    { state: "not-recorded" },
  );

  const key = profileCase?.key;
  for (const query of [
    `scope=project:${projectId}&type=profile.create&key=${key}`,
    `scope=system:capacity&type=project.configure&key=${key}`,
    `scope=profile:${profileId}&type=capacity.configure&key=${key}`,
    `scope=system:discovery&type=capacity.configure&key=${key}`,
    `scope=system:claude-token&type=capacity.configure&key=${key}`,
    `scope=${projectId}&type=project.configure&key=${key}`,
    `scope=profile:${profileId}&type=task.create&key=${key}`,
    `scope=profile:${profileId}&type=profile.create&key=nope`,
    `scope=profile:${profileId}&type=profile.create`,
    `scope=profile:${profileId}&type=profile.create&key=${key}&key=${key}`,
    `scope=profile:${profileId}&type=profile.create&key=${key}&extra=1`,
  ])
    assert.equal((await operation(read, query)).status, 400, query);

  const good = `scope=profile:${profileId}&type=profile.create&key=${key}`;
  const session = await s.sessionGet(`/api/operator/operations?${good}`);
  assert.equal(session.status, 200);
  assert.deepEqual(((await session.json()) as Json).data, {
    state: "recorded",
    receipt: profileCase?.receipt,
  });
  const anonymous = await fetch(`${s.origin}/api/operator/operations?${good}`, {
    headers: { authorization: "Bearer nope" },
  });
  assert.equal(anonymous.status, 401);
  for (const [scope, { type, key: k }] of cases) {
    const text = await (
      await operation(
        read,
        `scope=${encodeURIComponent(scope)}&type=${type}&key=${k}`,
      )
    ).text();
    assert.ok(!text.includes(instructionSecret), type);
  }
});

test("bearer capacity commands honour expectedCurrent; session commands without it still apply", async (t) => {
  const s = await startCliService(t);
  const write = (await s.issue("read-write", "cap-rw")).token;
  const before = databaseDigest(s.f);
  const stale = await s.bearer(write, "/api/operator/commands", {
    method: "POST",
    body: {
      type: "capacity.configure",
      key: randomUUID(),
      globalLimit: 2,
      projectOverrides: {},
      expectedCurrent: { globalLimit: 9, projectOverrides: {} },
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as Json).error.code, "conflict");
  assert.equal(databaseDigest(s.f), before);
  const matching = await s.bearer(write, "/api/operator/commands", {
    method: "POST",
    body: {
      type: "capacity.configure",
      key: randomUUID(),
      globalLimit: 3,
      projectOverrides: { [s.projectId]: 1 },
      expectedCurrent: {
        globalLimit: 4,
        projectOverrides: { [s.projectId]: null },
      },
    },
  });
  assert.equal(matching.status, 200);
  const session = await s.sessionPost("/api/operator/commands", {
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 6,
    projectOverrides: {},
  });
  assert.equal(session.status, 200);
  assert.equal(s.f.service.domain().capacityLimits().globalLimit, 6);
});

test("source configure and preview receipts read back exactly, without private text", async (t) => {
  let reads = 0;
  const s = await startCliService(t, {
    previewReader: () => ({
      async readSelection() {
        reads++;
        return { complete: true, issues: [], reason: null };
      },
    }),
  });
  const write = (await s.issue("read-write", "src-rw")).token;
  const read = (await s.issue("read", "src-ro")).token;
  const projectId = s.projectId;
  const post = async (command: Json) => {
    const r = await s.bearer(write, "/api/operator/commands", {
      method: "POST",
      body: command,
    });
    return { status: r.status, body: (await r.json()) as Json };
  };
  const get = async (
    type: string,
    key: string,
    scope = `project:${projectId}`,
  ) => {
    const r = await s.bearer(
      read,
      `/api/operator/operations?scope=${scope}&type=${type}&key=${key}`,
    );
    return { status: r.status, text: await r.text() };
  };
  const version = () =>
    s.f.service.domain().githubConfiguration(projectId).version;
  const configure = (selections: Json[]) => ({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: version(),
    credentialRef: "env:FIXTURE_SOURCE",
    selections,
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  });
  const configured = configure([
    { id: "S-1", kind: "search", query: "PRIVATEQ" },
  ]);
  const saved = await post(configured);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const preview = {
    type: "github.preview",
    key: randomUUID(),
    projectId,
    selectionId: "S-1",
    expectedVersion: version(),
  };
  const activated = await post(preview);
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  for (const [type, key, receipt] of [
    ["github.configure", configured.key, saved.body],
    ["github.preview", preview.key, activated.body],
  ] as const) {
    const r = await get(type, key);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).data, { state: "recorded", receipt });
    assert.ok(
      !r.text.includes("PRIVATEQ") && !r.text.includes("FIXTURE_SOURCE"),
    );
  }
  // A later configure leaves the preview receipt at its own version, read without the provider.
  assert.equal(
    (await post(configure([{ id: "S-1", keep: true }]))).status,
    200,
  );
  const later = JSON.parse((await get("github.preview", preview.key)).text);
  assert.equal(later.data.receipt.result.configVersion, 2);
  assert.equal(reads, 1);
  // Types never cross-read, and the scope and type must match.
  const projectKey = randomUUID();
  assert.equal(
    (
      await post({
        type: "project.configure",
        key: projectKey,
        projectId,
        expectedVersion: Number(
          s.f.service.domain().project(projectId).version,
        ),
        name: "Renamed",
      })
    ).status,
    200,
  );
  assert.equal((await get("github.configure", projectKey)).status, 409);
  assert.equal((await get("github.preview", configured.key)).status, 409);
  assert.equal((await get("github.configure", preview.key)).status, 409);
  assert.deepEqual(
    JSON.parse((await get("github.configure", randomUUID())).text).data,
    {
      state: "not-recorded",
    },
  );
  assert.equal(
    (await get("github.configure", configured.key, `profile:${projectId}`))
      .status,
    400,
  );
  assert.equal((await get("github.place", configured.key)).status, 400);
  // A selection ID equal to excluded text is never disclosed by the readback.
  const secret = "PRIVATESELECTIONID";
  assert.equal(
    (
      await post({
        type: "project.configure",
        key: randomUUID(),
        projectId,
        expectedVersion: Number(
          s.f.service.domain().project(projectId).version,
        ),
        instructions: secret,
      })
    ).status,
    200,
  );
  assert.equal(
    (await post(configure([{ id: secret, kind: "search", query: "x" }])))
      .status,
    200,
  );
  const hidden = {
    ...preview,
    key: randomUUID(),
    selectionId: secret,
    expectedVersion: version(),
  };
  assert.equal((await post(hidden)).status, 503);
  const r = await get("github.preview", hidden.key);
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.text).error.code, "unavailable");
  assert.ok(!r.text.includes(secret));
});

test("read-only credentials cannot send source or delivery commands", async (t) => {
  let reads = 0;
  const s = await startCliService(t, {
    previewReader: () => ({
      async readSelection() {
        reads++;
        return { complete: true, issues: [], reason: null };
      },
    }),
  });
  const read = (await s.issue("read", "deny-ro")).token;
  const before = databaseDigest(s.f);
  const base = { key: randomUUID(), projectId: s.projectId, taskId: s.taskId };
  for (const command of [
    {
      type: "github.configure",
      projectId: s.projectId,
      expectedVersion: 1,
      selections: [],
      readiness: { mode: "all", conditions: [{ kind: "label", name: "x" }] },
    },
    {
      type: "github.preview",
      projectId: s.projectId,
      selectionId: "S-1",
      expectedVersion: 1,
    },
    {
      type: "github.place",
      ...base,
      chosenProjectId: s.projectId,
      expectedVersion: 1,
    },
    { type: "delivery.refresh", taskId: s.taskId },
    {
      type: "comment.review",
      taskId: s.taskId,
      operationId: randomUUID(),
      expectedTaskVersion: 1,
      body: "x",
    },
    {
      type: "comment.confirm",
      taskId: s.taskId,
      reviewId: randomUUID(),
      expectedRevision: 1,
      materialHash: "0".repeat(64),
      decision: "approved",
    },
    {
      type: "comment.send",
      taskId: s.taskId,
      expectedTaskVersion: 1,
      body: "x",
    },
  ]) {
    const r = await s.bearer(read, "/api/operator/commands", {
      method: "POST",
      body: { key: randomUUID(), ...command },
    });
    assert.equal(r.status, 403, command.type);
    assert.equal(((await r.json()) as Json).error.code, "insufficient-scope");
  }
  assert.equal(databaseDigest(s.f), before);
  assert.equal(reads, 0);
});
