import assert from "node:assert/strict";
import { test } from "node:test";
import { startCliOperator } from "../fixtures/operator-cli.js";

test("task allowance takes exactly one of --total or --remove and a non-negative version", async (t) => {
  const { cli, s } = await startCliOperator(t);
  for (const [args, message] of [
    [["--expected-version", "0"], /exactly one of --total N or --remove/],
    [
      ["--total", "2", "--remove", "--expected-version", "0"],
      /exactly one of --total N or --remove/,
    ],
    [
      ["--total=-1", "--expected-version", "0"],
      /--total must be a non-negative/,
    ],
    [["--total", "2"], /--expected-version N is required/],
  ] as const) {
    const r = await cli("rw", ["task", "allowance", s.taskId, ...args]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.err + r.out, message);
  }
  assert.equal(s.f.service.taskAllowance(s.taskId).version, 0);
});

test("task allowance sets and removes the total, and task get renders it", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s } = o;
  const set = await o.h.run([
    "task",
    "allowance",
    s.taskId,
    "--total",
    "0",
    "--expected-version",
    "0",
    "--connection",
    "rw",
  ]);
  assert.equal(set.code, 0, set.err + set.out);
  assert.match(set.out, /Set the execution allowance/);
  assert.match(set.out, /Total:\s+0/);
  assert.match(set.out, /Remaining:\s+0/);
  assert.match(set.out, /admitted work continues/);
  assert.match(
    set.out,
    /Direct work and project drafting runs are not charged/,
  );

  const read = await o.h.run(["task", "get", s.taskId, "--connection", "rw"]);
  assert.match(
    read.out,
    /Allowance: 0 of 0 charged, 0 remaining \(version 1; Direct work and project drafting runs are not charged to a task\.\)/,
  );

  // A stale allowance version names the current one.
  let r = await cli("rw", [
    "task",
    "allowance",
    s.taskId,
    "--total",
    "3",
    "--expected-version",
    "0",
  ]);
  assert.notEqual(r.code, 0);
  assert.equal(r.json().error.code, "conflict");
  assert.match(r.json().error.message, /allowance is at version 1, not 0/);

  r = await cli("rw", [
    "task",
    "allowance",
    s.taskId,
    "--remove",
    "--expected-version",
    "1",
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(
    {
      total: r.json().data.total,
      remaining: r.json().data.remaining,
      version: r.json().data.version,
    },
    { total: null, remaining: null, version: 2 },
  );
  assert.equal(s.f.service.taskAllowance(s.taskId).state, "off");
});

test("a task allowance whose reply was lost is settled by reusing its request", async (t) => {
  const { cli, s, lostReply } = await startCliOperator(t);
  const args = [
    "task",
    "allowance",
    s.taskId,
    "--total",
    "4",
    "--expected-version",
    "0",
  ];
  let r = await cli("rw", args, { fetch: lostReply });
  assert.equal(s.f.service.taskAllowance(s.taskId).version, 1);
  assert.notEqual(r.code, 0);
  r = await cli("rw", args);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(s.f.service.taskAllowance(s.taskId).version, 1);
  assert.equal(s.f.service.taskAllowance(s.taskId).total, 4);
});
