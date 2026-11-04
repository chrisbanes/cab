import {
  DeliveryStore,
  type DeliveryActionRecord,
} from "../../src/core/delivery.js";
import { startedOf } from "../fixtures/service-internals.js";
import { boundWorld } from "./bound-turn-recovery-fixture.js";
import { until } from "../fixtures/until.js";
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

test("old form payloads replay their original recovery receipts through JSON without another effect", async (t) => {
  const w = await world(t, "no-turn");
  const c = commands(w.g);
  const adopt = c.adopt();
  const { type: _type, assignmentId: _assignment, ...inner } = adopt;
  const originalAdoption = w.s.f.service.adoptHistoricalNoTurnSubmission(
    JSON.parse(JSON.stringify(inner)),
  );
  const adopted = databaseDigest(w.s.f);
  const receipt = await w.ok(adopt);
  assert.equal(receipt.witnessId, originalAdoption.witnessId);
  assert.equal(databaseDigest(w.s.f), adopted);
  const recover = c.recover();
  const {
    type: _recoverType,
    assignmentId: _recoverAssignment,
    ...recoverInner
  } = recover;
  const originalRecovery = await w.s.f.service.recoverNoTurnExecution(
    JSON.parse(JSON.stringify(recoverInner)),
  );
  const recovered = databaseDigest(w.s.f);
  const replayed = await w.ok(recover);
  assert.equal(replayed.receiptId, originalRecovery.id);
  assert.equal(databaseDigest(w.s.f), recovered);
  const replace = c.replace();
  const { type: _replaceType, ...replaceInner } = replace;
  const originalReplacement =
    w.s.f.service.replaceConversationCommand(replaceInner);
  const replaced = databaseDigest(w.s.f);
  assert.equal((await w.ok(replace)).revision, originalReplacement.revision);
  assert.equal(databaseDigest(w.s.f), replaced);
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

for (const harness of ["codex", "claude"] as const)
  test(`${harness} bound recovery serializes identical submissions and replays before liveness`, async (t) => {
    const w = await boundWorld(t, harness);
    const rw = (await w.s.issue("read-write", "bound-commands")).token;
    const ro = (await w.s.issue("read", "bound-ro")).token;
    const command = { type: "recovery.bound-turn.recover", ...w.recovery() };
    const post = async (body: unknown, token = rw) => {
      const response = await w.s.bearer(token, "/api/operator/commands", {
        method: "POST",
        body,
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post(command, ro)).status, 403);
    let release!: () => void;
    w.setGate(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = post(command);
    await until(() => w.checks() === 1, "first bound verification");
    const second = post(command);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      w.checks(),
      1,
      "identical concurrent requests share verification",
    );
    assert.equal(
      (
        await post({
          ...command,
          receipt: { ...command.receipt, workspace: "reconciled" },
        })
      ).status,
      409,
    );
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(one, two);
    assert.equal(one.body.path, "bound-turn-recover");
    const session = await w.s.sessionPost("/api/operator/commands", command);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), one.body);
    assert.equal(
      w.runtime.turnInvocations.length,
      1,
      "reconciliation starts no turn",
    );
    assert.equal(w.s.f.service.turnRequest(w.g.workId)?.state, "held");
    w.setGate(undefined);
    w.setMode("unknown");
    const count = w.checks();
    assert.deepEqual(await post(command), one);
    assert.equal(
      w.checks(),
      count,
      "durable replay precedes termination verification",
    );
    await w.s.restart();
    assert.deepEqual(await post(command), one);
    assert.equal(w.checks(), count);
    assert.equal(
      (
        await post({
          ...command,
          receipt: { ...command.receipt, workspace: "reconciled" },
        })
      ).status,
      409,
    );
    const noTurn = {
      ...command,
      type: "recovery.no-turn.recover",
      receipt: {
        ...command.receipt,
        kind: "no-turn-submission",
        witnessId: randomUUID(),
        threadId: null,
        turnId: null,
      },
    };
    assert.equal(
      (await post(noTurn)).status,
      409,
      "key cannot cross recovery scope",
    );
    assert.equal(w.checks(), count);
    w.s.f.seedPersistedState((db) => {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM execution_recovery_receipts WHERE workId=?",
          )
          .get(w.g.workId)?.n,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT scope FROM execution_pre_turn_commands WHERE commandKey=?",
          )
          .get(command.key)?.scope,
        "recover-bound-turn",
      );
    });
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
  await w.s.f.service.recoverBoundTurnExecution(w.recovery());
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
