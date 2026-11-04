import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import { isDeletedProjectThread } from "../../src/standalone/project-cleanup-reservations.js";
import { databaseOf, startedOf } from "../fixtures/service-internals.js";
import { deletedCleanupFixture } from "../fixtures/deleted-project-cleanup.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fakeArchive(root: string) {
  const archive = join(root, "fake-codex-archive");
  await mkdir(archive);
  const archived = new Set<string>(),
    calls: [string, boolean][] = [],
    effects: string[] = [];
  const runtime = {
    setThreadArchived: async (threadId: string, value: boolean) => {
      calls.push([threadId, value]);
      assert.equal(value, true, "deleted cleanup never unarchives");
      if (!archived.has(threadId)) {
        archived.add(threadId);
        effects.push(threadId);
        await writeFile(
          join(archive, `${threadId}.jsonl`),
          "Retained fake Codex archive contents\n",
        );
      }
    },
  } as Runtime;
  return {
    runtime,
    archived,
    calls,
    effects,
    file: (id: string) => join(archive, `${id}.jsonl`),
  };
}

test("captured thread cleanup survives deletion of every intent/qualification and preserves fake archive files", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true }),
    fake = await fakeArchive(f.fixture.directory);
  await f.commit();
  f.assertDeleted();
  assert.equal(
    databaseOf(f.service)
      .prepare("SELECT 1 FROM execution_intents WHERE threadId=?")
      .get(f.threadId),
    undefined,
  );
  assert.equal(
    databaseOf(f.service)
      .prepare("SELECT 1 FROM runtime_thread_qualification WHERE threadId=?")
      .get(f.threadId),
    undefined,
  );
  await f.runner(() => fake.runtime).sweep();
  assert.deepEqual(fake.effects, [f.threadId]);
  assert.deepEqual(fake.calls, [[f.threadId, true]]);
  assert.equal(
    await readFile(fake.file(f.threadId), "utf8"),
    "Retained fake Codex archive contents\n",
  );
  assert.equal(f.store().pendingCleanup().length, 0);
  await f.runner(() => fake.runtime).sweep();
  assert.equal(fake.calls.length, 1);
  assert.equal(f.fixture.runtime.turns, 0);
});

for (const interruption of [
  "after-effect-before-ack",
  "after-ack-before-checkpoint",
] as const)
  test(`thread cleanup retries ${interruption} across restart without duplicating its archival effect`, async (t) => {
    const f = await deletedCleanupFixture(t, { thread: true }),
      fake = await fakeArchive(f.fixture.directory);
    await f.commit();
    const set = fake.runtime.setThreadArchived!.bind(fake.runtime);
    if (interruption === "after-effect-before-ack")
      fake.runtime.setThreadArchived = async (id, value) => {
        await set(id, value);
        throw new Error("Lost acknowledgement");
      };
    await f
      .runner(() => fake.runtime, {
        ...(interruption === "after-ack-before-checkpoint"
          ? {
              afterEffect: async () => {
                throw new Error("Crash before receipt checkpoint");
              },
            }
          : {}),
      })
      .sweep();
    assert.deepEqual(fake.effects, [f.threadId]);
    assert.ok(f.store().pendingCleanup().length);
    const bytes = await readFile(fake.file(f.threadId), "utf8");
    await f.service.stop();
    await f.service.start(); // Startup without a fake archive method retains pending.
    await startedOf(f.service).projectDeletionCleanup.sweep();
    fake.runtime.setThreadArchived = set;
    await f.runner(() => fake.runtime).sweep();
    assert.deepEqual(fake.effects, [f.threadId]);
    assert.equal(f.store().pendingCleanup().length, 0);
    assert.equal(await readFile(fake.file(f.threadId), "utf8"), bytes);
    f.assertDeleted();
  });

test("unavailable runtime and failed archive leave a safe pending reason and a replayable committed delete", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true });
  const result = await f.commit();
  await f.runner().sweep();
  assert.ok(
    f
      .store()
      .status(f.projectId)!
      .cleanup.some(
        (item) =>
          item.kind === "codex-thread" &&
          item.state === "pending" &&
          item.reason === "unavailable",
      ),
  );
  const secret = "do-not-expose-provider-error";
  const runtime = {
    setThreadArchived: async () => {
      throw new Error(secret);
    },
  } as unknown as Runtime;
  await f.runner(() => runtime).sweep();
  assert.equal(
    JSON.stringify(f.store().status(f.projectId)).includes(secret),
    false,
  );
  assert.deepEqual(await f.service.deleteProject(f.command), result);
  f.assertDeleted();
});

test("unknown RPC stays serialized after the bounded pass; duplicate sweeps never dispatch another RPC", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true });
  await f.commit();
  const entered = deferred(),
    ack = deferred();
  let calls = 0;
  const runtime = {
    setThreadArchived: async () => {
      calls++;
      entered.resolve();
      await ack.promise;
    },
  } as unknown as Runtime;
  const runner = f.runner(() => runtime, { budgetMs: 10 }),
    first = runner.sweep(),
    second = runner.sweep();
  assert.equal(first, second);
  await entered.promise;
  await first;
  assert.equal(calls, 1);
  assert.ok(f.store().pendingCleanup().length);
  await runner.sweep();
  assert.equal(calls, 1);
  ack.resolve();
  await runner.settle();
  // The fake acknowledges the idempotent read/archive on retry; no physical deletion is duplicated.
  await runner.sweep();
  assert.equal(f.store().pendingCleanup().length, 0);
});

test("legacy restore is fenced during pending archive and after completed payload pruning", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true });
  await f.commit();
  const entered = deferred(),
    ack = deferred(),
    calls: boolean[] = [];
  const runtime = {
    setThreadArchived: async (_id: string, value: boolean) => {
      calls.push(value);
      entered.resolve();
      await ack.promise;
    },
  } as unknown as Runtime;
  const runner = f.runner(() => runtime),
    cleanup = runner.sweep();
  await entered.promise;
  const archival = startedOf(f.service).conversationArchival;
  const restore = assert.rejects(
    archival.restore(runtime, f.threadId),
    /Archived/,
  );
  ack.resolve();
  await Promise.all([cleanup, restore]);
  assert.deepEqual(calls, [true]);
  assert.ok(isDeletedProjectThread(databaseOf(f.service), f.threadId));
  assert.equal(
    String(
      databaseOf(f.service)
        .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId=?")
        .get(f.projectId)!.cleanupJson,
    ).includes(f.threadId),
    false,
    "completed payload prunes raw thread identity",
  );
  await assert.rejects(archival.restore(runtime, f.threadId), /Archived/);
  assert.deepEqual(calls, [true]);
});

test("an already archived captured thread converges and never removes retained archive files", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true }),
    fake = await fakeArchive(f.fixture.directory);
  await fake.runtime.setThreadArchived!(f.threadId, true);
  await f.commit();
  const before = await readFile(fake.file(f.threadId), "utf8");
  await f.runner(() => fake.runtime).sweep();
  assert.deepEqual(fake.effects, [f.threadId]);
  assert.equal(await readFile(fake.file(f.threadId), "utf8"), before);
  assert.equal(f.store().pendingCleanup().length, 0);
});

test("a new surviving execution claiming the captured thread refuses archival", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true }),
    fake = await fakeArchive(f.fixture.directory);
  await f.commit();
  databaseOf(f.service)
    .prepare("UPDATE execution_intents SET threadId=? WHERE workId=?")
    .run(f.threadId, f.workB);
  await f.runner(() => fake.runtime).sweep();
  assert.equal(fake.calls.length, 0);
  assert.ok(f.store().pendingCleanup().length);
  f.assertDeleted();
});

test("shutdown after dispatch keeps pending even when acknowledgement arrives after the database closes", async (t) => {
  const f = await deletedCleanupFixture(t, { thread: true });
  await f.commit();
  const entered = deferred(),
    ack = deferred();
  let accepting = true;
  const runtime = {
    setThreadArchived: async () => {
      entered.resolve();
      await ack.promise;
    },
  } as unknown as Runtime;
  const cleanup = f
    .runner(() => runtime, { accepting: () => accepting })
    .sweep();
  await entered.promise;
  accepting = false;
  await f.service.stop();
  ack.resolve();
  await cleanup;
  await f.service.start();
  await startedOf(f.service).projectDeletionCleanup.sweep();
  assert.ok(f.store().pendingCleanup().length);
  await f.runner(() => runtime).sweep();
  assert.equal(f.store().pendingCleanup().length, 0);
  f.assertDeleted();
});
