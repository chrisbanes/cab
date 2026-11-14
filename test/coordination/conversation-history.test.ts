import { seedLegacyCommand } from "../fixtures/legacy-harness-configuration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeConversationEvent,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import {
  capBytesOutsideRedaction,
  ConversationHistoryCapture,
  ConversationHistoryStore,
  sanitizeConversationText,
} from "../../src/standalone/conversation-history.js";
import { normalizePlan } from "../../src/standalone/agent-plan.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { tmpdir } from "../fixtures/temp.js";
import { until } from "../fixtures/until.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

interface PlannedTurn {
  id: string;
  beforeReturn?: (
    runtime: HistoryRuntime,
    threadId: string,
    turnId: string,
    workspace: string,
  ) => void;
  loseResponse?: boolean;
}

class HistoryRuntime implements Runtime {
  private conversationListener:
    | ((event: RuntimeConversationEvent) => void)
    | undefined;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private started = deferred<{ threadId: string; turnId: string }>();
  private plans: PlannedTurn[] = [];
  private threadCount = 0;
  private turnStartCount = 0;

  get turnStarts() {
    return this.turnStartCount;
  }

  plan(...turns: PlannedTurn[]) {
    this.plans.push(...turns);
  }

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("failed");
  }

  async startThread() {
    return `thread-${++this.threadCount}`;
  }

  async resumeThread(_threadId: string) {}

  async startTurn(threadId: string, workspace: string) {
    this.turnStartCount += 1;
    const plan = this.plans.shift();
    assert.ok(plan, "test runtime received an explicit turn plan");
    this.started = deferred();
    this.outcomes.set(plan.id, deferred());
    plan.beforeReturn?.(this, threadId, plan.id, workspace);
    this.started.resolve({ threadId, turnId: plan.id });
    if (plan.loseResponse) throw new Error("disposable lost response");
    return plan.id;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversationListener = listener;
  }

  onToolCall(
    _listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ) {}

  emit(event: RuntimeConversationEvent) {
    this.conversationListener?.(event);
  }

  async waitForTurnStart(afterCount = 0) {
    await until(() => this.turnStartCount > afterCount);
    return this.started.promise;
  }

  complete(turnId: string) {
    this.outcomes.get(turnId)?.resolve("completed");
  }
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return seedLegacyCommand(service.domain(), {
    key: randomUUID(),
    ...body,
  } as never);
}

function query<T extends Record<string, unknown>>(
  root: string,
  sql: string,
  ...parameters: (string | number | null)[]
): T[] {
  const db = new DatabaseSync(join(root, "data", "standalone.sqlite"));
  try {
    return db.prepare(sql).all(...parameters) as T[];
  } finally {
    db.close();
  }
}

function serviceDatabase(service: StandaloneService): DatabaseSync {
  return (service as unknown as { db: DatabaseSync }).db;
}

function countRows(root: string, workId: string): number {
  return (
    query<{ count: number }>(
      root,
      "SELECT COUNT(*) AS count FROM conversation_history_items WHERE workId = ?",
      workId,
    )[0]?.count ?? 0
  );
}

function executionState(
  service: StandaloneService,
  workId: string,
  turnStarts: number,
) {
  const intent = service.list().find((item) => item.workId === workId);
  return {
    state: intent?.state ?? "missing",
    threadBound: Boolean(intent?.threadId),
    turnBound: Boolean(intent?.turnId),
    turnStarts,
    workIds: service.list().map((item) => item.workId),
  };
}

async function waitForExecutionState(
  service: StandaloneService,
  workId: string,
  state: string,
) {
  try {
    await until(
      () =>
        service.list().find((item) => item.workId === workId)?.state === state,
    );
  } catch {
    const executions = service.list().map((item) => ({
      workId: item.workId,
      state: item.state,
      threadBound: Boolean(item.threadId),
      turnBound: Boolean(item.turnId),
    }));
    throw new Error(
      `expected execution state ${state}; observed ${JSON.stringify(executions)}`,
    );
  }
}

async function createTaskAssignment(
  service: StandaloneService,
  projectId: string,
  profileId: string,
) {
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "History test task",
    outcome: "Complete the disposable history test.",
  });
  command(service, {
    type: "assignment.create",
    actor: "operator",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Complete the disposable history test.",
    resultDestination: "lead:task",
    requesterAssignmentId: null,
  });
  await service.provisionTask(taskId);
  return {
    taskId,
    assignmentId,
    workId: `assignment:${assignmentId}:initial`,
    activate() {
      command(service, {
        type: "task.configure",
        actor: "operator",
        projectId,
        taskId,
        expectedVersion: 1,
        ready: true,
      });
    },
  };
}

// The `token=` pattern must not rewrite the instruction before its exact match.
const profileInstructions =
  "PRIVATE_PROFILE_INSTRUCTION_CANARY token=PROFILE_TOKEN_CANARY PROFILE_INSTRUCTION_TAIL_CANARY";

async function fixture(
  runtime: HistoryRuntime,
  options: { exclusions?: () => readonly string[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cab-s05-history-"));
  const dataDir = join(root, "data");
  const service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    ...(options.exclusions
      ? { conversationHistoryExclusions: options.exclusions }
      : {}),
  });
  const profileId = randomUUID();
  const projectId = randomUUID();
  await service.start();
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "History test profile",
    instructions: profileInstructions,
    capabilities: "test",
  });
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "History test project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
    instructions: "PRIVATE_PROJECT_INSTRUCTION_CANARY",
  });
  const assignment = await createTaskAssignment(service, projectId, profileId);
  return {
    root,
    service,
    profileId,
    projectId,
    ...assignment,
  };
}

test("persists only the response-bound completed item and survives reopen", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime, {
    exclusions: () => ["FIXTURE_SECRET_CANARY"],
  });
  const workId = f.workId;
  const escapedCredential = [
    JSON.stringify({
      token: 'ESCAPED_VALUE_PREFIX_CANARY"ESCAPED_VALUE_SUFFIX_CANARY',
    }),
    "password='SINGLE_ESCAPED_PREFIX_CANARY\\'SINGLE_ESCAPED_SUFFIX_CANARY'",
  ].join(" ");
  runtime.plan({
    id: "turn-bound",
    beforeReturn: (active, threadId, turnId, workspace) => {
      active.emit({
        threadId: "other-thread",
        turnId,
        itemId: "wrong-thread-item",
        kind: "completed",
        text: "WRONG_THREAD_CANARY",
      });
      active.emit({
        threadId,
        turnId: "other-turn",
        itemId: "wrong-turn-item",
        kind: "completed",
        text: "WRONG_TURN_CANARY",
      });
      active.emit({ threadId, turnId, itemId: "answer-1", kind: "started" });
      active.emit({
        threadId,
        turnId,
        itemId: "answer-1",
        kind: "delta",
        bytes: 9,
      });
      active.emit({
        threadId,
        turnId,
        itemId: "answer-1",
        kind: "completed",
        text: [
          "A useful answer.",
          "FIXTURE_SECRET_CANARY",
          profileInstructions,
          "PRIVATE_PROJECT_INSTRUCTION_CANARY",
          workspace,
          escapedCredential,
          "Authorization: Bearer BEARER_SECRET_CANARY",
          "password=PASSWORD_SECRET_CANARY",
          "api_key=API_KEY_SECRET_CANARY",
          "https://URL_USER_CANARY:URL_PASSWORD_CANARY@example.test/path",
        ].join(" "),
      });
      active.emit({
        threadId,
        turnId,
        itemId: "answer-1",
        kind: "completed",
        text: "duplicate must not add a row",
      });
      assert.equal(turnId, "turn-bound");
    },
  });

  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    runtime.emit({
      threadId: bound.threadId,
      turnId: "late-other-turn",
      itemId: "late-wrong-turn",
      kind: "completed",
      text: "LATE_OTHER_TURN_CANARY",
    });
    try {
      await until(() => countRows(f.root, workId) === 1);
    } catch {
      assert.fail(
        `history row was not written; execution=${JSON.stringify(executionState(f.service, workId, runtime.turnStarts))}`,
      );
    }
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, workId, "completed");

    const rows = query<Record<string, unknown>>(
      f.root,
      "SELECT * FROM conversation_history_items WHERE workId = ?",
      workId,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.threadId, bound.threadId);
    assert.equal(row.turnId, bound.turnId);
    assert.equal(row.itemId, "answer-1");
    assert.equal(row.lifecycle, "completed");
    const text = String(row.text);
    for (const canary of [
      "FIXTURE_SECRET_CANARY",
      "PRIVATE_PROFILE_INSTRUCTION_CANARY",
      "PROFILE_TOKEN_CANARY",
      "PROFILE_INSTRUCTION_TAIL_CANARY",
      "PRIVATE_PROJECT_INSTRUCTION_CANARY",
      "WRONG_THREAD_CANARY",
      "WRONG_TURN_CANARY",
      "LATE_OTHER_TURN_CANARY",
      "BEARER_SECRET_CANARY",
      "PASSWORD_SECRET_CANARY",
      "API_KEY_SECRET_CANARY",
      "URL_USER_CANARY",
      "URL_PASSWORD_CANARY",
      "ESCAPED_VALUE_PREFIX_CANARY",
      "ESCAPED_VALUE_SUFFIX_CANARY",
      "SINGLE_ESCAPED_PREFIX_CANARY",
      "SINGLE_ESCAPED_SUFFIX_CANARY",
      f.root,
    ])
      assert.ok(
        !text.includes(canary),
        `database projection excludes ${canary}`,
      );
    assert.match(text, /A useful answer\./);
    assert.match(text, /\{"token":\[redacted\]\}/);
    const readItem = f.service
      .coordinationView()
      .readAssignmentHistory(f.assignmentId)
      .items.find((item) => item.itemId === "answer-1");
    assert.equal(readItem?.lifecycle, "completed");
    assert.ok(readItem?.text);
    for (const canary of [
      "ESCAPED_VALUE_PREFIX_CANARY",
      "ESCAPED_VALUE_SUFFIX_CANARY",
      "SINGLE_ESCAPED_PREFIX_CANARY",
      "SINGLE_ESCAPED_SUFFIX_CANARY",
    ])
      assert.ok(!readItem.text.includes(canary));
    await f.service.stop();
    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    try {
      assert.equal(
        (
          reopened
            .prepare(
              "SELECT COUNT(*) AS count FROM conversation_history_items WHERE workId = ? AND itemId = ?",
            )
            .get(workId, "answer-1") as { count: number }
        ).count,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("does not attach an unreturned turn or a response-lost orphan", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const unboundWorkId = f.workId;
  runtime.plan(
    {
      id: "selected-turn",
      beforeReturn: (active, threadId) => {
        active.emit({
          threadId,
          turnId: "unreturned-turn",
          itemId: "unreturned-item",
          kind: "completed",
          text: "UNRETURNED_TURN_CANARY",
        });
      },
    },
    {
      id: "response-lost-turn",
      loseResponse: true,
      beforeReturn: (active, threadId, turnId) => {
        active.emit({
          threadId,
          turnId,
          itemId: "orphan-item",
          kind: "completed",
          text: "ORPHAN_TURN_CANARY",
        });
      },
    },
  );

  try {
    f.activate();
    const selectedTurn = await runtime.waitForTurnStart();
    runtime.emit({
      threadId: selectedTurn.threadId,
      turnId: selectedTurn.turnId,
      itemId: "selected-item",
      kind: "completed",
      text: "SELECTED_TURN_CANARY should remain diagnostic.",
    });
    try {
      await until(() => countRows(f.root, unboundWorkId) === 1);
    } catch {
      assert.fail(
        `selected history row was not written; execution=${JSON.stringify(executionState(f.service, unboundWorkId, runtime.turnStarts))}`,
      );
    }
    runtime.complete(selectedTurn.turnId);
    await waitForExecutionState(f.service, unboundWorkId, "completed");

    const lostAssignment = await createTaskAssignment(
      f.service,
      f.projectId,
      f.profileId,
    );
    lostAssignment.activate();
    await runtime.waitForTurnStart();
    await waitForExecutionState(f.service, lostAssignment.workId, "held");
    const lostWorkId = lostAssignment.workId;
    assert.equal(countRows(f.root, lostWorkId), 0);
    const allText = query<{ text: string | null }>(
      f.root,
      "SELECT text FROM conversation_history_items",
    )
      .map((row) => row.text ?? "")
      .join(" ");
    assert.ok(!allText.includes("UNRETURNED_TURN_CANARY"));
    assert.ok(!allText.includes("ORPHAN_TURN_CANARY"));
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("keeps incomplete delta bytes out of SQLite and redacts both turn-start and current values", async () => {
  const runtime = new HistoryRuntime();
  let currentSecret = "ROTATED_OLD_SECRET_CANARY";
  const f = await fixture(runtime, { exclusions: () => [currentSecret] });
  const workId = f.workId;
  runtime.plan({
    id: "rotation-turn",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "rotating-item",
        kind: "started",
      });
      active.emit({
        threadId,
        turnId,
        itemId: "rotating-item",
        kind: "delta",
        bytes: 12,
      });
    },
  });

  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    await until(() => countRows(f.root, workId) === 1);
    // An omission is a deterministic flush trigger for the batched byte count.
    runtime.emit({
      threadId: bound.threadId,
      turnId: bound.turnId,
      itemId: "flush-trigger",
      kind: "omitted",
      reason: "size-limit",
    });
    const activeRows = query<Record<string, unknown>>(
      f.root,
      "SELECT * FROM conversation_history_items WHERE workId = ? AND itemId = 'rotating-item'",
      workId,
    );
    assert.equal(activeRows[0]?.text, null);
    assert.equal(activeRows[0]?.lifecycle, "streaming");
    assert.equal(activeRows[0]?.deltaBytes, 12);

    currentSecret = "ROTATED_NEW_SECRET_CANARY";
    runtime.emit({
      threadId: bound.threadId,
      turnId: bound.turnId,
      itemId: "rotating-item",
      kind: "completed",
      text: `Completed ${currentSecret} and ROTATED_OLD_SECRET_CANARY.`,
    });
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, workId, "completed");
    const completed = query<{ text: string | null }>(
      f.root,
      "SELECT text FROM conversation_history_items WHERE workId = ? AND itemId = 'rotating-item'",
      workId,
    )[0]?.text;
    assert.ok(completed);
    assert.ok(!completed.includes("ROTATED_OLD_SECRET_CANARY"));
    assert.ok(!completed.includes("ROTATED_NEW_SECRET_CANARY"));
    assert.match(completed, /Completed/);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("turn end and service shutdown write pending delta byte counts", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const second = await createTaskAssignment(
    f.service,
    f.projectId,
    f.profileId,
  );
  runtime.plan({ id: "ending-turn" }, { id: "shutdown-turn" });
  const rows = (workId: string) =>
    query<Record<string, unknown>>(
      f.root,
      "SELECT lifecycle, omissionReason, deltaBytes FROM conversation_history_items WHERE workId = ?",
      workId,
    ).map((row) => ({ ...row }));

  try {
    const initialStarts = runtime.turnStarts;
    f.activate();
    const endingTurn = await runtime.waitForTurnStart(initialStarts);
    const startsBeforeSecond = runtime.turnStarts;
    second.activate();
    const stayingTurn = await runtime.waitForTurnStart(startsBeforeSecond);
    for (const [turn, itemId, bytes] of [
      [endingTurn, "ending-item", 7],
      [stayingTurn, "staying-item", 5],
    ] as const) {
      runtime.emit({ ...turn, itemId, kind: "started" });
      runtime.emit({ ...turn, itemId, kind: "delta", bytes });
    }
    runtime.complete(endingTurn.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");
    assert.deepEqual(rows(f.workId), [
      { lifecycle: "omitted", omissionReason: "turn-ended", deltaBytes: 7 },
    ]);

    await f.service.stop();
    assert.deepEqual(rows(second.workId), [
      { lifecycle: "streaming", omissionReason: null, deltaBytes: 5 },
    ]);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("early buffer overflow is attached only to the returned immutable turn", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const firstWorkId = f.workId;
  const second = await createTaskAssignment(
    f.service,
    f.projectId,
    f.profileId,
  );
  runtime.plan({
    id: "overflow-selected",
    beforeReturn: (active, threadId, turnId) => {
      for (let index = 0; index <= 8192; index += 1)
        active.emit({
          threadId,
          turnId: index % 2 === 0 ? "other-early-turn" : turnId,
          itemId: `buffered-${index}`,
          kind: "started",
        });
    },
  });
  runtime.plan({
    id: "overflow-other-task",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "shared-item-id",
        kind: "completed",
        text: "Same item identity, different task and thread.",
      });
    },
  });

  try {
    const initialStarts = runtime.turnStarts;
    f.activate();
    const selected = await runtime.waitForTurnStart(initialStarts);
    runtime.emit({
      threadId: selected.threadId,
      turnId: selected.turnId,
      itemId: "shared-item-id",
      kind: "completed",
      text: "The bound turn remains separately visible.",
    });
    const startsBeforeSecond = runtime.turnStarts;
    second.activate();
    const secondTurn = await runtime.waitForTurnStart(startsBeforeSecond);
    runtime.complete(secondTurn.turnId);
    await waitForExecutionState(f.service, second.workId, "completed");
    runtime.complete(selected.turnId);
    await waitForExecutionState(f.service, firstWorkId, "completed");

    const gaps = query<Record<string, unknown>>(
      f.root,
      "SELECT * FROM conversation_history_turn_omissions ORDER BY sequence",
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.workId, firstWorkId);
    assert.equal(gaps[0]?.taskId, f.taskId);
    assert.equal(gaps[0]?.turnId, "overflow-selected");
    assert.equal(gaps[0]?.reason, "early-buffer-limit");
    const matchingItems = query<Record<string, unknown>>(
      f.root,
      "SELECT workId, taskId, threadId, turnId, itemId FROM conversation_history_items WHERE itemId = ? ORDER BY sequence",
      "shared-item-id",
    );
    assert.equal(matchingItems.length, 2);
    assert.deepEqual(
      matchingItems.map((row) => row.workId),
      [firstWorkId, second.workId],
    );
    assert.deepEqual(
      matchingItems.map((row) => row.taskId),
      [f.taskId, second.taskId],
    );
    assert.notEqual(matchingItems[0]?.threadId, matchingItems[1]?.threadId);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("history write failures cannot hold or fail the exact bound execution", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  const firstWorkId = f.workId;
  const second = await createTaskAssignment(
    f.service,
    f.projectId,
    f.profileId,
  );
  const db = serviceDatabase(f.service);
  runtime.plan({
    id: "flush-write-failure",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "flush-write-item",
        kind: "completed",
        text: "Diagnostic persistence failure is non-authoritative.",
      });
    },
  });
  runtime.plan({
    id: "finish-write-failure",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({
        threadId,
        turnId,
        itemId: "finish-write-item",
        kind: "started",
      });
    },
  });

  try {
    db.exec(`CREATE TRIGGER fail_history_insert BEFORE INSERT ON conversation_history_items
      BEGIN SELECT RAISE(ABORT, 'diagnostic write failed'); END`);
    const initialStarts = runtime.turnStarts;
    f.activate();
    const firstTurn = await runtime.waitForTurnStart(initialStarts);
    db.exec("DROP TRIGGER fail_history_insert");

    const startsBeforeSecond = runtime.turnStarts;
    second.activate();
    const secondTurn = await runtime.waitForTurnStart(startsBeforeSecond);
    await waitForExecutionState(f.service, second.workId, "running");
    db.exec(`CREATE TRIGGER fail_history_update BEFORE UPDATE ON conversation_history_items
      BEGIN SELECT RAISE(ABORT, 'diagnostic update failed'); END`);
    runtime.complete(secondTurn.turnId);
    await waitForExecutionState(f.service, second.workId, "completed");
    runtime.complete(firstTurn.turnId);
    await waitForExecutionState(f.service, firstWorkId, "completed");
    const rows = query<Record<string, unknown>>(
      f.root,
      "SELECT workId, lifecycle, text FROM conversation_history_items WHERE workId = ?",
      second.workId,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.lifecycle, "started");
    assert.equal(rows[0]?.text, null);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("assignment history reads are scoped, re-redacted, and bounded in sequence order", () => {
  const db = new DatabaseSync(":memory:");
  const history = new ConversationHistoryStore(db);
  const binding = (index: number, taskId: string, assignmentId: string) => ({
    workId: `work-${index}`,
    taskId,
    assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: `thread-${index}`,
    turnId: `turn-${index}`,
  });

  try {
    for (let index = 0; index <= 200; index += 1) {
      const itemBinding = binding(index, "task-1", "assignment-1");
      history.record(
        itemBinding,
        {
          threadId: itemBinding.threadId,
          turnId: itemBinding.turnId,
          itemId: `item-${index}`,
          kind: "completed",
          text: `history ${index} current-value`,
        },
        [],
      );
    }
    for (const [index, taskId, assignmentId] of [
      [201, "other-task", "assignment-1"],
      [202, "task-1", "other-assignment"],
    ] as const) {
      const itemBinding = binding(index, taskId, assignmentId);
      history.record(
        itemBinding,
        {
          threadId: itemBinding.threadId,
          turnId: itemBinding.turnId,
          itemId: `item-${index}`,
          kind: "completed",
          text: "must not cross assignment scope",
        },
        [],
      );
    }

    const projection = history.readAssignment("task-1", "assignment-1", 200, [
      "current-value",
    ]);
    assert.equal(projection.items.length, 200);
    assert.equal(projection.omittedItemCount, 1);
    assert.equal(projection.turnOmissions.length, 0);
    assert.equal(projection.items[0]?.text, "history 1 [redacted]");
    assert.equal(projection.items.at(-1)?.text, "history 200 [redacted]");
    assert.ok(
      projection.items.every((item) => !item.text?.includes("current-value")),
    );
  } finally {
    db.close();
  }
});

test("current exclusions are computed only for completed items", () => {
  const db = new DatabaseSync(":memory:");
  const history = new ConversationHistoryStore(db);
  const binding = {
    workId: "work-1",
    taskId: "task-1",
    assignmentId: "assignment-1",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread-1",
    turnId: "turn-1",
  };
  let exclusionCalls = 0;
  const capture = new ConversationHistoryCapture({
    store: history,
    workId: binding.workId,
    threadId: binding.threadId,
    captureStartExclusions: ["start-value"],
    currentExclusions: () => {
      exclusionCalls += 1;
      return ["current-value"];
    },
  });
  const event = { threadId: binding.threadId, turnId: binding.turnId };

  try {
    assert.equal(capture.bind(binding), true);
    capture.receive({ ...event, itemId: "item-1", kind: "started" });
    capture.receive({ ...event, itemId: "item-1", kind: "delta", bytes: 5 });
    capture.receive({
      ...event,
      itemId: "item-2",
      kind: "omitted",
      reason: "size-limit",
    });
    assert.equal(exclusionCalls, 0);
    capture.receive({
      ...event,
      itemId: "item-1",
      kind: "completed",
      text: "start-value and current-value",
    });
    assert.equal(exclusionCalls, 1);
    const projection = history.readAssignment(
      "task-1",
      "assignment-1",
      200,
      [],
    );
    assert.deepEqual(
      projection.items.map((item) => [item.itemId, item.lifecycle, item.text]),
      [
        ["item-1", "completed", "[redacted] and [redacted]"],
        ["item-2", "omitted", null],
      ],
    );
  } finally {
    db.close();
  }
});

test("the installation discovery credential is redacted when history is captured", async () => {
  const runtime = new HistoryRuntime();
  const previous = process.env.FIXTURE_HISTORY_DISCOVERY;
  // The name deliberately avoids the generic TOKEN/SECRET environment pattern.
  process.env.FIXTURE_HISTORY_DISCOVERY = "DISCOVERYVALUECANARY841";
  const f = await fixture(runtime);
  command(f.service, {
    type: "discovery.configure",
    actor: "operator",
    credentialRef: "env:FIXTURE_HISTORY_DISCOVERY",
  });
  runtime.plan({
    id: "discovery-turn",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({ threadId, turnId, itemId: "d-1", kind: "started" });
      active.emit({
        threadId,
        turnId,
        itemId: "d-1",
        kind: "completed",
        text: "Found DISCOVERYVALUECANARY841 via env:FIXTURE_HISTORY_DISCOVERY.",
      });
    },
  });
  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");
    const stored = JSON.stringify(
      query(
        f.root,
        "SELECT text FROM conversation_history_items WHERE workId = ?",
        f.workId,
      ),
    );
    assert.equal(stored.includes("DISCOVERYVALUECANARY841"), false);
    assert.equal(stored.includes("FIXTURE_HISTORY_DISCOVERY"), false);
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_HISTORY_DISCOVERY;
    else process.env.FIXTURE_HISTORY_DISCOVERY = previous;
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the Claude token reference and value are redacted when history is captured", async () => {
  const runtime = new HistoryRuntime();
  const previous = process.env.FIXTURE_HISTORY_CLAUDE;
  // The name deliberately avoids the generic TOKEN/SECRET environment pattern.
  process.env.FIXTURE_HISTORY_CLAUDE = "CLAUDEVALUECANARY517";
  const f = await fixture(runtime);
  command(f.service, {
    type: "claude-token.configure",
    actor: "operator",
    credentialRef: "env:FIXTURE_HISTORY_CLAUDE",
  });
  runtime.plan({
    id: "claude-token-turn",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({ threadId, turnId, itemId: "c-1", kind: "started" });
      active.emit({
        threadId,
        turnId,
        itemId: "c-1",
        kind: "completed",
        text: "Found CLAUDEVALUECANARY517 via env:FIXTURE_HISTORY_CLAUDE.",
      });
    },
  });
  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");
    const stored = JSON.stringify(
      query(
        f.root,
        "SELECT text FROM conversation_history_items WHERE workId = ?",
        f.workId,
      ),
    );
    assert.equal(stored.includes("CLAUDEVALUECANARY517"), false);
    assert.equal(stored.includes("FIXTURE_HISTORY_CLAUDE"), false);
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_HISTORY_CLAUDE;
    else process.env.FIXTURE_HISTORY_CLAUDE = previous;
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a file-sourced Claude token value and path are redacted when history is captured", async () => {
  const runtime = new HistoryRuntime();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-history-token-")));
  chmodSync(root, 0o700);
  const path = join(root, "claude-token");
  writeFileSync(path, "CLAUDEFILECANARY884\n", { mode: 0o600 });
  const f = await fixture(runtime);
  command(f.service, {
    type: "claude-token.configure",
    actor: "operator",
    credentialRef: `file:${path}`,
  });
  runtime.plan({
    id: "claude-file-token-turn",
    beforeReturn: (active, threadId, turnId) => {
      active.emit({ threadId, turnId, itemId: "c-1", kind: "started" });
      active.emit({
        threadId,
        turnId,
        itemId: "c-1",
        kind: "completed",
        text: `Found CLAUDEFILECANARY884 in ${path}.`,
      });
    },
  });
  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");
    const stored = JSON.stringify(
      query(
        f.root,
        "SELECT text FROM conversation_history_items WHERE workId = ?",
        f.workId,
      ),
    );
    assert.equal(stored.includes("CLAUDEFILECANARY884"), false);
    assert.equal(stored.includes(path), false);
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("history capture and reads exclude every project's source and routing references and generic secret values", async (t) => {
  const runtime = new HistoryRuntime(),
    f = await fixture(runtime),
    otherProjectId = randomUUID(),
    keys = [
      "FIXTURE_HISTORY_SOURCE_A",
      "FIXTURE_HISTORY_ROUTE_A",
      "FIXTURE_HISTORY_SOURCE_B",
      "FIXTURE_HISTORY_ROUTE_B",
      "FIXTURE_HISTORY_SECRET",
    ],
    previous = keys.map((key) => process.env[key]);
  t.after(async () => {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  });
  command(f.service, {
    type: "project.create",
    actor: "operator",
    projectId: otherProjectId,
    name: "Other history project",
    leadProfileId: f.profileId,
  });
  for (const [index, projectId] of [f.projectId, otherProjectId].entries()) {
    command(f.service, {
      type: "github.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      credentialRef: `env:${keys[index * 2]}`,
      selections: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    command(f.service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      credentialRef: `env:${keys[index * 2 + 1]}`,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
  }
  for (const [index, key] of keys.entries())
    process.env[key] = `CaptureAccessCanary${index}`;
  // Each item isolates one exclusion, so another reference cannot hide a missed key/value.
  const captureTexts = keys.flatMap((key, index) => [
      ...(index < 4 ? [`Reference env:${key}`, `Key ${key}`] : []),
      `Value CaptureAccessCanary${index}`,
    ]),
    futureTexts = keys.map((_, index) => `Value RotatedAccessCanary${index}`);
  runtime.plan({
    id: "reference-history-turn",
    beforeReturn: (active, threadId, turnId) => {
      for (const [index, text] of [
        ...captureTexts,
        ...futureTexts,
        "Ordinary public update",
      ].entries()) {
        const itemId = `reference-${index}`;
        active.emit({ threadId, turnId, itemId, kind: "started" });
        active.emit({ threadId, turnId, itemId, kind: "completed", text });
      }
    },
  });
  f.activate();
  const bound = await runtime.waitForTurnStart();
  runtime.complete(bound.turnId);
  await waitForExecutionState(f.service, f.workId, "completed");
  const stored = JSON.stringify(
    query(
      f.root,
      "SELECT text FROM conversation_history_items WHERE workId = ?",
      f.workId,
    ),
  );
  assert.ok(stored.includes("Ordinary public update"));
  for (const [index, key] of keys.entries()) {
    if (index < 4) assert.equal(stored.includes(key), false, key);
    assert.equal(stored.includes(`CaptureAccessCanary${index}`), false);
    assert.ok(stored.includes(`RotatedAccessCanary${index}`));
    process.env[key] = `RotatedAccessCanary${index}`;
  }
  const read = JSON.stringify(
    f.service.coordinationView().readAssignmentHistory(f.assignmentId),
  );
  assert.ok(read.includes("Ordinary public update"));
  for (const [index, key] of keys.entries()) {
    if (index < 4) assert.equal(read.includes(key), false, key);
    assert.equal(read.includes(`RotatedAccessCanary${index}`), false);
  }
});

test("exact values and credential patterns cannot hide each other", () => {
  for (const [text, excluded, expected] of [
    ["x PRIV token=TOK TAIL y", "PRIV token=TOK TAIL", "x [redacted] y"],
    ["deploy token: LEAK", "deploy token", "[redacted]: [redacted]"],
    [
      "Send Authorization: Basic LEAK",
      "Send Authorization",
      "[redacted]: [redacted]",
    ],
    ["use Bearer LEAK", "use Bearer", "[redacted] [redacted]"],
    [
      "clone https://user:LEAK@host/r",
      "clone https:",
      "[redacted]//[redacted]@host/r",
    ],
    ['password="P1 LEAK"', '"P1', "password=[redacted]"],
    ["token=abcLEAK", "token=abc", "[redacted]"],
    [
      "AWS_SECRET_ACCESS_KEY=wJalrLEAK",
      "UNUSED",
      "AWS_SECRET_ACCESS_KEY=[redacted]",
    ],
    ["DB_PASSWORD_PROD=hunter2", "UNUSED", "DB_PASSWORD_PROD=[redacted]"],
    ["MY_SECRET=LEAK ok", "UNUSED", "MY_SECRET=[redacted] ok"],
    ["token count: 5", "UNUSED", "token count: 5"],
  ] as const)
    assert.equal(sanitizeConversationText(text, [excluded]), expected, text);
});

test("a raw @ in a URL password is redacted through the last @ before the path", () => {
  const redacted = sanitizeConversationText(
    "postgres://u:p@ss@db/x and https://user:pw@example.test/path?q=a@b#f@g",
    [],
  );
  assert.equal(
    redacted,
    "postgres://[redacted]@db/x and https://[redacted]@example.test/path?q=a@b#f@g",
  );
  assert.equal(redacted.includes("ss@"), false);
});

/** `capBytesOutsideRedaction`'s result, asserted to be a whole-character prefix within `maxBytes`. */
function capChecked(text: string, maxBytes: number, values: readonly string[]) {
  const result = capBytesOutsideRedaction(text, maxBytes, values);
  const label = JSON.stringify({ text, maxBytes });
  assert.ok(Buffer.byteLength(result, "utf8") <= maxBytes, label);
  assert.ok(text.startsWith(result), label);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result), label);
  return result;
}

test("a byte cap never keeps part of a redactable span", () => {
  const path = "/tmp/a b/source checkout";
  const text = `${"x ".repeat(20)}${path} tail`;
  const cut = text.indexOf("checkout") - 1;
  const capped = capChecked(text, cut, [path]);
  assert.equal(capped, "x ".repeat(20));
  assert.equal(
    sanitizeConversationText(capped, [path])?.includes("/tmp"),
    false,
  );

  const secret = 'start password: "a b c" end';
  // A word-boundary cut here would keep `"a b`, leaving `b` unredacted.
  assert.equal(capChecked(secret, secret.indexOf("c"), []), "start password: ");
  // The header and URL cuts also stop before the credential.
  const header = "see Authorization: Bearer one two three";
  assert.equal(
    capChecked(header, header.indexOf("two"), []),
    "see Authorization: ",
  );
  const url = "clone https://user:LEAK@host/r";
  assert.equal(capChecked(url, url.indexOf("@"), []), "clone ");

  // Overlapping spans with spaces: the cut moves before both.
  const overlap = "go /a b/c d/e f end";
  assert.equal(
    capChecked(overlap, overlap.indexOf("e f") + 1, ["/a b/c d", "c d/e f"]),
    "go ",
  );
  // A span at the start leaves nothing, and the loop ends.
  assert.equal(capChecked(`${path} tail`, 10, [path]), "");
});

test("a byte cap cuts plain text at a word boundary and whole UTF-8 characters", () => {
  const old = (text: string, max: number) =>
    Buffer.from(text, "utf8")
      .subarray(0, max)
      .toString("utf8")
      .replace(/\S*$/, "");
  const plain = "alpha beta gamma delta";
  assert.equal(capBytesOutsideRedaction(plain, 100, []), plain);
  assert.equal(capBytesOutsideRedaction(plain, plain.length, ["delta"]), plain);
  for (let max = 0; max < plain.length; max++)
    assert.equal(capBytesOutsideRedaction(plain, max, [""]), old(plain, max));
  // Text too large to search for spans keeps nothing rather than block on it.
  assert.equal(capBytesOutsideRedaction("a ".repeat(40 * 1024), 1024, []), "");

  // Every byte limit, including those inside a multi-byte character or the path: the
  // word-boundary result, except that a partly kept path is dropped whole.
  const before = "日本 😀😀 ";
  const path = "/tmp/é è/x";
  const wide = `${before}${path} ok`;
  for (let max = 0; max < Buffer.byteLength(wide); max++) {
    const capped = capChecked(wide, max, [path]);
    const words = old(wide, max);
    assert.equal(capped.includes("\uFFFD"), false);
    assert.equal(
      capped,
      words.includes("/tmp") && !words.includes(path) ? before : words,
    );
  }
});

test("byte caps at every boundary of mixed secrets keep no unredacted fragment", () => {
  // Every redactable character is upper case and nothing else is, so any kept one leaked.
  const values = ["/TMP/X LEAK Y/SRC", "SRC/.GIT LEAK", "É LEAK Ö"];
  const pieces = [
    ...values,
    "/TMP/X LEAK Y/SRC/.GIT LEAK",
    'password: "P LEAK Q"',
    "token=LEAKX",
    "authorization: bearer LEAK Z",
    "bearer LEAKW",
    "https://U:LEAK@host/p",
    "postgres://U:P@LEAK@db/x",
    "é",
    "😀",
    "word",
    "src",
  ];
  const separators = [" ", "  ", "\n", ", ", " 😀 "];
  let seed = 1668;
  const pick = <T>(list: readonly T[]) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return list[Math.floor((seed / 2 ** 31) * list.length)] as T;
  };
  for (let sample = 0; sample < 300; sample++) {
    let text = "";
    for (let count = 1 + pick([0, 1, 2, 3, 4, 5, 6, 7, 8]); count > 0; count--)
      text += pick(pieces) + pick(separators);
    assert.doesNotMatch(
      sanitizeConversationText(text, values) ?? "",
      /[A-ZÉÖ]/,
    );
    for (let max = 0; max <= Buffer.byteLength(text, "utf8"); max++) {
      const kept = sanitizeConversationText(
        capChecked(text, max, values),
        values,
      );
      assert.ok(kept !== undefined);
      assert.doesNotMatch(kept, /[A-ZÉÖ]/, JSON.stringify({ text, max }));
    }
  }
});

function plan(...statuses: ("pending" | "in_progress" | "completed")[]) {
  const normalized = normalizePlan(
    statuses.map((status, index) => ({ text: `Step ${index + 1}`, status })),
  );
  assert.ok(normalized);
  return normalized;
}

function planRows(root: string, workId: string) {
  return query<{
    steps: string | null;
    omissionReason: string | null;
    done: number;
    total: number;
  }>(
    root,
    "SELECT steps, omissionReason, done, total FROM conversation_plan_updates WHERE workId = ? ORDER BY sequence",
    workId,
  );
}

test("plan updates of the bound turn are redacted, deduplicated and keep steps only on the newest row", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime, {
    exclusions: () => ["FIXTURE_SECRET_CANARY"],
  });
  runtime.plan({ id: "plan-turn" });
  try {
    f.activate();
    const bound = await runtime.waitForTurnStart();
    const at = { threadId: bound.threadId, turnId: bound.turnId };
    runtime.emit({
      ...at,
      kind: "plan",
      plan: plan("completed", "in_progress", "pending"),
    });
    const second = normalizePlan([
      {
        text: `Use token=hunter2, ${profileInstructions} and FIXTURE_SECRET_CANARY`,
        status: "completed",
      },
      { text: "Step 2", status: "completed" },
      { text: "Step 3", status: "in_progress" },
    ]);
    assert.ok(second);
    runtime.emit({ ...at, kind: "plan", plan: second });
    runtime.emit({ ...at, kind: "plan", plan: second });
    // A plan for a turn this execution never returned is never attached.
    runtime.emit({ ...at, turnId: "unbound-turn", kind: "plan", plan: second });
    await until(() => planRows(f.root, f.workId).length === 2);
    runtime.complete(bound.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");

    const rows = planRows(f.root, f.workId);
    assert.deepEqual(
      rows.map(({ done, total, steps, omissionReason }) => ({
        done,
        total,
        steps: steps && JSON.parse(steps),
        omissionReason,
      })),
      [
        { done: 1, total: 3, steps: null, omissionReason: null },
        {
          done: 2,
          total: 3,
          steps: [
            {
              text: "Use token=[redacted], [redacted] and [redacted]",
              status: "done",
            },
            { text: "Step 2", status: "done" },
            { text: "Step 3", status: "in-progress" },
          ],
          omissionReason: null,
        },
      ],
    );
    assert.equal(
      query(f.root, "SELECT * FROM conversation_plan_updates").length,
      2,
    );
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a captured plan step is redacted before storage", () => {
  const db = new DatabaseSync(":memory:");
  const history = new ConversationHistoryStore(db);
  const binding = {
    workId: "work-1",
    taskId: "task-1",
    assignmentId: "assignment-1",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread-1",
    turnId: "turn-1",
  };
  try {
    const secret = normalizePlan([
      { text: "Use token=hunter2 with INSTRUCTION_SECRET", status: "pending" },
    ]);
    assert.ok(secret);
    history.recordPlan(binding, secret, ["INSTRUCTION_SECRET"]);
    const [latest] = history.latestPlans("task-1");
    assert.deepEqual(latest?.steps, [
      { text: "Use token=[redacted] with [redacted]", status: "pending" },
    ]);
    assert.doesNotMatch(
      JSON.stringify(
        db.prepare("SELECT * FROM conversation_plan_updates").all(),
      ),
      /hunter2|INSTRUCTION_SECRET/,
    );
  } finally {
    db.close();
  }
});

test("plan caps, unavailable redaction and corrupt rows are handled at the store", () => {
  const db = new DatabaseSync(":memory:");
  const history = new ConversationHistoryStore(db);
  const binding = (assignmentId: string) => ({
    workId: `work-${assignmentId}`,
    taskId: "task-1",
    assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread-1",
    turnId: "turn-1",
  });
  try {
    const long = normalizePlan(
      Array.from({ length: 51 }, (_, index) => ({
        text: index === 0 ? "x".repeat(1025) : `Step ${index + 1}`,
        status: index < 2 ? "completed" : "pending",
      })),
    );
    assert.ok(long);
    history.recordPlan(binding("capped"), long, []);
    history.recordPlan(binding("unredacted"), plan("pending"), undefined);
    const [capped, unredacted] = history.latestPlans("task-1");
    assert.equal(capped?.steps?.length, 50);
    assert.deepEqual(capped?.steps?.[0], { text: null, status: "done" });
    assert.equal(capped?.omittedStepCount, 1);
    assert.equal(capped?.done, 2);
    assert.equal(capped?.total, 51);
    assert.equal(unredacted?.steps, null);
    assert.equal(unredacted?.omissionReason, "redaction-unavailable");
    assert.equal(unredacted?.total, 1);
    assert.equal(
      history.readPlanUpdatesBefore("task-1", undefined, 10).length,
      2,
    );

    db.prepare(
      "UPDATE conversation_plan_updates SET steps = ? WHERE assignmentId = 'capped'",
    ).run(JSON.stringify([{ text: "Leaked", status: "unknown" }]));
    assert.throws(() => history.latestPlans("task-1"), { name: "ZodError" });
  } finally {
    db.close();
  }
});

test("normalizePlan maps both runtimes' statuses and rejects invalid or oversized plans", () => {
  assert.deepEqual(
    normalizePlan([
      { text: "a", status: "pending" },
      { text: "b", status: "inProgress" },
      { text: "c", status: "in_progress" },
      { text: "d", status: "completed" },
    ]),
    {
      steps: [
        { text: "a", status: "pending" },
        { text: "b", status: "in-progress" },
        { text: "c", status: "in-progress" },
        { text: "d", status: "done" },
      ],
      omittedStepCount: 0,
      done: 1,
      total: 4,
    },
  );
  assert.equal(
    normalizePlan(
      Array.from({ length: 1001 }, () => ({ text: "a", status: "pending" })),
    ),
    undefined,
  );
  assert.equal(normalizePlan([{ text: 1, status: "pending" }]), undefined);
  assert.equal(normalizePlan([{ text: "a", status: "done" }]), undefined);
});

test("reasoning storage caps Unicode after redaction, re-redacts reads, and durably fences erasure", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  runtime.plan({ id: "reasoning-storage-turn" });
  try {
    f.activate();
    const turn = await runtime.waitForTurnStart();
    await waitForExecutionState(f.service, f.workId, "running");
    const db = serviceDatabase(f.service);
    const intent = f.service.list().find((i) => i.workId === f.workId)!;
    const row = db
      .prepare(`SELECT b.*, r.workRevision FROM task_execution_bindings b
      JOIN task_work_revisions r USING(workId) WHERE b.workId = ?`)
      .get(f.workId)!;
    const binding = {
      workId: f.workId,
      taskId: f.taskId,
      assignmentId: f.assignmentId,
      assignmentVersion: Number(row.assignmentVersion),
      instructionsRevision: Number(row.instructionsRevision),
      profileRevision: Number(row.profileRevision),
      conversationRevision: Number(row.conversationRevision),
      workRevision: Number(row.workRevision),
      ...turn,
    };
    db.prepare(
      "UPDATE task_execution_bindings SET harness = 'claude' WHERE workId = ?",
    ).run(f.workId);
    db.prepare(`UPDATE execution_intent_reasoning_summaries SET enabled = 1,
      captureMode = 'enhanced', generation = 0 WHERE intentId = ?`).run(
      intent.id,
    );
    const history = f.service.conversationHistoryStore()!;
    const clear = () => db.exec("DELETE FROM conversation_reasoning_summaries");
    const record = (
      text: string | undefined,
      exclusions: readonly string[] | undefined = [],
    ) => history.recordReasoningSummary(binding, intent.id, text, exclusions);
    const read = (exclusions: readonly string[] = []) =>
      history.readReasoningSummary(binding, () => exclusions)!;
    for (const char of ["a", "😀"]) {
      for (const count of [16_000, 16_001]) {
        clear();
        record(char.repeat(count));
        assert.equal(read().text, char.repeat(16_000));
        assert.equal(read().truncated, Number(count > 16_000));
        assert.equal(read().stored, 1);
      }
    }
    for (const [text, exclusions, forbidden] of [
      [
        "a".repeat(15_990) + "PRIVATE_INSTRUCTION_CANARY tail",
        ["PRIVATE_INSTRUCTION_CANARY"],
        "PRIVATE",
      ],
      [
        "a".repeat(15_990) + " token=TOKEN_VALUE_CANARY tail",
        [],
        "TOKEN_VALUE",
      ],
      [
        "a".repeat(15_985) + " Bearer BEARER_VALUE_CANARY tail",
        [],
        "BEARER_VALUE",
      ],
      [
        "a".repeat(15_990) + "/workspace/private/path tail",
        ["/workspace/private/path"],
        "/workspace",
      ],
    ] as const) {
      clear();
      record(text, exclusions);
      const raw = String(
        db.prepare("SELECT text FROM conversation_reasoning_summaries").get()
          ?.text,
      );
      assert.ok(!raw.includes(forbidden));
      // Slicing first would leave a fragment that the exact-value redactor cannot see.
      if (exclusions.length)
        assert.ok(
          sanitizeConversationText(text.slice(0, 16_000), exclusions)?.includes(
            forbidden,
          ),
        );
    }
    clear();
    record("public NEW_PRIVATE_VALUE tail");
    assert.equal(read(["NEW_PRIVATE_VALUE"]).text, "public [redacted] tail");
    assert.equal(
      history.readReasoningSummary(binding, () => {
        throw new Error("unavailable");
      })?.text,
      null,
    );
    for (const exclusions of [undefined, [42] as unknown as string[]]) {
      clear();
      record("UNSAFE_CANARY", exclusions);
      // An explicitly missing context must fail closed (no default at the production seam).
      if (exclusions !== undefined) assert.equal(read().text, null);
    }
    clear();
    history.recordReasoningSummary(
      binding,
      intent.id,
      "UNSAFE_CANARY",
      undefined,
    );
    assert.equal(read().text, null);
    for (const [enabled, mode] of [
      [0, "enhanced"],
      [1, "baseline"],
      [1, null],
    ] as const) {
      clear();
      db.prepare(
        "UPDATE execution_intent_reasoning_summaries SET enabled=?, captureMode=? WHERE intentId=?",
      ).run(enabled, mode, intent.id);
      record("UNSOLICITED_CANARY");
      assert.equal(read().text, null);
    }
    clear();
    db.prepare(
      "UPDATE execution_intent_reasoning_summaries SET enabled=1,captureMode='enhanced' WHERE intentId=?",
    ).run(intent.id);
    const capture = (requested = true) =>
      new ConversationHistoryCapture({
        store: history,
        workId: binding.workId,
        threadId: binding.threadId,
        reasoningIntentId: intent.id,
        reasoningRequested: requested,
        captureStartExclusions: ["PRIVATE_SPLIT_CANARY"],
        currentExclusions: () => ["PRIVATE_SPLIT_CANARY"],
      });
    const summary = (
      itemId: string,
      text: string,
      turnId = binding.turnId,
    ) => ({
      threadId: binding.threadId,
      turnId,
      itemId,
      kind: "reasoning-summary" as const,
      text,
    });
    clear();
    const buffered = capture();
    buffered.receive(summary("wrong", "WRONG_TURN_CANARY", "wrong-turn"));
    buffered.receive(summary("first", "Ordered PRIVATE_SPL"));
    buffered.receive(summary("first", "Ordered PRIVATE_SPL"));
    buffered.receive(summary("second", "IT_CANARY tail"));
    assert.equal(buffered.bind(binding), true);
    buffered.finish();
    assert.equal(read().text, "Ordered [redacted] tail");
    clear();
    const mixed = capture();
    mixed.receive(summary("wrong-cap", "x".repeat(131_066), "wrong-turn"));
    mixed.receive(summary("selected", "PRIVATE_SPLIT_CANARY"));
    mixed.bind(binding);
    mixed.finish();
    assert.equal(read().text, "[redacted]");
    clear();
    for (const finish of ["bind", "discard"] as const) {
      const saturated = capture();
      saturated.receive(summary("full", "x".repeat(131_072)));
      for (let i = 0; i < 20_000; i++)
        saturated.receive(summary(`after-cap-${i}`, "x"));
      const retained = saturated as unknown as {
        bufferedSummaryItems: Set<string>;
        bufferedSummaryBytes: Map<string, number>;
      };
      assert.equal(retained.bufferedSummaryItems.size, 1);
      if (finish === "bind") saturated.bind(binding);
      else saturated.discard();
      assert.equal(retained.bufferedSummaryItems.size, 0);
      assert.equal(retained.bufferedSummaryBytes.size, 0);
      saturated.discard();
    }
    clear();
    for (const overflow of ["events", "bytes"] as const) {
      const lostPrefix = capture();
      lostPrefix.receive(summary("prefix", "PRIVATE_"));
      if (overflow === "events") {
        for (let i = 0; i < 8192; i++)
          lostPrefix.receive({
            ...turn,
            itemId: `early-${i}`,
            kind: "started",
          });
      } else
        lostPrefix.receive({
          ...turn,
          itemId: "large-early",
          kind: "completed",
          text: "x".repeat(4 * 1024 * 1024),
        });
      assert.equal(lostPrefix.bind(binding), true);
      lostPrefix.receive(summary("suffix", "SPLIT_CANARY"));
      lostPrefix.receive({
        ...turn,
        itemId: `normal-after-${overflow}`,
        kind: "completed",
        text: "Normal after overflow",
      });
      lostPrefix.finish();
      assert.equal(read().text, null);
      assert.equal(
        db
          .prepare(
            "SELECT text FROM conversation_reasoning_summaries WHERE workId=?",
          )
          .get(binding.workId)?.text,
        null,
      );
      assert.equal(
        db
          .prepare(
            "SELECT text FROM conversation_history_items WHERE workId=? AND itemId=?",
          )
          .get(binding.workId, `normal-after-${overflow}`)?.text,
        "Normal after overflow",
      );
      clear();
    }
    const unbound = capture();
    unbound.receive(summary("lost", "LOST_BINDING_CANARY"));
    unbound.discard();
    unbound.finish();
    assert.equal(read(), undefined);
    const disabled = capture(false);
    disabled.bind(binding);
    disabled.receive(summary("off", "UNSOLICITED_CANARY"));
    disabled.finish();
    assert.equal(read().text, null);
    for (const input of [
      "b".repeat(5 * 1024 * 1024),
      "https://user:" + "URLPASS_".repeat(30_000) + "@example.org",
      "😀".repeat(40_000),
      "a".repeat(15_990) + ' token="' + "secret words ".repeat(15_000),
    ]) {
      clear();
      const bounded = capture();
      bounded.bind(binding);
      bounded.receive(summary("large", input));
      bounded.finish();
      assert.equal(read().truncated, 1);
      assert.ok(read().text);
      assert.doesNotMatch(read().text!, /secret|URLPASS_/);
      assert.ok(Array.from(read().text!).length <= 16_000);
    }
    clear();
    record("ERASE_CANARY");
    assert.equal(read().stored, 1);
    const deletion = {
      type: "project.reasoning.delete",
      projectId: f.projectId,
      expectedVersion: Number(f.service.domain().project(f.projectId).version),
      confirmed: true,
      key: randomUUID(),
      actor: "operator",
    };
    const beforeDelete = capture();
    beforeDelete.receive(summary("buffered-delete", "PREDELETE_BUFFER_CANARY"));
    f.service.domain().execute(deletion as never);
    beforeDelete.bind(binding);
    beforeDelete.finish();
    assert.equal(read().text, null);
    assert.equal(read().stored, 0);
    assert.equal(
      db
        .prepare(
          "SELECT generation FROM project_reasoning_summaries WHERE projectId=?",
        )
        .get(f.projectId)?.generation,
      1,
    );
    f.service.domain().execute(deletion as never);
    assert.equal(
      db
        .prepare(
          "SELECT generation FROM project_reasoning_summaries WHERE projectId=?",
        )
        .get(f.projectId)?.generation,
      1,
    );
    clear();
    record("LATE_CANARY");
    assert.equal(read().text, null);
    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    try {
      reopened.exec("DELETE FROM conversation_reasoning_summaries");
      const afterRestart = new ConversationHistoryStore(reopened);
      afterRestart.recordReasoningSummary(
        binding,
        intent.id,
        "RESTART_CANARY",
        [],
      );
      assert.equal(
        afterRestart.readReasoningSummary(binding, () => [])?.text,
        null,
      );
    } finally {
      reopened.close();
    }
    runtime.complete(turn.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reasoning health reads exact retained metadata independently of current settings and diagnostics", async () => {
  const runtime = new HistoryRuntime();
  const f = await fixture(runtime);
  runtime.plan({ id: "metadata-turn" });
  try {
    f.activate();
    const turn = await runtime.waitForTurnStart();
    await waitForExecutionState(f.service, f.workId, "running");
    const db = serviceDatabase(f.service);
    const intent = f.service.executionForWork(f.workId)!;
    const state = new (
      await import("../../src/standalone/state.js")
    ).ExecutionState(db);
    const binding = state.conversationHistoryBinding(
      f.workId,
      turn.threadId,
      turn.turnId,
    )!;
    const history = f.service.conversationHistoryStore()!;
    const health = () => f.service.reasoningSummaryCaptureFor(f.workId);
    assert.deepEqual(f.service.reasoningSummaryCaptureFor("unknown"), {
      requested: false,
      stored: false,
    });
    // Today's opt-in cannot fill an absent or ineligible admission.
    db.prepare(
      "INSERT OR REPLACE INTO project_reasoning_summaries(projectId, enabled, generation) VALUES (?,1,0)",
    ).run(f.projectId);
    for (const [enabled, mode] of [
      [0, "enhanced"],
      [1, "baseline"],
      [1, null],
    ] as const) {
      db.prepare(
        "UPDATE execution_intent_reasoning_summaries SET enabled=?, captureMode=? WHERE intentId=?",
      ).run(enabled, mode, intent.id);
      assert.deepEqual(health(), { requested: false, stored: false });
    }
    db.prepare(
      "UPDATE execution_intent_reasoning_summaries SET enabled=1, captureMode='enhanced', generation=0 WHERE intentId=?",
    ).run(intent.id);
    assert.deepEqual(health(), { requested: true, stored: false }); // opted-in Codex
    db.prepare(
      "UPDATE project_reasoning_summaries SET enabled=0 WHERE projectId=?",
    ).run(f.projectId);
    db.prepare(
      "UPDATE task_execution_bindings SET harness='claude' WHERE workId=?",
    ).run(f.workId);
    history.recordReasoningSummary(binding, intent.id, undefined, []);
    assert.deepEqual(health(), { requested: true, stored: false }); // Claude without thinking
    db.exec("DELETE FROM conversation_reasoning_summaries");
    db.exec(`CREATE TEMP TRIGGER fail_summary_insert BEFORE INSERT ON conversation_reasoning_summaries
      BEGIN SELECT RAISE(FAIL, 'SUMMARY_INSERT_ERROR_CANARY'); END`);
    const failedCapture = new ConversationHistoryCapture({
      store: history,
      workId: f.workId,
      threadId: turn.threadId,
      reasoningIntentId: intent.id,
      reasoningRequested: true,
      captureStartExclusions: [],
      currentExclusions: () => [],
    });
    failedCapture.bind(binding);
    failedCapture.receive({
      kind: "reasoning-summary",
      ...turn,
      itemId: "summary",
      text: "FAILED_SUMMARY_CANARY",
    });
    failedCapture.receive({
      kind: "completed",
      ...turn,
      itemId: "ordinary",
      text: "ordinary history",
    });
    assert.doesNotThrow(() => failedCapture.finish());
    assert.deepEqual(health(), { requested: true, stored: false });
    assert.equal(
      db
        .prepare(
          "SELECT text FROM conversation_history_items WHERE itemId='ordinary'",
        )
        .get()?.text,
      "ordinary history",
    );
    db.exec("DROP TRIGGER fail_summary_insert");
    history.recordReasoningSummary(
      binding,
      intent.id,
      "SUMMARY_METADATA_CANARY".repeat(1000),
      [],
    );
    assert.deepEqual(health(), { requested: true, stored: true }); // truncated still collected
    const originalTextRead = history.readReasoningSummary;
    history.readReasoningSummary = () => {
      throw new Error("health must never read text");
    };
    assert.equal(health().stored, true);
    history.readReasoningSummary = originalTextRead;
    const before = db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.equal(history.hasStoredReasoningSummary(binding, intent.id), true);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.ok(!JSON.stringify(health()).includes("CANARY"));
    // Retained conversations need not be the assignment's current revision.
    db.prepare(
      "UPDATE assignment_conversations SET revision=revision+1 WHERE assignmentId=?",
    ).run(f.assignmentId);
    assert.equal(health().stored, true);
    for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
      const value = binding[key];
      assert.equal(
        history.hasStoredReasoningSummary(
          {
            ...binding,
            [key]: typeof value === "number" ? value + 1 : `${value}-wrong`,
          },
          intent.id,
        ),
        false,
        key,
      );
    }
    assert.equal(
      history.hasStoredReasoningSummary(binding, randomUUID()),
      false,
    );
    for (const [column, value] of [
      ["projectId", "wrong"],
      ["intentId", randomUUID()],
      ["generation", 5],
      ["createdAt", -1],
    ] as const) {
      const original = db
        .prepare(
          `SELECT ${column} AS value FROM conversation_reasoning_summaries`,
        )
        .get()!.value;
      db.prepare(`UPDATE conversation_reasoning_summaries SET ${column}=?`).run(
        value,
      );
      assert.equal(health().stored, false, column);
      db.prepare(`UPDATE conversation_reasoning_summaries SET ${column}=?`).run(
        original!,
      );
    }
    db.prepare(
      "UPDATE execution_intents SET turnId='wrong-turn' WHERE id=?",
    ).run(intent.id);
    assert.equal(health().stored, false);
    db.prepare("UPDATE execution_intents SET turnId=? WHERE id=?").run(
      turn.turnId,
      intent.id,
    );
    db.exec("DELETE FROM diagnostic_items; DELETE FROM diagnostic_executions");
    assert.equal(health().stored, true);
    db.prepare(
      "UPDATE execution_intent_reasoning_summaries SET generation=NULL WHERE intentId=?",
    ).run(intent.id);
    assert.deepEqual(health(), { requested: true, stored: false });
    db.prepare(
      "UPDATE execution_intent_reasoning_summaries SET generation=0 WHERE intentId=?",
    ).run(intent.id);
    db.prepare(`INSERT INTO execution_intents(id, workId, prompt, workspace, state, threadId, turnId, accountType, sandbox, approval)
      VALUES (?, 'ambiguous-work', 'test', ?, 'completed', ?, ?, 'chatgpt', 'workspaceWrite', 'never')`).run(
      randomUUID(),
      f.root,
      turn.threadId,
      turn.turnId,
    );
    assert.equal(health().stored, false);
    db.exec("DELETE FROM execution_intents WHERE workId='ambiguous-work'");
    assert.equal(health().stored, true);
    const originalRead = history.hasStoredReasoningSummary;
    history.hasStoredReasoningSummary = () => {
      throw new Error("SUMMARY_ERROR_CANARY");
    };
    assert.deepEqual(health(), { requested: true, stored: false });
    history.hasStoredReasoningSummary = originalRead;
    const deletion = {
      type: "project.reasoning.delete",
      projectId: f.projectId,
      expectedVersion: Number(f.service.domain().project(f.projectId).version),
      confirmed: true,
      key: randomUUID(),
      actor: "operator",
    };
    f.service.domain().execute(deletion as never);
    f.service.domain().execute(deletion as never);
    assert.deepEqual(health(), { requested: true, stored: false });
    const reopened = new DatabaseSync(
      join(f.root, "data", "standalone.sqlite"),
    );
    try {
      const retained = new ConversationHistoryStore(reopened);
      retained.recordReasoningSummary(binding, intent.id, "LATE_CANARY", []);
      assert.equal(
        retained.hasStoredReasoningSummary(binding, intent.id),
        false,
      );
    } finally {
      reopened.close();
    }
    const later = {
      ...binding,
      workId: `${f.workId}:later`,
      turnId: "later-turn",
      workRevision: binding.workRevision + 1,
    };
    const laterIntent = randomUUID();
    db.prepare(`INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval)
      VALUES (?,?,'later',?,'completed',?,?,'chatgpt','workspaceWrite','never')`).run(
      laterIntent,
      later.workId,
      f.root,
      later.threadId,
      later.turnId,
    );
    db.prepare(`INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,harness)
      SELECT ?,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,harness FROM task_execution_bindings WHERE workId=?`).run(
      later.workId,
      f.workId,
    );
    db.prepare(
      "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES (?,?,?,?)",
    ).run(
      later.workId,
      later.assignmentId,
      later.conversationRevision,
      later.workRevision,
    );
    db.prepare(
      "INSERT INTO execution_intent_reasoning_summaries(intentId,enabled,captureMode,generation) VALUES (?,1,'enhanced',1)",
    ).run(laterIntent);
    history.recordReasoningSummary(later, laterIntent, "LATER_SUMMARY", []);
    assert.deepEqual(f.service.reasoningSummaryCaptureFor(later.workId), {
      requested: true,
      stored: true,
    });
    db.prepare(
      "DELETE FROM execution_intent_reasoning_summaries WHERE intentId=?",
    ).run(intent.id);
    assert.deepEqual(health(), { requested: false, stored: false });
    runtime.complete(turn.turnId);
    await waitForExecutionState(f.service, f.workId, "completed");
  } finally {
    await f.service.stop().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});
