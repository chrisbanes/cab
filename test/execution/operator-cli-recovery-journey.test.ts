import { boundWorld } from "./bound-turn-recovery-fixture.js";
import { startedOf } from "../fixtures/service-internals.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { assignmentRecoverySchema } from "../../src/operator/contracts.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  cliGeneration,
  type GenerationMode,
  NoTurnRuntime,
} from "../fixtures/recovery-generations.js";
import { until } from "../fixtures/until.js";

type World = Awaited<ReturnType<typeof cliGeneration>>;
const turns = (w: World) =>
  w.runtime instanceof NoTurnRuntime
    ? w.runtime.turnInvocations.length
    : w.runtime.turns;
const requestState = (w: World) =>
  w.s.f.service.turnRequests().find((r) => r.workId === w.g.workId)?.state;

async function prepare(
  w: World,
  path: string,
  extra: string[],
  connection: "ro" | "rw" = "ro",
) {
  const file = join(w.h.dir, `${randomUUID()}.json`);
  const r = await w.cli(connection, [
    "recovery",
    "prepare",
    path,
    w.g.assignmentId,
    "--out",
    file,
    ...extra,
  ]);
  assert.equal(r.code, 0, `${path}: ${r.err}${r.out}`);
  return file;
}
const submit = (w: World, file: string, connection: "ro" | "rw" = "rw") =>
  w.cli(connection, ["recovery", "submit", "--file", file]);
const sessionRecovery = async (w: World) =>
  assignmentRecoverySchema.parse(
    await (
      await w.s.sessionGet(
        `/api/operator/assignments/${w.g.assignmentId}/recovery`,
      )
    ).json(),
  ).data;

for (const mode of [
  "no-turn",
  "pre-turn-historical",
  "pre-turn-runtime",
] as const satisfies readonly GenerationMode[])
  test(`${mode}: inspect, adopt, fail closed, recover, replace, then only a new message admits work`, async (t) => {
    const w = await cliGeneration(t, mode);
    const start = turns(w);
    let r = await w.cli("ro", ["recovery", "get", w.g.assignmentId]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().data.held, true);
    const adoptPath = mode === "no-turn" ? "no-turn-adopt" : "pre-turn-adopt";
    const recoverPath =
      mode === "no-turn" ? "no-turn-recover" : "pre-turn-recover";
    if (mode !== "pre-turn-runtime") {
      const adopt = await prepare(w, adoptPath, [
        "--work",
        w.g.workId,
        "--evidence-file",
        w.evidenceFile(w.g.adoptionEvidence()),
      ]);
      r = await submit(w, adopt);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.json().data.effect, "saved");
      // The retained UI read sees the witness the CLI recorded.
      const ui = await sessionRecovery(w);
      const record = ui.records.find((x) => x.workId === w.g.workId);
      assert.equal(
        record?.noTurnSubmission?.id ?? record?.preTurnRejection?.id,
        r.json().data.receipt.witnessId,
      );
      // Restart and resubmission replay the same receipt.
      await w.s.restart();
      const replay = await submit(w, adopt);
      assert.equal(replay.code, 0, replay.err);
      assert.deepEqual(replay.json().data.receipt, r.json().data.receipt);
    }
    const recover = await prepare(w, recoverPath, [
      "--work",
      w.g.workId,
      "--evidence-file",
      w.evidenceFile(w.receiptEvidence),
    ]);
    w.verifier.set("unknown");
    r = await submit(w, recover);
    assert.equal(r.code, 4);
    assert.match(r.json().error.message, /termination-unknown/);
    const held = w.s.f.service
      .recoveryForTask(w.g.taskId)
      .find((x) => x.workId === w.g.workId);
    assert.ok(held?.holds.writer && held.holds.capacity, "holds intact");
    // Resume clears only an operator Stop; it never releases recovery holds.
    r = await w.cli("rw", ["task", "resume", w.g.taskId]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().data.effect, "none");
    assert.equal(requestState(w), "held");
    assert.equal(turns(w), start);

    w.verifier.set("verified");
    r = await submit(w, recover);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().data.effect, "completed");
    assert.equal(requestState(w), "held", "recovery leaves the request held");

    if (w.runtime instanceof NoTurnRuntime) w.runtime.rejectStart = false;
    else {
      w.runtime.rejectResume = false;
      w.runtime.resumeError = undefined;
    }
    const replace = await prepare(w, "conversation-replace", [
      "--expected-version",
      "1",
      "--expected-conversation-revision",
      "1",
    ]);
    r = await submit(w, replace);
    assert.equal(r.code, 0, r.err);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(turns(w), start, "replacement dispatches nothing");
    r = await w.cli("rw", [
      "task",
      "message",
      w.g.taskId,
      "--to",
      w.g.assignmentId,
      "--expected-version",
      "1",
      "--message-file",
      w.file("message.txt", "Continue with fresh work."),
    ]);
    assert.equal(r.code, 0, r.err);
    await until(() => turns(w) > start, "new message admits work");
  });

test("concurrent, stale and read-only submissions apply at most once", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const evidence = w.evidenceFile(w.g.adoptionEvidence());
  const adopt = await prepare(w, "no-turn-adopt", [
    "--work",
    w.g.workId,
    "--evidence-file",
    evidence,
  ]);
  // Read-only: prepare is allowed, submit is refused and nothing changes.
  const before = databaseDigest(w.s.f);
  let r = await submit(w, adopt, "ro");
  assert.equal(r.code, 3);
  assert.equal(databaseDigest(w.s.f), before);

  // A document prepared before a separate JSON command acted is refused.
  await w.s.sessionPost("/api/operator/commands", {
    type: "recovery.no-turn.adopt",
    assignmentId: w.g.assignmentId,
    ...w.g.adoption(),
  });
  const witness = w.g.witnessId();
  r = await submit(w, adopt);
  assert.equal(r.code, 4);
  assert.equal(w.g.witnessId(), witness, "nothing applied");

  // Two concurrent submissions of one recovery settle exactly once.
  const recover = await prepare(w, "no-turn-recover", [
    "--work",
    w.g.workId,
    "--evidence-file",
    w.evidenceFile(w.receiptEvidence),
  ]);
  const results = await Promise.all([submit(w, recover), submit(w, recover)]);
  assert.ok(results.some((x) => x.code === 0));
  for (const x of results) assert.ok([0, 4].includes(x.code), x.out);
  const receipts = new Set(
    results
      .filter((x) => x.code === 0)
      .map((x) => x.json().data.receipt.receiptId),
  );
  assert.equal(receipts.size, 1);
});

for (const harness of ["codex", "claude"] as const)
  test(`${harness}: bound CLI recovery replays and only explicit allowed continuation resumes the existing conversation`, async (t) => {
    const w = await boundWorld(t, harness, [], false, true);
    const start = w.runtime.turnInvocations.length;
    const resumedBefore = w.runtime.resumed.length;
    const c = await w.cli();
    const evidence = c.file(
      "bound-evidence.json",
      JSON.stringify({
        schema: "cab.cli.recovery-evidence/v1",
        receipt: {
          termination: { kind: "process-exit" },
          effects: "settled",
          workspace: "preserved",
        },
      }),
    );
    const document = join(c.h.dir, "bound-recovery.json");
    w.setMode("live");
    let result = await c.cli("ro", ["recovery", "get", w.g.assignmentId]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /termination-live/);
    result = await c.cli("ro", [
      "recovery",
      "prepare",
      "bound-turn-recover",
      w.g.assignmentId,
      "--work",
      w.g.workId,
      "--evidence-file",
      evidence,
      "--out",
      document,
    ]);
    assert.equal(result.code, 4);
    w.setMode("verified");
    result = await c.cli("ro", [
      "recovery",
      "prepare",
      "bound-turn-recover",
      w.g.assignmentId,
      "--work",
      w.g.workId,
      "--evidence-file",
      evidence,
      "--out",
      document,
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.out, /cannot be undone/);
    await w.s.f.service.stopTask(w.g.taskId);
    const pause = (paused: boolean) =>
      w.command({
        type: "project.configure",
        projectId: w.g.projectId,
        expectedVersion: Number(
          w.s.f.service.domain().project(w.g.projectId).version,
        ),
        paused,
      });
    pause(true);
    result = await c.cli("ro", ["recovery", "submit", "--file", document]);
    assert.notEqual(result.code, 0, "read credential cannot recover");
    result = await c.cli("rw", ["recovery", "submit", "--file", document]);
    assert.equal(result.code, 0, result.err + result.out);
    const receipt = result.json().data.receipt;
    assert.equal(receipt.path, "bound-turn-recover");
    const human = await c.h.run([
      "recovery",
      "submit",
      "--file",
      document,
      "--connection",
      "rw",
    ]);
    assert.equal(human.code, 0, human.err);
    assert.match(human.out, /Not resumed; nothing was dispatched/);
    assert.doesNotMatch(human.out, /needs conversation replacement/);
    assert.equal(w.s.f.service.isTaskStopped(w.g.taskId), true);
    assert.equal(
      Boolean(w.s.f.service.domain().project(w.g.projectId).paused),
      true,
    );
    assert.equal(w.runtime.turnInvocations.length, start);
    w.setMode("unknown");
    const checks = w.checks();
    await w.s.restart();
    result = await c.cli("rw", ["recovery", "submit", "--file", document]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.deepEqual(result.json().data.receipt, receipt);
    assert.equal(
      w.checks(),
      checks,
      "restart replay does not need process evidence again",
    );
    result = await c.cli("rw", ["task", "resume", w.g.taskId]);
    assert.equal(result.code, 0, result.err);
    assert.equal(
      Boolean(w.s.f.service.domain().project(w.g.projectId).paused),
      true,
    );
    assert.equal(w.runtime.turnInvocations.length, start);
    pause(false);
    await startedOf(w.s.f.service).scheduler.wake();
    assert.equal(
      w.runtime.turnInvocations.length,
      start,
      "clearing holds alone sends no continuation",
    );
    w.runtime.complete = true;
    result = await c.cli("rw", [
      "task",
      "message",
      w.g.taskId,
      "--to",
      w.g.assignmentId,
      "--expected-version",
      String(w.s.f.service.domain().assignment(w.g.assignmentId).version),
      "--message-file",
      c.file("continue.txt", "Explicitly continue this conversation."),
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    await until(
      () => w.runtime.turnInvocations.length === start + 1,
      "one explicit continuation",
    );
    assert.deepEqual(w.runtime.resumed.slice(resumedBefore), [w.g.threadId]);
  });
