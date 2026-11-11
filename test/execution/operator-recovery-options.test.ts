import { until } from "../fixtures/until.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assignmentRecoverySchema,
  recoveryOptionsSchema,
} from "../../src/operator/contracts.js";
import { RecoveryRejectedError } from "../../src/standalone/recovery-types.js";
import { seedOperatorRecovery } from "../fixtures/operator-web.js";
import {
  type GenerationMode,
  type PreTurnRuntime,
  servedGeneration,
} from "../fixtures/recovery-generations.js";

type World = Awaited<ReturnType<typeof servedGeneration>>;

async function options(
  w: World,
  token?: string,
  assignmentId = w.g.assignmentId,
) {
  const path = `/api/operator/assignments/${assignmentId}/recovery-options`;
  const response = token
    ? await w.s.bearer(token, path)
    : await w.s.sessionGet(path);
  assert.equal(response.status, 200, await response.clone().text());
  return recoveryOptionsSchema.parse(await response.json()).data;
}
const path = (
  record: Awaited<ReturnType<typeof options>>["records"][number],
  name: string,
) => record.paths.find((p) => p.path === name);
const eligibility = (
  record: Awaited<ReturnType<typeof options>>["records"][number],
) =>
  Object.fromEntries(
    record.paths.map((p) => [
      p.path,
      p.eligible ? "eligible" : p.blockedBy.join(","),
    ]),
  );

async function world(
  t: { after(fn: () => unknown): void },
  mode: GenerationMode,
) {
  const w = await servedGeneration(t, mode);
  const read = (await w.s.issue("read", "options-ro")).token;
  const write = (await w.s.issue("read-write", "options-rw")).token;
  return { ...w, read, write };
}

test("a held no-turn generation exposes its exact identity, eligibility and blockers to both scopes", async (t) => {
  const w = await world(t, "no-turn");
  const { g, s } = w;
  const data = await options(w, w.read);
  assert.deepEqual(
    await options(w),
    data,
    "session read is the same projection",
  );
  assert.equal(data.assignmentId, g.assignmentId);
  assert.equal(data.taskId, g.taskId);
  assert.equal(data.projectId, g.projectId);
  assert.equal(data.assignmentVersion, 1);
  assert.equal(data.conversationRevision, 1);
  assert.equal(data.held, true);
  assert.deepEqual(data.gaps, []);
  assert.deepEqual(data.restart, {
    eligible: false,
    blockedBy: ["submission-interrupted"],
    releasePending: null,
  });
  const record = data.records.find((r) => r.workId === g.workId);
  assert.ok(record);
  const adoption = g.adoption() as {
    writerSequence: number;
    conversationRevision: number;
  };
  assert.deepEqual(
    {
      generation: record.generation,
      process: record.process,
      retainedReason: record.retainedReason,
      writerSequence: record.writerSequence,
      conversationRevision: record.conversationRevision,
      predecessor: record.predecessor,
      witnesses: record.witnesses,
    },
    {
      generation: {
        workRevision: g.workRevision,
        requestSequence: g.requestSequence,
      },
      process: g.processIdentity,
      retainedReason: g.retainedReason,
      writerSequence: adoption.writerSequence,
      conversationRevision: adoption.conversationRevision,
      predecessor: null,
      witnesses: { preTurn: null, noTurn: null },
    },
  );
  assert.deepEqual(eligibility(record), { release: "eligible" });
  assert.equal(record.holds.writer && record.holds.capacity, true);

  // A witness an earlier build's adoption recorded no longer blocks release.
  const witnessId = g.adoptAsBefore();
  const after = (await options(w, w.read)).records.find(
    (r) => r.workId === g.workId,
  );
  assert.ok(after);
  assert.deepEqual(after.witnesses.noTurn, { id: witnessId });
  assert.equal(path(after, "release")?.eligible, true);
  s.f.service.releaseUnboundHold({
    key: randomUUID(),
    assignmentId: g.assignmentId,
    workId: g.workId,
    workRevision: g.workRevision,
    requestSequence: g.requestSequence,
  });
  const released = await options(w, w.read);
  assert.deepEqual(released.restart, {
    eligible: true,
    blockedBy: [],
    releasePending: null,
  });

  // An operator Stop blocks nothing here: Start again queues and the new request is held.
  const control = async (type: "task.stop" | "task.resume") => {
    const r = await s.bearer(w.write, "/api/operator/commands", {
      method: "POST",
      body: { type, key: randomUUID(), taskId: g.taskId },
    });
    assert.equal(r.status, 200, await r.text());
  };
  await control("task.stop");
  assert.equal((await options(w, w.read)).restart.eligible, true);
  await control("task.resume");
});

test("historical and runtime-captured pre-turn generations expose predecessor identity and release", async (t) => {
  const historical = await world(t, "pre-turn-historical");
  let data = await options(historical, historical.read);
  let record = data.records.find((r) => r.workId === historical.g.workId);
  assert.ok(record);
  const adoption = historical.g.adoption() as {
    predecessorWorkId: string;
  };
  assert.deepEqual(record.predecessor, {
    workId: adoption.predecessorWorkId,
    threadId: "thread-1",
  });
  assert.equal(record.retainedReason, historical.g.retainedReason);
  assert.deepEqual(eligibility(record), { release: "eligible" });
  // An operator-adopted pre-turn witness from an earlier build stays as evidence.
  historical.g.adoptAsBefore();
  record = (await options(historical, historical.read)).records.find(
    (r) => r.workId === historical.g.workId,
  );
  assert.ok(record);
  assert.equal(record.witnesses.preTurn?.source, "operator-adopted");
  assert.equal(path(record, "release")?.eligible, true);

  const runtime = await world(t, "pre-turn-runtime");
  data = await options(runtime, runtime.read);
  record = data.records.find((r) => r.workId === runtime.g.workId);
  assert.ok(record);
  assert.equal(record.witnesses.preTurn?.source, "runtime");
  assert.equal(path(record, "release")?.eligible, true);
});

test("a resume held by a cab defect is released as a refusal that Start again runs", async (t) => {
  const w = await world(t, "pre-turn-defect");
  const { g, s } = w;
  const service = s.f.service;
  let record = (await options(w, w.read)).records.find(
    (r) => r.workId === g.workId,
  );
  assert.ok(record);
  assert.match(
    record.retainedReason ?? "",
    /^Runtime submission or observation uncertain: .*invalid_value/s,
  );
  assert.deepEqual(eligibility(record), { release: "eligible" });
  const command = {
    key: randomUUID(),
    assignmentId: g.assignmentId,
    workId: g.workId,
    workRevision: g.workRevision,
    requestSequence: g.requestSequence,
  };
  for (const altered of [
    { workRevision: g.workRevision + 1 },
    { requestSequence: g.requestSequence + 1 },
    { assignmentId: randomUUID() },
  ])
    assert.throws(
      () =>
        service.releaseUnboundHold({
          ...command,
          key: randomUUID(),
          ...altered,
        }),
      RecoveryRejectedError,
    );
  assert.equal(service.startAgainAvailability(g.taskId).available, false);

  const released = service.releaseUnboundHold(command);
  assert.deepEqual(service.releaseUnboundHold(command), released);
  assert.throws(
    () =>
      service.releaseUnboundHold({
        ...command,
        requestSequence: g.requestSequence + 1,
      }),
    /reused with different material/,
  );
  record = (await options(w, w.read)).records.find(
    (r) => r.workId === g.workId,
  );
  assert.ok(record);
  assert.deepEqual(record.holds, {
    ...record.holds,
    writer: false,
    capacity: false,
  });
  assert.ok(record.paths.every((p) => !p.eligible));
  assert.deepEqual(path(record, "release")?.blockedBy, ["ownership-released"]);
  assert.deepEqual(service.startAgainAvailability(g.taskId), {
    available: true,
    assignmentId: g.assignmentId,
    workId: g.workId,
  });
  (w.runtime as PreTurnRuntime).resumeError = undefined;
  const receipt = await service.startAgain({
    key: randomUUID(),
    taskId: g.taskId,
    expectedVersion: Number(service.domain().task(g.taskId).version),
    workId: g.workId,
  });
  await until(
    () =>
      service.list().find((i) => i.workId === receipt.workId)?.state ===
      "completed",
    "started again",
  );
  assert.equal(
    service.turnRequests().find((r) => r.workId === g.workId)?.state,
    "held",
    "the refused request stays as history",
  );
});

test("redaction withholds exact strings and blocks the paths that would send them", async (t) => {
  const w = await world(t, "no-turn");
  // A profile instruction overlapping the held reason changes it under redaction.
  const profile = w.s.f.service.domain().profile(w.g.profileId);
  w.s.f.service.domain().execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: w.g.profileId,
    expectedVersion: Number(profile.version),
    instructions: "Runtime stopped",
  } as never);
  const data = await options(w, w.read);
  const record = data.records.find((r) => r.workId === w.g.workId);
  assert.ok(record);
  assert.equal(record.retainedReason, null);
  // Release sends no reason, so a withheld one doesn't block it.
  assert.equal(path(record, "release")?.eligible, true);
  assert.deepEqual(data.gaps, ["content-redacted"]);

  // A retained generation bound to an unknown assignment makes redaction unavailable.
  seedOperatorRecovery(
    w.s.f,
    {
      taskId: w.g.taskId,
      assignmentId: randomUUID(),
      projectId: w.g.projectId,
    },
    1,
  );
  const unavailable = { data: await options(w, w.read) };
  assert.deepEqual(unavailable.data.gaps, ["redaction-unavailable"]);
  for (const r of unavailable.data.records) {
    assert.equal(r.workId, null);
    assert.equal(r.process, null);
    assert.ok(r.paths.every((p) => p.blockedBy.includes("identity-withheld")));
  }
});

test("recovery options are bounded, validated and fail closed", async (t) => {
  const w = await world(t, "no-turn");
  seedOperatorRecovery(
    w.s.f,
    {
      taskId: w.g.taskId,
      assignmentId: w.g.assignmentId,
      projectId: w.g.projectId,
    },
    20,
  );
  const data = await options(w, w.read);
  assert.equal(data.records.length, 20);
  assert.equal(data.omittedCount, 1);
  const base = `/api/operator/assignments/${w.g.assignmentId}/recovery-options`;
  for (const [path, status] of [
    [`/api/operator/assignments/${randomUUID()}/recovery-options`, 404],
    ["/api/operator/assignments/not-a-uuid/recovery-options", 400],
    [`${base}?workId=x`, 400],
  ] as const)
    assert.equal((await w.s.bearer(w.read, path)).status, status, path);
  assert.equal((await fetch(`${w.s.origin}${base}`)).status, 401);
  assert.equal(
    (await w.s.bearer(w.write, base, { method: "POST", body: {} })).status,
    405,
  );
});

test("assignment recovery caps each assignment while retaining task-wide sibling holds", async (t) => {
  const w = await world(t, "no-turn");
  const sibling = randomUUID();
  w.s.f.service.domain().execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId: w.g.projectId,
    taskId: w.g.taskId,
    assignmentId: sibling,
    profileId: w.g.profileId,
    brief: "Sibling work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  } as never);
  // More than 20 newer generations on the sibling must not push out this one's.
  w.s.f.seedPersistedState((db) => {
    for (let n = 0; n < 21; n++) {
      const workId = `sibling-generation-${n}`;
      db.prepare(
        "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'p','/w','completed','r',NULL,NULL,'chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId);
      db.prepare(
        "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence,processId,processStartedAt,bootId,threadId,turnId) VALUES (?,1,?,'p','s','b',NULL,NULL)",
      ).run(workId, 1000 + n);
      db.prepare(
        "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
      ).run(workId, w.g.taskId, sibling);
    }
  });
  const aPath = `/api/operator/assignments/${w.g.assignmentId}/recovery`,
    aResponse = await w.s.bearer(w.read, aPath);
  assert.equal(aResponse.status, 200, await aResponse.clone().text());
  const a = assignmentRecoverySchema.parse(await aResponse.json()).data;
  assert.deepEqual(
    a.records.map((r) => r.workId),
    [w.g.workId],
  );
  assert.equal(a.evidenceAvailable, true);
  assert.equal(a.omittedCount, 0);

  const bResponse = await w.s.bearer(
    w.read,
    `/api/operator/assignments/${sibling}/recovery`,
  );
  assert.equal(bResponse.status, 200, await bResponse.clone().text());
  const b = assignmentRecoverySchema.parse(await bResponse.json()).data;
  assert.equal(b.records.length, 20);
  assert.equal(
    b.records.some((r) => r.workId === w.g.workId),
    false,
  );
  assert.equal(b.omittedCount, 1);
  assert.equal(b.evidenceAvailable, true);
  assert.equal(b.holds.writer, true);
  assert.equal(b.holds.capacity, true);
  assert.equal(b.holds.uncertainty, true);

  const siblingOptions = await options(w, w.read, sibling);
  assert.equal(siblingOptions.held, false);
  assert.deepEqual(siblingOptions.holds, {
    stop: false,
    writer: false,
    capacity: false,
    uncertainty: false,
    task: false,
  });

  const data = await options(w, w.read);
  assert.equal(data.held, true);
  assert.deepEqual(data.holds, {
    stop: false,
    writer: true,
    capacity: true,
    uncertainty: true,
    task: false,
  });
  assert.deepEqual(
    data.records.map((r) => r.workId),
    [w.g.workId],
  );
  assert.deepEqual(data.gaps, []);
  assert.equal(data.omittedCount, 0);
  assert.equal(data.evidenceAvailable, true);
  assert.equal(
    data.records[0]?.paths.find((p) => p.path === "release")?.eligible,
    true,
    "the older held generation stays selectable",
  );
  // A command naming the sibling's work under this assignment is refused.
  const r = await w.s.bearer(w.write, "/api/operator/commands", {
    method: "POST",
    body: {
      type: "recovery.release",
      key: randomUUID(),
      assignmentId: w.g.assignmentId,
      workId: "sibling-generation-0",
      workRevision: 1,
      requestSequence: 1000,
    },
  });
  assert.equal(r.status, 409);
});
