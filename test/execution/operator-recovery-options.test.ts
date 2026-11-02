import { until } from "../fixtures/until.js";
import { boundWorld } from "./bound-turn-recovery-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assignmentRecoverySchema,
  recoveryOptionsSchema,
} from "../../src/operator/contracts.js";
import { seedOperatorRecovery } from "../fixtures/operator-web.js";
import {
  type GenerationMode,
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
    "bound-turn-recover": "bound-identity-missing",
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
    "bound-turn-recover": "bound-identity-missing",
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
    data.records[0]?.paths.find((p) => p.path === "no-turn-adopt")?.eligible,
    true,
    "the older held generation stays selectable",
  );
  // A command naming the sibling's work under this assignment is refused.
  const r = await w.s.bearer(w.write, "/api/operator/commands", {
    method: "POST",
    body: {
      type: "recovery.no-turn.adopt",
      assignmentId: w.g.assignmentId,
      ...w.g.adoption(),
      workId: "sibling-generation-0",
    },
  });
  assert.equal(r.status, 409);
});

for (const harness of ["codex", "claude"] as const)
  test(`${harness} bound recovery options verify exit without mutating ownership`, async (t) => {
    const w = await boundWorld(t, harness);
    const ro = (await w.s.issue("read", "bound-options")).token;
    const read = async () => {
      const response = await w.s.bearer(
        ro,
        `/api/operator/assignments/${w.g.assignmentId}/recovery-options`,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return recoveryOptionsSchema.parse(await response.json()).data;
    };
    for (const [mode, blocker] of [
      ["live", "termination-live"],
      ["unknown", "termination-unknown"],
      ["conflict", "termination-conflict"],
      ["other-identity", "termination-conflict"],
      ["verified", undefined],
    ] as const) {
      w.setMode(mode);
      const data = await read();
      const record = data.records.find((r) => r.workId === w.g.workId);
      assert.ok(record);
      assert.deepEqual(record.process, w.g.processIdentity);
      assert.equal(record.threadId, w.g.threadId);
      assert.equal(record.turnId, w.g.turnId);
      const bound = record.paths.find((p) => p.path === "bound-turn-recover");
      assert.equal(bound?.eligible, blocker === undefined);
      assert.deepEqual(bound?.blockedBy, blocker ? [blocker] : []);
      assert.ok(record.holds.writer && record.holds.capacity);
      assert.equal(w.runtime.turnInvocations.length, 1);
    }
  });

test("bound recovery redaction and missing identity refuse without invoking the verifier", async (t) => {
  const w = await boundWorld(t, "codex", ["synthetic-no-turn"]);
  const response = await w.s.sessionGet(
    `/api/operator/assignments/${w.g.assignmentId}/recovery-options`,
  );
  const data = recoveryOptionsSchema.parse(await response.json()).data;
  const record = data.records.find((r) => r.workId === w.g.workId);
  assert.equal(record?.process, null);
  assert.ok(
    record?.paths
      .find((p) => p.path === "bound-turn-recover")
      ?.blockedBy.includes("identity-withheld"),
  );
  assert.equal(w.checks(), 0);
});

for (const column of ["process", "threadId", "turnId"] as const)
  test(`bound recovery explicitly reports missing ${column}`, async (t) => {
    const w = await boundWorld(t);
    w.s.f.seedPersistedState((db) =>
      db
        .prepare(
          `UPDATE execution_recovery_identities SET ${column === "process" ? "processId=NULL,processStartedAt=NULL,bootId=NULL" : `${column}=NULL`} WHERE workId=?`,
        )
        .run(w.g.workId),
    );
    const response = await w.s.sessionGet(
      `/api/operator/assignments/${w.g.assignmentId}/recovery-options`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = recoveryOptionsSchema.parse(await response.json()).data;
    const bound = data.records
      .find((r) => r.workId === w.g.workId)
      ?.paths.find((p) => p.path === "bound-turn-recover");
    assert.equal(bound?.eligible, false);
    assert.ok(bound?.blockedBy.includes("bound-identity-missing"));
    assert.equal(w.checks(), 0);
  });

test("bound eligibility refuses a generation changed while verification was pending", async (t) => {
  const w = await boundWorld(t);
  let release!: () => void;
  w.setGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const read = w.s.f.service.boundTurnRecoveryEligibility(
    w.g.workId,
    w.g.assignmentId,
  );
  await until(() => w.checks() === 1, "eligibility verification pending");
  w.s.f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE task_work_revisions SET workRevision=workRevision+1 WHERE workId=?",
      )
      .run(w.g.workId),
  );
  release();
  assert.deepEqual(await read, ["identity-changed"]);
});

test("bound eligibility has a finite termination-verifier deadline", {
  timeout: 10000,
}, async (t) => {
  const w = await boundWorld(t);
  w.setMode("hang");
  const started = Date.now();
  assert.deepEqual(
    await w.s.f.service.boundTurnRecoveryEligibility(
      w.g.workId,
      w.g.assignmentId,
    ),
    ["termination-unknown"],
  );
  assert.ok(Date.now() - started < 8000);
  assert.equal(
    w.s.f.service
      .recoveryForTask(w.g.taskId)
      .find((r) => r.workId === w.g.workId)?.receipt,
    null,
  );
});
