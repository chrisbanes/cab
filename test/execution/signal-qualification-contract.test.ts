import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  readdirSync as fsReaddir,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ChildProcess, fork, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const control = await import(
  pathToFileURL(resolve("test/execution/signal-qualification/live-control.mjs"))
    .href
);
const driver = await import(
  pathToFileURL(resolve("test/execution/signal-qualification/live-signals.mjs"))
    .href
);
const hostModule = await import(
  pathToFileURL(resolve("test/execution/signal-qualification/live-host.mjs"))
    .href
);
const { Journal, Owner, LIMITS, fenceAdapters, reasonOf } = control;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cab-signal-contract-"));
  let now = Date.now();
  const file = join(root, "journal");
  const journal = Journal.create(file, { offline: true }, () => now);
  return {
    root,
    file,
    journal,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
const shape = () => ({
  permissionMode: "dontAsk",
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  abortController: new AbortController(),
});
function never() {
  return {
    async *[Symbol.asyncIterator]() {
      yield* [];
    },
  };
}
async function* modelPrompt() {
  yield { message: { role: "user", content: "offline" } };
}
function sdk(counter: { queries: number; prompts: number }) {
  return {
    query(input: { prompt: AsyncIterable<unknown> }) {
      counter.queries++;
      return {
        async supportedModels() {
          for await (const _ of input.prompt) counter.prompts++;
          return [];
        },
        async *[Symbol.asyncIterator]() {
          for await (const _ of input.prompt) {
            counter.prompts++;
            yield {};
          }
        },
      };
    },
  };
}
test("strict opt-in and exact finite limits refuse endpoints, roots, duplicate options and grant absence", () => {
  const args = [
    "--live",
    "--max-turns",
    "20",
    "--max-attempts",
    "1",
    "--deadline-ms",
    "1800000",
    "--grant",
    "/tmp/root-grant",
  ];
  assert.deepEqual(control.parseArgs(args), { grant: "/tmp/root-grant" });
  for (const invalid of [
    [],
    args.slice(1),
    [...args, "--url", "http://127.0.0.1:8787"],
    [...args, "--max-turns", "21"],
    args.slice(0, -2),
    [...args, "--root", "/tmp/production"],
  ])
    assert.throws(() => control.parseArgs(invalid));
  for (const endpoint of [
    "http://127.0.0.1:8787",
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.1:1234/path",
    "http://user:secret@127.0.0.1:1234",
  ])
    assert.throws(() => driver.safeEndpoint(endpoint));
  assert.equal(
    driver.safeEndpoint("http://127.0.0.1:1234"),
    "http://127.0.0.1:1234",
  );
  const { root } = fixture();
  assert.throws(() => driver.ownedRoot(root, "missing"));
  symlinkSync(root, join(root, "alias"));
  assert.throws(() => driver.ownedRoot(join(root, "alias"), "missing"));
});
test("entry executable refuses without live opt-in and emits no environment secrets", () => {
  const r = spawnSync(
    process.execPath,
    ["test/execution/signal-qualification/live-signals.mjs"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        OFFLINE_SECRET: "do-not-print-fixture-value",
      },
    },
  );
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout + r.stderr, /do-not-print-fixture-value/);
});
test("durable single attempt, hard20 reservations, no refunds and exact one-use binding survive reopen", () => {
  const { journal, file } = fixture();
  assert.throws(() => Journal.create(file, {}));
  const binding = {
    harness: "claude",
    thread: "thread",
    workspace: "owned",
    generation: 1,
  };
  const reservation = journal.reserve(binding);
  const reopened = new Journal(file, journal.now);
  assert.throws(() => reopened.consume(undefined, binding));
  assert.throws(() =>
    reopened.consume(reservation, { ...binding, thread: "other" }),
  );
  reopened.consume(reservation, binding);
  assert.throws(() => reopened.consume(reservation, binding));
  for (let i = 1; i < 20; i++) reopened.reserve(binding);
  assert.throws(() => reopened.reserve(binding), /turn cap/);
  assert.equal(
    reopened.entries().filter((r: { kind: string }) => r.kind === "reserve")
      .length,
    20,
  );
  assert.equal(
    readFileSync(file, "utf8").split('"kind":"attempt"').length - 1,
    1,
  );
});
test("both Claude boundaries share one durable reservation and consume before prompt release", async () => {
  const { journal } = fixture();
  const count = { queries: 0, prompts: 0 };
  const fence = fenceAdapters(journal, { caseId: "offline" });
  const wrapped = fence.sdk(sdk(count));
  const runtime = fence.runtime(
    {
      async startTurn() {
        const q = wrapped.query({ prompt: modelPrompt(), options: shape() });
        for await (const _ of q);
        return "turn";
      },
    },
    "claude",
    "generation",
    Date.now() + 1000,
  );
  assert.equal(await runtime.startTurn("thread", "workspace"), "turn");
  assert.equal(count.queries, 1);
  assert.equal(count.prompts, 1);
  const rows = journal.entries();
  assert.equal(
    rows.filter((r: { kind: string }) => r.kind === "reserve").length,
    1,
  );
  assert.equal(
    rows.filter((r: { kind: string }) => r.kind === "consume").length,
    1,
  );
});
test("unreserved, duplicate, and unconsumed model queries fail before another raw SDK call", async () => {
  for (const mode of ["duplicate", "missing-query"]) {
    const { journal } = fixture();
    const count = { queries: 0, prompts: 0 };
    const fence = fenceAdapters(journal, {});
    const wrapped = fence.sdk(sdk(count));
    assert.throws(() =>
      wrapped.query({
        prompt: modelPrompt(),
        options: { ...shape(), kind: "settings" },
      }),
    );
    const runtime = fence.runtime(
      {
        async startTurn() {
          if (mode === "duplicate") {
            const first = wrapped.query({
              prompt: modelPrompt(),
              options: shape(),
            });
            for await (const _ of first);
            wrapped.query({ prompt: modelPrompt(), options: shape() });
          }
          return "turn";
        },
      },
      "claude",
      mode,
      Date.now() + 1000,
    );
    await assert.rejects(runtime.startTurn("thread", "workspace"));
    assert.equal(count.queries, mode === "duplicate" ? 1 : 0);
    assert.equal(
      journal.entries().filter((r: { kind: string }) => r.kind === "reserve")
        .length,
      1,
      "failed attempt was refunded",
    );
  }
});
test("only fenced model-free preflight queries get six separate journal entries; cache gets no debit", async () => {
  const { journal } = fixture();
  const count = { queries: 0, prompts: 0 };
  const fence = fenceAdapters(journal, {});
  const wrapped = fence.sdk(sdk(count));
  for (let generation = 0; generation < 7; generation++) {
    const runtime = fence.runtime(
      {
        async preflightTurn() {
          const q = wrapped.query({ prompt: never(), options: shape() });
          await q.supportedModels();
          for await (const _ of q);
        },
        async startTurn() {
          return "unused";
        },
      },
      "claude",
      generation,
      Date.now() + 1000,
    );
    if (generation < 6) await runtime.preflightTurn();
    else await assert.rejects(runtime.preflightTurn(), /settings cap/);
  }
  assert.equal(count.queries, 6);
  assert.equal(count.prompts, 0);
  assert.equal(
    journal.entries().filter((r: { kind: string }) => r.kind === "reserve")
      .length,
    0,
  );
  assert.equal(
    journal.entries().filter((r: { kind: string }) => r.kind === "settings")
      .length,
    6,
  );
});
test("a yielded prompt cannot disguise a model query as settings, and failure cannot retry", async () => {
  const { journal } = fixture();
  const count = { queries: 0, prompts: 0 };
  const fence = fenceAdapters(journal, {});
  const wrapped = fence.sdk(sdk(count));
  const runtime = fence.runtime(
    {
      async preflightTurn() {
        const q = wrapped.query({ prompt: modelPrompt(), options: shape() });
        await q.supportedModels();
        for await (const _ of q);
      },
      async startTurn() {
        return "unused";
      },
    },
    "claude",
    1,
    Date.now() + 1000,
  );
  await assert.rejects(runtime.preflightTurn());
  assert.equal(count.prompts, 0);
  assert.equal(count.queries, 1);
  await assert.rejects(runtime.preflightTurn());
  assert.equal(count.queries, 1);
});
test("Codex turn/start boundary consumes once, absolute turn/session deadlines refuse late or new starts", async () => {
  const f = fixture();
  const fence = fenceAdapters(f.journal, {});
  let calls = 0;
  const runtime = fence.runtime(
    {
      async startTurn() {
        calls++;
        f.advance(LIMITS.turnMs + 1);
        return "late";
      },
    },
    "codex",
    0,
    f.now() + LIMITS.readyMs,
  );
  await assert.rejects(runtime.startTurn("thread", "workspace"), /deadline/);
  assert.equal(calls, 1);
  f.advance(LIMITS.sessionMs);
  await assert.rejects(runtime.startTurn("thread", "workspace"));
  assert.equal(calls, 1);
});
test("readiness starts before creation and every late rejected handoff remains owned exactly once", async () => {
  let now = 0,
    creates = 0,
    closes = 0;
  const owner = new Owner(() => now);
  await assert.rejects(
    owner.acquire(
      () => {
        creates++;
        now = 101;
        return {};
      },
      100,
      "readiness",
      async () => {
        closes++;
        return true;
      },
    ),
    /deadline/,
  );
  assert.equal(creates, 1);
  assert.equal(closes, 0);
  const cleanup = await owner.cleanup(200);
  assert.equal(cleanup.verified, true);
  assert.equal(closes, 1);
  await owner.cleanup(200);
  assert.equal(closes, 1);
  const refused = new Owner(() => 100);
  assert.throws(() =>
    refused.acquire(
      () => {
        creates++;
      },
      100,
      "before-spawn",
      () => true,
    ),
  );
  assert.equal(creates, 1);
});
test("pending creation remains unresolved at cutoff and is closed when it eventually returns", async () => {
  const owner = new Owner();
  let release: (value: object) => void = () => {};
  let closed = 0;
  const pending = new Promise<object>((resolve) => {
    release = resolve;
  });
  const rejected = owner.acquire(
    () => pending,
    Date.now() + 5,
    "pending",
    async () => {
      closed++;
      return true;
    },
  );
  await assert.rejects(rejected);
  const cleanup = await owner.cleanup(Date.now() + 5);
  assert.equal(cleanup.verified, false);
  assert.equal(cleanup.creations[0].state, "pending");
  release({});
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(cleanup.resources[0].state, "exited");
  assert.equal(cleanup.verified, false);
});
test("signal checks require exact birth/boot, sole group membership and a driver outside the group", () => {
  const target = { pid: 10, ppid: 1, pgid: 10, birth: "birth", boot: "boot" };
  const members = [{ pid: 10, ppid: 1, pgid: 10, birth: "birth" }];
  const parent = { pid: 1, pgid: 1 };
  driver.verifySignalTarget(target, target, members, parent);
  for (const change of [{ birth: "reused" }, { boot: "other" }, { ppid: 2 }])
    assert.throws(() =>
      driver.verifySignalTarget(
        target,
        { ...target, ...change },
        members,
        parent,
      ),
    );
  assert.throws(() =>
    driver.verifySignalTarget(
      target,
      target,
      [...members, { pid: 11, ppid: 10, pgid: 10, birth: "foreign" }],
      parent,
    ),
  );
  assert.throws(() =>
    driver.verifySignalTarget(target, target, members, { pid: 1, pgid: 10 }),
  );
});
test("the six-case matrix fixes expected14, restarts twice, independent read-only oracle and refusal/replay sequence", () => {
  assert.equal(driver.CASES.length, 6);
  assert.equal(
    driver.CASES.reduce((n: number, c: { turns: number }) => n + c.turns, 0),
    14,
  );
  const source = readFileSync(
    resolve("test/execution/signal-qualification/live-signals.mjs"),
    "utf8",
  );
  assert.match(source, /readOnly: true/);
  assert.doesNotMatch(source, /pkill/);
});

test("fake-boundary journeys enforce the complete six-case signal/restart/refusal/replay/continuation lifecycle", async () => {
  const f = fixture();
  const scenarios = new Map<
    string,
    {
      kind: string;
      turns: number;
      phase: string;
      closed: number;
      receipt: object;
    }
  >();
  const calls: string[] = [];
  const reserve = (id: string) => {
    const scenario = scenarios.get(id);
    assert.ok(scenario);
    const binding = {
      caseId: id,
      harness: id.startsWith("codex") ? "codex" : "claude",
      generation: scenario.turns,
    };
    const permit = f.journal.reserve(binding);
    f.journal.consume(permit, binding);
    scenario.turns++;
  };
  const snap = (id: string) => {
    const s = scenarios.get(id);
    assert.ok(s);
    const initial = {
      workId: "initial",
      state: "running",
      threadId: "same-thread",
      workspace: "same-workspace",
    };
    const done = s.phase === "done" || s.phase === "observed";
    return {
      intents:
        s.kind === "clean"
          ? [
              done ? { ...initial, state: "resolved-failed" } : initial,
              ...(done
                ? [{ ...initial, workId: "successor", state: "completed" }]
                : []),
            ]
          : [
              { ...initial, state: "completed" },
              ...(done
                ? [{ ...initial, workId: "continued", state: "completed" }]
                : []),
            ],
      resolutions:
        s.kind === "clean" && done
          ? [{ interruptedWorkId: "initial", requeueWorkId: "successor" }]
          : [],
      inbox: [
        {
          eventId: "inbox",
          recipientAssignmentId: "stopped-assignment",
          sequence: 1,
        },
      ],
      results: done ? [{ id: "one-result" }] : [],
      receipts:
        s.kind === "uncertain" && (s.phase === "reconciled" || done)
          ? [s.receipt]
          : [],
    };
  };
  type Host = { id: string; generation: number; closed: boolean };
  const backend = {
    now: f.now,
    async start(
      c: { id: string; kind: string },
      generation: number,
      deadline: number,
    ) {
      assert.equal(deadline, f.now() + LIMITS.readyMs);
      calls.push(`${c.id}:start${generation}`);
      if (!scenarios.has(c.id))
        scenarios.set(c.id, {
          kind: c.kind,
          turns: 0,
          phase: "new",
          closed: 0,
          receipt: { id: "durable" },
        });
      if (generation === 1 && c.kind === "clean") {
        reserve(c.id);
        const s = scenarios.get(c.id);
        assert.ok(s);
        s.phase = "done";
      }
      return { id: c.id, generation, closed: false };
    },
    async call(host: Host, op: string) {
      calls.push(`${host.id}:${op}`);
      const s = scenarios.get(host.id);
      assert.ok(s);
      if (op === "seed") {
        reserve(host.id);
        return { workId: "initial" };
      }
      if (op === "followup") {
        reserve(host.id);
        s.phase = "held";
      }
      if (op === "get")
        return { code: 0, data: { blocker: "termination-live" } };
      if (op === "prepare") return { code: s.phase === "exited" ? 0 : 4 };
      if (op === "submit") {
        s.phase = "reconciled";
        return { code: 0, data: { data: { receipt: s.receipt } } };
      }
      if (op === "inspect") return { stopped: true, paused: true };
      if (op === "continue") {
        reserve(host.id);
        s.phase = "done";
      }
      return undefined;
    },
    async active(host: Host) {
      calls.push(`${host.id}:active`);
    },
    async completed(host: Host) {
      calls.push(`${host.id}:completed`);
    },
    async held(host: Host) {
      calls.push(`${host.id}:held`);
    },
    async snapshot(host: Host) {
      return snap(host.id);
    },
    async signal(host: Host, mode: string) {
      calls.push(`${host.id}:signal:${mode}`);
    },
    async endRuntime(host: Host) {
      const s = scenarios.get(host.id);
      assert.ok(s);
      s.phase = "exited";
      calls.push(`${host.id}:exact-exit`);
    },
    async observe(host: Host, ms: number) {
      assert.equal(ms, 30000);
      calls.push(`${host.id}:observe`);
    },
    async close(host: Host) {
      if (!host.closed) {
        host.closed = true;
        const s = scenarios.get(host.id);
        assert.ok(s);
        s.closed++;
      }
      return true;
    },
  };
  const results = await driver.runCases(backend, f.journal);
  assert.equal(results.length, 6);
  assert.ok(
    results.every(
      (r: { cleanup: { verified: boolean } }) => r.cleanup.verified,
    ),
  );
  assert.equal(
    f.journal.entries().filter((r: { kind: string }) => r.kind === "reserve")
      .length,
    14,
  );
  for (const c of driver.CASES as { id: string; kind: string }[]) {
    const s = scenarios.get(c.id);
    assert.ok(s);
    assert.equal(s.closed, c.kind === "clean" ? 3 : 2);
    if (c.kind === "clean")
      assert.ok(
        calls.indexOf(`${c.id}:active`) <
          calls.findIndex((x) => x.startsWith(`${c.id}:signal:`)),
      );
    else {
      assert.ok(
        calls.indexOf(`${c.id}:prepare`) < calls.indexOf(`${c.id}:exact-exit`),
      );
      assert.equal(calls.filter((x) => x === `${c.id}:submit`).length, 2);
      assert.ok(
        calls.indexOf(`${c.id}:inspect`) < calls.indexOf(`${c.id}:continue`),
      );
    }
  }
});

test("cached settings incur no query debit and wrong-path settings shapes are refused", async () => {
  const { journal } = fixture();
  const count = { queries: 0, prompts: 0 };
  const fence = fenceAdapters(journal, {});
  const wrapped = fence.sdk(sdk(count));
  let cached = false;
  const runtime = fence.runtime(
    {
      async preflightTurn() {
        if (cached) return;
        const q = wrapped.query({ prompt: never(), options: shape() });
        await q.supportedModels();
        for await (const _ of q);
        cached = true;
      },
      async startTurn() {
        return "unused";
      },
    },
    "claude",
    0,
    Date.now() + 1000,
  );
  await runtime.preflightTurn();
  await runtime.preflightTurn();
  assert.equal(count.queries, 1);
  assert.equal(
    journal.entries().filter((r: { kind: string }) => r.kind === "settings")
      .length,
    1,
  );
  const wrong = fence.runtime(
    {
      async preflightTurn() {
        wrapped.query({
          prompt: never(),
          options: { ...shape(), tools: ["Bash"], kind: "settings" },
        });
      },
      async startTurn() {
        return "unused";
      },
    },
    "claude",
    1,
    Date.now() + 1000,
  );
  await assert.rejects(wrong.preflightTurn());
  assert.equal(count.queries, 1);
});

test("failed fake readiness closes its exact owned host and stops all later cases", async () => {
  const f = fixture();
  let closed = 0,
    starts = 0;
  const backend = {
    now: f.now,
    async start() {
      starts++;
      return { exact: "owned-host" };
    },
    async call() {
      throw Error("injected-readiness-or-protocol-failure");
    },
    async close(host: { exact: string }) {
      assert.equal(host.exact, "owned-host");
      closed++;
      return true;
    },
  };
  await assert.rejects(driver.runCases(backend, f.journal));
  assert.equal(starts, 1);
  assert.equal(closed, 1);
  assert.equal(
    f.journal.entries().filter((r: { kind: string }) => r.kind === "reserve")
      .length,
    0,
  );
});

test("offline budget decision is not accepted as a live grant, and child entry also needs opt-in", async () => {
  const { root } = fixture();
  const file = join(root, "offline-grant.json");
  const fs = await import("node:fs");
  fs.writeFileSync(file, JSON.stringify({ authorizedLive: false }));
  await assert.rejects(
    driver.main([
      "--live",
      "--max-turns",
      "20",
      "--max-attempts",
      "1",
      "--deadline-ms",
      "1800000",
      "--grant",
      file,
    ]),
  );
  assert.equal(fs.existsSync(`${file}.consumed`), false);
  const r = spawnSync(
    process.execPath,
    ["test/execution/signal-qualification/live-host.mjs"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        OFFLINE_SECRET: "do-not-print-fixture-value",
      },
    },
  );
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout + r.stderr, /do-not-print-fixture-value/);
});

test("an expired cleanup still closes already-created resources but never credits late completion", async () => {
  let now = 0,
    closed = 0;
  const owner = new Owner(() => now);
  await owner.acquire(
    () => ({}),
    100,
    "owned",
    async () => {
      closed++;
      return true;
    },
  );
  now = 101;
  const proof = await owner.cleanup(100);
  assert.equal(proof.verified, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(proof.resources[0].state, "exited");
  assert.equal(proof.verified, false);
});

test("durable oracle opens only read-only SQLite and preserves inbox identity without database mutations", async () => {
  const { root } = fixture();
  const fs = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  fs.mkdirSync(join(root, "data"));
  const file = join(root, "data", "standalone.sqlite");
  const db = new DatabaseSync(file);
  for (const table of [
    "execution_intents",
    "execution_shutdown_resolutions",
    "execution_recovery_identities",
    "task_writer_admissions",
    "execution_capacity_reservations",
    "execution_recovery_receipts",
    "coordination_results",
  ])
    db.exec(`CREATE TABLE ${table}(id TEXT)`);
  db.exec(
    "CREATE TABLE coordination_inbox_events(eventId TEXT, recipientAssignmentId TEXT, sequence INTEGER); INSERT INTO coordination_inbox_events VALUES('exact-event','exact-assignment',1)",
  );
  db.close();
  const digest = () =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = digest();
  const read = driver.snapshot(root);
  assert.deepEqual(
    read.inbox.map((r: Record<string, unknown>) => ({ ...r })),
    [
      {
        eventId: "exact-event",
        recipientAssignmentId: "exact-assignment",
        sequence: 1,
      },
    ],
  );
  assert.equal(digest(), before);
  const missing = fixture().root;
  assert.throws(() => driver.snapshot(missing));
  assert.equal(
    fs.existsSync(join(missing, "data", "standalone.sqlite")),
    false,
  );
});

type Row = { kind: string; reason?: string; caseId?: string };
const kinds = (journal: { entries(): Row[] }) =>
  journal.entries().map((r) => r.kind);
/** A Claude-like model query whose stream rethrows a stored exit error once its child ends. */
function exitingSdk(message: string, raw: { streamInput: number }) {
  return {
    query({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<unknown>;
      options: { abortController: AbortController };
    }) {
      const abort = options.abortController;
      return {
        async supportedModels() {
          return [];
        },
        async streamInput() {
          raw.streamInput++;
        },
        async *[Symbol.asyncIterator]() {
          for await (const _ of prompt) {
            yield { type: "assistant" };
            break;
          }
          if (!abort.signal.aborted)
            await new Promise((r) =>
              abort.signal.addEventListener("abort", r, { once: true }),
            );
          throw new Error(message);
        },
      };
    },
  };
}
test("Claude stream exit errors after abort or child signal return to the runtime and keep the attempt open", async () => {
  for (const message of [
    "Claude Code process aborted by user",
    "Claude Code process terminated by signal SIGTERM",
  ]) {
    const { journal, file } = fixture();
    const raw = { streamInput: 0 };
    const fence = fenceAdapters(journal, { caseId: "claude-group-SIGINT" });
    const wrapped = fence.sdk(exitingSdk(message, raw));
    const abort = new AbortController();
    let consumed: Promise<string | undefined> = Promise.resolve(undefined);
    const runtime = fence.runtime(
      {
        async startTurn() {
          const q = wrapped.query({
            prompt: modelPrompt(),
            options: { ...shape(), abortController: abort },
          });
          consumed = (async () => {
            try {
              for await (const _ of q);
            } catch (error) {
              return (error as Error).message;
            }
          })();
          return "turn";
        },
      },
      "claude",
      0,
      Date.now() + 60000,
    );
    await runtime.startTurn("thread", "workspace");
    abort.abort();
    assert.equal(await consumed, message, "runtime sees its own SDK error");
    assert.ok(!kinds(journal).includes("failed"), "attempt stays open");
    new Journal(file).reserve({ caseId: "claude-group-SIGINT", generation: 1 });
  }
});
test("fence violations still close the attempt: prompt release without reservation and prompt-carrying controls", async () => {
  const yielded = fixture();
  const fence = fenceAdapters(yielded.journal, { caseId: "c" });
  const wrapped = fence.sdk(sdk({ queries: 0, prompts: 0 }));
  const runtime = fence.runtime(
    {
      async preflightTurn() {
        const q = wrapped.query({ prompt: modelPrompt(), options: shape() });
        for await (const _ of q);
      },
      async startTurn() {
        return "unused";
      },
    },
    "claude",
    0,
    Date.now() + 1000,
  );
  await assert.rejects(
    runtime.preflightTurn(),
    /prompt-release-without-model-reservation/,
  );
  assert.ok(kinds(yielded.journal).includes("failed"));
  const control = fixture();
  const raw = { streamInput: 0 };
  const fence2 = fenceAdapters(control.journal, { caseId: "c" });
  const wrapped2 = fence2.sdk(exitingSdk("unused", raw));
  const runtime2 = fence2.runtime(
    {
      async startTurn() {
        const q = wrapped2.query({ prompt: modelPrompt(), options: shape() });
        await (
          q as unknown as { streamInput(x: unknown): Promise<void> }
        ).streamInput(modelPrompt());
        return "turn";
      },
    },
    "claude",
    0,
    Date.now() + 1000,
  );
  await assert.rejects(runtime2.startTurn("t", "w"), /unfenced-query-method/);
  assert.equal(raw.streamInput, 0, "prompt-carrying control never reached SDK");
  assert.ok(kinds(control.journal).includes("failed"));
});
test("settings reads are keyed by case and generation across one shared journal", async () => {
  const { journal } = fixture();
  const count = { queries: 0, prompts: 0 };
  const read = (caseId: string, generation: number) => {
    const fence = fenceAdapters(journal, { caseId });
    const wrapped = fence.sdk(sdk(count));
    return fence
      .runtime(
        {
          async preflightTurn() {
            const q = wrapped.query({ prompt: never(), options: shape() });
            await q.supportedModels();
            for await (const _ of q);
          },
          async startTurn() {
            return "unused";
          },
        },
        "claude",
        generation,
        Date.now() + 1000,
      )
      .preflightTurn();
  };
  await read("claude-group-SIGINT", 0);
  await read("claude-PID-SIGTERM", 0);
  await read("claude-uncertain", 0);
  await assert.rejects(read("claude-PID-SIGTERM", 0), /reused/);
  assert.equal(count.queries, 3);
  assert.deepEqual(
    journal
      .entries()
      .filter((r: Row) => r.kind === "settings")
      .map((r: Row) => r.caseId),
    ["claude-group-SIGINT", "claude-PID-SIGTERM", "claude-uncertain"],
  );
  assert.ok(!kinds(journal).includes("failed"));
});
test("failure evidence keeps stage, name, code and fixed driver text but drops foreign messages", async () => {
  const sdkError = Object.assign(new Error("CLI stderr: secret-ish output"), {
    code: "ERR_CHILD",
  });
  assert.deepEqual(reasonOf(sdkError, "seed"), {
    stage: "seed",
    name: "Error",
    code: "ERR_CHILD",
  });
  assert.equal(
    reasonOf(control.fixed("host operation refused")).message,
    "host operation refused",
  );
  try {
    assert.equal(1, 2, "unexpected model start count");
  } catch (error) {
    assert.equal(reasonOf(error).message, "unexpected model start count");
  }
  try {
    assert.deepEqual({ token: "row-data" }, {});
  } catch (error) {
    const message = reasonOf(error).message;
    assert.equal(message, "Expected values to be strictly deep-equal:");
    assert.doesNotMatch(JSON.stringify(reasonOf(error)), /row-data/);
  }
  const f = fixture();
  const backend = {
    now: f.now,
    async start() {
      return {};
    },
    async call() {
      throw sdkError;
    },
    async close() {
      return true;
    },
  };
  const error = await driver
    .runCases(backend, f.journal)
    .catch((e: unknown) => e);
  assert.deepEqual(error.results[0].failure, {
    stage: "seed",
    name: "Error",
    code: "ERR_CHILD",
  });
  assert.doesNotMatch(JSON.stringify(error.results), /secret-ish/);
});
test("grant marker is keyed by grant id, build is redone from HEAD and versions are version prints only", () => {
  const home = mkdtempSync(join(tmpdir(), "cab-signal-home-"));
  const a = driver.grantMarker("grant-1", home);
  assert.equal(driver.grantMarker("grant-1", home), a);
  assert.notEqual(driver.grantMarker("grant-2", home), a);
  assert.throws(() => driver.grantMarker("../escape", home));
  const runs: { command: string; args: string[]; cwd?: string }[] = [];
  const build = driver.prepareBuild(
    (command: string, args: string[], options: { cwd: string }) => {
      runs.push({ command, args, cwd: options.cwd });
    },
  );
  assert.deepEqual(
    runs.map((r) => r.args[0]),
    ["node_modules/typescript/bin/tsc", "node_modules/vite/bin/vite.js"],
  );
  assert.equal(runs[0]?.cwd, `${resolve(".")}/`);
  assert.match(build.distSha256, /^[a-f0-9]{64}$/);
  assert.throws(() =>
    driver.prepareBuild(() => {
      throw new Error("build failed");
    }),
  );
  const asked: string[][] = [];
  const versions = driver.runtimeVersions(
    "/opt/codex",
    (command: string, args: string[]) => {
      asked.push([command, ...args]);
      return `${command} 1.0\n`;
    },
  );
  assert.deepEqual(asked, [
    ["/opt/codex", "--version"],
    ["claude", "--version"],
  ]);
  assert.equal(versions.node, process.version);
  assert.match(versions.claudeAgentSdk, /^\d+\.\d+\.\d+/);
});

// Offline wiring: realBackend + live-host over the model-free fake-child/sdk fixtures.
const darwin = { skip: process.platform !== "darwin", timeout: 120000 };
const fakeChild = new URL(
  "./signal-qualification/fake-child.js",
  import.meta.url,
).href;
function offlineSession() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cab-signal-live-"));
  const marker = randomUUID();
  writeFileSync(join(root, "owner"), marker, { mode: 0o600 });
  const executable = join(root, "fake-runtime");
  writeFileSync(
    executable,
    `#!${process.execPath}\nprocess.env.SIGNAL_TRACE ??= ${JSON.stringify(join(root, "fixture-trace.jsonl"))};\nprocess.env.SIGNAL_RESUME = "1";\nawait import(${JSON.stringify(fakeChild)});\n`,
    { mode: 0o700 },
  );
  const grant = {
    authorizedLive: false,
    offlineFixture: true,
    grantId: "offline-fixture",
    limits: LIMITS,
    claudeModel: "opus",
    claudeTokenRef: "env:CAB_SIGNAL_OFFLINE_TOKEN",
  };
  const journalFile = join(root, "session.jsonl");
  const journal = Journal.create(journalFile, { grantId: grant.grantId });
  const options = { entry: "--offline-fixture", offline: { executable } };
  return { root, marker, executable, grant, journalFile, journal, options };
}
type Identity = {
  pid: number;
  ppid: number;
  pgid: number;
  birth: string;
  boot: string;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pids: number[], ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until && pids.some(alive))
    await new Promise((r) => setTimeout(r, 50));
  return !pids.some(alive);
}
const caseOf = (id: string) => ({
  id,
  harness: id.split("-")[0],
  kind: "clean",
  signal: "group-SIGINT",
  turns: 2,
});
test(
  "offline realBackend drives live-host through Codex call, wait, snapshot, signals and exact close",
  darwin,
  async () => {
    const s = offlineSession();
    const backend = driver.realBackend(
      s.root,
      s.marker,
      s.journalFile,
      s.grant,
      s.options,
    );
    const id = "codex-group-SIGINT";
    let host = await backend.start(caseOf(id), 0, Date.now() + LIMITS.readyMs);
    try {
      const ids = await backend.call(host, "seed");
      await backend.call(host, "inbox");
      await backend.completed(host, Date.now() + 30000, 1);
      const before = await backend.snapshot(host);
      assert.ok(before.inbox.length, "stopped inbox captured");
      assert.ok(
        before.intents.some((r: { workId: string }) => r.workId === ids.workId),
      );
      await backend.signal(host, "group-SIGINT");
      assert.equal(await backend.close(host), true);
      const record = JSON.parse(
        readFileSync(join(host.root, `cleanup-${host.owned.pid}.json`), "utf8"),
      );
      assert.ok(record.runtimes.length >= 1, "adapter identity captured");
      assert.ok(record.runtimes.every((r: { absent: boolean }) => r.absent));
      assert.deepEqual(
        driver
          .adapterRows(host.root, host.owned)
          .map((r: Identity) => r.pid)
          .sort(),
        record.runtimes.map((r: Identity) => r.pid).sort(),
      );
      host = await backend.start(caseOf(id), 1, Date.now() + LIMITS.readyMs);
      const after = await backend.call(host, "inspect");
      assert.ok(Array.isArray(after.list));
      await backend.signal(host, "PID-SIGTERM");
      assert.equal(await backend.close(host), true);
      const rows = s.journal.entries();
      assert.ok(!rows.some((r: Row) => r.kind === "failed"));
      assert.equal(rows.filter((r: Row) => r.kind === "reserve").length, 1);
      assert.equal(rows.filter((r: Row) => r.kind === "consume").length, 1);
    } finally {
      await backend.closeAll();
    }
  },
);
test(
  "offline Claude host receives its token only after the runtime snapshot and settles one keyed settings read",
  darwin,
  async () => {
    const s = offlineSession();
    process.env.CAB_SIGNAL_OFFLINE_TOKEN = "offline-fixture-token";
    const backend = driver.realBackend(
      s.root,
      s.marker,
      s.journalFile,
      s.grant,
      s.options,
    );
    const id = "claude-group-SIGINT";
    const host = await backend.start(
      caseOf(id),
      0,
      Date.now() + LIMITS.readyMs,
    );
    try {
      await backend.call(host, "seed");
      const fixtureTrace = join(host.root, "fixture-trace.jsonl");
      const until = Date.now() + 30000;
      while (
        Date.now() < until &&
        !(
          existsSync(fixtureTrace) &&
          readFileSync(fixtureTrace, "utf8").includes('"child-active"')
        )
      )
        await new Promise((r) => setTimeout(r, 50));
      assert.match(
        readFileSync(fixtureTrace, "utf8"),
        /"child-active"/,
        "prompt released to the turn child: token available, not restart-required",
      );
      await backend.signal(host, "group-SIGINT");
      assert.equal(await backend.close(host), true);
      const rows = s.journal.entries();
      assert.ok(
        !rows.some((r: Row) => r.kind === "failed"),
        "abort kept attempt",
      );
      assert.deepEqual(
        rows
          .filter((r: Row) => r.kind === "settings")
          .map((r: Row & { generation?: number }) => [r.caseId, r.generation]),
        [[id, 0]],
      );
      assert.equal(rows.filter((r: Row) => r.kind === "consume").length, 1);
      const settingsProbe = readFileSync(fixtureTrace, "utf8").includes(
        '"probe-start"',
      );
      if (settingsProbe)
        assert.ok(
          host.cleanup.runtimes.length >= 2,
          "settings-read process identity is durable too",
        );
    } finally {
      delete process.env.CAB_SIGNAL_OFFLINE_TOKEN;
      await backend.closeAll();
    }
  },
);
test(
  "endExact escalates only for the exact identity; endRuntime ends only an owned bound runtime",
  darwin,
  async () => {
    const s = offlineSession();
    const backend = driver.realBackend(
      s.root,
      s.marker,
      s.journalFile,
      s.grant,
      s.options,
    );
    const stubborn = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const sleeper = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        stdio: "ignore",
      },
    );
    const answer = (value: unknown): ChildProcess =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.on("message",m=>process.send({id:m.id,value:${JSON.stringify(value)}}))`,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
    const hosts: ChildProcess[] = [];
    try {
      await new Promise((r) => setTimeout(r, 200));
      const hard = driver.identity(stubborn.pid);
      await assert.rejects(
        driver.endExact({ ...hard, birth: "reused" }, Date.now() + 3000),
        /identity conflict/,
      );
      assert.ok(alive(hard.pid), "mismatched identity never signalled");
      assert.equal(await driver.endExact(hard, Date.now() + 3000), true);
      const owned = driver.identity(sleeper.pid);
      const inspect = {
        recovery: [
          {
            intent: { state: "held" },
            processIdentity: { processId: String(owned.pid) },
          },
        ],
      };
      const unowned = answer(inspect);
      hosts.push(unowned);
      await assert.rejects(
        backend.endRuntime({ child: unowned, runtimes: [], failures: [] }),
        /unowned bound runtime/,
      );
      assert.ok(alive(owned.pid));
      const ownedHost = answer(inspect);
      hosts.push(ownedHost);
      await backend.endRuntime({
        child: ownedHost,
        runtimes: [owned],
        failures: [],
      });
      assert.ok(await gone([owned.pid], 2000));
    } finally {
      for (const child of [stubborn, sleeper, ...hosts])
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
    }
  },
);
for (const mode of ["SIGTERM-handler", "SIGKILL-death"] as const)
  test(
    `driver ${mode} leaves no owned host or runtime running`,
    darwin,
    async () => {
      const s = offlineSession();
      const script = join(s.root, "driver.mjs");
      writeFileSync(
        script,
        `const driver = await import(${JSON.stringify(pathToFileURL(resolve("test/execution/signal-qualification/live-signals.mjs")).href)});
const control = await import(${JSON.stringify(pathToFileURL(resolve("test/execution/signal-qualification/live-control.mjs")).href)});
const s = JSON.parse(process.argv[2]);
const backend = driver.realBackend(s.root, s.marker, s.journalFile, s.grant, s.options);
if (s.guard) driver.guardDriver(backend, new control.Journal(s.journalFile));
const host = await backend.start({ id: "codex-group-SIGINT", harness: "codex", kind: "clean" }, 0, Date.now() + 60000);
await host.ready;
await backend.call(host, "seed");
const until = Date.now() + 30000;
while (Date.now() < until && driver.adapterRows(host.root, host.owned).length === 0) await new Promise((r) => setTimeout(r, 50));
process.send({ host: host.owned, root: host.root });
setInterval(() => {}, 1000);
`,
      );
      const child = fork(
        script,
        [
          JSON.stringify({
            ...s,
            journal: undefined,
            guard: mode === "SIGTERM-handler",
          }),
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const exited = new Promise<number | null>((r) =>
        child.once("exit", (code) => r(code)),
      );
      let started: { host: Identity; root: string } | undefined;
      try {
        started = await new Promise((resolveStart, reject) => {
          child.once("message", resolveStart);
          child.once("exit", () => reject(Error("driver exited early")));
        });
        assert.ok(started);
        const runtimes = driver.adapterRows(started.root, started.host);
        assert.ok(runtimes.length >= 1);
        const own = driver.identity(child.pid);
        assert.equal(own.ppid, process.pid, "exact driver child");
        process.kill(
          child.pid as number,
          mode === "SIGTERM-handler" ? "SIGTERM" : "SIGKILL",
        );
        const code = await exited;
        if (mode === "SIGTERM-handler") assert.equal(code, 143);
        assert.ok(
          await gone(
            [started.host.pid, ...runtimes.map((r: Identity) => r.pid)],
            25000,
          ),
          "host and runtime exited after driver loss",
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        if (started)
          for (const owned of [
            started.host,
            ...driver.adapterRows(started.root, started.host),
          ])
            await driver.endExact(owned, Date.now() + 5000).catch(() => false);
      }
    },
  );

test("Claude bound-turn proof needs running intent, recorded identity, consumed reservation and a live owned process", () => {
  const process_ = {
    pid: 42,
    ppid: 7,
    pgid: 42,
    birth: "Mon Nov  2 09:00:00 2026",
    boot: "boot",
  };
  const input = {
    intents: [{ workId: "w", state: "running", threadId: "t", turnId: "u" }],
    identities: [
      {
        workId: "w",
        threadId: "t",
        turnId: "u",
        processId: "42",
        processStartedAt: process_.birth,
        bootId: "boot",
      },
    ],
    entries: [
      {
        kind: "consume",
        token: "r",
        binding: { caseId: "c", generation: 0, thread: "t" },
      },
    ],
    owned: [process_],
    caseId: "c",
    generation: 0,
    workId: "w",
    live: () => true,
  };
  assert.deepEqual(driver.boundTurn(input), {
    workId: "w",
    threadId: "t",
    turnId: "u",
    process: process_,
    reservation: "r",
  });
  for (const change of [
    { intents: [{ ...input.intents[0], state: "ready" }] },
    { identities: [{ ...input.identities[0], processId: null }] },
    { identities: [{ ...input.identities[0], turnId: "older" }] },
    { entries: [] },
    { generation: 1 },
    { owned: [{ ...process_, birth: "reused" }] },
    { owned: [] },
    { live: () => false },
    { caseId: "other-case" },
    {
      entries: [
        {
          ...input.entries[0],
          binding: { caseId: "c", generation: 0, thread: "other" },
        },
      ],
    },
    { identities: [{ ...input.identities[0], threadId: "other" }] },
    { saved: () => undefined },
  ])
    assert.equal(driver.boundTurn({ ...input, ...change }), undefined);
  const session = { file: "data/claude/config/projects/p/t.jsonl", row: 0 };
  assert.deepEqual(
    driver.boundTurn({
      ...input,
      saved: (thread: string) => (thread === "t" ? session : undefined),
    }).session,
    session,
  );
});
test(
  "offline Claude active barrier waits for the binding and the saved prompt, so restart1 resumes the session",
  darwin,
  async () => {
    const s = offlineSession();
    process.env.CAB_SIGNAL_OFFLINE_TOKEN = "offline-fixture-token";
    const backend = driver.realBackend(
      s.root,
      s.marker,
      s.journalFile,
      s.grant,
      s.options,
    );
    const id = "claude-group-SIGINT";
    let host = await backend.start(caseOf(id), 0, Date.now() + LIMITS.readyMs);
    try {
      const ids = await backend.call(host, "seed");
      // The fixture never yields assistant text and saves its session only after 850 ms.
      const value = await backend.active(
        host,
        ids.workId,
        Date.now() + LIMITS.readyMs,
      );
      assert.deepEqual(value.active, [], "no text-derived activity");
      const rows = driver.jsonlRows(
        readFileSync(join(host.root, "trace.jsonl"), "utf8"),
      );
      const proof = rows.find(
        (r: { event: string }) => r.event === "active-bound-durable",
      );
      assert.ok(proof, "barrier evidenced in the trace");
      assert.equal(proof.detail.textEvents, 0);
      const recorded = rows.find(
        (r: { event: string }) => r.event === "turn-process-recorded",
      );
      assert.equal(
        recorded?.detail.processIdentity.processId,
        String(proof.detail.process.pid),
      );
      assert.ok(alive(proof.detail.process.pid), "bound process alive");
      const fixtureTrace = join(host.root, "fixture-trace.jsonl");
      const fixtureRows = () =>
        driver.jsonlRows(readFileSync(fixtureTrace, "utf8"));
      await backend.signal(host, "group-SIGINT");
      assert.equal(await backend.close(host), true);
      const generation0 = host.owned.pid;
      host = await backend.start(caseOf(id), 1, Date.now() + LIMITS.readyMs);
      const until = Date.now() + 30000;
      const outcome = () =>
        fixtureRows().find((r: { event: string }) =>
          ["resume-missing", "result-saved"].includes(r.event),
        );
      while (Date.now() < until && !outcome())
        await new Promise((r) => setTimeout(r, 50));
      // Restart1 is the consequence that matters: an unsaved session cannot be resumed.
      assert.equal(outcome()?.event, "result-saved", "successor resumed");
      assert.match(
        proof.detail.session.file,
        /^data\/claude\/config\/projects\//,
      );
      const saved = fixtureRows().find(
        (r: { event: string }) => r.event === "session-saved",
      );
      assert.ok(
        saved && Date.parse(saved.at) <= Date.parse(proof.at),
        "prompt saved before the barrier",
      );
      // Token custody: generation 0 restores only after its reference (exclusion) exists;
      // the restarted generation restores in the factory, before successor dispatch.
      const tokenRows = (pid: number) =>
        driver
          .jsonlRows(readFileSync(join(host.root, "trace.jsonl"), "utf8"))
          .filter(
            (r: { pid: number; event: string }) =>
              r.pid === pid && r.event.startsWith("claude-token-"),
          )
          .map((r: { event: string; detail?: { stage?: string } }) =>
            [r.event, r.detail?.stage].filter(Boolean).join(":"),
          );
      assert.deepEqual(tokenRows(generation0), [
        "claude-token-reference-configured",
        "claude-token-restored:after-reference-configured",
      ]);
      assert.deepEqual(tokenRows(host.owned.pid), [
        "claude-token-restored:factory-reference-configured",
      ]);
      await backend.completed(host, Date.now() + LIMITS.readyMs, 2);
      assert.equal(await backend.close(host), true);
      assert.ok(!kinds(s.journal).includes("failed"));
    } finally {
      delete process.env.CAB_SIGNAL_OFFLINE_TOKEN;
      await backend.closeAll();
    }
  },
);
test(
  "offline Claude observation loss holds at the durable binding with its process still live",
  darwin,
  async () => {
    const s = offlineSession();
    process.env.CAB_SIGNAL_OFFLINE_TOKEN = "offline-fixture-token";
    const backend = driver.realBackend(
      s.root,
      s.marker,
      s.journalFile,
      s.grant,
      s.options,
    );
    const host = await backend.start(
      { ...caseOf("claude-uncertain"), kind: "uncertain" },
      0,
      Date.now() + LIMITS.readyMs,
    );
    try {
      await backend.call(host, "seed");
      // Arms the injected loss before the first turn's wait; that turn never yields text.
      await backend.call(host, "followup");
      // The follow-up is the long first-time request, not the short continuation.
      assert.equal(
        readFileSync(join(host.root, "followup.txt"), "utf8"),
        hostModule.SIGNAL_BRIEF,
      );
      await backend.held(host, Date.now() + LIMITS.readyMs);
      const get = await backend.call(host, "get");
      assert.equal(get.code, 0);
      assert.match(JSON.stringify(get.data), /termination-live/);
      assert.equal((await backend.call(host, "prepare")).code, 4);
      await backend.endRuntime(host);
      assert.equal(await backend.close(host), true);
    } finally {
      delete process.env.CAB_SIGNAL_OFFLINE_TOKEN;
      await backend.closeAll();
    }
  },
);
test("grant source checks run in the repository; build/version children get no Claude token; failures are durable", async () => {
  const calls: { args: string[]; cwd?: string }[] = [];
  const grant = { sourceHead: "head", sourceTree: "tree" };
  driver.verifySource(
    grant,
    (_: string, args: string[], options: { cwd: string }) => {
      calls.push({ args, cwd: options.cwd });
      return args[1] === "HEAD^{tree}" ? "tree\n" : "head\n";
    },
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.cwd === `${resolve(".")}/`));
  assert.throws(() =>
    driver.verifySource({ ...grant, sourceHead: "other" }, () => "head"),
  );
  const env = driver.childEnvironment(
    { claudeTokenRef: "env:CAB_FIXTURE_TOKEN" },
    { PATH: "/bin", CAB_FIXTURE_TOKEN: "fixture-value" },
  );
  assert.deepEqual(env, { PATH: "/bin" });
  const seen: unknown[] = [];
  driver.prepareBuild((_: string, __: string[], o: { env: unknown }) => {
    seen.push(o.env);
  }, env);
  driver.runtimeVersions(
    "/opt/codex",
    (_: string, __: string[], o: { env: unknown }) => {
      seen.push(o.env);
      return "1";
    },
    env,
  );
  assert.ok(seen.length === 4 && seen.every((e) => e === env));
  const f = fixture();
  const backend = {
    now: f.now,
    async start() {
      return {};
    },
    async call() {
      throw control.fixed("host operation refused");
    },
    diagnostics: () => [
      { workId: "w", state: "ready", reason: "Claude runtime unavailable" },
    ],
    async close() {
      return true;
    },
  };
  const error = await driver
    .runCases(backend, f.journal)
    .catch((e: unknown) => e);
  assert.deepEqual(error.results[0].failure.store, [
    { workId: "w", state: "ready", reason: "Claude runtime unavailable" },
  ]);
  const failed = f.journal.entries().filter((r: Row) => r.kind === "failed");
  assert.deepEqual(
    failed.map((r: Row & { stage?: string }) => [r.caseId, r.stage]),
    [["codex-group-SIGINT", "seed"]],
  );
  assert.throws(() => f.journal.reserve({}), /attempt closed/);
  assert.deepEqual(
    driver.listReasons([
      { workId: "x".repeat(500), state: "s", reason: "r".repeat(500) },
    ])[0].reason.length,
    240,
  );
});
test("no host is forked once driver shutdown has begun", darwin, async () => {
  const s = offlineSession();
  const backend = driver.realBackend(
    s.root,
    s.marker,
    s.journalFile,
    s.grant,
    s.options,
  );
  await backend.closeAll();
  await assert.rejects(
    backend.start(caseOf("codex-group-SIGINT"), 0, Date.now() + 60000),
    /shutting down/,
  );
  const fs = await import("node:fs");
  assert.deepEqual(
    fs.readdirSync(s.root).filter((d) => d.startsWith("codex-")),
    [],
  );
});
test("polling reads skip a torn trace line and tolerate bounded SQLite BUSY; other damage still fails", async () => {
  assert.deepEqual(driver.jsonlRows('{"a":1}\n{"a":2}\n{"a":'), [
    { a: 1 },
    { a: 2 },
  ]);
  assert.deepEqual(driver.jsonlRows('{"a":1}\n'), [{ a: 1 }]);
  assert.throws(() => driver.jsonlRows('{"a":1}\n{"a\n{"a":3}\n'));
  const owner = { pid: 9, boot: "b" };
  const { root } = fixture();
  writeFileSync(
    join(root, "trace.jsonl"),
    `${JSON.stringify({ pid: 9, event: "adapter-process", detail: { pid: 10, ppid: 9, pgid: 10, birth: "x", boot: "b" } })}\n{"pid":9,"event":"adap`,
  );
  assert.equal(driver.adapterRows(root, owner).length, 1);
  const project = join(root, "data", "claude", "config", "projects", "p");
  const fs = await import("node:fs");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    join(project, "s-1.jsonl"),
    '{"type":"system"}\n{"type":"us',
  );
  assert.equal(driver.savedPrompt(root, "s-1"), undefined, "torn user row");
  fs.appendFileSync(join(project, "s-1.jsonl"), 'er"}\n');
  assert.deepEqual(driver.savedPrompt(root, "s-1"), {
    file: "data/claude/config/projects/p/s-1.jsonl",
    row: 1,
  });
  assert.equal(driver.savedPrompt(root, "../escape"), undefined);
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(root, "data", "standalone.sqlite");
  const writer = new DatabaseSync(file);
  for (const table of [
    "execution_intents",
    "execution_shutdown_resolutions",
    "execution_recovery_identities",
    "task_writer_admissions",
    "execution_capacity_reservations",
    "execution_recovery_receipts",
    "coordination_results",
  ])
    writer.exec(`CREATE TABLE ${table}(id TEXT)`);
  writer.exec(
    "CREATE TABLE coordination_inbox_events(eventId TEXT, recipientAssignmentId TEXT, sequence INTEGER)",
  );
  writer.exec("BEGIN EXCLUSIVE");
  const state = {};
  for (let i = 0; i < 3; i++)
    assert.equal(
      driver.pollRead(() => driver.snapshot(root), state, 3),
      undefined,
      "real SQLITE_BUSY is retried",
    );
  assert.throws(
    () => driver.pollRead(() => driver.snapshot(root), state, 3),
    /locked|busy/i,
  );
  writer.exec("COMMIT");
  writer.close();
  assert.ok(driver.pollRead(() => driver.snapshot(root), {}, 3).intents);
  assert.throws(() =>
    driver.pollRead(
      () => {
        throw new Error("not transient");
      },
      {},
      3,
    ),
  );
});
test("durable snapshots after a spent turn retry a transient BUSY within their deadline", async () => {
  const { root } = fixture();
  const fs = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(join(root, "data"));
  const writer = new DatabaseSync(join(root, "data", "standalone.sqlite"));
  for (const table of [
    "execution_intents",
    "execution_shutdown_resolutions",
    "execution_recovery_identities",
    "task_writer_admissions",
    "execution_capacity_reservations",
    "execution_recovery_receipts",
    "coordination_results",
  ])
    writer.exec(`CREATE TABLE ${table}(id TEXT)`);
  writer.exec(
    "CREATE TABLE coordination_inbox_events(eventId TEXT, recipientAssignmentId TEXT, sequence INTEGER)",
  );
  writer.exec("BEGIN EXCLUSIVE");
  setTimeout(() => writer.exec("COMMIT"), 150);
  const value = await driver.readDurable(root, Date.now() + 5000);
  assert.deepEqual(value.intents, []);
  writer.exec("BEGIN EXCLUSIVE");
  await assert.rejects(
    driver.readDurable(root, Date.now() + 100),
    /deadline|locked|busy/i,
  );
  if (process.platform === "darwin") {
    // The backend's own snapshot (the clean case's `before`) goes through the same retry.
    const s = offlineSession();
    const backend = driver.realBackend(
      s.root,
      s.marker,
      s.journalFile,
      s.grant,
      s.options,
    );
    setTimeout(() => writer.exec("COMMIT"), 150);
    const durable = await backend.snapshot({ root });
    assert.deepEqual(durable.inbox, []);
  } else writer.exec("COMMIT");
  writer.close();
});
test("the brief keeps a long first delivery, a one-sentence continuation, and the explicit continuation is unchanged", () => {
  const brief: string = hostModule.SIGNAL_BRIEF;
  assert.match(brief, /Write a long original story \(about 1500 words\)/);
  assert.ok(
    brief.endsWith(
      "If this conversation already contains this request (you are continuing after an interruption), do not write or finish the story: reply with one sentence, call cab_report_result once with summary SIGNAL QUALIFICATION DONE, and end the turn.",
    ),
  );
  assert.doesNotMatch(brief, /finish the story and report once/);
  assert.equal(
    hostModule.CONTINUATION_MESSAGE,
    "Explicit continuation: call cab_report_result once with summary CONTINUATION DONE and end this existing conversation. No other tools.",
  );
  const source = readFileSync(
    resolve("test/execution/signal-qualification/live-host.mjs"),
    "utf8",
  );
  // Clean-case assignments and the uncertain follow-up both carry the same long brief.
  assert.match(source, /const prompt = SIGNAL_BRIEF;/);
  assert.match(source, /feedLead\(ids, prompt, "followup\.txt"\)/);
  assert.match(
    source,
    /feedLead\(ids, CONTINUATION_MESSAGE, "continue\.txt"\)/,
  );
});
for (const harness of ["codex", "claude"] as const)
  test(
    `offline ${harness}-uncertain runs the complete live journey through the real driver and host`,
    darwin,
    async () => {
      const s = offlineSession();
      // Present in the driver, as live: a Codex host must still run without it.
      process.env.CAB_SIGNAL_OFFLINE_TOKEN = "offline-fixture-token";
      const backend = driver.realBackend(
        s.root,
        s.marker,
        s.journalFile,
        s.grant,
        {
          ...s.options,
          // Generation 0: the seed settles, the follow-up stays live until ended.
          offline: {
            ...s.options.offline,
            script: (_: unknown, generation: number) =>
              generation === 0 ? ["complete", "hold"] : undefined,
          },
        },
      );
      const testCase = driver.CASES.find(
        (c: { id: string }) => c.id === `${harness}-uncertain`,
      );
      try {
        const results = await driver
          .runCases(backend, s.journal, [testCase])
          .catch((error: { results?: unknown }) => {
            assert.fail(
              `uncertain journey failed: ${JSON.stringify(error.results ?? String(error))}`,
            );
          });
        assert.equal(results[0].failure, undefined);
        assert.equal(results[0].cleanup.verified, true);
        const rows = s.journal.entries();
        assert.equal(rows.filter((r: Row) => r.kind === "reserve").length, 3);
        assert.ok(!rows.some((r: Row) => r.kind === "failed"));
        const caseRoot = fsReaddir(s.root)
          .map((d) => join(s.root, d))
          .find((d) => d.includes(`${harness}-uncertain-`));
        assert.ok(caseRoot);
        const trace = driver.jsonlRows(
          readFileSync(join(caseRoot, "trace.jsonl"), "utf8"),
        );
        const tokenRows = trace.filter((r: { event: string }) =>
          r.event.startsWith("claude-token-"),
        );
        if (harness === "codex")
          assert.deepEqual(tokenRows, [], "Codex host never holds the token");
        else assert.ok(tokenRows.length >= 2);
        const ids = JSON.parse(
          readFileSync(join(caseRoot, "ids.json"), "utf8"),
        );
        assert.match(ids.workId, new RegExp(ids.assignmentId));
        assert.ok(existsSync(join(caseRoot, "followup.txt")));
        assert.ok(existsSync(join(caseRoot, "continue.txt")));
      } finally {
        delete process.env.CAB_SIGNAL_OFFLINE_TOKEN;
        await backend.closeAll();
      }
    },
  );
// Pre-live gate, opt-in for its ~2.5 min of fixed 30 s no-duplicate observations.
test("offline six-case matrix runs the exact live journey: expected 14 turns, 6 settings reads, no failure", {
  skip:
    process.platform !== "darwin" ||
    process.env.CAB_SIGNAL_OFFLINE_MATRIX !== "1"
      ? "set CAB_SIGNAL_OFFLINE_MATRIX=1 on macOS"
      : false,
  timeout: 400000,
}, async () => {
  const s = offlineSession();
  process.env.CAB_SIGNAL_OFFLINE_TOKEN = "offline-fixture-token";
  const backend = driver.realBackend(s.root, s.marker, s.journalFile, s.grant, {
    ...s.options,
    offline: {
      ...s.options.offline,
      script: (c: { kind: string }, generation: number) =>
        generation !== 0
          ? undefined
          : c.kind === "uncertain"
            ? ["complete", "hold"]
            : ["hold"],
    },
  });
  try {
    const results = await driver
      .runCases(backend, s.journal)
      .catch((error: { results?: unknown }) =>
        assert.fail(
          `matrix failed: ${JSON.stringify(error.results ?? String(error))}`,
        ),
      );
    assert.deepEqual(
      results.map((r: { caseId: string }) => r.caseId),
      driver.CASES.map((c: { id: string }) => c.id),
    );
    assert.ok(
      results.every(
        (r: { failure?: unknown; cleanup: { verified: boolean } }) =>
          r.failure === undefined && r.cleanup.verified,
      ),
    );
    const rows = s.journal.entries();
    assert.equal(rows.filter((r: Row) => r.kind === "reserve").length, 14);
    assert.equal(rows.filter((r: Row) => r.kind === "consume").length, 14);
    assert.equal(rows.filter((r: Row) => r.kind === "settings").length, 6);
    assert.ok(!rows.some((r: Row) => r.kind === "failed"));
  } finally {
    delete process.env.CAB_SIGNAL_OFFLINE_TOKEN;
    await backend.closeAll();
  }
});
