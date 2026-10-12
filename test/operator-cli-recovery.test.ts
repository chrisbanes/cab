import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { recoveryRequirements } from "../src/core/recovery-contracts.js";
import { fakeServer, harness } from "./fixtures/cli-harness.js";
import { databaseDigest } from "./fixtures/database-digest.js";
import { seedOperatorRecovery } from "./fixtures/operator-web.js";
import { cliGeneration } from "./fixtures/recovery-generations.js";

test("recovery get shows identity, holds, paths and required inputs on both credentials", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const before = databaseDigest(w.s.f);
  for (const connection of ["ro", "rw"] as const) {
    const r = await w.cli(connection, ["recovery", "get", w.g.assignmentId]);
    assert.equal(r.code, 0, r.err);
    const out = r.json();
    assert.equal(out.data.assignmentId, w.g.assignmentId);
    assert.deepEqual(out.data.requirements, recoveryRequirements);
    const record = out.data.records.find(
      (x: { workId: string }) => x.workId === w.g.workId,
    );
    assert.deepEqual(record.process, w.g.processIdentity);
    assert.equal(record.retainedReason, w.g.retainedReason);
    assert.deepEqual(out.coverage.gaps, []);
    assert.equal(out.coverage.complete, true);
  }
  const human = await w.h.run([
    "recovery",
    "get",
    w.g.assignmentId,
    "--connection",
    "ro",
  ]);
  assert.equal(human.code, 0, human.err);
  for (const text of [
    `Work: +${w.g.workId}`,
    `Process: +${w.g.processIdentity.processId} started`,
    "Reason: +Runtime submission or observation uncertain: Error: Runtime stopped",
    "no-turn-adopt +yes +- +evidence: frozenSourceRevision",
    "no-turn-recover +no +witness-missing +receipt: termination, effects, workspace",
    "attestations \\(each true\\): completeSynchronousWriteAheadLedger",
    "Replacement: +blocked by unresolved-execution",
    "there is no force unlock",
    "cannot be undone",
  ])
    assert.match(human.out, new RegExp(text), text);
  assert.equal(databaseDigest(w.s.f), before);

  // assignment get points to recovery only while the assignment is held.
  const a = await w.h.run([
    "assignment",
    "get",
    w.g.assignmentId,
    "--connection",
    "ro",
  ]);
  assert.match(
    a.out,
    new RegExp(`Recovery: ensemble recovery get ${w.g.assignmentId}`),
  );
  const unknown = await w.cli("ro", ["recovery", "get", randomUUID()]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.json().error.code, "not-found");
});

test("recovery get reports omitted, redacted, unavailable and missing evidence as gaps", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const ids = {
    taskId: w.g.taskId,
    assignmentId: w.g.assignmentId,
    projectId: w.g.projectId,
  };
  w.s.f.service.domain().execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: w.g.profileId,
    expectedVersion: Number(
      w.s.f.service.domain().profile(w.g.profileId).version,
    ),
    instructions: "Runtime stopped",
  } as never);
  let r = await w.cli("ro", ["recovery", "get", w.g.assignmentId]);
  assert.ok(r.json().coverage.gaps.includes("content-redacted"));
  seedOperatorRecovery(w.s.f, ids, 20);
  r = await w.cli("ro", ["recovery", "get", w.g.assignmentId]);
  assert.ok(r.json().coverage.gaps.includes("item-omitted"));
  // A retained generation bound to an unknown assignment makes redaction unavailable.
  w.s.f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,'foreign-generation','p','/w','completed',NULL,NULL,NULL,'chatgpt','workspaceWrite','never')",
    ).run(randomUUID());
    db.prepare(
      "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence,processId,processStartedAt,bootId,threadId,turnId) VALUES ('foreign-generation',1,999,'p','s','b',NULL,NULL)",
    ).run();
    db.prepare(
      "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES ('foreign-generation',?,?,1,1,1,1)",
    ).run(ids.taskId, randomUUID());
  });
  r = await w.cli("ro", ["recovery", "get", w.g.assignmentId]);
  assert.ok(r.json().coverage.gaps.includes("redaction-unavailable"));
  const human = await w.h.run([
    "recovery",
    "get",
    w.g.assignmentId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Gap: redaction-unavailable/);
  assert.match(human.out, /\(withheld\)/);

  // An assignment with no recorded generations reports missing evidence.
  const d = w.s.f.service.domain();
  const taskId = randomUUID();
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId: w.g.projectId,
    taskId,
    title: "Quiet",
    outcome: "No execution",
    ready: false,
  } as never);
  const assignmentId = randomUUID();
  d.execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId: w.g.projectId,
    taskId,
    assignmentId,
    profileId: w.g.profileId,
    brief: "Quiet work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  } as never);
  r = await w.cli("ro", ["recovery", "get", assignmentId]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.json().coverage.gaps.includes("evidence-unavailable"));
  const quiet = await w.h.run([
    "assignment",
    "get",
    assignmentId,
    "--connection",
    "ro",
  ]);
  assert.doesNotMatch(quiet.out, /Recovery:/);
});

test("a service without recovery capabilities is unsupported after identity only", async (t) => {
  const h = harness(t);
  const fake = await fakeServer(t, (_q, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        apiVersion: 1,
        capabilities: ["cli.identity", "assignment.read"],
        service: {
          installationId: randomUUID(),
          origin: "https://ensemble.example",
        },
        credential: {
          id: randomUUID(),
          name: "fake",
          scope: "read-write",
          createdAt: 1,
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    ),
  );
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "fake",
    "--url",
    fake.origin,
    "--token-file",
    h.tokenFile(`ens_${randomUUID()}_${"a".repeat(43)}`),
  ]);
  assert.equal(login.code, 0, login.err);
  const seen = fake.hits.length;
  const r = await h.run(["recovery", "get", randomUUID(), "--output", "json"]);
  assert.equal(r.code, 7);
  assert.equal(r.json().error.code, "unsupported-service");
  assert.equal(fake.hits.length, seen + 1);
});
