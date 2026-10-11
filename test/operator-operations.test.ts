import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "./fixtures/database-digest.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "./fixtures/instruction-history.js";
import { startCliService } from "./fixtures/operator-cli.js";

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
