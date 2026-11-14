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
    "No recorded request for reasoning summaries for this execution.",
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
    /Captured submission of cab-supplied inputs; not the runtime's effective prompt/,
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
  assert.match(
    detail.out,
    /Note: No recorded request for reasoning summaries for this execution\./,
  );
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
      CAB_CLI_CONFIG_DIR: h.configDir,
      CAB_MANAGED_ASSIGNMENT: "1",
    },
  });
  assert.equal(r.code, 3);
  assert.equal(h.fetches.length, unmanaged);
  assert.equal(databaseDigest(s.f), before);
});

test("execution notes print once and only with --verbose", async (t) => {
  const { s, seed, h, ok } = await setup(t);
  const executionNotes = [
    "Tool observation is incomplete.",
    "No recorded request for reasoning summaries for this execution.",
  ];
  const commands = [
    ["execution", "list", "--task", seed.taskA],
    ["execution", "get", seed.captured],
    ["logs", "--execution", seed.captured],
    ["logs", "--execution", seed.captured, "--follow", "--max-duration", "1"],
  ];
  const notesFor = (args: string[]) =>
    args[1] === "list"
      ? [
          executionNotes[0],
          "Reasoning summary capture is reported per execution.",
        ]
      : executionNotes;
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
      notesFor(args).map((n) => `Note: ${n}`),
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
    assert.deepEqual(quiet.coverage.notes, notesFor(args), args.join(" "));
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
  assert.match(paged.out, /^More: cab logs .* --verbose .*--cursor \S+$/m);
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

test("per-execution notes reflect API health while lists stay neutral and bounded", async (t) => {
  const { seed, h, api } = await setup(t);
  const detail = await api(
    `/api/operator/executions/${encodeURIComponent(seed.captured)}`,
  );
  const events = await api(
    `/api/operator/executions/${encodeURIComponent(seed.captured)}/events`,
  );
  const list = await api(
    `/api/operator/executions?task=${seed.taskA}&limit=50`,
  );
  const notes = {
    "not-requested":
      "No recorded request for reasoning summaries for this execution.",
    collected: "Reasoning summaries were collected for this execution.",
    unavailable: "Reasoning summaries are unavailable for this execution.",
  };
  const noteLines = (out: string) =>
    out.split("\n").filter((line) => line.startsWith("Note: "));
  for (const [reasoning, note] of Object.entries(notes)) {
    for (const args of [
      ["execution", "get", seed.captured],
      ["logs", "--execution", seed.captured],
    ]) {
      const options = {
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).includes("/executions/"))
            return Response.json({
              data: {
                ...(String(input).includes("/events") ? events : detail),
                health: { ...detail.health, reasoning },
              },
              observedAt: 1,
            });
          return fetch(input, init);
        },
      };
      const quiet = await h.run(args, options);
      assert.equal(quiet.code, 0, quiet.err);
      assert.deepEqual(noteLines(quiet.out), []);
      const loud = await h.run([...args, "--verbose"], options);
      assert.equal(loud.code, 0, loud.err);
      assert.deepEqual(noteLines(loud.out), [
        "Note: Tool observation is incomplete.",
        `Note: ${note}`,
      ]);
      const json = await h.run([...args, "--output", "json"], options);
      const verboseJson = await h.run(
        [...args, "--output", "json", "--verbose"],
        options,
      );
      assert.equal(json.code, 0, json.err);
      assert.equal(verboseJson.code, 0, verboseJson.err);
      assert.deepEqual(json.json().coverage.notes, [
        "Tool observation is incomplete.",
        note,
      ]);
      assert.deepEqual(
        verboseJson.json().coverage.notes,
        json.json().coverage.notes,
      );
    }
  }
  for (const executions of [list.executions, []]) {
    const requests: string[] = [];
    const result = await h.run(
      ["execution", "list", "--task", seed.taskA, "--verbose"],
      {
        fetch: async (input, init) => {
          requests.push(String(input));
          return String(input).includes("/executions?")
            ? Response.json({ data: { ...list, executions }, observedAt: 1 })
            : fetch(input, init);
        },
      },
    );
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(noteLines(result.out), [
      "Note: Tool observation is incomplete.",
      "Note: Reasoning summary capture is reported per execution.",
    ]);
    assert.equal(
      requests.filter((url) => url.includes("/executions")).length,
      1,
    );
  }
});

test("follow notes use only the last successful page, with a neutral pre-page interruption", async (t) => {
  const { seed, h, api } = await setup(t);
  const events = await api(
    `/api/operator/executions/${encodeURIComponent(seed.captured)}/events`,
  );
  for (const final of ["collected", "unavailable"] as const) {
    let pages = 0;
    const result = await h.run(
      ["logs", "--execution", seed.captured, "--follow", "--verbose"],
      {
        sleep: async () => {},
        fetch: async (input, init) => {
          if (!String(input).includes("/events")) return fetch(input, init);
          pages++;
          return Response.json({
            data: {
              ...events,
              items: [],
              more: false,
              finished: pages === 2,
              health: {
                ...events.health,
                reasoning:
                  pages === 1
                    ? final === "collected"
                      ? "unavailable"
                      : "collected"
                    : final,
              },
            },
            observedAt: 1,
          });
        },
      },
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(pages, 2);
    const notes = result.out
      .split("\n")
      .filter((line) => line.startsWith("Note: "));
    assert.deepEqual(notes, [
      "Note: Tool observation is incomplete.",
      final === "collected"
        ? "Note: Reasoning summaries were collected for this execution."
        : "Note: Reasoning summaries are unavailable for this execution.",
    ]);
  }
  const controller = new AbortController();
  let pages = 0;
  const interrupted = await h.run(
    ["logs", "--execution", seed.captured, "--follow", "--verbose"],
    {
      signal: controller.signal,
      fetch: async (input, init) => {
        if (String(input).includes("/events")) pages++;
        const response = await fetch(input, init);
        const body: unknown = await response.json();
        controller.abort(); // Connected, with no events page read yet.
        return Response.json(body, { status: response.status });
      },
    },
  );
  assert.equal(interrupted.code, 0, interrupted.err);
  assert.equal(pages, 0);
  assert.match(
    interrupted.out,
    /Note: Reasoning summary capture is reported per execution\./,
  );
});
