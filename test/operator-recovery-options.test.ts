import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { recoveryOptionsSchema } from "../src/operator/contracts.js";
import { seedOperatorRecovery } from "./fixtures/operator-web.js";
import {
  type GenerationMode,
  servedGeneration,
} from "./fixtures/recovery-generations.js";

type World = Awaited<ReturnType<typeof servedGeneration>>;

async function options(w: World, token?: string) {
  const path = `/api/operator/assignments/${w.g.assignmentId}/recovery-options`;
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
  assert.deepEqual(data.replacement, {
    eligible: false,
    blockedBy: ["unresolved-execution"],
    expectedAssignmentVersion: 1,
    expectedConversationRevision: 1,
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
  assert.deepEqual(eligibility(record), {
    "pre-turn-adopt": "context-unavailable",
    "pre-turn-recover": "context-unavailable,witness-missing",
    "no-turn-adopt": "eligible",
    "no-turn-recover": "witness-missing",
  });
  assert.equal(record.holds.writer && record.holds.capacity, true);

  const adopted = s.f.service.adoptHistoricalNoTurnSubmission(
    g.adoption() as never,
  );
  let after = (await options(w, w.read)).records.find(
    (r) => r.workId === g.workId,
  );
  assert.ok(after);
  assert.deepEqual(after.witnesses.noTurn, { id: adopted.witnessId });
  assert.deepEqual(path(after, "no-turn-adopt")?.blockedBy, [
    "witness-present",
  ]);
  assert.equal(path(after, "no-turn-recover")?.eligible, true);
  assert.deepEqual(path(after, "pre-turn-recover")?.blockedBy, [
    "context-unavailable",
    "witness-missing",
    "other-witness",
  ]);

  await s.f.service.recoverNoTurnExecution(g.recovery() as never);
  const reconciled = await options(w, w.read);
  after = reconciled.records.find((r) => r.workId === g.workId);
  assert.ok(after);
  assert.equal(after.receiptRecorded, true);
  assert.equal(after.workspace, "preserved");
  assert.ok(
    after.paths.every((p) => p.blockedBy.includes("already-reconciled")),
  );
  assert.deepEqual(reconciled.replacement.blockedBy, []);
  assert.equal(reconciled.replacement.eligible, true);

  // An operator Stop blocks replacement until Resume clears it.
  const control = async (type: "task.stop" | "task.resume") => {
    const r = await s.bearer(w.write, "/api/operator/commands", {
      method: "POST",
      body: { type, key: randomUUID(), taskId: g.taskId },
    });
    assert.equal(r.status, 200, await r.text());
  };
  await control("task.stop");
  assert.deepEqual((await options(w, w.read)).replacement.blockedBy, [
    "task-held",
  ]);
  await control("task.resume");
  assert.equal((await options(w, w.read)).replacement.eligible, true);
});

test("historical and runtime-captured pre-turn generations expose predecessor identity and their paths", async (t) => {
  const historical = await world(t, "pre-turn-historical");
  let data = await options(historical, historical.read);
  let record = data.records.find((r) => r.workId === historical.g.workId);
  assert.ok(record);
  const adoption = historical.g.adoption() as {
    predecessorWorkId: string;
    retainedReason: string;
  };
  assert.deepEqual(record.predecessor, {
    workId: adoption.predecessorWorkId,
    threadId: "thread-1",
  });
  assert.equal(record.retainedReason, adoption.retainedReason);
  assert.deepEqual(eligibility(record), {
    "pre-turn-adopt": "eligible",
    "pre-turn-recover": "witness-missing",
    "no-turn-adopt": "context-unavailable",
    "no-turn-recover": "context-unavailable,witness-missing",
  });

  const runtime = await world(t, "pre-turn-runtime");
  data = await options(runtime, runtime.read);
  record = data.records.find((r) => r.workId === runtime.g.workId);
  assert.ok(record);
  assert.equal(record.witnesses.preTurn?.source, "runtime");
  assert.deepEqual(path(record, "pre-turn-adopt")?.blockedBy, [
    "witness-present",
  ]);
  assert.equal(path(record, "pre-turn-recover")?.eligible, true);
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
  assert.deepEqual(path(record, "no-turn-adopt")?.blockedBy, [
    "reason-withheld",
  ]);
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
