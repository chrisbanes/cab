import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  FailureEvidence,
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import type { RuntimeProcessIdentity } from "../../src/standalone/recovery-types.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { allowanceWaitPrefix } from "../../src/standalone/state.js";
import { sourceRepository } from "../fixtures/drafting.js";
import { ManualRestartClock, settle } from "../fixtures/restart-clock.js";
import { startedOf } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";
import { QUIET_WINDOW_MS } from "../fixtures/until.js";
import { BoundRuntime, boundWorld } from "./bound-turn-recovery-fixture.js";

type Outcome = "completed" | "failed";

/** One bound turn as the fake runtime sees it, with the cab tools it may call. */
interface Turn {
  threadId: string;
  turnId: string;
  workId: string;
  assignmentId: string | null;
  call(tool: string, args: Record<string, unknown>): Promise<RuntimeToolResult>;
  /** Ends when the turn is interrupted (`failed`) or `finish`ed. */
  wait(): Promise<Outcome>;
}

const report = async (turn: Turn): Promise<Outcome> => {
  const result = await turn.call("cab_report_result", {
    summary: `Done in ${turn.turnId}`,
  });
  assert.equal(result.success, true, result.text);
  return "completed";
};

/** A runtime whose every turn runs `onTurn`; by default it reports a result and completes. */
class LifecycleRuntime implements Runtime {
  service: StandaloneService | undefined;
  onTurn: (turn: Turn) => Promise<Outcome> = report;
  startThreadError: (() => Error) | undefined;
  startTurnError: (() => Error) | undefined;
  startTurnCalls = 0;
  readonly startedTurns: string[] = [];
  readonly interrupted: string[] = [];
  readonly failures = new Map<string, FailureEvidence>();
  private threads = 0;
  private readonly waits = new Map<
    string,
    { resolve: (outcome: Outcome) => void; reject: (error: Error) => void }
  >();
  private listener:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  async start() {}
  async stop() {
    for (const wait of this.waits.values())
      wait.reject(new Error("runtime stopped"));
    this.waits.clear();
  }
  async startThread() {
    if (this.startThreadError) throw this.startThreadError();
    return `thread-${++this.threads}`;
  }
  async resumeThread() {}
  async startTurn() {
    this.startTurnCalls++;
    if (this.startTurnError) throw this.startTurnError();
    const turnId = `turn-${this.startedTurns.length + 1}`;
    this.startedTurns.push(turnId);
    return turnId;
  }
  async interruptTurn(_threadId: string, turnId: string) {
    this.interrupted.push(turnId);
    this.finish(turnId, "failed");
  }
  finish(turnId: string, outcome: Outcome = "completed") {
    this.waits.get(turnId)?.resolve(outcome);
    this.waits.delete(turnId);
  }
  async waitForTurn(threadId: string, turnId: string) {
    const service = this.service;
    assert.ok(service);
    const intent = service
      .list()
      .find((item) => item.threadId === threadId && item.turnId === turnId);
    assert.ok(intent, `turn ${turnId} is bound`);
    const request = service
      .turnRequests()
      .find((item) => item.workId === intent.workId);
    return this.onTurn({
      threadId,
      turnId,
      workId: intent.workId,
      assignmentId: request?.assignmentId ?? null,
      call: (tool, args) => {
        assert.ok(this.listener);
        return this.listener({
          threadId,
          turnId,
          callId: randomUUID(),
          tool,
          arguments: args,
        });
      },
      wait: () =>
        new Promise<Outcome>((resolve, reject) =>
          this.waits.set(turnId, { resolve, reject }),
        ),
    });
  }
  failureEvidence(_threadId: string, turnId: string) {
    return this.failures.get(turnId);
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.listener = listener;
  }
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const quiet = () =>
  new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));

/** A paused project whose ready task's lead runs on the fake runtime; the service can restart. */
async function world(
  t: { after: (fn: () => Promise<void> | void) => void },
  options: { backoffMs?: number; now?: () => number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cab-allowance-lifecycle-"));
  const runtime = new LifecycleRuntime();
  const services: StandaloneService[] = [];
  t.after(async () => {
    for (const service of services) await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  let service!: StandaloneService;
  const open = async () => {
    service = new StandaloneService(
      join(root, "data"),
      () => runtime,
      undefined,
      {
        power: { enabled: false },
        routingClient: null,
        supervisor: { observationMs: 5, shutdownWaitMs: 2000 },
        retry: {
          fallbackBackoffMs: options.backoffMs ?? 0,
          ...(options.now ? { now: options.now } : {}),
        },
      },
    );
    services.push(service);
    runtime.service = service;
    await service.start();
    return service;
  };
  await open();
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  execute({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "build",
    capabilities: "coordination",
  });
  execute({
    type: "project.create",
    projectId,
    name: "Allowance lifecycle",
    leadProfileId: profileId,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: true,
  });
  execute({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Allowance",
    outcome: "Run",
    ready: true,
  });
  await service.provisionTask(taskId);
  const assignmentId = String(service.domain().assignments(taskId)[0]!.id);
  const db = () => (service as unknown as { db: DatabaseSync }).db;
  const f = {
    root,
    runtime,
    profileId,
    projectId,
    taskId,
    assignmentId,
    initial: `assignment:${assignmentId}:initial`,
    get service() {
      return service;
    },
    open,
    execute,
    db,
    allowance: (id = taskId) => service.taskAllowance(id),
    /** The task's charge rows, oldest first. */
    charges: (id = taskId) =>
      (
        db()
          .prepare(
            "SELECT workId, correctedAt IS NOT NULL AS corrected FROM task_execution_charges WHERE taskId = ? ORDER BY rowid",
          )
          .all(id) as Array<{ workId: string; corrected: number }>
      ).map((row) => ({ ...row })),
    set(total: number | null) {
      return service.setTaskAllowance({
        key: randomUUID(),
        taskId,
        expectedAllowanceVersion: service.taskAllowance(taskId).version,
        total,
      });
    },
    paused(paused: boolean) {
      execute({
        type: "project.configure",
        projectId,
        expectedVersion: Number(service.domain().project(projectId).version),
        paused,
      });
    },
    message(text = "Continue") {
      return service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId,
        recipientAssignmentId: assignmentId,
        expectedAssignmentVersion: Number(
          service.domain().assignment(assignmentId).version,
        ),
        message: text,
      });
    },
    intent: (workId: string) =>
      service.list().find((item) => item.workId === workId),
    request: (workId: string) =>
      service.turnRequests().find((item) => item.workId === workId),
    count(sql: string, ...args: string[]) {
      return Number(
        (
          db()
            .prepare(sql)
            .get(...args) as { n: number }
        ).n,
      );
    },
    /** Nothing of the task is queued, active or live. */
    settled: () =>
      service
        .turnRequests()
        .every(
          (r) => r.taskId !== taskId || !["queued", "active"].includes(r.state),
        ) &&
      service
        .list()
        .every((i) => !["ready", "submitting", "running"].includes(i.state)),
    describe: () => ({
      allowance: service.taskAllowance(taskId),
      requests: service
        .turnRequests()
        .map((r) => [r.workId, r.state, r.reason]),
      intents: service.list().map((i) => [i.workId, i.state, i.reason]),
    }),
  };
  return f;
}

const isAllowanceHeld = (reason: string | null | undefined) =>
  (reason ?? "").startsWith(allowanceWaitPrefix);

test("delegation and callbacks charge nothing, each admission and a draft turn charge one, and unbound work never charges the task", async (t) => {
  const f = await world(t);
  const depth = new Map<string, number>([[f.assignmentId, 0]]);
  const delegated = new Set<string>();
  /** A cab callback, asserted to leave the task's consumption unchanged. */
  const callback = async (
    turn: Turn,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const before = f.allowance().charged;
    const result = await turn.call(tool, args);
    assert.equal(result.success, true, result.text);
    assert.equal(f.allowance().charged, before, `${tool} charges nothing`);
  };
  // Lead → child → nested child; each result wakes its requester.
  f.runtime.onTurn = async (turn) => {
    const assignment = String(turn.assignmentId);
    const level = depth.get(assignment);
    assert.notEqual(level, undefined, turn.workId);
    if (level! < 2 && !delegated.has(assignment)) {
      delegated.add(assignment);
      await callback(turn, "cab_delegate", {
        profileId: f.profileId,
        brief: `Level ${level! + 1}`,
      });
      const child = f.service
        .domain()
        .assignments(f.taskId)
        .find((a) => !depth.has(String(a.id)));
      assert.ok(child);
      depth.set(String(child.id), level! + 1);
      // It reports once woken by its delegate's result.
      return "completed";
    }
    await callback(turn, "cab_report_result", { summary: `Level ${level}` });
    return "completed";
  };
  f.set(20);
  f.paused(false);
  await waitUntil(
    () =>
      depth.size === 3 &&
      f.service
        .domain()
        .assignments(f.taskId)
        .every((a) => a.state === "completed") &&
      f.settled(),
    f.describe,
  );
  // Lead, child and nested child first turns, then the child and lead woken by results.
  assert.equal(f.runtime.startedTurns.length, 5);
  const admitted = f.service
    .list()
    .map((i) => i.workId)
    .sort();
  assert.deepEqual(
    f
      .charges()
      .map((c) => c.workId)
      .sort(),
    admitted,
  );
  assert.ok(f.charges().every((c) => c.corrected === 0));
  assert.equal(f.allowance().charged, 5);
  assert.equal(f.allowance().corrected, 0);

  // Direct work and a project drafting run are not task work.
  f.runtime.onTurn = async () => "completed";
  const workspace = join(f.root, "direct");
  mkdirSync(workspace);
  await f.service.submit("direct-work", "Direct", workspace);
  await waitUntil(
    () => f.intent("direct-work")?.state === "completed",
    f.describe,
  );
  await f.service.domain().configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.service.domain().repositoryLinks(f.projectId).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "repo-alpha",
        path: sourceRepository(f.root),
        ref: "main",
      },
    ],
  });
  const runId = randomUUID();
  await f.service.draftingCommand({
    type: "drafting.start",
    key: randomUUID(),
    runId,
    projectId: f.projectId,
    idea: "A small idea",
  });
  await waitUntil(
    () =>
      f.runtime.startedTurns.length === 7 &&
      f.intent(`drafting:${runId}`)?.state !== "running",
    f.describe,
  );
  assert.equal(f.allowance().charged, 5);
  assert.equal(
    f.count("SELECT COUNT(*) AS n FROM task_execution_charges"),
    5,
    "neither direct nor drafting work has a charge",
  );

  // A draft turn of another task charges that task once.
  const draftTaskId = randomUUID();
  f.execute({
    type: "task.create",
    projectId: f.projectId,
    taskId: draftTaskId,
    title: "Draft",
    outcome: "Explore",
    ready: false,
  });
  await f.service.provisionTask(draftTaskId);
  const draft = await f.service.startDraftTurn({
    key: randomUUID(),
    taskId: draftTaskId,
    expectedVersion: Number(f.service.domain().task(draftTaskId).version),
    message: "Look into it",
  });
  await waitUntil(
    () => f.intent(draft.workId)?.state === "completed",
    f.describe,
  );
  assert.deepEqual(f.charges(draftTaskId), [
    { workId: draft.workId, corrected: 0 },
  ]);
  assert.equal(f.allowance(draftTaskId).charged, 1);
  assert.equal(f.allowance().charged, 5);
});

test("a lost turn-start reply stays charged and is never dispatched again, also after a restart", async (t) => {
  const f = await world(t);
  f.set(5);
  f.runtime.startTurnError = () => new Error("turn/start timed out");
  f.paused(false);
  await waitUntil(() => f.intent(f.initial)?.state === "held", f.describe);
  assert.match(f.intent(f.initial)?.reason ?? "", /uncertain/);
  assert.equal(f.intent(f.initial)?.turnId, null, "no turn ID was recorded");
  f.runtime.startTurnError = undefined;
  const expect = () => {
    assert.equal(f.runtime.startTurnCalls, 1, "not redispatched");
    assert.deepEqual(f.charges(), [{ workId: f.initial, corrected: 0 }]);
    assert.equal(f.allowance().charged, 1);
    assert.equal(
      f.service.turnRequests().filter((r) => r.taskId === f.taskId).length,
      1,
    );
    assert.equal(f.intent(f.initial)?.state, "held");
  };
  await quiet();
  expect();
  await f.service.stop();
  await f.open();
  await quiet();
  expect();
});

test("each cab retry generation charges one, backoff charges nothing and the retry limit holds", async (t) => {
  const backoffMs = 300;
  // A manual retry clock: backoff ends only when the test moves time and wakes the scheduler.
  let clock = Date.now();
  const f = await world(t, { backoffMs, now: () => clock });
  const elapse = async () => {
    clock += backoffMs;
    await startedOf(f.service).scheduler.wake();
  };
  f.set(10);
  f.runtime.onTurn = async (turn) => {
    await report(turn);
    f.runtime.failures.set(turn.turnId, {
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: "failed",
      classification: "transient",
      reasonCode: "serverOverloaded",
      source: "harness",
      harnessRetries: 0,
    });
    return "failed";
  };
  f.paused(false);
  const retries = () =>
    f.service.turnRequests().filter((r) => r.workId.startsWith("retry:"));
  await waitUntil(() => retries().length === 1, f.describe);
  // Waiting out the backoff admits nothing.
  await quiet();
  assert.equal(f.request(retries()[0]!.workId)?.state, "queued");
  assert.equal(f.allowance().charged, 1);
  assert.equal(f.runtime.startedTurns.length, 1);
  await elapse();
  await waitUntil(() => retries().length === 2, f.describe);
  await quiet();
  assert.equal(f.request(retries()[1]!.workId)?.state, "queued");
  assert.equal(f.allowance().charged, 2);
  assert.equal(f.runtime.startedTurns.length, 2);
  await elapse();
  await waitUntil(
    () => f.runtime.startedTurns.length === 3 && f.settled(),
    f.describe,
  );
  await elapse();
  await quiet();
  assert.equal(f.runtime.startedTurns.length, 3, "two cab retries at most");
  assert.deepEqual(
    f.charges().map((c) => c.workId),
    [f.initial, ...retries().map((r) => r.workId)],
  );
  assert.ok(f.charges().every((c) => c.corrected === 0));
  assert.equal(f.allowance().charged, 3);
});

test("a planned-shutdown requeue waits on a used allowance and charges one when admitted", async (t) => {
  const f = await world(t);
  f.runtime.onTurn = (turn) => turn.wait();
  f.set(1);
  f.paused(false);
  await waitUntil(() => f.intent(f.initial)?.state === "running", f.describe);
  await f.service.stop();
  assert.deepEqual(f.runtime.interrupted, ["turn-1"]);
  f.runtime.onTurn = report;
  await f.open();
  const requeue = () =>
    f.service.turnRequests().find((r) => r.workId.startsWith("shutdown:"));
  await waitUntil(() => isAllowanceHeld(requeue()?.reason), f.describe);
  const workId = requeue()!.workId;
  assert.equal(f.intent(f.initial)?.state, "resolved-failed");
  assert.deepEqual(f.allowance().heldWorkIds, [workId]);
  assert.deepEqual(f.charges(), [{ workId: f.initial, corrected: 0 }]);
  assert.equal(f.runtime.startedTurns.length, 1);

  f.set(2);
  await waitUntil(() => f.intent(workId)?.state === "completed", f.describe);
  assert.deepEqual(f.charges(), [
    { workId: f.initial, corrected: 0 },
    { workId, corrected: 0 },
  ]);
  assert.equal(f.allowance().charged, 2);
});

test("follow-up, Start again, Reset and conversation replacement keep the total and consumption", async (t) => {
  const f = await world(t);
  f.set(1);
  // A proved pre-turn refusal leaves Start again available and corrects its charge.
  f.runtime.startThreadError = () => new Error("Runtime stopped");
  f.paused(false);
  await waitUntil(() => f.request(f.initial)?.state === "held", f.describe);
  assert.equal(f.allowance().charged, 0);
  f.runtime.startThreadError = undefined;
  f.set(0);

  /** `act` queues a fresh turn: it waits on the used allowance until one more unit is set. */
  const fresh = async (name: string, act: () => Promise<unknown> | unknown) => {
    const before = f.allowance();
    assert.equal(before.remaining, 0, name);
    await act();
    await waitUntil(() => f.allowance().heldWorkIds.length === 1, f.describe);
    const after = f.allowance();
    assert.deepEqual(
      [after.total, after.version, after.charged, after.corrected],
      [before.total, before.version, before.charged, before.corrected],
      name,
    );
    const [held] = after.heldWorkIds;
    f.set(before.total! + 1);
    await waitUntil(
      () => f.intent(held!)?.state === "completed" && f.settled(),
      f.describe,
    );
    assert.equal(f.allowance().charged, before.charged + 1, name);
    assert.deepEqual(f.charges().at(-1), { workId: held, corrected: 0 }, name);
  };
  await fresh("Start again", () =>
    f.service.startAgain({
      key: randomUUID(),
      taskId: f.taskId,
      expectedVersion: Number(f.service.domain().task(f.taskId).version),
      workId: f.initial,
    }),
  );
  await fresh("Reset", () =>
    f.service.resetTask({
      key: randomUUID(),
      taskId: f.taskId,
      expectedVersion: Number(f.service.domain().task(f.taskId).version),
    }),
  );
  await fresh("operator follow-up", () => f.message("Follow up"));
  // A replacement on its own queues nothing; Reset above replaced and admitted afresh.
  const before = f.allowance();
  f.service.replaceConversation(f.assignmentId);
  await quiet();
  assert.deepEqual(f.allowance(), before);
  assert.equal(f.allowance().charged, 3);
  assert.equal(f.allowance().corrected, 1);
});

test("exhaustion lets the active turn finish and holds what it queues, without extending the allowance", async (t) => {
  const f = await world(t);
  let child: string | undefined;
  let second: string | undefined;
  let woken: string | undefined;
  const effect = (workId: string) =>
    (
      f
        .db()
        .prepare(
          "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        )
        .get(workId) as { state: string } | undefined
    )?.state;
  const noStopOrRelease = () => {
    assert.equal(
      f.count("SELECT COUNT(*) AS n FROM execution_stop_targets"),
      0,
    );
    assert.equal(
      f.count("SELECT COUNT(*) AS n FROM execution_held_turn_releases"),
      0,
    );
  };
  f.runtime.onTurn = async (turn) => {
    if (turn.assignmentId !== f.assignmentId) return report(turn);
    if (!child) {
      const result = await turn.call("cab_delegate", {
        profileId: f.profileId,
        brief: "Child",
      });
      assert.equal(result.success, true, result.text);
      child = String(
        f.service
          .domain()
          .assignments(f.taskId)
          .find((a) => String(a.id) !== f.assignmentId)!.id,
      );
      return "completed";
    }
    // The lead woken by the child's result: the allowance is used up under it.
    woken = turn.workId;
    const used = f.allowance().charged;
    assert.equal(used, 3, "lead, child, then the lead woken by its result");
    f.set(used);
    const { total, version } = f.allowance();
    const delegated = await turn.call("cab_delegate", {
      profileId: f.profileId,
      brief: "Second child",
    });
    assert.equal(delegated.success, true, delegated.text);
    second = String(
      f.service
        .domain()
        .assignments(f.taskId)
        .find((a) => ![f.assignmentId, child].includes(String(a.id)))!.id,
    );
    const { resultId } = f
      .db()
      .prepare(
        "SELECT resultId FROM coordination_results WHERE assignmentId = ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(child) as { resultId: string };
    const followUp = await turn.call("cab_request_follow_up", {
      resultId,
      instructions: "Again",
    });
    assert.equal(followUp.success, true, followUp.text);
    await quiet();
    assert.equal(f.intent(turn.workId)?.state, "running");
    assert.equal(effect(turn.workId), "pending");
    noStopOrRelease();
    assert.deepEqual(
      [f.allowance().total, f.allowance().version],
      [total, version],
    );
    assert.equal(f.allowance().charged, used);
    // Its delegates are unfinished, so it reports once woken again.
    return "completed";
  };
  f.paused(false);
  await waitUntil(
    () =>
      woken !== undefined &&
      f.intent(woken)?.state === "completed" &&
      f.allowance().heldWorkIds.length === 2,
    f.describe,
  );
  await quiet();
  assert.notEqual(effect(woken!), "pending", "settled at its terminal");
  noStopOrRelease();
  const held = f.allowance().heldWorkIds;
  const assignmentOf = (workId: string) => f.request(workId)?.assignmentId;
  assert.deepEqual(held.map(assignmentOf).sort(), [child, second].sort());
  for (const workId of held)
    assert.ok(isAllowanceHeld(f.request(workId)?.reason));
  assert.equal(f.allowance().charged, 3);
  assert.equal(f.allowance().total, 3);
  assert.equal(f.runtime.startedTurns.length, 3);
});

/** Copied from held-turn-release.test.ts: a bound turn whose observation is lost. */
class HeldTurnRuntime extends BoundRuntime {
  readonly interrupts: [string, string][] = [];
  override processIdentity(): RuntimeProcessIdentity {
    return this.identity;
  }
  override async interruptTurn(threadId?: string, turnId?: string) {
    this.interrupts.push([String(threadId), String(turnId)]);
  }
  override async waitForTurn(threadId: string, turnId: string) {
    if (this.turnInvocations.length <= 1)
      return super.waitForTurn(threadId, turnId);
    await new Promise(() => {});
    return "completed" as const;
  }
}

for (const allowance of ["off", "exhausted"] as const)
  test(`a held turn's quiet release is unchanged with the allowance ${allowance} and leaves its consumption`, async (t) => {
    const runtime = new HeldTurnRuntime();
    const clock = new ManualRestartClock();
    const w = await boundWorld(t, "codex", [], false, false, {
      runtime,
      mode: "unknown",
      heldTurnRelease: { clock, wallNow: clock.wallNow },
    });
    const service = w.s.f.service;
    const db = () =>
      // biome-ignore lint/complexity/useLiteralKeys: private member access for tests
      startedOf(service).state["db"] as DatabaseSync;
    const one = (sql: string) => {
      const row = db().prepare(sql).get(w.g.workId);
      return row ? { ...row } : null;
    };
    const rows = () => ({
      intent: one("SELECT state FROM execution_intents WHERE workId=?"),
      capacity: one(
        "SELECT 1 AS held FROM execution_capacity_reservations WHERE workId=?",
      ),
      writer: one(
        "SELECT 1 AS held FROM task_writer_admissions WHERE workId=?",
      ),
      basis: one(
        "SELECT basis FROM execution_held_turn_releases WHERE workId=?",
      ),
    });
    const consumption = () => {
      const { charged, corrected } = service.taskAllowance(w.g.taskId);
      return { charged, corrected };
    };
    await settle(() => rows().basis !== null);
    assert.deepEqual(consumption(), { charged: 1, corrected: 0 });
    if (allowance === "exhausted") {
      service.setTaskAllowance({
        key: randomUUID(),
        taskId: w.g.taskId,
        expectedAllowanceVersion: 0,
        total: 1,
      });
      assert.equal(service.taskAllowance(w.g.taskId).remaining, 0);
    }
    // Reattaching the held turn after a restart charges nothing.
    await service.stop();
    await service.start();
    assert.deepEqual(consumption(), { charged: 1, corrected: 0 });
    for (const ms of [20, 10, 1] as const) {
      clock.advance(ms * 60_000);
      await settle(() => clock.pending() > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await settle(
      () => (rows().basis as { basis?: string } | null)?.basis != null,
      rows,
    );
    assert.deepEqual(rows(), {
      intent: { state: "resolved-failed" },
      capacity: null,
      writer: null,
      basis: { basis: "quiet-period" },
    });
    // Interrupted once per start, as without an allowance.
    assert.deepEqual(runtime.interrupts, [
      [w.g.threadId, w.g.turnId],
      [w.g.threadId, w.g.turnId],
    ]);
    assert.deepEqual(consumption(), { charged: 1, corrected: 0 });
  });
