import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  type GenerationMode,
  type HeldGeneration,
  servedGeneration,
} from "../fixtures/recovery-generations.js";

type Json = Record<string, unknown>;
const observations = (name: string) =>
  name === "execution_recovery_observations";

async function world(
  t: { after(fn: () => unknown): void },
  mode: GenerationMode,
) {
  const w = await servedGeneration(t, mode);
  const ro = (await w.s.issue("read", "recovery-ro")).token;
  const rw = (await w.s.issue("read-write", "recovery-rw")).token;
  const post = async (body: unknown, token = rw) => {
    const r = await w.s.bearer(token, "/api/operator/commands", {
      method: "POST",
      body,
    });
    return { status: r.status, body: (await r.json()) as Json };
  };
  const ok = async (body: unknown) => {
    const r = await post(body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const turns = () =>
    "turns" in w.runtime ? w.runtime.turns : w.runtime.turnInvocations.length;
  const requestState = () =>
    w.s.f.service.turnRequests().find((r) => r.workId === w.g.workId)?.state;
  return { ...w, ro, rw, post, ok, turns, requestState };
}

/** The operator command for one path, from the fixture's exact service command. */
function commands(g: HeldGeneration) {
  const adoptType =
    g.mode === "no-turn" ? "recovery.no-turn.adopt" : "recovery.pre-turn.adopt";
  const recoverType =
    g.mode === "no-turn"
      ? "recovery.no-turn.recover"
      : "recovery.pre-turn.recover";
  return {
    adopt: (key: string = randomUUID()) => ({
      type: adoptType,
      assignmentId: g.assignmentId,
      ...g.adoption(key),
    }),
    recover: (witnessId?: string, key: string = randomUUID()) => ({
      type: recoverType,
      assignmentId: g.assignmentId,
      ...g.recovery(witnessId, key),
    }),
    replace: (key: string = randomUUID(), revision = 1, version = 1) => ({
      type: "recovery.conversation.replace",
      key,
      assignmentId: g.assignmentId,
      expectedAssignmentVersion: version,
      expectedConversationRevision: revision,
    }),
  };
}

for (const mode of ["no-turn", "pre-turn-historical"] as const)
  test(`${mode}: adopt, recover and replace over the receipted command route, replaying exactly`, async (t) => {
    const w = await world(t, mode);
    const c = commands(w.g);
    const turns = w.turns();
    const adopt = c.adopt();
    const adopted = await w.ok(adopt);
    assert.deepEqual(adopted, {
      kind: "recovery-adoption",
      key: adopt.key,
      recorded: true,
      path: mode === "no-turn" ? "no-turn-adopt" : "pre-turn-adopt",
      assignmentId: w.g.assignmentId,
      workId: w.g.workId,
      witnessId: w.g.witnessId(),
    });
    const before = databaseDigest(w.s.f);
    assert.deepEqual(
      await w.ok(adopt),
      adopted,
      "same key and content replays",
    );
    assert.equal(databaseDigest(w.s.f), before);

    const recover = c.recover();
    const [first, second] = await Promise.all([w.ok(recover), w.ok(recover)]);
    assert.deepEqual(first, second, "concurrent same-key calls settle once");
    assert.equal(first.kind, "recovery-resolution");
    assert.equal(first.state, "reconciled");
    assert.equal(first.workId, w.g.workId);
    assert.equal(w.turns(), turns, "recovery dispatches nothing");
    assert.equal(w.requestState(), "held", "the old request stays held");
    await w.s.restart();
    assert.deepEqual(await w.ok(recover), first, "replays after restart");

    const replace = c.replace();
    assert.deepEqual(await w.ok(replace), {
      kind: "conversation-replacement",
      key: replace.key,
      recorded: true,
      assignmentId: w.g.assignmentId,
      revision: 2,
    });
    assert.equal((await w.ok(replace)).revision, 2);
    assert.equal(w.turns(), turns, "replacement dispatches nothing");
    assert.equal(w.requestState(), "held");
  });

test("a runtime-captured pre-turn generation recovers without adoption", async (t) => {
  const w = await world(t, "pre-turn-runtime");
  const r = await w.ok(commands(w.g).recover());
  assert.equal(r.path, "pre-turn-recover");
  assert.equal(w.requestState(), "held");
});

test("a command recorded through either entry point replays through the other", async (t) => {
  const w = await world(t, "no-turn");
  const c = commands(w.g);
  // Bearer first, then the retained session form with the same inner payload.
  const adopt = c.adopt();
  const receipt = await w.ok(adopt);
  const { type: _t, assignmentId: _a, ...inner } = adopt;
  const before = databaseDigest(w.s.f);
  let r = await w.s.sessionForm("/runtime/control/no-turn/adopt", {
    payload: JSON.stringify(inner),
  });
  assert.equal(r.status, 303);
  assert.equal(databaseDigest(w.s.f), before);
  // Session form first, then the bearer command replays its receipt.
  const recover = c.recover();
  const { type: _rt, assignmentId: _ra, ...recoverInner } = recover;
  r = await w.s.sessionForm("/runtime/control/no-turn/recover", {
    payload: JSON.stringify(recoverInner),
  });
  assert.equal(r.status, 303);
  const recovered = databaseDigest(w.s.f);
  const replayed = await w.ok(recover);
  assert.equal(replayed.kind, "recovery-resolution");
  assert.equal(databaseDigest(w.s.f), recovered);
  const replace = c.replace();
  r = await w.s.sessionForm("/runtime/control/conversation-replace", {
    key: replace.key,
    assignmentId: replace.assignmentId,
    expectedAssignmentVersion: "1",
    expectedConversationRevision: "1",
  });
  assert.equal(r.status, 303);
  assert.equal((await w.ok(replace)).revision, 2);
  assert.ok(receipt.witnessId);
});

test("read-only, cross-origin and malformed recovery commands change nothing", async (t) => {
  const w = await world(t, "no-turn");
  const c = commands(w.g);
  const witness = randomUUID();
  const before = databaseDigest(w.s.f);
  for (const body of [c.adopt(), c.recover(witness), c.replace()]) {
    const r = await w.post(body, w.ro);
    assert.equal(r.status, 403);
    assert.equal((r.body.error as Json).code, "insufficient-scope");
  }
  for (const path of [
    "/runtime/control/no-turn/adopt",
    "/runtime/control/no-turn/recover",
    "/runtime/control/pre-turn/adopt",
    "/runtime/control/pre-turn/recover",
    "/runtime/control/conversation-replace",
  ])
    for (const token of [w.ro, w.rw]) {
      const r = await fetch(`${w.s.origin}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ payload: "{}" }).toString(),
      });
      assert.equal(r.status, 403, path);
    }
  const noCsrf = await fetch(`${w.s.origin}/api/operator/commands`, {
    method: "POST",
    headers: {
      cookie: w.s.cookie,
      origin: w.s.authOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify(c.adopt()),
  });
  assert.equal(noCsrf.status, 403);
  const adopt = c.adopt() as Json & {
    evidence: Json;
    attestation: Json;
  };
  const recover = c.recover(witness) as Json & { receipt: Json };
  const invalid: Json[] = [
    {
      ...adopt,
      attestation: { ...adopt.attestation, independentlyReviewed: false },
    },
    { ...adopt, attestation: { independentlyReviewed: true } },
    { ...adopt, evidence: { ...adopt.evidence, evidenceSha256: "abc" } },
    {
      ...adopt,
      evidence: { ...adopt.evidence, frozenSourceRevision: "a".repeat(39) },
    },
    {
      ...adopt,
      evidence: { ...adopt.evidence, reviewReference: "http://example.test/r" },
    },
    { ...adopt, extra: true },
    { ...recover, receipt: { ...recover.receipt, effects: "unknown" } },
    { ...recover, receipt: { ...recover.receipt, effects: undefined } },
    { ...recover, receipt: { ...recover.receipt, workspace: undefined } },
    { ...recover, receipt: { ...recover.receipt, threadId: "thread-1" } },
    { ...recover, receipt: { ...recover.receipt, turnId: "turn-1" } },
  ];
  for (const body of invalid) {
    const r = await w.post(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 200));
  }
  assert.equal(databaseDigest(w.s.f), before);
});

test("definite recovery refusals are conflicts that keep holds, never uncertain outcomes", async (t) => {
  const w = await world(t, "no-turn");
  const c = commands(w.g);
  const unchanged = async (
    body: unknown,
    status = 409,
    skip = observations,
  ) => {
    const before = databaseDigest(w.s.f, skip);
    const r = await w.post(body);
    assert.equal(
      r.status,
      status,
      `${JSON.stringify(r.body)} ${JSON.stringify(body).slice(0, 160)}`,
    );
    assert.equal(databaseDigest(w.s.f, skip), before);
  };
  const adopt = c.adopt() as Json & { processIdentity: Json };
  await unchanged({ ...c.adopt(), assignmentId: randomUUID() }, 404);
  await unchanged({
    ...adopt,
    workRevision: (adopt.workRevision as number) + 1,
  });
  await unchanged({
    ...adopt,
    requestSequence: (adopt.requestSequence as number) + 1,
  });
  await unchanged({
    ...adopt,
    processIdentity: { ...adopt.processIdentity, processId: "x" },
  });
  await unchanged({ ...adopt, retainedReason: "another reason" });
  await unchanged({ ...adopt, workId: "assignment:unknown:work" });
  // Replacement while the generation is unresolved is a definite refusal.
  await unchanged(c.replace());
  // Recovery without the adopted witness: the verifier ran, nothing else changed.
  await unchanged(c.recover(randomUUID()));
  const adopted = await w.ok(adopt);
  await unchanged({ ...c.adopt(), key: randomUUID() }, 409);
  await unchanged({ ...adopt, retainedReason: "reuse" }, 409);
  await unchanged({ ...c.replace(adopt.key as string) }, 409);
  await unchanged(c.recover(randomUUID()));
  for (const [mode, kind] of [
    ["unknown", "termination-unknown"],
    ["conflict", "termination-conflict"],
  ] as const) {
    w.verifier.set(mode);
    await unchanged(c.recover(adopted.witnessId as string));
    const record = w.s.f.service
      .recoveryForTask(w.g.taskId)
      .find((r) => r.workId === w.g.workId);
    assert.ok(record?.observations.some((o) => o.kind === kind));
    assert.ok(record?.holds.writer && record.holds.capacity);
  }
  w.verifier.set("verified");
  const recovered = await w.ok(c.recover(adopted.witnessId as string));
  await unchanged(c.recover(adopted.witnessId as string), 409);
  await unchanged(c.replace(randomUUID(), 1, 2));
  await unchanged(c.replace(randomUUID(), 2, 1));
  const stop = await w.ok({
    type: "task.stop",
    key: randomUUID(),
    taskId: w.g.taskId,
  });
  assert.equal(stop.kind, "task-stop");
  await unchanged(c.replace());
  await unchanged({ ...c.replace(), key: recovered.key }, 409);
});
