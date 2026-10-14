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

test("configuration impact lists bound assignments read-only and bounded", async (t) => {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  const read = (await s.issue("read", "impact-ro")).token;
  const get = async (path: string, status = 200) => {
    const r = await s.bearer(read, path);
    const text = await r.text();
    assert.equal(r.status, status, `${path}: ${text}`);
    assert.ok(!text.includes(instructionSecret));
    return JSON.parse(text) as Json;
  };
  const before = databaseDigest(s.f);

  const profile = (await get(`/api/operator/profiles/${seed.profileId}/impact`))
    .data;
  assert.deepEqual(profile.target, { kind: "profile", id: seed.profileId });
  assert.equal(profile.total, 2);
  assert.equal(profile.truncated, false);
  assert.equal(profile.limit, 200);
  const [a, b] = profile.assignments;
  assert.deepEqual(a, {
    assignmentId: seed.assignmentA,
    taskId: seed.taskA,
    projectId: seed.projectA,
    profileId: seed.profileId,
    state: a.state,
    lead: true,
    bound: { profileRevision: 1, instructionsRevision: 1 },
    current: { profileRevision: 3, instructionsRevision: 2 },
    stale: { profile: true, instructions: true },
  });
  assert.equal(b.assignmentId, seed.assignmentB);
  assert.deepEqual(b.stale, { profile: false, instructions: false });

  const project = (await get(`/api/operator/projects/${seed.projectA}/impact`))
    .data;
  assert.deepEqual(
    project.assignments.map((r: Json) => r.assignmentId),
    [seed.assignmentA],
  );
  const one = (
    await get(`/api/operator/profiles/${seed.profileId}/impact?limit=1`)
  ).data;
  assert.equal(one.assignments.length, 1);
  assert.equal(one.total, 2);
  assert.equal(one.truncated, true);

  for (const query of [
    "limit=0",
    "limit=201",
    "limit=x",
    "limit=1&limit=2",
    "other=1",
  ])
    await get(`/api/operator/profiles/${seed.profileId}/impact?${query}`, 400);
  await get(`/api/operator/profiles/${randomUUID()}/impact`, 404);
  await get(`/api/operator/projects/${randomUUID()}/impact`, 404);
  await get("/api/operator/projects/nope/impact", 400);
  assert.equal(databaseDigest(s.f), before);

  const session = await s.sessionGet(
    `/api/operator/projects/${seed.projectA}/impact`,
  );
  assert.equal(session.status, 200);
  const anonymous = await fetch(
    `${s.origin}/api/operator/projects/${seed.projectA}/impact`,
    { headers: { authorization: "Bearer nope" } },
  );
  assert.equal(anonymous.status, 401);

  const applied = await s.sessionPost("/api/operator/commands", {
    type: "assignment.apply",
    key: randomUUID(),
    projectId: seed.projectA,
    assignmentId: seed.assignmentA,
    expectedVersion: Number(
      s.f.service.domain().assignment(seed.assignmentA).version,
    ),
  });
  assert.equal(applied.status, 200);
  const after = (await get(`/api/operator/projects/${seed.projectA}/impact`))
    .data.assignments[0];
  assert.deepEqual(after.stale, { profile: false, instructions: false });
});
