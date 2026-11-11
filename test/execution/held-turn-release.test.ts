import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RuntimeConversationEvent } from "../../src/standalone/codex.js";
import type { RuntimeProcessIdentity } from "../../src/standalone/recovery-types.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { ManualRestartClock, settle } from "../fixtures/restart-clock.js";
import { startedOf } from "../fixtures/service-internals.js";
import { BoundRuntime, boundWorld } from "./bound-turn-recovery-fixture.js";

const minute = 60_000;

/** A bound turn whose observation is lost; later turns wait until released by the test. */
class HeldTurnRuntime extends BoundRuntime {
  readonly interrupts: [string, string][] = [];
  stops = 0;
  starts = 0;
  noProcess = false;
  conversation: ((event: RuntimeConversationEvent) => void) | undefined;
  private finishLater!: () => void;
  private readonly later = new Promise<void>((resolve) => {
    this.finishLater = resolve;
  });
  override async start() {
    this.starts++;
  }
  override async stop() {
    this.stops++;
  }
  override processIdentity(): RuntimeProcessIdentity {
    return (this.noProcess ? null : this.identity) as RuntimeProcessIdentity;
  }
  override async interruptTurn(threadId?: string, turnId?: string) {
    this.interrupts.push([String(threadId), String(turnId)]);
  }
  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversation = listener;
  }
  override async waitForTurn(threadId: string, turnId: string) {
    // The seed turn and the held turn behave as `BoundRuntime`; a later turn runs until finished.
    if (this.turnInvocations.length <= (this.seedConversation ? 2 : 1))
      return super.waitForTurn(threadId, turnId);
    await this.later;
    return "completed" as const;
  }
  finish() {
    this.finishLater();
  }
}

async function heldWorld(
  t: { after(fn: () => unknown): void },
  options: {
    harness?: "codex" | "claude";
    seedConversation?: boolean;
    foreign?: HeldTurnRuntime;
  } = {},
) {
  const runtime = new HeldTurnRuntime();
  runtime.noProcess = options.harness === "claude";
  const clock = new ManualRestartClock();
  const w = await boundWorld(
    t,
    options.harness,
    [],
    false,
    options.seedConversation,
    {
      runtime,
      ...(options.foreign ? { foreign: options.foreign } : {}),
      mode: "unknown",
      heldTurnRelease: { clock, wallNow: clock.wallNow },
    },
  );
  const service = w.s.f.service;
  const db = () =>
    // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
    startedOf(service).state["db"] as import("node:sqlite").DatabaseSync;
  const rows = () => {
    const one = (sql: string) => {
      const row = db().prepare(sql).get(w.g.workId);
      return row ? { ...row } : null;
    };
    return {
      intent: one("SELECT state, reason FROM execution_intents WHERE workId=?"),
      request: one("SELECT state FROM turn_requests WHERE workId=?"),
      capacity: one(
        "SELECT 1 AS held FROM execution_capacity_reservations WHERE workId=?",
      ),
      writer: one(
        "SELECT 1 AS held FROM task_writer_admissions WHERE workId=?",
      ),
      release: one(
        "SELECT threadId, turnId, harness, interruptState, basis FROM execution_held_turn_releases WHERE workId=?",
      ),
      result: one(
        "SELECT state FROM execution_pending_effects WHERE workId=? AND effectKey='assignment-result'",
      ),
    };
  };
  const advance = async (ms: number) => {
    clock.advance(ms);
    await settle(() => clock.pending() > 0);
    // The sweep the wake started has finished once the next poll is armed and writes settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const released = () =>
    settle(
      () => rows().release?.basis != null,
      () => rows(),
    );
  return { ...w, runtime, clock, db, rows, advance, released };
}

test("a held Codex turn is interrupted once and released when the runtime reports its end", async (t) => {
  const w = await heldWorld(t);
  await settle(() => w.rows().release !== null);
  assert.deepEqual(w.runtime.interrupts, [[w.g.threadId, w.g.turnId]]);
  await settle(() => w.rows().release?.interruptState === "acknowledged");
  assert.equal(w.rows().release?.basis, null);
  assert.ok(w.rows().capacity && w.rows().writer);
  const read = await new OperatorApi(w.s.f.service).readTask(w.g.taskId);
  assert.equal(read.data.execution.state, "uncertain");
  assert.ok(read.data.execution.reasonCodes.includes("turn-release-pending"));
  assert.equal(read.data.startAgain?.available, false);

  // The runtime durably records the turn's terminal, as both harnesses do.
  w.db()
    .prepare(`INSERT INTO runtime_terminal_evidence (threadId, turnId, firstStatus,
      workId, firstRuntimeGeneration, lastRuntimeGeneration, firstObservedAt, lastObservedAt)
      VALUES (?, ?, 'failed', ?, 'g', 'g', 1, 1)`)
    .run(w.g.threadId, w.g.turnId, w.g.workId);
  await w.advance(minute);
  await w.released();

  const after = w.rows();
  assert.equal(after.intent?.state, "resolved-failed");
  assert.match(String(after.intent?.reason), /reported the turn ended/);
  assert.deepEqual(after.request, { state: "held" });
  assert.equal(after.capacity, null);
  assert.equal(after.writer, null);
  assert.equal(after.release?.basis, "turn-ended");
  assert.notEqual(after.result?.state, "pending");
  assert.deepEqual(w.runtime.interrupts, [[w.g.threadId, w.g.turnId]]);
  // Only `interruptTurn`: the shared runtime is never stopped or restarted.
  assert.equal(w.runtime.stops, 0);
  assert.equal(w.runtime.starts, 1);
});

test("a held Codex turn is released at startup when its process is verified to have exited", async (t) => {
  const w = await heldWorld(t);
  await settle(() => w.rows().release !== null);
  await w.s.f.service.stop();
  await w.s.f.service.start();
  // Still unknown after a restart: nothing is released.
  assert.equal(w.rows().release?.basis, null);
  assert.ok(w.rows().capacity);
  await w.s.f.service.stop();
  w.setMode("verified");
  await w.s.f.service.start();
  // Before any clock advance or admission.
  assert.equal(w.rows().release?.basis, "process-exited");
  assert.equal(w.rows().capacity, null);
  assert.equal(w.runtime.stops, 2);
});

test("a held turn whose process exits after cab starts watching it is released on a later check", async (t) => {
  const w = await heldWorld(t);
  await settle(() => w.rows().release !== null);
  // Alive on the first check; then the process exits, for example after the interrupt.
  assert.equal(w.rows().release?.basis, null);
  w.setMode("verified");
  await w.advance(minute);
  await w.released();
  assert.equal(w.rows().release?.basis, "process-exited");
  assert.equal(w.rows().capacity, null);
  assert.equal(w.rows().writer, null);
});

test("a held Codex turn is released after 30 minutes with no event for it", async (t) => {
  const w = await heldWorld(t);
  await settle(() => w.rows().release !== null);
  await w.advance(20 * minute);
  // Activity for the exact turn restarts the quiet period.
  w.runtime.conversation?.({
    threadId: w.g.threadId,
    turnId: w.g.turnId,
  } as RuntimeConversationEvent);
  await w.advance(10 * minute);
  assert.equal(w.rows().release?.basis, null);
  await w.advance(19 * minute + 59_000);
  assert.equal(w.rows().release?.basis, null);
  await w.advance(1000);
  await w.released();
  assert.equal(w.rows().release?.basis, "quiet-period");
  assert.equal(w.rows().capacity, null);
});

test("a held turn whose turn ID was never saved waits for a verified process exit, not silence", async (t) => {
  const w = await heldWorld(t);
  await settle(() => w.rows().release !== null);
  // As after a lost turn/start reply: the thread is saved, the turn is not.
  w.db()
    .prepare("UPDATE execution_intents SET turnId = NULL WHERE workId = ?")
    .run(w.g.workId);
  w.db()
    .prepare(
      "UPDATE execution_recovery_identities SET turnId = NULL WHERE workId = ?",
    )
    .run(w.g.workId);
  await w.advance(minute);
  assert.equal(w.rows().release?.interruptState, "unbound");
  await w.advance(31 * minute);
  await w.advance(minute);
  assert.equal(w.rows().release?.basis, null);
  assert.ok(w.rows().capacity);
  // It has no quiet deadline, so the release loop keeps the normal poll interval.
  assert.deepEqual(w.clock.requested.slice(-3), [minute, minute, minute]);
  await w.s.f.service.stop();
  w.setMode("verified");
  await w.s.f.service.start();
  assert.equal(w.rows().release?.basis, "process-exited");
});

for (const basis of ["turn-ended", "quiet-period"] as const)
  test(`a held Claude turn is released on ${basis} without process proof`, async (t) => {
    const w = await heldWorld(t, { harness: "claude" });
    await settle(() => w.rows().release !== null);
    assert.equal(w.rows().release?.harness, "claude");
    if (basis === "turn-ended")
      w.db()
        .prepare(`INSERT INTO runtime_terminal_evidence (threadId, turnId, firstStatus,
          workId, firstRuntimeGeneration, lastRuntimeGeneration, firstObservedAt,
          lastObservedAt, harness)
          VALUES (?, ?, 'failed', ?, 'g', 'g', 1, 1, 'claude')`)
        .run(w.g.threadId, w.g.turnId, w.g.workId);
    await w.advance(basis === "turn-ended" ? minute : 30 * minute);
    await w.released();
    assert.equal(w.rows().release?.basis, basis);
    // Claude records no process identity, so the verifier is never asked.
    assert.equal(w.checks(), 0);
  });

for (const hold of ["stop", "task-hold", "pending-effect", "callback"] as const)
  test(`an independent ${hold} keeps a held turn held`, async (t) => {
    const w = await heldWorld(t);
    await settle(() => w.rows().release !== null);
    if (hold === "stop") await w.s.f.service.stopTask(w.g.taskId);
    if (hold === "task-hold")
      w.db()
        .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
        .run(w.g.taskId, "Fixture task hold");
    if (hold === "pending-effect")
      w.db()
        .prepare(`INSERT INTO execution_pending_effects (workId, effectKey, state, reason)
          VALUES (?, 'external-action:fixture', 'pending', 'Fixture effect')`)
        .run(w.g.workId);
    if (hold === "callback")
      w.s.f.service.registerExecutionCallback(
        w.g.workId,
        new Promise(() => {}),
      );
    await w.advance(31 * minute);
    await w.advance(minute);
    assert.equal(w.rows().release?.basis, null);
    assert.ok(w.rows().capacity);
    assert.equal(w.rows().intent?.state, "held");
    // Release interrupted it once; a Stop sends its own interrupt.
    assert.equal(w.runtime.interrupts.length, hold === "stop" ? 2 : 1);
  });

test("Start again continues a released turn's conversation; later activity for it holds the task", async (t) => {
  const w = await heldWorld(t, { seedConversation: true });
  await settle(() => w.rows().release !== null);
  await w.advance(30 * minute);
  await w.released();
  const service = w.s.f.service;
  const api = new OperatorApi(service);
  const read = (await api.readTask(w.g.taskId)).data;
  assert.equal(read.execution.state, "not-started");
  assert.deepEqual(read.execution.reasonCodes, ["held-turn-released"]);
  assert.deepEqual(read.startAgain, {
    available: true,
    assignmentId: w.g.assignmentId,
    workId: w.g.workId,
  });
  assert.ok(
    service
      .inboxConditions(w.g.taskId)
      .some(
        (c) =>
          c.code === "not-started" && /Start again continues/.test(c.reason),
      ),
  );
  const conversation = () =>
    w
      .db()
      .prepare(
        "SELECT revision FROM assignment_conversations WHERE assignmentId=?",
      )
      .get(w.g.assignmentId);
  const before = conversation();
  const resumed = w.runtime.resumed.length;
  const key = randomUUID();
  const command = {
    key,
    taskId: w.g.taskId,
    expectedVersion: Number(service.domain().task(w.g.taskId).version),
    workId: w.g.workId,
  };
  const receipt = await service.startAgain(command);
  assert.deepEqual(await service.startAgain(command), receipt);
  await settle(() =>
    service.list().some((i) => i.workId === receipt.workId && i.turnId),
  );
  // It resumes the conversation's thread; no replacement, receipt or message.
  assert.deepEqual(w.runtime.resumed.slice(resumed), [w.g.threadId]);
  assert.deepEqual(conversation(), before);
  assert.equal(
    w
      .db()
      .prepare("SELECT COUNT(*) AS n FROM execution_recovery_receipts")
      .get()?.n,
    0,
  );

  // The released turn shows activity after its successor started.
  w.runtime.conversation?.({
    threadId: w.g.threadId,
    turnId: w.g.turnId,
  } as RuntimeConversationEvent);
  const successor = () =>
    service.list().find((i) => i.workId === receipt.workId)?.state;
  await settle(() => successor() === "held");
  assert.ok(
    w
      .db()
      .prepare("SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId=?")
      .get(w.g.taskId),
  );
  assert.equal(
    w
      .db()
      .prepare(
        "SELECT state FROM execution_pending_effects WHERE workId=? AND effectKey='known-survivor'",
      )
      .get(w.g.workId)?.state,
    "pending",
  );
  assert.equal(service.startAgainAvailability(w.g.taskId).available, false);
  w.runtime.finish();
  await service.stop();
  await service.start();
  assert.ok(
    w
      .db()
      .prepare("SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId=?")
      .get(w.g.taskId),
  );
  assert.equal(service.startAgainAvailability(w.g.taskId).available, false);
});

test("activity another harness's runtime reports for a turn changes nothing", async (t) => {
  const foreign = new HeldTurnRuntime();
  const w = await heldWorld(t, { foreign });
  await settle(() => w.rows().release !== null);
  const claim = () =>
    foreign.conversation?.({
      threadId: w.g.threadId,
      turnId: w.g.turnId,
    } as RuntimeConversationEvent);
  assert.ok(foreign.conversation, "the foreign runtime is attached");
  // A Claude runtime naming the Codex turn does not restart its quiet period.
  await w.advance(20 * minute);
  claim();
  await w.advance(10 * minute);
  await w.released();
  assert.equal(w.rows().release?.basis, "quiet-period");
  // Nor does it re-hold the task once released.
  claim();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    w
      .db()
      .prepare("SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId=?")
      .get(w.g.taskId),
    undefined,
  );
  assert.ok(w.s.f.service.heldTurnReleased(w.g.workId));
});
