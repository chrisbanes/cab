import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "./fixtures/database-digest.js";
import { startCliOperator } from "./fixtures/operator-cli.js";
import { startOwnWork } from "./fixtures/questions.js";

type Operator = Awaited<ReturnType<typeof startCliOperator>>;
const stopped = (o: Operator, taskId: string) =>
  o.s.f.service.isTaskStopped(taskId);

test("task stop requests best-effort cancellation without a pre-read", async (t) => {
  const o = await startCliOperator(t);
  const { a } = await startOwnWork(o.s.f, "Running", "Running project");
  let r = await o.h.run(["task", "stop", a.taskId, "--connection", "rw"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Effect:\s+cancellation-requested/);
  assert.match(r.out, /best-effort cancellation: new turns are held/);
  r = await o.cli("rw", ["task", "get", a.taskId]);
  assert.equal(r.json().data.execution.holds.stop, true);
  assert.ok(
    ["stopping", "uncertain", "paused"].includes(r.json().data.execution.state),
  );

  // Idle task: nothing to cancel, the hold is saved.
  r = await o.cli("rw", ["task", "stop", o.s.taskId]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(
    {
      cancellationRequested: r.json().data.receipt.cancellationRequested,
      effect: r.json().data.effect,
      stopInEffect: r.json().data.stopInEffect,
    },
    { cancellationRequested: 0, effect: "saved", stopInEffect: true },
  );
  await o.s.f.service.resumeTask(o.s.taskId);

  // A failing task read never blocks a Stop.
  r = await o.cli("rw", ["task", "stop", o.s.taskId], {
    fetch: async (input, init) => {
      if (String(input).includes("/api/operator/tasks/"))
        return new Response("{}", { status: 503 });
      return fetch(input, init);
    },
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.stopInEffect, null);
  assert.equal(stopped(o, o.s.taskId), true);
});

test("task resume clears only the operator Stop and reports what remains", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d } = o;
  let r = await cli("rw", ["task", "resume", s.taskId]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.effect, "none");
  assert.equal(r.json().data.receipt.stopCleared, false);

  await s.f.service.stopTask(s.taskId);
  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Fixture ambiguity')",
      )
      .run(s.taskId),
  );
  r = await o.h.run(["task", "resume", s.taskId, "--connection", "rw"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Resume cleared only the operator Stop/);
  assert.match(r.out, /No work started: still held by/);
  assert.equal(stopped(o, s.taskId), false);
  assert.equal(s.f.service.taskHold(s.taskId), "Fixture ambiguity");
  s.f.seedPersistedState((db) =>
    db
      .prepare("DELETE FROM task_writer_ambiguity_holds WHERE taskId = ?")
      .run(s.taskId),
  );

  // Optional version fence, unknown task and read-only denial.
  const version = Number(d.task(s.taskId).version);
  r = await cli("rw", [
    "task",
    "stop",
    s.taskId,
    "--expected-version",
    String(version + 1),
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(stopped(o, s.taskId), false);
  r = await cli("rw", [
    "task",
    "stop",
    s.taskId,
    "--expected-version",
    String(version),
  ]);
  assert.equal(r.code, 0, r.out);
  r = await cli("rw", ["task", "resume", randomUUID()]);
  assert.equal(r.code, 2, r.out);
  const digest = databaseDigest(s.f);
  for (const verb of ["stop", "resume"]) {
    r = await cli("ro", ["task", verb, s.taskId]);
    assert.equal(r.code, 3);
  }
  assert.equal(databaseDigest(s.f), digest);
});

test("repeated and replayed Stop and Resume follow the unresolved-key rule", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, lostReply } = o;
  for (const [verb, expected] of [
    ["stop", true],
    ["resume", false],
    ["stop", true],
    ["resume", false],
  ] as const) {
    const r = await cli("rw", ["task", verb, s.taskId]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.json().data.reusedRequest, false);
    assert.equal(stopped(o, s.taskId), expected, verb);
  }

  // A Stop whose reply was lost, a Resume through the retained form, then `task stop`.
  let r = await cli("rw", ["task", "stop", s.taskId], { fetch: lostReply });
  assert.equal(r.code, 6, r.out);
  assert.doesNotMatch(r.json().error.message, /operation get/);
  const form = await s.sessionForm("/runtime/control/resume", {
    taskId: s.taskId,
  });
  assert.equal(form.status, 303);
  assert.equal(stopped(o, s.taskId), false);
  r = await o.h.run([
    "task",
    "stop",
    s.taskId,
    "--connection",
    "rw",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(r.json().data.stopInEffect, false);
  const human = await o.h.run([
    "task",
    "stop",
    s.taskId,
    "--connection",
    "rw",
    "--request-id",
    r.json().request.key,
  ]);
  assert.match(human.out, /Stop is not in effect.*new --request-id/s);
  r = await cli("rw", ["task", "stop", s.taskId, "--request-id", randomUUID()]);
  assert.equal(r.json().data.stopInEffect, true);
  assert.equal(stopped(o, s.taskId), true);

  // The mirror: a lost Resume, a retained Stop, then `task resume`.
  r = await cli("rw", ["task", "resume", s.taskId], { fetch: lostReply });
  assert.equal(r.code, 6);
  assert.equal(
    (await s.sessionForm("/runtime/control/stop", { taskId: s.taskId })).status,
    303,
  );
  r = await cli("rw", ["task", "resume", s.taskId]);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(r.json().data.stopInEffect, true);
  assert.equal(stopped(o, s.taskId), true);
});

test("CLI and retained forms share the Stop hold and the session projection", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s } = o;
  assert.equal(
    (await s.sessionForm("/runtime/control/stop", { taskId: s.taskId })).status,
    303,
  );
  let r = await cli("rw", ["task", "resume", s.taskId]);
  assert.equal(r.json().data.receipt.stopCleared, true);
  r = await cli("rw", ["task", "stop", s.taskId]);
  const session = (await (
    await s.sessionGet(`/api/operator/tasks/${s.taskId}`)
  ).json()) as {
    data: { execution: { holds: unknown } };
  };
  r = await cli("rw", ["task", "get", s.taskId]);
  assert.deepEqual(r.json().data.execution.holds, session.data.execution.holds);
  assert.equal(
    (await s.sessionForm("/runtime/control/resume", { taskId: s.taskId }))
      .status,
    303,
  );
  assert.equal(stopped(o, s.taskId), false);
  await cli("rw", ["task", "stop", s.taskId]);
  await s.f.service.resumeTask(s.taskId);
  assert.equal(stopped(o, s.taskId), false);
});
