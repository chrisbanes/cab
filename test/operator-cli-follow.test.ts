import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionDiagnosticsStore } from "../src/standalone/execution-diagnostics.js";
import { harness } from "./fixtures/cli-harness.js";
import { seedExecutionDiagnostics } from "./fixtures/execution-diagnostics.js";
import { startCliService } from "./fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed JSONL records are asserted structurally
type Json = Record<string, any>;
const DAY = 24 * 3600 * 1000;

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await startCliService(t);
  const seed = await seedExecutionDiagnostics(s.f);
  t.after(seed.cleanup);
  // A second, still-running execution of the same assignment.
  const live = seed.absent;
  const write = (fn: (store: ExecutionDiagnosticsStore) => void) =>
    s.f.seedPersistedState((db) => fn(new ExecutionDiagnosticsStore(db)));
  write((store) =>
    store.begin({
      workId: live,
      taskId: seed.taskA,
      projectId: seed.projectA,
      assignmentId: seed.assignmentA,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "enhanced",
      eventSource: "supported",
    }),
  );
  let n = 0;
  const add = (count = 1) =>
    write((store) => {
      for (let i = 0; i < count; i++)
        store.record(
          live,
          "service",
          `event-${++n}`,
          "info",
          undefined,
          { n },
          [],
        );
    });
  const h = harness(t);
  const login = async (name: string, token: string) => {
    const r = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(token),
    ]);
    assert.equal(r.code, 0, r.err);
  };
  const read = await s.issue("read", "follow-ro");
  await login("home", read.token);
  return { s, seed, live, write, add, h, login, read };
}

const records = (out: string) =>
  out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);

test("following delivers each item once, ends when finished and resumes", async (t) => {
  const { live, write, add, h } = await setup(t);
  add(2);
  let polls = 0;
  const sleep = async () => {
    polls++;
    if (polls === 1) add(3);
    if (polls === 2) write((store) => store.finish(live));
  };
  const r = await h.run(
    ["logs", "--execution", live, "--follow", "--output", "jsonl"],
    { sleep },
  );
  assert.equal(r.code, 0, r.err);
  const lines = records(r.out);
  for (const line of lines) assert.equal(line.schema, "ensemble.cli/v1");
  const items = lines.filter((l) => l.type === "item");
  assert.deepEqual(
    items.map((l) => l.item.name),
    ["event-1", "event-2", "event-3", "event-4", "event-5"],
  );
  const sequences = items.map((l) => l.item.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
  );
  const end = lines.at(-1);
  assert.equal(end?.type, "end");
  assert.equal(end?.reason, "execution-finished");
  assert.deepEqual(
    lines.map((l) => l.type),
    [...items.map(() => "item"), "end"],
  );
  // Resuming from the end cursor repeats nothing.
  add(1);
  const resumed = await h.run(
    [
      "logs",
      "--execution",
      live,
      "--follow",
      "--output",
      "jsonl",
      "--cursor",
      end?.resumeCursor,
    ],
    { sleep: async () => {} },
  );
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(
    records(resumed.out)
      .filter((l) => l.type === "item")
      .map((l) => l.item.name),
    ["event-6"],
  );
  // Human following prints the rows and a resume line.
  const human = await h.run(["logs", "--execution", live, "--follow"], {
    sleep: async () => {},
  });
  assert.match(human.out, /event-1/);
  assert.match(human.out, /End: execution-finished/);
  assert.match(human.out, /Resume: ensemble logs --execution \S+ --cursor \S+/);
});

test("following is bounded by duration and the interrupt signal", async (t) => {
  const { live, h } = await setup(t);
  let now = 1_000_000;
  const timed = await h.run(
    [
      "logs",
      "--execution",
      live,
      "--follow",
      "--max-duration",
      "10",
      "--interval",
      "2",
      "--output",
      "jsonl",
    ],
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(timed.code, 0, timed.err);
  assert.equal(records(timed.out).at(-1)?.reason, "max-duration");
  const interrupt = new AbortController();
  const interrupted = await h.run(
    ["logs", "--execution", live, "--follow", "--output", "jsonl"],
    { signal: interrupt.signal, sleep: async () => interrupt.abort() },
  );
  assert.equal(interrupted.code, 0);
  assert.equal(records(interrupted.out).at(-1)?.reason, "interrupted");
});

test("revocation or expiry during following stops with exit 3", async (t) => {
  const { s, live, add, h, login } = await setup(t);
  const store = s.f.service.operatorCredentials();
  const doomed = await s.issue("read", "doomed");
  await login("doomed", doomed.token);
  add(1);
  let revokedAt = -1;
  const r = await h.run(
    [
      "logs",
      "--execution",
      live,
      "--follow",
      "--output",
      "jsonl",
      "--connection",
      "doomed",
    ],
    {
      sleep: async () => {
        store.revoke(doomed.credential.id);
        add(1);
        revokedAt = 1;
      },
    },
  );
  assert.equal(revokedAt, 1);
  assert.equal(r.code, 3, r.out);
  const lines = records(r.out);
  assert.deepEqual(
    lines.map((l) => l.type),
    ["item", "error"],
  );
  assert.equal(lines[1]?.error.code, "credential-invalid");
  assert.match(lines[1]?.error.message, /--cursor /);

  const expiring = store.issue(
    { name: "soon", scope: "read", expiresInDays: 1 },
    Date.now() - DAY + 1500,
  );
  await login("soon", expiring.token);
  const expired = await h.run(
    [
      "logs",
      "--execution",
      live,
      "--follow",
      "--output",
      "jsonl",
      "--connection",
      "soon",
    ],
    { sleep: () => new Promise((resolve) => setTimeout(resolve, 1600)) },
  );
  assert.equal(expired.code, 3, expired.out);
  assert.equal(records(expired.out).at(-1)?.type, "error");
});

test("repeated unavailability stops with exit 5 and a pruned range is a gap record", async (t) => {
  const { s, live, add, write, h } = await setup(t);
  add(2);
  // Expire the rows with a later clock: the follower sees an explicit gap.
  s.f.seedPersistedState((db) => {
    void new ExecutionDiagnosticsStore(db, {
      now: () => Date.now() + 31 * DAY,
    }).prune();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  write((store) => store.finish(live));
  const pruned = await h.run(
    ["logs", "--execution", live, "--follow", "--output", "jsonl"],
    { sleep: async () => {} },
  );
  assert.equal(pruned.code, 0, pruned.err);
  const gap = records(pruned.out).find((l) => l.type === "gap");
  assert.equal(gap?.gap.code, "expired");
  assert.equal(gap?.coverage, "evidence-gap");

  let calls = 0;
  const failing = await h.run(
    ["logs", "--execution", live, "--follow", "--output", "jsonl"],
    {
      sleep: async () => {},
      fetch: async (input, init) => {
        if (String(input).includes("/events") && ++calls)
          return new Response("{}", { status: 503 });
        return fetch(input, init);
      },
    },
  );
  assert.equal(failing.code, 5, failing.out);
  assert.equal(calls, 3);
  assert.match(records(failing.out).at(-1)?.error.message, /--cursor /);
});
