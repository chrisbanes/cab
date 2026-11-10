import { OperatorApi } from "../../src/standalone/operator-api.js";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainStore } from "../../src/core/domain.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import { RoutingAttemptStore } from "../../src/standalone/routing.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { tmpdir } from "../fixtures/temp.js";
import { startedOf } from "../fixtures/service-internals.js";

class FakeRuntime implements Runtime {
  turns = 0;
  release: Promise<void> | undefined;
  /** Ending each turn with a durable waiting action avoids reporting repairs. */
  asksQuestion = false;
  private starts = 0;
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  async start() {}
  async stop() {}
  async startThread() {
    return `thread-${++this.starts}`;
  }
  async resumeThread() {}
  async startTurn() {
    return `turn-${++this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn(threadId: string, turnId: string) {
    if (this.asksQuestion)
      await this.toolCall?.({
        threadId,
        turnId,
        callId: `question-${threadId}-${turnId}`,
        tool: "cab_ask_question",
        arguments: { question: "Waiting for the next step" },
      });
    await this.release;
    return "completed" as const;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

type Access = {
  db: DatabaseSync;
  wakeScheduler(...args: unknown[]): Promise<void>;
  finalizeDeliveryCompletion(requestId: string, workId: string): Promise<void>;
};
const access = (service: StandaloneService) => service as unknown as Access;

/** Full-history readers a controlled wake must never call. */
const wakeContext = new AsyncLocalStorage<true>();
function forbidFullHistoryReads() {
  const violations: string[] = [];
  const restore: Array<() => void> = [];
  const guard = <T extends object>(
    prototype: T,
    method: keyof T & string,
    full: (args: unknown[]) => boolean = () => true,
  ) => {
    const original = prototype[method] as unknown as (
      ...args: unknown[]
    ) => unknown;
    (prototype as Record<string, unknown>)[method] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (wakeContext.getStore() && full(args)) {
        violations.push(method);
        throw new Error(`wake called full-history reader ${method}`);
      }
      return original.apply(this, args);
    };
    restore.push(() => {
      (prototype as Record<string, unknown>)[method] = original;
    });
  };
  guard(SchedulerStore.prototype, "list");
  guard(CoordinationStore.prototype, "completionRequests", ([id]) => !id);
  guard(DomainStore.prototype, "routingOperations", ([id]) => !id);
  guard(RoutingAttemptStore.prototype, "operations", ([id]) => !id);
  return {
    violations,
    restore: () => {
      for (const undo of restore.reverse()) undo();
    },
  };
}

function observeWakes(service: StandaloneService) {
  const target = access(service);
  const original = target.wakeScheduler.bind(service);
  target.wakeScheduler = (...args: unknown[]) =>
    wakeContext.run(true, () => original(...args));
}

function execute(service: StandaloneService, command: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...command } as never);
}

interface Fixture {
  service: StandaloneService;
  runtime: FakeRuntime;
  profileId: string;
  projectId: string;
  wake(): Promise<void>;
  sql(query: string, ...parameters: Array<string | number | null>): unknown[];
  count(query: string, ...parameters: Array<string | number | null>): number;
  addTask(options?: { ready?: boolean; assignment?: string }): Promise<{
    taskId: string;
    assignmentId: string | undefined;
  }>;
  insertRequest(
    workId: string,
    assignmentId: string | null,
    state: string,
    extra?: Record<string, string | number | null>,
  ): void;
}

async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
  options: { lead?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cab-wake-"));
  const runtime = new FakeRuntime();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  const guard = forbidFullHistoryReads();
  try {
    await service.start();
    observeWakes(service);
    const profileId = randomUUID();
    const projectId = randomUUID();
    execute(service, {
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: options.lead === false ? null : profileId,
    });
    execute(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    const fixture: Fixture = {
      service,
      runtime,
      profileId,
      projectId,
      wake: () => access(service).wakeScheduler(),
      sql: (query, ...parameters) =>
        access(service)
          .db.prepare(query)
          .all(...parameters),
      count: (query, ...parameters) =>
        Number(
          (
            access(service)
              .db.prepare(query)
              .get(...parameters) as { count: number }
          ).count,
        ),
      async addTask(taskOptions = {}) {
        const taskId = randomUUID();
        execute(service, {
          type: "task.create",
          actor: "operator",
          projectId,
          taskId,
          title: "Task",
          outcome: "Deliver",
          ready: false,
        });
        await service.provisionTask(taskId);
        let assignmentId: string | undefined;
        if (taskOptions.assignment) {
          assignmentId = randomUUID();
          execute(service, {
            type: "assignment.create",
            actor: "agent",
            projectId,
            taskId,
            assignmentId,
            profileId,
            brief: taskOptions.assignment,
            resultDestination: "lead",
            requesterAssignmentId: null,
          });
        }
        if (taskOptions.ready !== false)
          execute(service, {
            type: "task.configure",
            actor: "operator",
            projectId,
            taskId,
            expectedVersion: 1,
            ready: true,
          });
        return { taskId, assignmentId };
      },
      insertRequest(workId, assignmentId, state, extra = {}) {
        const row: Record<string, string | number | null> = {
          requestKey: workId,
          workId,
          kind: "assignment",
          assignmentId,
          prompt: "prompt",
          state,
          ...extra,
        };
        const columns = Object.keys(row);
        access(service)
          .db.prepare(
            `INSERT INTO turn_requests (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row));
      },
    };
    await body(fixture);
    assert.deepEqual(guard.violations, []);
  } finally {
    guard.restore();
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

function insertFallbackOperation(
  fixture: Fixture,
  taskId: string,
  taskVersion: number,
  reason = "no-candidates",
) {
  const id = randomUUID();
  access(fixture.service)
    .db.prepare(
      `INSERT INTO routing_operations (id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief, payloadHash)
      VALUES (?, ?, ?, ?, NULL, '{}', 1, 'model', 'question', '{"kind":"lead-review"}', ?, 'lead:task', 'Review this', ?)`,
    )
    .run(
      id,
      fixture.projectId,
      taskId,
      taskVersion,
      `lead-review:${reason}`,
      id,
    );
  return id;
}

test("repeated and concurrent wakes admit each assignment once without full-history reads", async () => {
  await withFixture(async (fixture) => {
    const gate = deferred();
    fixture.runtime.release = gate.promise;
    const first = await fixture.addTask({ assignment: "First" });
    const second = await fixture.addTask({ assignment: "Second" });
    assert.equal(
      await waitUntil(() => fixture.runtime.turns === 2),
      true,
      "both assignments should be admitted",
    );
    await Promise.all([fixture.wake(), fixture.wake(), fixture.wake()]);
    await fixture.wake();
    assert.equal(fixture.runtime.turns, 2);
    for (const assignmentId of [first.assignmentId, second.assignmentId])
      assert.equal(
        fixture.count(
          "SELECT COUNT(*) AS count FROM turn_requests WHERE workId = ?",
          `assignment:${assignmentId}:initial`,
        ),
        1,
      );
    gate.resolve();
  });
});

test("unrelated request history does not change what a wake materializes", async () => {
  await withFixture(async (fixture) => {
    const gate = deferred();
    fixture.runtime.release = gate.promise;
    await fixture.addTask({ assignment: "Active" });
    assert.equal(await waitUntil(() => fixture.runtime.turns === 1), true);

    const parsed = { count: 0 };
    const prototype = SchedulerStore.prototype as unknown as {
      parse(row: Record<string, unknown>): unknown;
    };
    const original = prototype.parse;
    prototype.parse = function (this: unknown, row: Record<string, unknown>) {
      parsed.count++;
      return original.call(this, row);
    };
    try {
      await fixture.wake();
      const baseline = parsed.count;

      const prompt = "x".repeat(1024);
      const db = access(fixture.service).db;
      db.exec("BEGIN");
      for (let n = 0; n < 3000; n++)
        fixture.insertRequest(
          `history-${n}`,
          randomUUID(),
          n % 2 ? "completed" : "held",
          { prompt },
        );
      db.exec("COMMIT");

      parsed.count = 0;
      await fixture.wake();
      assert.equal(parsed.count, baseline);
      assert.equal(fixture.runtime.turns, 1);
    } finally {
      prototype.parse = original;
      gate.resolve();
    }
  });
});

test("a failed initial request holds the assignment's oldest request, not a newer one", async () => {
  await withFixture(async (fixture) => {
    const { assignmentId } = await fixture.addTask({
      assignment: "Obsolete",
      ready: false,
    });
    assert.ok(assignmentId);
    // An older request already owns the initial identity with another predecessor.
    fixture.insertRequest("history-oldest", assignmentId, "completed", {
      requestKey: `assignment:${assignmentId}:initial`,
      previousWorkId: "unrelated-predecessor",
    });
    fixture.insertRequest("history-newest", assignmentId, "completed");
    execute(fixture.service, {
      type: "task.configure",
      actor: "operator",
      projectId: fixture.projectId,
      taskId: fixture
        .sql("SELECT taskId FROM domain_assignments WHERE id = ?", assignmentId)
        .map((row) => (row as { taskId: string }).taskId)[0],
      expectedVersion: 1,
      ready: true,
    });
    assert.equal(
      await waitUntil(
        () =>
          fixture.count(
            "SELECT COUNT(*) AS count FROM turn_requests WHERE workId = 'history-oldest' AND state = 'held'",
          ) === 1,
      ),
      true,
    );
    const states = fixture.sql(
      "SELECT workId, state, reason FROM turn_requests WHERE assignmentId = ? ORDER BY sequence",
      assignmentId,
    ) as Array<{ workId: string; state: string; reason: string | null }>;
    assert.deepEqual(
      states.map((row) => [row.workId, row.state]),
      [
        ["history-oldest", "held"],
        ["history-newest", "completed"],
      ],
    );
    assert.match(
      states[0]?.reason ?? "",
      /^Assignment request became obsolete/,
    );
    assert.equal(fixture.runtime.turns, 0);
  });
});

test("routing fallback events are created once, survive restart and wait for a lead", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-wake-fallback-"));
  const dataDir = join(root, "data");
  const guard = forbidFullHistoryReads();
  const ensured: string[] = [];
  const original = CoordinationStore.prototype.ensureRoutingFallbackEvent;
  CoordinationStore.prototype.ensureRoutingFallbackEvent = function (
    this: CoordinationStore,
    input: Parameters<CoordinationStore["ensureRoutingFallbackEvent"]>[0],
  ) {
    ensured.push(input.routingOperationId);
    return original.call(this, input);
  };
  let service = new StandaloneService(dataDir, () => new FakeRuntime());
  try {
    await service.start();
    observeWakes(service);
    const profileId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    execute(service, {
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Lead",
      instructions: "lead",
      capabilities: "code",
    });
    execute(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "No lead yet",
      leadProfileId: null,
    });
    execute(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Task",
      outcome: "Deliver",
      ready: false,
    });
    const db = () => access(service).db;
    const events = (operationId: string) =>
      Number(
        (
          db()
            .prepare(
              "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE routingOperationId = ?",
            )
            .get(operationId) as { count: number }
        ).count,
      );
    const operationId = randomUUID();
    db()
      .prepare(
        `INSERT INTO routing_operations (id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief, payloadHash)
        VALUES (?, ?, ?, 99, NULL, '{}', 1, 'model', 'question', '{"kind":"lead-review"}', 'lead-review:no-candidates', 'lead:task', 'Review this', ?)`,
      )
      .run(operationId, projectId, taskId, operationId);
    // A case-different disposition is not a fallback.
    db()
      .prepare(
        `INSERT INTO routing_operations (id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief, payloadHash)
        VALUES (?, ?, ?, 100, NULL, '{}', 1, 'model', 'question', '{}', 'Lead-Review:no-candidates', 'lead:task', 'Review this', ?)`,
      )
      .run(randomUUID(), projectId, taskId, randomUUID());

    await access(service).wakeScheduler();
    assert.equal(events(operationId), 0, "no lead, so no recipient yet");
    assert.deepEqual(ensured, []);

    execute(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      leadProfileId: profileId,
    });
    await access(service).wakeScheduler();
    await access(service).wakeScheduler();
    assert.equal(events(operationId), 1);
    assert.deepEqual(
      ensured,
      [operationId],
      "existing events are not revisited",
    );

    await service.stop();
    service = new StandaloneService(dataDir, () => new FakeRuntime());
    await service.start();
    observeWakes(service);
    await access(service).wakeScheduler();
    assert.equal(events(operationId), 1);
    assert.deepEqual(ensured, [operationId]);
    assert.deepEqual(guard.violations, []);
  } finally {
    CoordinationStore.prototype.ensureRoutingFallbackEvent = original;
    guard.restore();
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale routing reconciles only uncommitted attempts, in order, from fresh state", async () => {
  await withFixture(async (fixture) => {
    const { taskId } = await fixture.addTask({ ready: false });
    const attemptStore = new RoutingAttemptStore(access(fixture.service).db);
    const snapshot = (taskVersion: number) => ({
      projectId: fixture.projectId,
      taskId,
      taskVersion,
      guidanceRevision: 1,
      brief: "Route this",
      findings: "",
      guidance: "route",
      candidates: [],
    });
    const stale = attemptStore.ensureOperation(snapshot(41));
    const committed = attemptStore.ensureOperation(snapshot(42));
    const alreadyStale = attemptStore.ensureOperation(snapshot(43));
    attemptStore.markStale(alreadyStale.operationId, "task-held");
    access(fixture.service)
      .db.prepare(
        `INSERT INTO routing_operations (id, projectId, taskId, taskVersion, assignmentId, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief, payloadHash)
        VALUES (?, ?, ?, 42, NULL, '{}', 1, 'model', 'question', '{}', 'assigned', 'lead:task', 'b', ?)`,
      )
      .run(
        committed.operationId,
        fixture.projectId,
        taskId,
        committed.operationId,
      );

    await fixture.wake();
    const status = (operationId: string) => ({
      ...(fixture.sql(
        "SELECT status, staleReason FROM routing_attempt_operations WHERE operationId = ?",
        operationId,
      )[0] as { status: string; staleReason: string | null }),
    });
    assert.deepEqual(status(stale.operationId), {
      status: "stale",
      staleReason: "task-revision-changed",
    });
    assert.deepEqual(status(committed.operationId), {
      status: "pending",
      staleReason: null,
    });
    assert.deepEqual(status(alreadyStale.operationId), {
      status: "stale",
      staleReason: "task-held",
    });
    // A later attempt created after the first wake is seen by the next one.
    const later = attemptStore.ensureOperation(snapshot(44));
    await fixture.wake();
    assert.equal(status(later.operationId).status, "stale");
  });
});

/** Completion requests whose lead work the wake sees as completed or not. */
function seedCompletionRequests(
  fixture: Fixture,
  rows: Array<{
    requestId: string;
    createdAt: number;
    status: string;
    leadWorkId: string;
  }>,
  taskId: string,
  leadAssignmentId: string,
) {
  const db = access(fixture.service).db;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const row of rows)
      db.prepare(
        `INSERT INTO coordination_completion_requests (requestId, taskId, leadAssignmentId, leadWorkId, leadWorkRevision, taskVersion, reviewedResultIds, status, revision, createdAt)
        VALUES (?, ?, ?, ?, 1, 1, '[]', ?, 1, ?)`,
      ).run(
        row.requestId,
        taskId,
        leadAssignmentId,
        row.leadWorkId,
        row.status,
        row.createdAt,
      );
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function stubLeadWork(
  fixture: Fixture,
  works: Record<
    string,
    { state: string; taskId: string; assignmentId: string } | undefined
  >,
) {
  // Partial rows stand in for the fields the wake reads.
  const state = startedOf(fixture.service).state as unknown as {
    byWorkId(workId: string): unknown;
    taskBinding(workId: string): unknown;
  };
  const byWorkId = state.byWorkId.bind(state);
  const taskBinding = state.taskBinding.bind(state);
  state.byWorkId = (workId) =>
    workId in works
      ? works[workId]
        ? { state: works[workId].state }
        : undefined
      : byWorkId(workId);
  state.taskBinding = (workId) =>
    workId in works && works[workId]
      ? {
          workId,
          taskId: works[workId].taskId,
          assignmentId: works[workId].assignmentId,
        }
      : taskBinding(workId);
}

test("pending completions finalize in order only for their completed lead work", async () => {
  await withFixture(async (fixture) => {
    const { taskId } = await fixture.addTask({ ready: false });
    const lead = randomUUID();
    const other = randomUUID();
    seedCompletionRequests(
      fixture,
      [
        {
          requestId: "c-4",
          createdAt: 40,
          status: "pending",
          leadWorkId: "w4",
        },
        {
          requestId: "c-1",
          createdAt: 10,
          status: "pending",
          leadWorkId: "w1",
        },
        {
          requestId: "c-2",
          createdAt: 20,
          status: "pending",
          leadWorkId: "w2",
        },
        {
          requestId: "c-3",
          createdAt: 30,
          status: "pending",
          leadWorkId: "w3",
        },
        {
          requestId: "c-5",
          createdAt: 5,
          status: "rejected",
          leadWorkId: "w5",
        },
        {
          requestId: "c-6",
          createdAt: 6,
          status: "finalized",
          leadWorkId: "w6",
        },
      ],
      taskId,
      lead,
    );
    stubLeadWork(fixture, {
      w1: { state: "completed", taskId, assignmentId: lead },
      w2: { state: "running", taskId, assignmentId: lead },
      w3: { state: "completed", taskId, assignmentId: other },
      w4: { state: "completed", taskId, assignmentId: lead },
      w5: { state: "completed", taskId, assignmentId: lead },
      w6: { state: "completed", taskId, assignmentId: lead },
    });
    const finalized: Array<[string, string]> = [];
    access(fixture.service).finalizeDeliveryCompletion = async (
      requestId,
      workId,
    ) => {
      finalized.push([requestId, workId]);
    };
    await fixture.wake();
    assert.deepEqual(finalized, [
      ["c-1", "w1"],
      ["c-4", "w4"],
    ]);
    // The running lead work completes later; its request is picked up then.
    stubLeadWork(fixture, {
      w2: { state: "completed", taskId, assignmentId: lead },
    });
    finalized.length = 0;
    await fixture.wake();
    assert.deepEqual(
      finalized.map(([requestId]) => requestId),
      ["c-1", "c-2", "c-4"],
    );
  });
});

/** Wait until no turn is queued or active and further wakes add no turns. */
async function settle(fixture: Fixture) {
  let last = -1;
  for (;;) {
    assert.equal(
      await waitUntil(
        () =>
          fixture.count(
            "SELECT COUNT(*) AS count FROM turn_requests WHERE state IN ('queued','active')",
          ) === 0,
      ),
      true,
      "turns did not settle",
    );
    await fixture.wake();
    await fixture.wake();
    if (
      fixture.runtime.turns === last &&
      fixture.count(
        "SELECT COUNT(*) AS count FROM turn_requests WHERE state IN ('queued','active')",
      ) === 0
    )
      return;
    last = fixture.runtime.turns;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

const deliveries = (fixture: Fixture) =>
  fixture.count("SELECT COUNT(*) AS count FROM coordination_delivery_batches");

test("a queued reporting repair is replayed as exactly one request", async () => {
  await withFixture(async (fixture) => {
    const { assignmentId } = await fixture.addTask({ assignment: "Worker" });
    await settle(fixture);
    const repairs = fixture.sql(
      "SELECT repairWorkId FROM coordination_reporting_repairs WHERE assignmentId = ?",
      assignmentId ?? null,
    ) as Array<{ repairWorkId: string }>;
    assert.ok(repairs.length >= 1, "turn ended without a saved result");
    const turns = fixture.runtime.turns;
    await Promise.all([fixture.wake(), fixture.wake()]);
    await fixture.wake();
    assert.equal(fixture.runtime.turns, turns);
    for (const { repairWorkId } of repairs)
      assert.equal(
        fixture.count(
          "SELECT COUNT(*) AS count FROM turn_requests WHERE workId = ?",
          repairWorkId,
        ),
        1,
      );
    // One initial request plus one request per replayed repair.
    assert.equal(turns, 1 + repairs.length);
  });
});

test("inbox delivery waits on unresolved held work and sees holds added while a completion yields", async () => {
  await withFixture(async (fixture) => {
    fixture.runtime.asksQuestion = true;
    const { taskId } = await fixture.addTask({ ready: true });
    await settle(fixture);
    assert.ok(fixture.runtime.turns >= 1, "lead turn should have run");
    const lead = String(
      fixture.service
        .domain()
        .leadBindings()
        .find((binding) => binding.taskId === taskId)?.assignmentId,
    );
    const operationId = insertFallbackOperation(fixture, taskId, 99);
    const turns = fixture.runtime.turns;

    // A completion finalization yields; a hold lands before the wake resumes.
    seedCompletionRequests(
      fixture,
      [{ requestId: "c-1", createdAt: 1, status: "pending", leadWorkId: "w1" }],
      taskId,
      lead,
    );
    stubLeadWork(fixture, {
      w1: { state: "completed", taskId, assignmentId: lead },
    });
    const entered = deferred();
    const proceed = deferred();
    access(fixture.service).finalizeDeliveryCompletion = async () => {
      entered.resolve();
      await proceed.promise;
    };
    const wake = fixture.wake();
    await entered.promise;
    fixture.insertRequest("blocker-1", lead, "held", { taskId });
    proceed.resolve();
    await wake;
    assert.equal(
      fixture.count(
        "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE routingOperationId = ?",
        operationId,
      ),
      1,
    );
    assert.equal(
      deliveries(fixture),
      0,
      "unresolved held work blocks delivery",
    );
    assert.equal(fixture.runtime.turns, turns);

    // Resolving the hold lets the following wakes deliver exactly once.
    fixture.sql(
      "UPDATE turn_requests SET state = 'completed' WHERE workId = 'blocker-1'",
    );
    await fixture.wake();
    await fixture.wake();
    assert.equal(deliveries(fixture), 1);
    await settle(fixture);
    assert.equal(deliveries(fixture), 1);

    // Historical resolution is still decided by the coordination store.
    insertFallbackOperation(fixture, taskId, 100, "missing-context");
    fixture.insertRequest("blocker-2", lead, "held", { taskId });
    const { coordination } = startedOf(fixture.service);
    const resolve = coordination.isHistoricalWorkResolved.bind(coordination);
    const consulted: string[] = [];
    coordination.isHistoricalWorkResolved = (workId: string) => {
      consulted.push(workId);
      return workId === "blocker-2" || resolve(workId);
    };
    await fixture.wake();
    assert.ok(consulted.includes("blocker-2"));
    assert.equal(deliveries(fixture), 2);
  });
});

test("holding a settled execution leaves its request settled", async () => {
  await withFixture(async (fixture) => {
    const db = access(fixture.service).db;
    const store = new SchedulerStore(db);
    const state = new ExecutionState(db);
    const bind = (workId: string) => {
      store.ensure({
        requestKey: workId,
        workId,
        kind: "direct",
        taskId: null,
        projectId: null,
        assignmentId: null,
        taskVersion: null,
        assignmentVersion: null,
        instructionsRevision: null,
        profileRevision: null,
        prompt: workId,
        workspace: "/synthetic",
        previousWorkId: null,
      });
      const intent = state.create(workId, workId, "/synthetic");
      fixture.sql(
        "UPDATE execution_intents SET state = 'running', threadId = ?, turnId = ? WHERE id = ?",
        `thread-${workId}`,
        `turn-${workId}`,
        intent.id,
      );
      return intent;
    };
    const settled = bind("settled");
    const running = bind("running");
    state.complete(settled.id, "thread-settled", "turn-settled");

    // A failing post-completion step reaches hold() with a completed intent.
    assert.equal(state.hold(settled.id, "Post-completion step failed"), false);
    assert.equal(state.get(settled.id).state, "completed");
    assert.equal(store.byWorkId("settled").state, "completed");

    assert.equal(state.hold(running.id, "Runtime uncertain"), true);
    assert.equal(state.get(running.id).state, "held");
    assert.equal(store.byWorkId("running").state, "held");
  });
});

test("a failed wake after a committed delegation still reports success", async () => {
  await withFixture(async (fixture) => {
    const gate = deferred();
    fixture.runtime.release = gate.promise;
    const { taskId } = await fixture.addTask({ assignment: "Parent" });
    assert.equal(await waitUntil(() => fixture.runtime.turns === 1), true);
    const before = fixture.service.domain().assignments(taskId).length;
    access(fixture.service).wakeScheduler = async () => {
      throw new Error("Synthetic wake failure");
    };
    const toolCall = (
      fixture.runtime as unknown as {
        toolCall: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
      }
    ).toolCall;
    const result = await toolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "delegate-after-commit",
      tool: "cab_delegate",
      arguments: { profileId: fixture.profileId, brief: "Child work" },
    });
    assert.equal(result.success, true, result.text);
    assert.equal(
      fixture.service.domain().assignments(taskId).length,
      before + 1,
    );
    gate.resolve();
  });
});

async function seedRevisionCollision(fixture: Fixture) {
  const { service, projectId } = fixture;
  const { taskId, assignmentId } = await fixture.addTask({
    ready: false,
    assignment: "Collision",
  });
  assert.ok(assignmentId);
  const { coordination, schedulerStore, state } = startedOf(service);
  const assignment = service.domain().assignment(assignmentId);
  coordination.postOperatorMessage({
    actor: "operator",
    key: randomUUID(),
    taskId,
    recipientAssignmentId: assignmentId,
    expectedAssignmentVersion: Number(assignment.version),
    message: "PRESERVED_COLLISION_INPUT",
  });
  const event = coordination.pendingEvents(assignmentId)[0]!;
  const delivery = coordination.bindDeliveryBatch(
    assignmentId,
    `assignment:${assignmentId}:v${assignment.version}:inbox:${event.eventId}`,
    Number(assignment.version),
  );
  assert.ok(delivery);
  const prompt = (
    service as unknown as {
      assignmentPrompt(
        brief: string,
        batch: NonNullable<typeof delivery>,
      ): string;
    }
  ).assignmentPrompt(String(assignment.brief), delivery);
  fixture.insertRequest("unrelated-old-work", assignmentId, "completed");
  const request = schedulerStore.createAssignment(
    {
      taskId,
      projectId,
      assignmentId,
      taskVersion: Number(service.domain().task(taskId).version),
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
      prompt,
      previousWorkId: null,
    },
    { requestKey: delivery.deliveryWorkId, workId: delivery.deliveryWorkId },
  );
  return { taskId, assignmentId, request, state, coordination, schedulerStore };
}

test("an exact uncaptured revision collision is refused once and Start again retains its inbox and conversation", async () => {
  await withFixture(async (fixture) => {
    const c = await seedRevisionCollision(fixture);
    execute(fixture.service, {
      type: "task.configure",
      actor: "operator",
      projectId: fixture.projectId,
      taskId: c.taskId,
      expectedVersion: 1,
      ready: true,
    });
    await fixture.wake();
    const old = c.schedulerStore.byWorkId(c.request.workId);
    assert.equal(old.state, "held");
    assert.match(old.reason ?? "", /older.*never ran.*Start again/);
    assert.equal(c.state.byWorkId(old.workId), undefined);
    assert.equal(c.state.refusedBeforeStart(old.workId), true);
    assert.equal(
      c.schedulerStore.byWorkId("unrelated-old-work").state,
      "completed",
    );
    await fixture.wake();
    assert.deepEqual(c.schedulerStore.byWorkId(old.workId), old);
    assert.equal(
      fixture.count(
        "SELECT COUNT(*) AS count FROM assignment_request_refusals WHERE workId=?",
        old.workId,
      ),
      1,
    );
    const api = new OperatorApi(fixture.service);
    const taskRead = (await api.readTask(c.taskId)).data;
    assert.equal(taskRead.execution.state, "not-started");
    assert.match(
      taskRead.assignments.find((a) => a.assignmentId === c.assignmentId)
        ?.requestRefusal?.reason ?? "",
      /never ran/,
    );
    const recovery = (await api.readAssignmentRecovery(c.assignmentId)).data;
    assert.equal(recovery.records.length, 0);
    assert.equal(
      recovery.assignment.requestRefusal?.startAgain.available,
      true,
    );
    const options = (await api.readRecoveryOptions(c.assignmentId)).data;
    assert.equal(options.requestRefusal?.workId, old.workId);
    assert.equal(options.records.length, 0);
    const item = (await api.readInbox()).data.items.find(
      (i) =>
        i.kind === "intervention" &&
        i.taskId === c.taskId &&
        i.attentionCode === "not-started",
    )!;
    assert.equal(item.dismissible, true);
    const turnsBeforeDismiss = fixture.runtime.turns;
    await api.execute({
      type: "inbox.dismiss",
      key: randomUUID(),
      itemId: item.id,
      expectedRevision: item.lifecycle!.revision,
    });
    assert.equal(
      (await api.readInbox()).data.items.some((i) => i.id === item.id),
      false,
    );
    assert.deepEqual(c.schedulerStore.byWorkId(old.workId), old);
    assert.equal(c.state.byWorkId(old.workId), undefined);
    assert.equal(fixture.runtime.turns, turnsBeforeDismiss);
    await api.execute({
      type: "inbox.restore",
      key: randomUUID(),
      itemId: item.id,
      expectedRevision: item.lifecycle!.revision + 1,
    });
    assert.equal(
      (await api.readInbox()).data.items.some((i) => i.id === item.id),
      true,
    );
    const availability = fixture.service.startAgainAvailability(c.taskId);
    assert.equal(availability.available, true);
    const conversation = fixture.sql(
      "SELECT revision FROM assignment_conversations WHERE assignmentId=?",
      c.assignmentId,
    );
    const receipt = await fixture.service.startAgain({
      key: randomUUID(),
      taskId: c.taskId,
      expectedVersion: Number(fixture.service.domain().task(c.taskId).version),
      workId: old.workId,
    });
    const fresh = c.schedulerStore.byWorkId(receipt.workId);
    assert.equal(
      fresh.taskVersion,
      Number(fixture.service.domain().task(c.taskId).version),
    );
    assert.equal(
      fresh.profileRevision,
      Number(
        fixture.service.domain().assignment(c.assignmentId).profileRevision,
      ),
    );
    assert.equal(
      fresh.instructionsRevision,
      Number(
        fixture.service.domain().assignment(c.assignmentId)
          .instructionsRevision,
      ),
    );
    assert.deepEqual(
      fixture.sql(
        "SELECT revision FROM assignment_conversations WHERE assignmentId=?",
        c.assignmentId,
      ),
      conversation,
    );
    assert.equal(fresh.prompt.split("PRESERVED_COLLISION_INPUT").length - 1, 1);
    fixture.runtime.asksQuestion = true;
    await fixture.wake();
    assert.equal(await waitUntil(() => fixture.runtime.turns === 1), true);
    assert.deepEqual(c.schedulerStore.byWorkId(old.workId), old);
  });
});

test("startup repairs a persisted obsolete uncaptured request and preserves the refusal over another restart", async () => {
  await withFixture(async (fixture) => {
    const c = await seedRevisionCollision(fixture);
    await fixture.service.stop();
    // The old build held this request before creating any execution intent.
    const database = new (await import("node:sqlite")).DatabaseSync(
      (fixture.service as unknown as { dataDir: string }).dataDir +
        "/standalone.sqlite",
    );
    try {
      database
        .prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?")
        .run(c.taskId);
      database
        .prepare(
          "UPDATE turn_requests SET state='held',reason=? WHERE workId=?",
        )
        .run(
          "Assignment request became obsolete: Error: Turn request identity already used with different captured revisions",
          c.request.workId,
        );
    } finally {
      database.close();
    }
    await fixture.service.start();
    assert.equal(
      startedOf(fixture.service).state.refusedBeforeStart(c.request.workId),
      true,
    );
    await fixture.service.stop();
    await fixture.service.start();
    assert.equal(
      startedOf(fixture.service).state.refusedBeforeStart(c.request.workId),
      true,
    );
    assert.equal(fixture.runtime.turns, 0);
  });
});

test("request-only refusal rejects execution evidence and completed history", async () => {
  await withFixture(async (fixture) => {
    const c = await seedRevisionCollision(fixture);
    access(fixture.service)
      .db.prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?")
      .run(c.taskId);
    c.state.create(c.request.workId, c.request.prompt, "/recorded-workspace");
    assert.equal(c.state.refuseUncapturedRevision(c.request.workId), false);
    access(fixture.service)
      .db.prepare("UPDATE turn_requests SET state='completed' WHERE workId=?")
      .run(c.request.workId);
    assert.equal(c.state.refuseUncapturedRevision(c.request.workId), false);
    assert.equal(
      fixture.count(
        "SELECT COUNT(*) AS count FROM assignment_request_refusals",
      ),
      0,
    );
  });
});

test("request-only refusal leaves independent task holds and unfinished callbacks authoritative", async () => {
  await withFixture(async (fixture) => {
    const c = await seedRevisionCollision(fixture);
    execute(fixture.service, {
      type: "task.configure",
      actor: "operator",
      projectId: fixture.projectId,
      taskId: c.taskId,
      expectedVersion: 1,
      ready: true,
    });
    await fixture.wake();
    assert.equal(c.state.refusedBeforeStart(c.request.workId), true);
    const callback = deferred();
    fixture.service.registerExecutionCallback(
      c.request.workId,
      callback.promise,
    );
    assert.equal(fixture.service.notStartedWork(c.request.workId), false);
    assert.deepEqual(fixture.service.startAgainAvailability(c.taskId), {
      available: false,
      reason: "execution-unresolved",
    });
    callback.resolve();
    await Promise.resolve();
    await fixture.wake();
    assert.equal(fixture.service.notStartedWork(c.request.workId), true);
    const domain = fixture.service.domain();
    const admission = domain.admission;
    domain.admission = function (...args) {
      const facts = admission.apply(this, args);
      return {
        ...facts,
        eligible: false,
        reasons: [...facts.reasons, "source-hold"],
      };
    };
    try {
      const api = new OperatorApi(fixture.service);
      assert.deepEqual((await api.readTask(c.taskId)).data.startAgain, {
        available: false,
        reason: "source-held",
      });
      assert.equal(
        (await api.readRecoveryOptions(c.assignmentId)).data.requestRefusal
          ?.startAgain.reason,
        "source-held",
      );
      await assert.rejects(
        fixture.service.startAgain({
          key: randomUUID(),
          taskId: c.taskId,
          expectedVersion: Number(domain.task(c.taskId).version),
          workId: c.request.workId,
        }),
        /source/,
      );
      assert.equal(fixture.runtime.turns, 0);
    } finally {
      domain.admission = admission;
    }
    access(fixture.service)
      .db.prepare(
        "INSERT INTO task_writer_ambiguity_holds(taskId,reason) VALUES (?,?)",
      )
      .run(c.taskId, "Independent ownership hold");
    assert.deepEqual(fixture.service.startAgainAvailability(c.taskId), {
      available: false,
      reason: "execution-unresolved",
    });
    assert.equal(fixture.runtime.turns, 0);
  });
});

test("an admitted revision collision keeps execution ownership and never refuses older history", async () => {
  await withFixture(async (fixture) => {
    const c = await seedRevisionCollision(fixture);
    const request = c.request;
    const intent = c.state.create(
      request.workId,
      request.prompt,
      "/admitted-collision",
    );
    c.state.bindTask(request.workId, {
      taskId: c.taskId,
      assignmentId: c.assignmentId,
      assignmentVersion: request.assignmentVersion!,
      instructionsRevision: request.instructionsRevision!,
      profileRevision: request.profileRevision!,
    });
    assert.equal(
      c.state.begin(intent.id, { projectId: fixture.projectId }),
      true,
    );
    execute(fixture.service, {
      type: "task.configure",
      actor: "operator",
      projectId: fixture.projectId,
      taskId: c.taskId,
      expectedVersion: 1,
      ready: true,
    });
    await fixture.wake();
    assert.equal(c.state.refusedBeforeStart(request.workId), false);
    assert.equal(
      fixture.count(
        "SELECT COUNT(*) AS count FROM assignment_request_refusals",
      ),
      0,
    );
    assert.equal(
      c.schedulerStore.byWorkId("unrelated-old-work").state,
      "completed",
    );
    assert.equal(
      fixture.count(
        "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId=?",
        request.workId,
      ),
      1,
    );
    assert.equal(fixture.runtime.turns, 0);
  });
});

for (const dimension of [
  "task",
  "assignment",
  "profile",
  "instructions",
] as const)
  for (const bound of [false, true])
    test(`startup refuses a stale ${dimension} capture ${bound ? "with an unadmitted intent" : "without an intent"} and Start again captures current revisions`, async () => {
      await withFixture(async (fixture) => {
        const c = await seedRevisionCollision(fixture);
        if (bound) {
          c.state.create(
            c.request.workId,
            c.request.prompt,
            "/waiting-capture",
          );
          c.state.bindTask(c.request.workId, {
            taskId: c.taskId,
            assignmentId: c.assignmentId,
            assignmentVersion: c.request.assignmentVersion!,
            instructionsRevision: c.request.instructionsRevision!,
            profileRevision: c.request.profileRevision!,
          });
        }
        if (dimension === "task")
          execute(fixture.service, {
            type: "task.configure",
            actor: "operator",
            projectId: fixture.projectId,
            taskId: c.taskId,
            expectedVersion: 1,
            title: "Changed task",
          });
        if (dimension === "assignment")
          access(fixture.service)
            .db.prepare(
              "UPDATE domain_assignments SET version=version+1 WHERE id=?",
            )
            .run(c.assignmentId);
        if (dimension === "profile")
          execute(fixture.service, {
            type: "profile.configure",
            actor: "operator",
            profileId: fixture.profileId,
            expectedVersion: Number(
              fixture.service.domain().profile(fixture.profileId).version,
            ),
            instructions: "Changed agent",
          });
        if (dimension === "instructions")
          execute(fixture.service, {
            type: "project.configure",
            actor: "operator",
            projectId: fixture.projectId,
            expectedVersion: Number(
              fixture.service.domain().project(fixture.projectId).version,
            ),
            instructions: "Changed instructions",
          });
        const dataPath = (fixture.service as unknown as { dataDir: string })
          .dataDir;
        await fixture.service.stop();
        const database = new (await import("node:sqlite")).DatabaseSync(
          join(dataPath, "standalone.sqlite"),
        );
        try {
          database
            .prepare(
              "UPDATE turn_requests SET state='held',reason='Old stale revision hold' WHERE workId=?",
            )
            .run(c.request.workId);
          if (bound)
            database
              .prepare(
                "UPDATE execution_intents SET state='held',reason='Old stale revision hold' WHERE workId=?",
              )
              .run(c.request.workId);
        } finally {
          database.close();
        }
        await fixture.service.start();
        const state = startedOf(fixture.service).state;
        assert.equal(state.refusedBeforeStart(c.request.workId), true);
        assert.equal(
          fixture.service.startAgainAvailability(c.taskId).available,
          true,
        );
        const read = (await new OperatorApi(fixture.service).readTask(c.taskId))
          .data;
        assert.match(
          read.assignments.find((a) => a.assignmentId === c.assignmentId)
            ?.requestRefusal?.reason ?? "",
          /never ran/,
        );
        await fixture.service.stop();
        await fixture.service.start();
        assert.equal(
          startedOf(fixture.service).state.refusedBeforeStart(c.request.workId),
          true,
        );
        const receipt = await fixture.service.startAgain({
          key: randomUUID(),
          taskId: c.taskId,
          workId: c.request.workId,
          expectedVersion: Number(
            fixture.service.domain().task(c.taskId).version,
          ),
        });
        const fresh = startedOf(fixture.service).schedulerStore.byWorkId(
          receipt.workId,
        );
        const assignment = fixture.service.domain().assignment(c.assignmentId);
        assert.equal(
          fresh.taskVersion,
          Number(fixture.service.domain().task(c.taskId).version),
        );
        assert.equal(fresh.assignmentVersion, Number(assignment.version));
        assert.equal(fresh.profileRevision, Number(assignment.profileRevision));
        assert.equal(
          fresh.instructionsRevision,
          Number(assignment.instructionsRevision),
        );
        assert.equal(
          fixture.runtime.turns,
          0,
          "an unready task still cannot run",
        );
      });
    });

for (const evidence of [
  "thread",
  "turn",
  "writer",
  "capacity",
  "effect",
  "stop",
] as const)
  test(`stale refusal rolls back unchanged when ${evidence} evidence remains`, async () => {
    await withFixture(async (fixture) => {
      const c = await seedRevisionCollision(fixture);
      c.state.create(c.request.workId, c.request.prompt, "/evidence-workspace");
      c.state.bindTask(c.request.workId, {
        taskId: c.taskId,
        assignmentId: c.assignmentId,
        assignmentVersion: c.request.assignmentVersion!,
        instructionsRevision: c.request.instructionsRevision!,
        profileRevision: c.request.profileRevision!,
      });
      access(fixture.service)
        .db.prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?")
        .run(c.taskId);
      const database = access(fixture.service).db;
      if (evidence === "thread")
        database
          .prepare(
            "UPDATE execution_intents SET threadId='possibly-started' WHERE workId=?",
          )
          .run(c.request.workId);
      if (evidence === "turn")
        database
          .prepare(
            "UPDATE execution_intents SET turnId='sent-turn' WHERE workId=?",
          )
          .run(c.request.workId);
      if (evidence === "writer")
        database
          .prepare(
            "INSERT INTO task_writer_admissions(workId,workspace) VALUES (?,?)",
          )
          .run(c.request.workId, "/evidence-workspace");
      if (evidence === "capacity")
        database
          .prepare(
            "INSERT INTO execution_capacity_reservations(workId,projectId) VALUES (?,?)",
          )
          .run(c.request.workId, fixture.projectId);
      if (evidence === "effect")
        database
          .prepare(
            "INSERT INTO execution_pending_effects(workId,effectKey,state,reason) VALUES (?,'known-survivor','pending','Still active')",
          )
          .run(c.request.workId);
      if (evidence === "stop")
        database
          .prepare(`INSERT INTO execution_stop_targets(taskId,workId,threadId,turnId,interruptState,terminalState,reason,requestedAt)
        VALUES (?,?,NULL,NULL,'unbound','unknown','Operator Stop',1)`)
          .run(c.taskId, c.request.workId);
      const before = {
        request: c.schedulerStore.byWorkId(c.request.workId),
        intent: c.state.byWorkId(c.request.workId),
      };
      assert.equal(
        c.state.refuseStaleRevision(c.request.workId, [
          "task-revision-changed",
        ]),
        false,
      );
      assert.deepEqual(
        {
          request: c.schedulerStore.byWorkId(c.request.workId),
          intent: c.state.byWorkId(c.request.workId),
        },
        before,
      );
      assert.equal(
        fixture.count(
          "SELECT COUNT(*) AS count FROM execution_request_refusals WHERE workId=?",
          c.request.workId,
        ),
        0,
      );
      assert.equal(
        fixture.count(
          "SELECT COUNT(*) AS count FROM assignment_request_refusals WHERE workId=?",
          c.request.workId,
        ),
        0,
      );
    });
  });
