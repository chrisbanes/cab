import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { COVERAGE_GAPS } from "../../src/cli/browse.js";
import { CAPTURE_GAP_COVERAGE } from "../../src/cli/browse-execution.js";
import { fakeServer, harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { seedExecutionDiagnostics } from "../fixtures/execution-diagnostics.js";
import { instructionSecret } from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function setup(
  t: { after(fn: () => unknown): void },
  options: { unchanged?: boolean } = {},
) {
  const s = await startCliService(t);
  const seed = await seedExecutionDiagnostics(s.f, options);
  t.after(seed.cleanup);
  const h = harness(t);
  const read = await s.issue("read", "execution-ro");
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const ok = async (args: string[]) => {
    const r = await h.run([...args, "--output", "json"]);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  const api = async (path: string) => {
    const r = await s.bearer(read.token, path);
    assert.equal(r.status, 200, path);
    return ((await r.json()) as Json).data as Json;
  };
  return { s, seed, h, read, ok, api };
}

test("capture gap codes map onto the closed coverage set", () => {
  for (const coverage of Object.values(CAPTURE_GAP_COVERAGE))
    assert.ok((COVERAGE_GAPS as readonly string[]).includes(coverage));
  assert.deepEqual(CAPTURE_GAP_COVERAGE, {
    "capture-baseline": "evidence-unavailable",
    "capture-failed": "evidence-gap",
    "capture-interrupted": "evidence-gap",
    "input-failed": "evidence-gap",
    "size-limit": "item-omitted",
    "redaction-unavailable": "redaction-unavailable",
    "execution-limit": "evidence-gap",
    "item-limit": "evidence-gap",
    expired: "evidence-gap",
    evicted: "evidence-gap",
    "late-event": "evidence-gap",
    "early-buffer-limit": "evidence-gap",
    "unsupported-event": "evidence-gap",
  });
});

test("execution and logs reads match the API and label their provenance", async (t) => {
  const { s, seed, h, ok, api } = await setup(t);
  const enc = encodeURIComponent;
  const before = databaseDigest(s.f);

  const list = await ok(["execution", "list", "--task", seed.taskA]);
  assert.deepEqual(
    list.data,
    await api(`/api/operator/executions?task=${seed.taskA}&limit=50`),
  );
  assert.ok(list.coverage.gaps.includes("evidence-unavailable"));
  const get = await ok(["execution", "get", seed.captured]);
  assert.deepEqual(
    get.data,
    await api(`/api/operator/executions/${enc(seed.captured)}`),
  );
  assert.deepEqual(get.coverage.notes, [
    "Tool observation is incomplete.",
    "Reasoning is not collected.",
  ]);
  const inputs = await ok([
    "execution",
    "inputs",
    seed.captured,
    "--compare-current",
  ]);
  assert.deepEqual(
    inputs.data,
    await api(
      `/api/operator/executions/${enc(seed.captured)}/inputs?compare=current`,
    ),
  );
  assert.ok(inputs.coverage.gaps.includes("content-redacted"));
  const logs = await ok(["logs", "--execution", seed.captured]);
  const events = await api(
    `/api/operator/executions/${enc(seed.captured)}/events?after=0&limit=50`,
  );
  const { resumeCursor, ...logData } = logs.data;
  assert.deepEqual(logData, events);
  assert.equal(typeof resumeCursor, "string");

  // Human output labels a captured submission, an absent one and a reconstruction.
  const human = await h.run(["execution", "inputs", seed.captured]);
  assert.match(
    human.out,
    /Captured submission of Ensemble-supplied inputs; not the runtime's effective prompt/,
  );
  assert.match(human.out, new RegExp(seed.profileOne));
  const absentJson = await ok(["execution", "inputs", seed.absent]);
  assert.ok(absentJson.coverage.gaps.includes("evidence-unavailable"));
  const absent = await h.run(["execution", "inputs", seed.absent]);
  assert.match(absent.out, /No captured submission/);
  assert.match(absent.out, /Reconstructed from retained revision records/);
  const detail = await h.run(["execution", "get", seed.captured, "--verbose"]);
  assert.match(detail.out, /model\s+gpt-seeded\s+runtime-reported/);
  assert.match(detail.out, /Note: Tool observation is incomplete\./);
  assert.match(detail.out, /Note: Reasoning is not collected\./);
  const humanLogs = await h.run(["logs", "--execution", seed.captured]);
  assert.match(humanLogs.out, /commandExecution\/completed/);
  for (const text of h.outputs) {
    assert.ok(!text.includes(instructionSecret));
    assert.ok(!text.includes("hunter2"));
  }

  // Paging, cursor binding and stale cursors.
  const first = await ok([
    "logs",
    "--execution",
    seed.captured,
    "--limit",
    "2",
  ]);
  assert.equal(first.data.items.length, 2);
  assert.ok(first.coverage.gaps.includes("more-pages"));
  const next = await ok([
    "logs",
    "--execution",
    seed.captured,
    "--limit",
    "2",
    "--cursor",
    first.pagination.nextCursor,
  ]);
  assert.ok(next.data.items[0].sequence > first.data.items[1].sequence);
  let r = await h.run([
    "logs",
    "--execution",
    seed.captured,
    "--kind",
    "tool",
    "--cursor",
    first.pagination.nextCursor,
  ]);
  assert.equal(r.code, 2, "a token from other filters");
  const forged = Buffer.from(
    JSON.stringify({
      v: 1,
      k: "logs",
      q: JSON.parse(
        Buffer.from(first.pagination.nextCursor, "base64url").toString(),
      ).q,
      c: "999999",
    }),
  ).toString("base64url");
  r = await h.run([
    "logs",
    "--execution",
    seed.captured,
    "--cursor",
    forged,
    "--output",
    "json",
  ]);
  assert.equal(r.code, 4);
  assert.equal(r.json().error.code, "cursor-stale");
  const paged = await ok([
    "execution",
    "list",
    "--assignment",
    seed.assignmentA,
    "--limit",
    "1",
  ]);
  assert.equal(paged.data.executions.length, 1);
  const older = await ok([
    "execution",
    "list",
    "--assignment",
    seed.assignmentA,
    "--limit",
    "1",
    "--cursor",
    paged.pagination.nextCursor,
  ]);
  assert.equal(older.data.executions[0].workId, seed.captured);

  // Usage errors exit 2 before any request.
  const requests = h.fetches.length;
  for (const args of [
    ["execution", "list"],
    ["execution", "list", "--task", seed.taskA, "--project", seed.projectA],
    ["execution", "get", "bad id"],
    ["logs"],
    ["logs", "--execution", seed.captured, "--kind", "reasoning"],
    ["logs", "--execution", seed.captured, "--severity", "debug"],
    ["logs", "--execution", seed.captured, "--follow", "--interval", "31"],
    ["logs", "--execution", seed.captured, "--follow", "--max-duration", "0"],
    ["execution", "get", seed.captured, "--output", "jsonl"],
    ["logs", "--execution", seed.captured, "--follow", "--output", "json"],
  ]) {
    const result = await h.run(args);
    assert.equal(result.code, 2, args.join(" "));
  }
  assert.equal(h.fetches.length, requests);
  r = await h.run(["execution", "get", "unknown-work", "--output", "json"]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "not-found");

  // Managed assignments get no request at all.
  const unmanaged = h.fetches.length;
  r = await h.run(["logs", "--execution", seed.captured], {
    env: {
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      ENSEMBLE_MANAGED_ASSIGNMENT: "1",
    },
  });
  assert.equal(r.code, 3);
  assert.equal(h.fetches.length, unmanaged);
  assert.equal(databaseDigest(s.f), before);
});

test("execution notes print once and only with --verbose", async (t) => {
  const { s, seed, h, ok } = await setup(t);
  const notes = [
    "Tool observation is incomplete.",
    "Reasoning is not collected.",
  ];
  const commands = [
    ["execution", "list", "--task", seed.taskA],
    ["execution", "get", seed.captured],
    ["logs", "--execution", seed.captured],
    ["logs", "--execution", seed.captured, "--follow", "--max-duration", "1"],
  ];
  const noteLines = (out: string) =>
    out.split("\n").filter((line) => line.startsWith("Note: "));
  for (const args of commands) {
    const quiet = await h.run(args);
    assert.equal(quiet.code, 0, `${args.join(" ")}: ${quiet.err}`);
    assert.deepEqual(noteLines(quiet.out), [], args.join(" "));
    const loud = await h.run([...args, "--verbose"]);
    assert.equal(loud.code, 0, `${args.join(" ")}: ${loud.err}`);
    assert.deepEqual(
      noteLines(loud.out),
      notes.map((n) => `Note: ${n}`),
      args.join(" "),
    );
  }
  // JSON is the same with and without the flag, and still carries the notes.
  for (const args of commands.slice(0, 3)) {
    const quiet = await ok(args);
    const loud = await ok([...args, "--verbose"]);
    const { observedAt: _a, ...loudCoverage } = loud.coverage;
    const { observedAt: _b, ...quietCoverage } = quiet.coverage;
    assert.deepEqual(loudCoverage, quietCoverage, args.join(" "));
    assert.deepEqual(quiet.coverage.notes, notes, args.join(" "));
    assert.deepEqual(loud.data, quiet.data, args.join(" "));
  }
  // The next page keeps the flag, so its notes do not vanish.
  const paged = await h.run([
    "logs",
    "--execution",
    seed.captured,
    "--limit",
    "1",
    "--verbose",
  ]);
  assert.match(paged.out, /^More: ensemble logs .* --verbose .*--cursor \S+$/m);
  // Past `--` it is an argument, not a flag.
  const after = await h.run([
    "execution",
    "get",
    seed.captured,
    "--",
    "--verbose",
  ]);
  assert.equal(after.code, 2);
  assert.deepEqual(noteLines(after.out), []);
  // Writes do not take it: refused before anything is sent.
  const write = await s.issue("read-write", "execution-rw");
  assert.equal(
    (
      await h.run([
        "auth",
        "login",
        "--connection",
        "rw",
        "--url",
        s.origin,
        "--token-file",
        h.tokenFile(write.token),
      ])
    ).code,
    0,
  );
  const sent = h.fetches.length;
  const stop = await h.run([
    "task",
    "stop",
    seed.taskA,
    "--verbose",
    "--connection",
    "rw",
    "--output",
    "json",
  ]);
  assert.equal(stop.code, 2);
  assert.equal(stop.json().error.code, "usage");
  assert.equal(h.fetches.length, sent);
});

test("a service without execution capabilities is unsupported after identity only", async (t) => {
  const h = harness(t);
  const installationId = randomUUID();
  const fake = await fakeServer(t, (_q, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        apiVersion: 1,
        capabilities: ["cli.identity", "task.read", "execution.read"],
        service: { installationId, origin: "https://ensemble.example" },
        credential: {
          id: randomUUID(),
          name: "fake",
          scope: "read",
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
  if (login.code !== 0) return assert.fail(login.err);
  const seen = fake.hits.length;
  const r = await h.run(["logs", "--execution", "w-1", "--output", "json"]);
  assert.equal(r.code, 7);
  assert.equal(r.json().error.code, "unsupported-service");
  assert.equal(fake.hits.length, seen + 1);
});

test("execution inputs mark instruction segments the thread already held", async (t) => {
  const { seed, h, ok } = await setup(t, { unchanged: true });
  const human = await h.run(["execution", "inputs", seed.unchanged]);
  assert.match(human.out, /\[not sent: the thread already has this revision\]/);
  const { coverage } = await ok(["execution", "inputs", seed.unchanged]);
  assert.ok(!coverage.gaps.includes("item-omitted"));
  assert.ok(!coverage.gaps.includes("redaction-unavailable"));
});
