import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { configure } from "../fixtures/completed-lead.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  failReadAfterPost,
  startCliOperator,
} from "../fixtures/operator-cli.js";
import { startOwnWork } from "../fixtures/questions.js";
import { seedReviewTask } from "../fixtures/task-review.js";

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

test("task stop refuses a Done task, and task resume still clears its Stop", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s } = o;
  s.f.seedPersistedState((db) => {
    db.prepare("UPDATE domain_tasks SET state = 'done' WHERE id = ?").run(
      s.taskId,
    );
  });
  const digest = databaseDigest(s.f);
  let r = await cli("rw", ["task", "stop", s.taskId]);
  assert.equal(r.code, 4, r.out);
  assert.match(
    r.err + r.out,
    /Only an open task can be stopped\. This task is Done\./,
  );
  assert.equal(databaseDigest(s.f), digest);
  assert.equal(stopped(o, s.taskId), false);

  s.f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
    ).run(s.taskId);
  });
  r = await cli("rw", ["task", "get", s.taskId]);
  assert.equal(r.json().data.execution.holds.stop, true);
  r = await cli("rw", ["task", "resume", s.taskId]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.receipt.stopCleared, true);
  assert.equal(stopped(o, s.taskId), false);
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
  assert.match(r.out, /No work started; still held: Task hold\./);
  assert.equal(stopped(o, s.taskId), false);
  assert.equal(s.f.service.taskHold(s.taskId), "Fixture ambiguity");
  // A fresh Stop alongside another hold is reported as in effect.
  r = await cli("rw", ["task", "stop", s.taskId]);
  assert.equal(r.json().data.stopInEffect, true);
  assert.equal(stopped(o, s.taskId), true);
  // The ambiguity stays visible as uncertain execution beside the Stop.
  const listed = (await (
    await s.sessionGet(`/api/operator/task-list?projectId=${s.projectId}`)
  ).json()) as {
    data: { tasks: { id: string; attention: { codes: string[] } }[] };
  };
  assert.ok(
    listed.data.tasks
      .find((x) => x.id === s.taskId)
      ?.attention.codes.includes("execution-uncertain"),
  );
  assert.equal((await cli("rw", ["task", "resume", s.taskId])).code, 0);
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

test("stop and resume with a stale expected version name the current version", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  const current = Number(
    (await o.cli("rw", ["task", "get", s.taskId])).json().data.task.version,
  );
  for (const verb of ["stop", "resume"]) {
    const args = [
      "task",
      verb,
      s.taskId,
      "--expected-version",
      String(current + 5),
      "--connection",
      "rw",
    ];
    const human = await o.h.run(args);
    assert.equal(human.code, 4, `${verb}: ${human.err}`);
    assert.match(
      human.err,
      new RegExp(
        `Task ${s.taskId} is at version ${current}, not ${current + 5}\\.`,
      ),
    );
    const fix = human.err.match(/^Fix: (.*)$/m)?.[1] ?? "";
    assert.match(fix, new RegExp(`ensemble task get ${s.taskId}`));
    assert.match(fix, new RegExp(`--expected-version ${current}\\b`));
    const json = await o.h.run([...args, "--output", "json"]);
    assert.equal(json.code, 4);
    assert.equal(json.json().error.code, "conflict");
    assert.equal(json.json().error.outcome, "not-applied");
    assert.equal(json.json().error.request.type, `task.${verb}`);
  }
  assert.equal(stopped(o, s.taskId), false);
});

const waitBlock = (text: string) => {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^Waiting: \S/.test(l));
  if (first < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(first)) {
    if (!/^Waiting: \S/.test(line) && !line.startsWith("  ")) break;
    block.push(line);
  }
  return block;
};
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1);

/** A task read whose execution also reports the ownership holds, as a held generation would. */
const withOwnershipHolds: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (
    (init?.method ?? "GET") !== "GET" ||
    !/\/api\/operator\/tasks\/[0-9a-f-]{36}$/.test(String(input))
  )
    return response;
  const body = (await response.json()) as {
    data: { execution: { holds: Record<string, boolean> } };
  };
  Object.assign(body.data.execution.holds, {
    writer: true,
    capacity: true,
    uncertainty: true,
  });
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};
const cells = (line: string | undefined) => (line ?? "").trim().split(/ {2,}/);

test("task stop and resume print hold labels, not hold codes", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  const line = (out: string, label: string) =>
    out.split("\n").find((l) => l.startsWith(`${label}:`));
  let r = await o.h.run(["task", "stop", s.taskId, "--connection", "rw"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cells(line(r.out, "Holds")), ["Holds:", "Stop requested"]);
  const data = (await o.cli("ro", ["task", "get", s.taskId])).json().data;
  assert.equal(data.execution.holds.stop, true);

  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Fixture ambiguity')",
      )
      .run(s.taskId),
  );
  r = await o.h.run(["task", "resume", s.taskId, "--connection", "rw"], {
    fetch: withOwnershipHolds,
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cells(line(r.out, "Holds")), [
    "Holds:",
    "Task hold, Ownership held",
  ]);
  assert.ok(
    r.out.includes("No work started; still held: Task hold, Ownership held.\n"),
    r.out,
  );
  assert.doesNotMatch(r.out, /\b(writer|capacity|uncertainty)\b/i);
  // JSON keeps the three separate flags.
  const json = await o.cli("ro", ["task", "get", s.taskId], {
    fetch: withOwnershipHolds,
  });
  assert.deepEqual(json.json().data.execution.holds, {
    stop: false,
    writer: true,
    capacity: true,
    uncertainty: true,
    task: true,
  });
});

test("a replayed resume while Stop is in effect does not report a task hold", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  const key = randomUUID();
  const run = (verb: "stop" | "resume", args: string[] = []) =>
    o.h.run(["task", verb, s.taskId, ...args, "--connection", "rw"]);
  assert.equal((await run("stop")).code, 0);
  assert.equal((await run("resume", ["--request-id", key])).code, 0);
  assert.equal((await run("stop")).code, 0);
  const replay = await run("resume", ["--request-id", key]);
  assert.equal(replay.code, 0, replay.err);
  assert.ok(replay.out.includes("Stop is in effect"), replay.out);
  assert.deepEqual(
    cells(replay.out.split("\n").find((l) => l.startsWith("Holds:"))),
    ["Holds:", "Stop requested"],
  );
  assert.doesNotMatch(replay.out, /still held/);
});

test("task resume with remaining holds prints the task's wait lines or Next", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  await s.f.service.stopTask(s.taskId);
  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Fixture ambiguity')",
      )
      .run(s.taskId),
  );
  const resumed = await o.h.run([
    "task",
    "resume",
    s.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /No work started; still held: Task hold\./);
  const got = await o.h.run(["task", "get", s.taskId, "--connection", "ro"]);
  const expected = waitBlock(got.out);
  assert.ok(expected.length >= 4, got.out);
  assert.deepEqual(waitBlock(resumed.out), expected);
  assert.equal(
    lastLine(resumed.out),
    expected.at(-1),
    "the task's wait lines come last",
  );
  assert.doesNotMatch(resumed.out, /^Next:/m);
  // The JSON data keeps its shape.
  await s.f.service.stopTask(s.taskId);
  const json = await o.cli("rw", ["task", "resume", s.taskId]);
  assert.deepEqual(Object.keys(json.json().data).sort(), [
    "effect",
    "receipt",
    "reusedRequest",
    "stopInEffect",
  ]);
});

test("task resume whose post-read fails names task get", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  await s.f.service.stopTask(s.taskId);
  const resumed = await o.h.run(
    ["task", "resume", s.taskId, "--connection", "rw"],
    { fetch: failReadAfterPost() },
  );
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /Requeued:/);
  assert.equal(lastLine(resumed.out), `Next: ensemble task get ${s.taskId}`);
  assert.equal(stopped(o, s.taskId), false, "the Stop was cleared");
});

test("task resume with no Stop in effect prints no contradicting Next", async (t) => {
  const o = await startCliOperator(t);
  const project = await seedReviewTask(o.s.f, "Open project", "Open task");
  configure(o.s.f, project.projectId, false);
  const resumed = await o.h.run([
    "task",
    "resume",
    project.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /Effect:\s+none/);
  assert.match(
    resumed.out,
    /No operator Stop was in effect; nothing changed\./,
  );
  assert.doesNotMatch(resumed.out, /Resume cleared|No work started/);
  assert.equal(
    lastLine(resumed.out),
    `Next: ensemble task get ${project.taskId}`,
  );
  assert.doesNotMatch(resumed.out, /^Next: .*resume/m);
});
