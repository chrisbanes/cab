import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  StackFixtureGuard,
  StackFixtureRunner,
} from "./github-qualification/stack-guard.js";

function fixture() {
  const resource = {
    account: "synthetic-account",
    accountNodeId: "A_synthetic",
    repositoryNodeId: "R_synthetic",
    projectId: "08b6b958-047e-4d04-8400-2d8373dcbb47",
    taskIds: [
      "08b6b958-047e-4d04-8400-2d8373dcbb48",
      "08b6b958-047e-4d04-8400-2d8373dcbb49",
    ],
    branchPrefix: "cab-fixture-test/",
    repository: "synthetic/fixture",
    visibility: "private",
    base: "main",
    baseSha: "a".repeat(40),
    refs: [
      { name: "cab-fixture-test/lower", sha: "b".repeat(40) },
      { name: "cab-fixture-test/upper", sha: "c".repeat(40) },
    ],
    prs: [
      {
        id: "PR_lower",
        number: 1,
        head: "cab-fixture-test/lower",
        base: "main",
      },
      {
        id: "PR_upper",
        number: 2,
        head: "cab-fixture-test/upper",
        base: "cab-fixture-test/lower",
      },
    ],
    stack: ["PR_lower", "PR_upper"],
    materialSha256: "d".repeat(64),
  };
  const manifest = {
    version: 1,
    runId: "08b6b958-047e-4d04-8400-2d8373dcbb45",
    resource,
    credentialRef: "env:SYNTHETIC",
    maxWrites: 1,
    runtimeTurns: 1,
    operations: [
      {
        id: "retarget",
        cleanup: false,
        send: {
          method: "PATCH",
          path: "/repos/synthetic/fixture/pulls/2",
          body: '{"base":"main"}',
        },
        readback: {
          method: "GET",
          path: "/repos/synthetic/fixture/pulls/2",
          body: "",
        },
      },
    ],
  };
  const raw = JSON.stringify(manifest);
  const grant = {
    version: 1,
    runId: manifest.runId,
    resource,
    credentialRef: manifest.credentialRef,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    maxWrites: 1,
    runtimeTurns: 1,
    expiresAt: "2099-01-01T00:00:00Z",
    cleanup: false,
  };
  return { manifest, raw, grant };
}

test("missing, expired, digest, identity and allowance mismatches reject before credential or network", () => {
  const f = fixture();
  assert.throws(() => new StackFixtureGuard(f.raw, undefined));
  const guard = new StackFixtureGuard(f.raw, f.grant);
  guard.assertObserved(f.manifest.resource);
  assert.throws(() =>
    guard.assertObserved({ ...f.manifest.resource, accountNodeId: "wrong" }),
  );
  assert.throws(() => new StackFixtureGuard(`${f.raw} `, f.grant));
  assert.throws(
    () =>
      new StackFixtureGuard(f.raw, {
        ...f.grant,
        expiresAt: "2000-01-01T00:00:00Z",
      }),
  );
  for (const [key, value] of Object.entries({
    account: "other",
    repository: "other/repo",
    visibility: "public",
    base: "other",
    baseSha: "e".repeat(40),
    refs: [],
    prs: [],
    stack: [],
    materialSha256: "e".repeat(64),
  })) {
    assert.throws(
      () =>
        new StackFixtureGuard(f.raw, {
          ...f.grant,
          resource: { ...f.grant.resource, [key]: value },
        }),
      key,
    );
  }
  for (const change of [
    { maxWrites: 2 },
    { runtimeTurns: 2 },
    { credentialRef: "env:OTHER" },
    { runId: "08b6b958-047e-4d04-8400-2d8373dcbb46" },
  ])
    assert.throws(
      () => new StackFixtureGuard(f.raw, { ...f.grant, ...change }),
    );
  const cleanup = JSON.stringify({
    ...f.manifest,
    operations: f.manifest.operations.map((o) => ({ ...o, cleanup: true })),
  });
  assert.throws(
    () =>
      new StackFixtureGuard(cleanup, {
        ...f.grant,
        manifestSha256: createHash("sha256").update(cleanup).digest("hex"),
      }),
  );
});

test("method, path and exact body guard runs before credential lookup", async (t) => {
  const f = fixture(),
    root = await mkdtemp(join(tmpdir(), "cab-stack-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = new StackFixtureRunner(
    new StackFixtureGuard(f.raw, f.grant),
    join(root, "checkpoint.json"),
  );
  const credential = async () => {
    assert.fail("credential lookup forbidden");
  };
  const transport: typeof fetch = async () => {
    assert.fail("network forbidden");
  };
  for (const [method, path, body] of [
    ["POST", f.manifest.operations[0]!.send.path, '{"base":"main"}'],
    ["PATCH", "/repos/other/fixture/pulls/2", '{"base":"main"}'],
    ["PATCH", f.manifest.operations[0]!.send.path, '{"base":"elsewhere"}'],
  ]) {
    await assert.rejects(
      runner.send("retarget", method!, path!, body!, credential, transport),
      /material/,
    );
  }
});

test("durable intent/send survive unknown transport; restart reads back and cannot resend", async (t) => {
  const f = fixture(),
    root = await mkdtemp(join(tmpdir(), "cab-stack-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "checkpoint.json"),
    guard = new StackFixtureGuard(f.raw, f.grant);
  const runner = new StackFixtureRunner(guard, path);
  let writes = 0;
  const credential = async () => {
    const state = JSON.parse(await readFile(path, "utf8"));
    assert.equal(state.operations.retarget.phase, "intent");
    return "synthetic-secret";
  };
  const op = f.manifest.operations[0]!.send;
  await assert.rejects(
    runner.send(
      "retarget",
      op.method,
      op.path,
      op.body,
      credential,
      async () => {
        writes++;
        assert.equal(
          JSON.parse(await readFile(path, "utf8")).operations.retarget.phase,
          "sent",
        );
        throw new Error("unknown");
      },
    ),
    /unknown/,
  );
  const resumed = new StackFixtureRunner(guard, path);
  await assert.rejects(
    resumed.send(
      "retarget",
      op.method,
      op.path,
      op.body,
      async () => "unused",
      async () => {
        assert.fail("repeat");
      },
    ),
    /must not repeat/,
  );
  assert.equal(
    await resumed.readback(
      "retarget",
      async () => "synthetic-secret",
      async (input, init) => {
        assert.equal(String(input), `https://api.github.com${op.path}`);
        assert.equal(init?.redirect, "error");
        return new Response("{}");
      },
      async () => true,
    ),
    "confirmed",
  );
  assert.equal(writes, 1);
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes("synthetic-secret"));
  assert.ok(!raw.includes(op.body));
  assert.equal(JSON.parse(raw).writes, 1);
  assert.equal(await resumed.beginRuntimeTurn(), 1);
  await assert.rejects(resumed.beginRuntimeTurn(), /budget/);
  await assert.rejects(
    new StackFixtureRunner(guard, path).beginRuntimeTurn(),
    /budget/,
  );
});

test("host escape and mutated public manifest cannot expand granted requests", () => {
  const f = fixture();
  for (const path of [
    "//evil.test/repos/synthetic/fixture/pulls/2",
    "/repos/other/repo/pulls/2",
    "/repos/synthetic/fixture/pulls/2#fragment",
  ]) {
    const raw = JSON.stringify({
      ...f.manifest,
      operations: f.manifest.operations.map((o) => ({
        ...o,
        send: { ...o.send, path },
      })),
    });
    assert.throws(
      () =>
        new StackFixtureGuard(raw, {
          ...f.grant,
          manifestSha256: createHash("sha256").update(raw).digest("hex"),
        }),
    );
  }
  const guard = new StackFixtureGuard(f.raw, f.grant);
  guard.manifest.operations[0]!.send.body = "changed";
  assert.throws(() =>
    guard.operation(
      "retarget",
      "PATCH",
      f.manifest.operations[0]!.send.path,
      "changed",
    ),
  );
});

test("write exhaustion and expired credential continuation persist intent without extra effects", async (t) => {
  const f = fixture(),
    root = await mkdtemp(join(tmpdir(), "cab-stack-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    ...f.manifest,
    operations: [
      ...f.manifest.operations,
      { ...f.manifest.operations[0]!, id: "second" },
    ],
  };
  const raw = JSON.stringify(manifest);
  let now = Date.parse("2098-01-01T00:00:00Z");
  const grant = {
    ...f.grant,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
  const guard = new StackFixtureGuard(raw, grant, () => now);
  const path = join(root, "state.json"),
    runner = new StackFixtureRunner(guard, path),
    op = manifest.operations[0]!.send;
  await assert.rejects(
    runner.send(
      "retarget",
      op.method,
      op.path,
      op.body,
      async () => {
        now = Date.parse(grant.expiresAt);
        return "synthetic";
      },
      async () => {
        assert.fail("expired continuation sent");
      },
    ),
    /expired/,
  );
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).operations.retarget.phase,
    "intent",
  );
  now = Date.parse("2098-01-01T00:00:00Z");
  await assert.rejects(
    new StackFixtureRunner(guard, path).send(
      "retarget",
      op.method,
      op.path,
      op.body,
      async () => {
        assert.fail("lookup on repeat");
      },
      async () => {
        assert.fail("repeat");
      },
    ),
    /must not repeat/,
  );
  await assert.rejects(
    runner.send(
      "second",
      op.method,
      op.path,
      op.body,
      async () => {
        assert.fail("lookup beyond budget");
      },
      async () => {
        assert.fail("write beyond budget");
      },
    ),
    /limit/,
  );
});
