import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cliCapabilities } from "../../src/operator/contracts.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { wrapTaskExclusions } from "../fixtures/exclusions-hook.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

type Body = {
  revision: number;
  state: string;
  reason: string | null;
  text: string | null;
  redacted: boolean;
};

test("dedicated instruction reads disclose bound and current revisions with exclusions kept", async (t) => {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  const read = await s.issue("read");
  const write = await s.issue("read-write");
  const get = async (path: string, token = read.token) => {
    const r = await s.bearer(token, path);
    const body = (await r.json()) as { data: Record<string, unknown> };
    return { status: r.status, body, data: body.data as never };
  };
  const leaks = (value: unknown) => {
    const json = JSON.stringify(value);
    return [
      s.f.directory,
      instructionSecret,
      "hunter2",
      "CLI2_SYNTHETIC",
    ].filter((v) => json.includes(v));
  };

  // 1. Profile and project revision lists, selection and errors.
  const profile = `/api/operator/profiles/${seed.profileId}/instructions`;
  let r = await get(profile);
  assert.equal(r.status, 200);
  let data = r.data as {
    currentRevision: number;
    revisions: { revision: number; current: boolean }[];
    selected: Body & { runtime: { harness: string }; name: string };
    provenance: Record<string, unknown>;
  };
  assert.equal(data.currentRevision, 3);
  assert.deepEqual(
    data.revisions.map((x) => [x.revision, x.current]),
    [
      [1, false],
      [2, false],
      [3, true],
    ],
  );
  assert.equal(data.selected.revision, 3);
  assert.equal(data.selected.runtime.harness, "codex");
  assert.equal(data.selected.name, "Shared lead");
  assert.deepEqual(data.provenance, {
    source: "retained-revision-records",
    reconstructed: true,
    submittedPrompt: "not-captured",
  });
  // 2. Redaction inside the disclosed text.
  assert.match(data.selected.text ?? "", /^Profile revision three guidance /);
  assert.equal(data.selected.redacted, true);
  assert.deepEqual(leaks(r.body), []);
  r = await get(`${profile}?revision=1`);
  data = r.data;
  assert.equal(data.selected.text, seed.text.profile[0]);
  assert.equal(data.selected.redacted, false);
  for (const [query, status] of [
    ["revision=4", 404],
    ["revision=0", 400],
    ["revision=x", 400],
    ["revision=1&revision=2", 400],
    ["other=1", 400],
  ] as const)
    assert.equal((await get(`${profile}?${query}`)).status, status, query);
  assert.equal(
    (await get(`/api/operator/profiles/${randomUUID()}/instructions`)).status,
    404,
  );
  const projectA = `/api/operator/projects/${seed.projectA}/instructions`;
  r = await get(projectA);
  assert.equal((r.data as { selected: Body }).selected.redacted, true);
  assert.match(
    (r.data as { selected: Body }).selected.text ?? "",
    /^Project A revision two /,
  );
  assert.deepEqual(leaks(r.body), []);
  r = await get(`${projectA}?revision=1`);
  assert.equal(
    (r.data as { selected: Body }).selected.text,
    seed.text.project[0],
  );
  assert.ok(!JSON.stringify(r.body).includes("Project B only"));
  r = await get(`/api/operator/projects/${seed.projectB}/instructions`);
  assert.equal((r.data as { selected: Body }).selected.text, "Project B only");
  assert.ok(!JSON.stringify(r.body).includes("Project A revision"));

  // General reads keep instruction text redacted.
  for (const path of [
    `/api/operator/tasks/${seed.taskA}`,
    `/api/operator/assignments/${seed.assignmentA}/history`,
    `/api/operator/profiles/${seed.profileId}/configuration`,
    `/api/operator/projects/${seed.projectA}/configuration`,
    "/api/operator/search?query=Restate&historical=true",
  ]) {
    const general = await get(path);
    assert.equal(general.status, 200, path);
    const json = JSON.stringify(general.body);
    assert.ok(!json.includes("Profile revision one"), path);
    assert.ok(!json.includes("Project A revision"), path);
    assert.deepEqual(leaks(general.body), [], path);
  }

  // 4. Bound versus current for a stale and a current lead.
  const instructionsA = `/api/operator/assignments/${seed.assignmentA}/instructions`;
  type View = {
    bound: { profile: Body; project: Body };
    current: { profile: Body; project: Body };
    comparison: {
      profile: { sameRevision: boolean; sameContent: boolean | null };
      project: { sameRevision: boolean; sameContent: boolean | null };
      boundIsCurrent: boolean;
    };
    execution: null | { matchesBound: boolean; profileRevision: number };
    provenance: { submittedPrompt: string };
  };
  let view = (await get(instructionsA)).data as View;
  assert.deepEqual(
    [view.bound.profile.revision, view.bound.project.revision],
    [1, 1],
  );
  assert.deepEqual(
    [view.current.profile.revision, view.current.project.revision],
    [3, 2],
  );
  assert.equal(view.bound.profile.text, seed.text.profile[0]);
  assert.deepEqual(view.comparison, {
    profile: { sameRevision: false, sameContent: false },
    project: { sameRevision: false, sameContent: false },
    boundIsCurrent: false,
  });
  assert.equal(view.execution, null);
  assert.equal(view.provenance.submittedPrompt, "not-captured");
  view = (
    await get(`/api/operator/assignments/${seed.assignmentB}/instructions`)
  ).data;
  assert.deepEqual(view.comparison, {
    profile: { sameRevision: true, sameContent: true },
    project: { sameRevision: true, sameContent: true },
    boundIsCurrent: true,
  });

  // 5. Assignment detail equals the task entry plus its identity.
  r = await get(`/api/operator/assignments/${seed.assignmentA}`);
  assert.equal(r.status, 200);
  const task = (await get(`/api/operator/tasks/${seed.taskA}`)).data as {
    assignments: { assignmentId: string }[];
    task: { version: number };
  };
  const {
    taskId,
    projectId,
    taskVersion,
    lead,
    execution: _execution,
    ...entry
  } = r.data as Record<string, unknown>;
  assert.deepEqual(entry, task.assignments[0]);
  assert.deepEqual(
    [taskId, projectId, taskVersion, lead],
    [seed.taskA, seed.projectA, task.task.version, true],
  );
  assert.equal(
    (await get(`/api/operator/assignments/${randomUUID()}`)).status,
    404,
  );
  assert.equal(
    (await get(`/api/operator/assignments/${randomUUID()}/instructions`))
      .status,
    404,
  );

  // 6. Both scopes read identically, routes are read-only and persist nothing.
  const before = databaseDigest(s.f);
  for (const path of [
    profile,
    projectA,
    instructionsA,
    `/api/operator/assignments/${seed.assignmentA}`,
  ]) {
    assert.equal(operatorRouteAuthority("GET", path), "read");
    const viaRead = await get(path);
    const viaWrite = await get(path, write.token);
    const viaSession = (await (await s.sessionGet(path)).json()) as {
      data: unknown;
    };
    assert.deepEqual(viaRead.body.data, viaWrite.body.data, path);
    assert.deepEqual(viaRead.body.data, viaSession.data, path);
    assert.equal(
      (await fetch(`${s.origin}${path}`)).status,
      401,
      `unauthenticated ${path}`,
    );
  }
  assert.equal(databaseDigest(s.f), before);
  r = await get("/api/operator/cli");
  assert.deepEqual(
    (r.body as unknown as { capabilities: string[] }).capabilities,
    [...cliCapabilities],
  );
  assert.ok(cliCapabilities.includes("instructions.read"));

  // A running turn carries its own admitted revisions.
  const d = s.f.service.domain();
  await s.f.service.provisionTask(seed.taskA);
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seed.projectA,
    expectedVersion: Number(d.project(seed.projectA).version),
    paused: false,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seed.projectA,
    taskId: seed.taskA,
    expectedVersion: Number(d.task(seed.taskA).version),
    ready: true,
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    view = (await get(instructionsA)).data;
    if (view.execution) break;
    if (Date.now() > deadline) throw Error("no execution generation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(view.execution, {
    ...view.execution,
    profileRevision: 1,
    instructionsRevision: 1,
    matchesBound: true,
  });
  // Applying the current revisions makes the binding current.
  const assignment = d.assignment(seed.assignmentA);
  const applied = await s.sessionPost("/api/operator/commands", {
    type: "assignment.apply",
    key: randomUUID(),
    projectId: seed.projectA,
    assignmentId: seed.assignmentA,
    expectedVersion: Number(assignment.version),
  });
  assert.equal(applied.status, 200);
  view = (await get(instructionsA)).data;
  assert.equal(view.comparison.boundIsCurrent, true);
  // The finished turn no longer selects for the new version, or it no longer matches.
  assert.notEqual(view.execution?.matchesBound, true);
});

test("instruction views fail closed without exclusions and fence concurrent revisions", async (t) => {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  // 3. Without computable exclusions no text is shown.
  const unavailable = new OperatorApi(
    s.f.service,
    Array.from({ length: 129 }, (_, i) => `synthetic-path-${i}`),
  );
  const profile = await unavailable.readProfileInstructions(
    seed.profileId,
    new URLSearchParams(),
  );
  assert.deepEqual(
    [
      profile.data.selected.state,
      profile.data.selected.reason,
      profile.data.selected.text,
    ],
    ["omitted", "redaction-unavailable", null],
  );
  const view = await unavailable.readAssignmentInstructions(seed.assignmentA);
  assert.equal(view.data.bound.profile.text, null);
  assert.equal(view.data.comparison.profile.sameContent, null);

  const api = new OperatorApi(s.f.service, [s.f.directory]);
  const d = s.f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seed.projectB,
    expectedVersion: Number(d.project(seed.projectB).version),
    // Within the stored limit, but longer than 16000 characters once redacted.
    instructions: "token=a ".repeat(2000),
  });
  const long = await api.readProjectInstructions(
    seed.projectB,
    new URLSearchParams(),
  );
  assert.equal(long.data.selected.state, "omitted");
  assert.equal(long.data.selected.text, null);

  // A revision created while exclusions are computed fails the read.
  const restoreExclusions = wrapTaskExclusions(api, async (_id, run) => {
    restoreExclusions();
    d.execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId: seed.profileId,
      expectedVersion: Number(d.profile(seed.profileId).version),
      instructions: "Concurrent revision",
    });
    return run();
  });
  await assert.rejects(api.readAssignmentInstructions(seed.assignmentA), {
    status: 503,
  });
});
