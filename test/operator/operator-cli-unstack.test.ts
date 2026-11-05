import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { operationCommands } from "../../src/cli/operation.js";
import { unstackWriteCommands } from "../../src/cli/task-unstack.js";
import { RequestJournal } from "../../src/cli/request-journal.js";
import { ServiceClient } from "../../src/cli/transport.js";
import type { WriteContext, Session } from "../../src/cli/write.js";
import { CliError } from "../../src/cli/connections.js";
import { harness } from "../fixtures/cli-harness.js";

function fixture(t: import("node:test").TestContext, cancelled = false) {
  const h = harness(t),
    taskId = randomUUID(),
    key = randomUUID(),
    serviceId = randomUUID();
  const materialHash = "a".repeat(64);
  const receipt = cancelled
    ? {
        kind: "task-cancel",
        key,
        taskId,
        recorded: true,
        cancellationRequested: 1,
      }
    : {
        kind: "task-unstack",
        key,
        taskId,
        recorded: true,
        expectedVersion: 3,
        materialHash,
        phase: "unstack-attempting",
        revision: 2,
        reason: "readback-required",
      };
  let posts = 0,
    gets = 0,
    lose = false,
    scope = "read-write";
  const session = {
    name: "fixture",
    identity: { service: { installationId: serviceId }, credential: { scope } },
    client: new ServiceClient(
      "http://127.0.0.1:12345",
      "synthetic-token",
      async (_, init) => {
        if (init?.method === "POST") {
          posts++;
          if (lose) throw new Error("lost response");
          const sent = JSON.parse(String(init.body));
          assert.equal(sent.key, key);
          if (!cancelled) assert.equal(sent.materialHash, materialHash);
          return new Response(JSON.stringify(receipt), {
            headers: { "Content-Type": "application/json" },
          });
        }
        gets++;
        return new Response(
          JSON.stringify({
            data: { state: "recorded", receipt },
            observedAt: 1,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    ),
  } as unknown as Session;
  const ctx = {
    journal: new RequestJournal(h.configDir),
    deps: { commandTimeoutMs: 200 },
    positionals: ["task", cancelled ? "cancel" : "unstack", taskId],
    values: {
      "expected-version": "3",
      "material-hash": cancelled ? undefined : materialHash,
      yes: true,
      "request-id": key,
    },
    connect: async () => {
      session.identity.credential.scope = scope as "read" | "read-write";
      return session;
    },
  } as unknown as WriteContext;
  return {
    h,
    ctx,
    key,
    taskId,
    lose: () => {
      lose = true;
    },
    readonly: () => {
      scope = "read";
    },
    counts: () => ({ posts, gets }),
    lines: () => readFileSync(join(h.configDir, "requests.jsonl"), "utf8"),
  };
}

test("CLI validates confirmation flags and readonly scope before any command request", async (t) => {
  const f = fixture(t),
    command = unstackWriteCommands.get("task unstack")!;
  f.ctx.values.yes = false;
  await assert.rejects(
    command.run(f.ctx),
    (e) => e instanceof CliError && e.code === "usage",
  );
  f.ctx.values.yes = true;
  f.readonly();
  await assert.rejects(
    command.run(f.ctx),
    (e) => e instanceof CliError && e.code === "insufficient-scope",
  );
  assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
});

test("CLI lost Unstack response retains exact journal key/body digest; retry checks GET only and renders pending as unfinished", async (t) => {
  const f = fixture(t),
    command = unstackWriteCommands.get("task unstack")!;
  f.lose();
  await assert.rejects(
    command.run(f.ctx),
    (e) =>
      e instanceof CliError &&
      e.code === "command-outcome-unknown" &&
      /original|ORIGINAL/.test(e.message),
  );
  const before = f.lines();
  assert.match(before, /unknown/);
  assert.match(before, new RegExp(f.key));
  const result = await command.run(f.ctx);
  assert.match(result.human, /unfinished/);
  assert.deepEqual(f.counts(), { posts: 1, gets: 1 });
  delete f.ctx.values["request-id"];
  await command.run(f.ctx);
  assert.deepEqual(f.counts(), { posts: 1, gets: 2 });
  f.ctx.values["request-id"] = f.key;
  f.ctx.values["material-hash"] = "b".repeat(64);
  await assert.rejects(
    command.run(f.ctx),
    (e) => e instanceof CliError && e.code === "conflict",
  );
  assert.deepEqual(f.counts(), { posts: 1, gets: 2 });
});

test("CLI records and renders a typed unfinished receipt without claiming a queued restack", async (t) => {
  const f = fixture(t),
    result = await unstackWriteCommands.get("task unstack")!.run(f.ctx);
  assert.match(result.human, /unfinished/);
  assert.match(f.lines(), /recorded/);
  assert.deepEqual(f.counts(), { posts: 1, gets: 0 });
});

test("CLI Cancel requires separate consent, records its own receipt and reads an unknown original key without a duplicate cancellation", async (t) => {
  const f = fixture(t, true),
    command = unstackWriteCommands.get("task cancel")!;
  f.ctx.values.yes = false;
  await assert.rejects(
    command.run(f.ctx),
    (e) => e instanceof CliError && e.code === "usage",
  );
  f.ctx.values.yes = true;
  f.lose();
  await assert.rejects(
    command.run(f.ctx),
    (e) => e instanceof CliError && e.code === "command-outcome-unknown",
  );
  const result = await command.run(f.ctx);
  assert.match(result.human, /Cancel recorded/);
  assert.match(f.lines(), /task.cancel/);
  assert.deepEqual(f.counts(), { posts: 1, gets: 1 });
  delete f.ctx.values["request-id"];
  await command.run(f.ctx);
  assert.deepEqual(f.counts(), { posts: 1, gets: 2 });
  f.ctx.values["request-id"] = f.key;
  f.ctx.values["expected-version"] = "4";
  await assert.rejects(
    command.run(f.ctx),
    (e) => e instanceof CliError && e.code === "conflict",
  );
  assert.deepEqual(f.counts(), { posts: 1, gets: 2 });
});

test("CLI original Unstack lookup remains a read-only GET and renders its unfinished typed status", async (t) => {
  const f = fixture(t);
  f.readonly();
  f.ctx.positionals = ["operation", "get", f.key];
  f.ctx.values = { scope: `task:${f.taskId}`, type: "task.unstack" };
  const result = await operationCommands.get("operation get")!.run(f.ctx);
  assert.match(result.human, /Unstack unfinished/);
  assert.deepEqual(f.counts(), { posts: 0, gets: 1 });
});
