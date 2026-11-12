import {
  DeliveryStore,
  type DeliveryActionRecord,
} from "../../src/core/delivery.js";
import { startedOf } from "../fixtures/service-internals.js";
import { boundWorld } from "./bound-turn-recovery-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  reconcileAsBefore,
  replaceConversationAsBefore,
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
  const recoverType =
    g.mode === "no-turn"
      ? "recovery.no-turn.recover"
      : "recovery.pre-turn.recover";
  return {
    release: (key: string = randomUUID()) => ({
      type: "recovery.release",
      key,
      assignmentId: g.assignmentId,
      workId: g.workId,
      workRevision: g.workRevision,
      requestSequence: g.requestSequence,
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

type World = Awaited<ReturnType<typeof world>>;
const readOperation = async (w: World, type: string, key: string) => {
  const r = await w.s.bearer(
    w.ro,
    `/api/operator/operations?${new URLSearchParams({ scope: `assignment:${w.g.assignmentId}`, type, key })}`,
  );
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { data: Json }).data;
};

for (const mode of ["no-turn", "pre-turn-historical"] as const)
  test(`${mode}: receipts of retired adoption, recovery and replacement commands read back; the commands are refused`, async (t) => {
    const w = await world(t, mode);
    const c = commands(w.g);
    const turns = w.turns();
    const adoptKey = randomUUID();
    const witnessId = w.g.adoptAsBefore(adoptKey);
    const adoptType =
      mode === "no-turn" ? "recovery.no-turn.adopt" : "recovery.pre-turn.adopt";
    assert.deepEqual(await readOperation(w, adoptType, adoptKey), {
      state: "recorded",
      receipt: {
        kind: "recovery-adoption",
        key: adoptKey,
        recorded: true,
        path: mode === "no-turn" ? "no-turn-adopt" : "pre-turn-adopt",
        assignmentId: w.g.assignmentId,
        workId: w.g.workId,
        witnessId,
      },
    });
    const recover = c.recover(witnessId);
    const { type: recoverType, assignmentId: _a, ...recoverInner } = recover;
    const recovered = await reconcileAsBefore(w.s.f.service, recoverInner);
    const replace = c.replace();
    const { type: replaceType, ...replaceInner } = replace;
    replaceConversationAsBefore(w.s.f.service, replaceInner);
    const adopt = {
      type: adoptType,
      assignmentId: w.g.assignmentId,
      ...w.g.adoption(),
    };
    await w.s.restart();
    assert.deepEqual(await readOperation(w, recoverType, recover.key), {
      state: "recorded",
      receipt: {
        kind: "recovery-resolution",
        key: recover.key,
        recorded: true,
        path: mode === "no-turn" ? "no-turn-recover" : "pre-turn-recover",
        assignmentId: w.g.assignmentId,
        workId: w.g.workId,
        receiptId: recovered.id,
        state: "reconciled",
      },
    });
    assert.deepEqual(await readOperation(w, replaceType, replace.key), {
      state: "recorded",
      receipt: {
        kind: "conversation-replacement",
        key: replace.key,
        recorded: true,
        assignmentId: w.g.assignmentId,
        revision: 2,
      },
    });
    // The retired commands themselves are no longer accepted, even replaying a recorded key.
    const before = databaseDigest(w.s.f);
    for (const body of [
      adopt,
      recover,
      replace,
      c.recover(witnessId),
      c.replace(),
    ])
      assert.equal((await w.post(body)).status, 400);
    assert.equal(databaseDigest(w.s.f), before);
    assert.equal(w.turns(), turns);
  });

for (const mode of ["no-turn", "pre-turn-defect"] as const)
  test(`${mode}: release over the receipted command route replays exactly and reads back`, async (t) => {
    const w = await world(t, mode);
    const c = commands(w.g);
    const turns = w.turns();
    const release = c.release();
    const [released, again] = await Promise.all([w.ok(release), w.ok(release)]);
    assert.deepEqual(released, again);
    assert.deepEqual(released, {
      kind: "recovery-release",
      key: release.key,
      recorded: true,
      path: "release",
      assignmentId: w.g.assignmentId,
      workId: w.g.workId,
      refusalId: released.refusalId,
    });
    const after = databaseDigest(w.s.f, observations);
    assert.equal(w.turns(), turns, "release dispatches nothing");
    assert.equal(w.requestState(), "held", "the refused request stays held");
    assert.equal(
      w.s.f.service.startAgainAvailability(w.g.taskId).available,
      true,
    );
    // Altered material under the same key is refused; a new key finds it released.
    assert.equal(
      (await w.post({ ...release, workRevision: w.g.workRevision + 1 })).status,
      409,
    );
    assert.equal((await w.post(c.release())).status, 409);
    await w.s.restart();
    assert.deepEqual(await w.ok(release), released, "replays after restart");
    assert.deepEqual(await readOperation(w, "recovery.release", release.key), {
      state: "recorded",
      receipt: released,
    });
    assert.equal(databaseDigest(w.s.f, observations), after);
  });

test("an old form release payload replays its original receipt through JSON without another effect", async (t) => {
  const released = await world(t, "pre-turn-defect");
  const release = commands(released.g).release();
  const { type: _releaseType, ...releaseInner } = release;
  const original = released.s.f.service.releaseUnboundHold(
    JSON.parse(JSON.stringify(releaseInner)),
  );
  const afterRelease = databaseDigest(released.s.f);
  assert.equal((await released.ok(release)).refusalId, original.id);
  assert.equal(databaseDigest(released.s.f), afterRelease);
});

test("read-only, cross-origin and malformed recovery commands change nothing", async (t) => {
  const w = await world(t, "no-turn");
  const c = commands(w.g);
  const before = databaseDigest(w.s.f);
  for (const body of [c.release()]) {
    const r = await w.post(body, w.ro);
    assert.equal(r.status, 403);
    assert.equal((r.body.error as Json).code, "insufficient-scope");
  }
  const noCsrf = await fetch(`${w.s.origin}/api/operator/commands`, {
    method: "POST",
    headers: {
      cookie: w.s.cookie,
      origin: w.s.authOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify(c.release()),
  });
  assert.equal(noCsrf.status, 403);
  const release = c.release() as Json;
  const invalid: Json[] = [
    { ...release, extra: true },
    { ...release, workRevision: undefined },
    { ...release, requestSequence: 0 },
    { ...release, evidence: {} },
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
  const release = c.release();
  await unchanged({ ...release, assignmentId: randomUUID() }, 404);
  await unchanged({ ...release, workRevision: w.g.workRevision + 1 });
  await unchanged({ ...release, requestSequence: w.g.requestSequence + 1 });
  await unchanged({ ...release, workId: "assignment:unknown:work" });
  await w.ok(release);
  // Once released, another key finds nothing held.
  await unchanged(c.release());
});

test("bound reconciliation preserves approval material and an independent delivery admission hold", async (t) => {
  const w = await boundWorld(t, "codex", [], true);
  const { coordination } = startedOf(w.s.f.service);
  const approvals = coordination.interactions(w.g.taskId);
  assert.equal(approvals[0]?.status, "open");
  const binding = {
    projectId: w.g.projectId,
    taskId: w.g.taskId,
    assignmentId: w.g.assignmentId,
    workId: w.g.workId,
    workRevision: w.g.workRevision,
    taskVersion: Number(w.s.f.service.domain().task(w.g.taskId).version),
    assignmentVersion: Number(
      w.s.f.service.domain().assignment(w.g.assignmentId).version,
    ),
    conversationRevision: w.s.f.service.replacementFacts(w.g.assignmentId)
      .conversationRevision,
  };
  const operationId = randomUUID();
  const action: DeliveryActionRecord = {
    operationId,
    binding,
    policyVersion: 1,
    state: "uncertain",
    attempts: 1,
    request: {
      operationId,
      action: {
        kind: "issue.status",
        target: {
          repositoryId: "fixture-project",
          nodeId: "fixture-issue",
          number: 1,
        },
        statusId: "done",
        expected: { statusId: "open" },
      },
    },
    beforeState: null,
    observation: null,
    createdAt: 1,
    updatedAt: 1,
  };
  w.s.f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO delivery_actions (operationId,taskId,materialHash,recordJson) VALUES (?,?,'fixture',?)",
      )
      .run(operationId, w.g.taskId, JSON.stringify(action)),
  );
  await w.reconcile();
  await w.s.restart();
  assert.deepEqual(
    startedOf(w.s.f.service).coordination.interactions(w.g.taskId),
    approvals,
  );
  let retained!: DeliveryActionRecord;
  w.s.f.seedPersistedState((db) => {
    retained = new DeliveryStore(db).action(operationId);
  });
  assert.equal(retained.state, "uncertain");
  assert.equal(retained.attempts, 1);
  assert.deepEqual(retained.request, action.request);
  assert.deepEqual(retained.binding, action.binding);
  assert.ok(
    w.s.f.service
      .domain()
      .admission(w.g.taskId)
      .reasons.includes("external-action-uncertain"),
  );
  assert.equal(w.runtime.turnInvocations.length, 1);
});
