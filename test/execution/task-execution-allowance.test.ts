import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore, type DomainCommand } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  AllowanceHistoryUnavailableError,
  ExecutionState,
} from "../../src/standalone/state.js";
import {
  generationRuntime,
  holdGeneration,
} from "../fixtures/recovery-generations.js";
import { tmpdir } from "../fixtures/temp.js";

type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

/** Real SQLite with a domain task and its lead, and bound or unbound work queued directly. */
function stateFixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "cab-allowance-"));
  const file = join(directory, "state.sqlite");
  const open = () => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  };
  const db = open();
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  let state = new ExecutionState(db);
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: randomUUID() } as DomainCommand);
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  run({
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Lead",
    instructions: "lead",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Allowance",
    leadProfileId: profileId,
  });
  run({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Task",
    outcome: "Deliver",
    ready: true,
  });
  const lead = domain.ensureLeadAssignment(taskId)!;
  let sequence = 0;
  const f = {
    db,
    file,
    open,
    taskId,
    projectId,
    get state() {
      return state;
    },
    reopen() {
      state = new ExecutionState(db);
      return state;
    },
    /** Queues one bound generation in its own workspace, so the writer rule never decides. */
    queue(bound = true) {
      const workId = `work-${++sequence}`;
      const intent = state.create(
        workId,
        "prompt",
        join(directory, `workspace-${sequence}`),
      );
      if (bound) {
        const assignment = domain.assignment(String(lead.id));
        state.bindTask(workId, {
          taskId,
          assignmentId: String(lead.id),
          assignmentVersion: Number(assignment.version),
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
        });
      }
      return intent;
    },
    admit(intent: { id: string }, validate?: () => string[]) {
      return state.begin(intent.id, {
        projectId,
        ...(validate ? { validate } : {}),
      });
    },
    count(sql: string, ...args: string[]) {
      return Number((db.prepare(sql).get(...args) as { n: number }).n);
    },
    charges() {
      return f.count(
        "SELECT COUNT(*) AS n FROM task_execution_charges WHERE taskId = ?",
        taskId,
      );
    },
    set(total: number | null) {
      return state.setTaskAllowance({
        key: randomUUID(),
        taskId,
        expectedAllowanceVersion: state.taskAllowance(taskId).version,
        total,
      });
    },
    reason(intent: { id: string }) {
      return state.get(intent.id).reason ?? "";
    },
  };
  return f;
}

test("charges are recorded while the allowance is off, and toggling never resets them", (t) => {
  const f = stateFixture(t);
  for (let i = 0; i < 2; i++) assert.equal(f.admit(f.queue()), true);
  assert.equal(f.charges(), 2);
  assert.equal(f.state.taskAllowance(f.taskId).state, "off");
  assert.equal(f.state.taskAllowance(f.taskId).charged, 2);

  f.set(2);
  const held = f.queue();
  assert.equal(f.admit(held), false);
  assert.match(f.reason(held), /^Allowance waiting: /);
  assert.equal(f.state.get(held.id).state, "ready");
  assert.equal(f.charges(), 2, "a held admission charges nothing");
  assert.equal(
    f.count(
      "SELECT COUNT(*) AS n FROM execution_capacity_reservations WHERE workId = ?",
      held.workId,
    ),
    0,
  );
  assert.equal(
    f.count(
      "SELECT COUNT(*) AS n FROM task_writer_admissions WHERE workId = ?",
      held.workId,
    ),
    0,
  );
  assert.deepEqual(f.state.taskAllowance(f.taskId).heldWorkIds, [held.workId]);
  // Another wait recorded over the reason, such as a preflight failure, still leaves it held.
  f.state.wait(held.id, "runtime unavailable: preflight failed");
  assert.deepEqual(f.state.taskAllowance(f.taskId).heldWorkIds, [held.workId]);

  f.set(null);
  assert.equal(f.state.taskAllowance(f.taskId).charged, 2);
  assert.deepEqual(f.state.taskAllowance(f.taskId).heldWorkIds, []);
  f.set(2);
  assert.equal(f.state.taskAllowance(f.taskId).charged, 2);
  assert.equal(f.state.taskAllowance(f.taskId).remaining, 0);
  assert.equal(f.admit(held), false);
});

test("the last unit admits exactly one of two eligible requests", (t) => {
  const f = stateFixture(t);
  assert.equal(f.admit(f.queue()), true);
  f.set(2);
  const [first, second] = [f.queue(), f.queue()];
  const admitted = [f.admit(first), f.admit(second)];
  assert.deepEqual(admitted, [true, false]);
  assert.equal(f.charges(), 2);
  assert.match(f.reason(second), /^Allowance waiting: /);
  const allowance = f.state.taskAllowance(f.taskId);
  assert.ok(allowance.charged <= (allowance.total ?? 0));
  assert.equal(allowance.provisional, 2, "admitted, no turn bound yet");
});

test("a rolled-back admission charges nothing and a repeated begin charges once", (t) => {
  const f = stateFixture(t);
  const intent = f.queue();
  // The assignment moved on after the request was bound: `begin` throws inside its transaction.
  f.db
    .prepare(
      "UPDATE domain_assignments SET version = version + 1 WHERE taskId = ?",
    )
    .run(f.taskId);
  assert.throws(() => f.admit(intent), /no longer matches its bound version/);
  assert.equal(f.charges(), 0);
  assert.equal(
    f.count(
      "SELECT COUNT(*) AS n FROM execution_capacity_reservations WHERE workId = ?",
      intent.workId,
    ),
    0,
  );
  assert.equal(
    f.count(
      "SELECT COUNT(*) AS n FROM task_writer_admissions WHERE workId = ?",
      intent.workId,
    ),
    0,
  );
  assert.equal(f.state.get(intent.id).state, "ready");

  const next = f.queue();
  assert.equal(f.admit(next), true);
  assert.equal(f.admit(next), false, "already submitting");
  assert.equal(f.charges(), 1);
});

test("a charge survives a crash before any proof, and a throwing admission leaves nothing", (t) => {
  const f = stateFixture(t);
  const admitted = f.queue();
  assert.equal(f.admit(admitted), true);
  const failing = f.queue();
  assert.throws(() =>
    f.admit(failing, () => {
      throw new Error("storage failure inside begin");
    }),
  );
  const reopened = f.open();
  try {
    const state = new ExecutionState(reopened);
    assert.equal(state.taskAllowance(f.taskId).charged, 1);
    assert.equal(
      (
        reopened
          .prepare(
            "SELECT correctedAt FROM task_execution_charges WHERE workId = ?",
          )
          .get(admitted.workId) as { correctedAt: number | null }
      ).correctedAt,
      null,
    );
    assert.equal(
      reopened
        .prepare("SELECT 1 FROM task_execution_charges WHERE workId = ?")
        .get(failing.workId),
      undefined,
    );
  } finally {
    reopened.close();
  }
});

test("setting the allowance is keyed, fenced on its own version and revokes nothing", (t) => {
  const f = stateFixture(t);
  const running = f.queue();
  assert.equal(f.admit(running), true);
  const key = randomUUID();
  const first = f.state.setTaskAllowance({
    key,
    taskId: f.taskId,
    expectedAllowanceVersion: 0,
    total: 3,
  });
  assert.equal(first.replayed, false);
  assert.deepEqual(first.receipt, {
    kind: "task-allowance",
    key,
    recorded: true,
    taskId: f.taskId,
    previousTotal: null,
    total: 3,
    version: 1,
    charged: 1,
    remaining: 2,
    overBy: 0,
  });
  const replay = f.state.setTaskAllowance({
    key,
    taskId: f.taskId,
    expectedAllowanceVersion: 0,
    total: 3,
  });
  assert.deepEqual(replay, { receipt: first.receipt, replayed: true });
  assert.throws(
    () =>
      f.state.setTaskAllowance({
        key,
        taskId: f.taskId,
        expectedAllowanceVersion: 0,
        total: 4,
      }),
    /Request key reused/,
  );
  assert.throws(
    () =>
      f.state.setTaskAllowance({
        key: randomUUID(),
        taskId: f.taskId,
        expectedAllowanceVersion: 0,
        total: 4,
      }),
    /Allowance version conflict/,
  );
  assert.equal(f.state.taskAllowance(f.taskId).total, 3);
  assert.equal(f.state.taskAllowance(f.taskId).version, 1);

  // A task edit does not move the allowance version.
  const taskVersion = Number(
    (
      f.db
        .prepare("SELECT version FROM domain_tasks WHERE id = ?")
        .get(f.taskId) as { version: number }
    ).version,
  );
  const lowered = f.set(0).receipt;
  assert.equal(lowered.overBy, 1);
  assert.equal(lowered.remaining, 0);
  assert.equal(f.state.get(running.id).state, "submitting", "not revoked");
  assert.equal(
    Number(
      (
        f.db
          .prepare("SELECT version FROM domain_tasks WHERE id = ?")
          .get(f.taskId) as { version: number }
      ).version,
    ),
    taskVersion,
  );
  const held = f.queue();
  assert.equal(f.admit(held), false);
  const raised = f.set(2).receipt;
  assert.deepEqual([raised.previousTotal, raised.total], [0, 2]);
  assert.equal(f.admit(held), true, "the same queued request is admitted");
  const removed = f.set(null).receipt;
  assert.deepEqual(
    [removed.total, removed.remaining, removed.overBy, removed.version],
    [null, null, null, 4],
  );
  assert.equal(f.state.taskAllowance(f.taskId).state, "off");
  assert.equal(f.admit(f.queue()), true);
});

test("activation is refused for history from before the ledger, and missing accounting holds", async (t) => {
  await t.test("pre-ledger admissions", (t) => {
    const f = stateFixture(t);
    assert.equal(f.admit(f.queue()), true);
    // The level 37 migration on a database that already had this admission.
    f.db.exec(`DROP TABLE task_execution_charges;
      DROP TABLE task_execution_allowances;
      DROP TABLE task_execution_allowance_unprovable`);
    const state = f.reopen();
    assert.equal(state.taskAllowance(f.taskId).state, "history-unavailable");
    assert.throws(() => f.set(2), AllowanceHistoryUnavailableError);
    assert.equal(state.taskAllowance(f.taskId).version, 0);
    // Removing first cannot bypass the refusal.
    f.set(null);
    assert.throws(() => f.set(2), AllowanceHistoryUnavailableError);
    // A reopen does not run the migration again.
    assert.equal(
      f.reopen().taskAllowance(f.taskId).state,
      "history-unavailable",
    );
  });
  await t.test("a fresh task", (t) => {
    const f = stateFixture(t);
    f.db.exec(`DROP TABLE task_execution_charges;
      DROP TABLE task_execution_allowances;
      DROP TABLE task_execution_allowance_unprovable`);
    f.reopen();
    assert.equal(f.set(1).receipt.total, 1);
  });
  await t.test("an enabled task with an admission missing its charge", (t) => {
    const f = stateFixture(t);
    assert.equal(f.admit(f.queue()), true);
    f.set(5);
    f.db.exec("DELETE FROM task_execution_charges");
    const held = f.queue();
    assert.equal(f.admit(held), false);
    assert.equal(f.reason(held), "Allowance waiting: accounting unavailable");
    const allowance = f.state.taskAllowance(f.taskId);
    assert.equal(allowance.state, "inconsistent");
    assert.deepEqual(allowance.heldWorkIds, [held.workId]);
  });
});

test("configuring the allowance waits for an admission in progress", (t) => {
  const f = stateFixture(t);
  const other = f.open();
  t.after(() => other.close());
  const second = new ExecutionState(other);
  let refused: unknown;
  assert.equal(
    f.admit(f.queue(), () => {
      try {
        second.setTaskAllowance({
          key: randomUUID(),
          taskId: f.taskId,
          expectedAllowanceVersion: 0,
          total: 0,
        });
      } catch (error) {
        refused = error;
      }
      return [];
    }),
    true,
  );
  assert.match(String(refused), /locked|busy/i);
  assert.equal(f.state.taskAllowance(f.taskId).version, 0);
  assert.equal(f.state.taskAllowance(f.taskId).charged, 1);
});

test("unbound work is never charged, even beside an exhausted task", (t) => {
  const f = stateFixture(t);
  f.set(0);
  const direct = f.queue(false);
  assert.equal(f.admit(direct), true);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM task_execution_charges"), 0);
  assert.equal(f.admit(f.queue()), false);
});

test("no coordination tool sets an allowance", () => {
  for (const tool of coordinationTools)
    assert.doesNotMatch(
      `${tool.name} ${tool.description}`,
      /allowance/i,
      tool.name,
    );
});

/** A runtime whose thread start fails on request and whose turns wait on a gate. */
class AllowanceRuntime implements Runtime {
  startThreadError: (() => Error) | undefined;
  turnError: (() => Error) | undefined;
  gate: Promise<void> | undefined;
  turns = 0;
  private threads = 0;
  async start() {}
  async stop() {}
  async startThread() {
    if (this.startThreadError) throw this.startThreadError();
    return `thread-${++this.threads}`;
  }
  async resumeThread() {}
  async startTurn() {
    if (this.turnError) throw this.turnError();
    return `turn-${++this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn(threadId: string, turnId: string) {
    await this.gate;
    // Reporting a result keeps cab from queuing a reporting repair turn.
    const result = await this.listener?.({
      threadId,
      turnId,
      callId: `result-${turnId}`,
      tool: "cab_report_result",
      arguments: { summary: "Done" },
    });
    assert.equal(result?.success, true, JSON.stringify(result));
    return "completed" as const;
  }
  private listener:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
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

/** A service with one paused project and a ready task whose lead runs on the fake runtime. */
async function serviceFixture(t: {
  after: (fn: () => Promise<void> | void) => void;
}) {
  const root = mkdtempSync(join(tmpdir(), "cab-allowance-service-"));
  const runtime = new AllowanceRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      routingClient: null,
      supervisor: { observationMs: 5 },
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
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
    name: "Allowance",
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
  const api = new OperatorApi(service);
  const db = (service as unknown as { db: DatabaseSync }).db;
  return {
    service,
    runtime,
    api,
    db,
    taskId,
    assignmentId,
    initial: `assignment:${assignmentId}:initial`,
    allowance: () => service.taskAllowance(taskId),
    intent: (workId: string) =>
      service.list().find((item) => item.workId === workId),
    request: (workId: string) =>
      service.turnRequests().find((item) => item.workId === workId),
    describe: () => ({
      requests: service
        .turnRequests()
        .map((r) => [r.workId, r.state, r.reason]),
      intents: service.list().map((i) => [i.workId, i.state, i.reason]),
    }),
    unpause() {
      execute({
        type: "project.configure",
        projectId,
        expectedVersion: Number(service.domain().project(projectId).version),
        paused: false,
      });
    },
    set(total: number | null, expected?: number) {
      return api.execute({
        type: "task.allowance.set",
        key: randomUUID(),
        taskId,
        expectedAllowanceVersion:
          expected ?? service.taskAllowance(taskId).version,
        total,
      });
    },
    startAgain(workId: string) {
      return service.startAgain({
        key: randomUUID(),
        taskId,
        expectedVersion: Number(service.domain().task(taskId).version),
        workId,
      });
    },
  };
}

test("a proved pre-turn refusal corrects its charge once, and Start again charges afresh", async (t) => {
  const f = await serviceFixture(t);
  await f.set(1);
  f.runtime.startThreadError = () => new Error("Runtime stopped");
  f.unpause();
  let refused = f.initial;
  for (let round = 0; round < 3; round++) {
    await waitUntil(() => f.request(refused)?.state === "held", f.describe);
    assert.equal(f.allowance().charged, 0, `round ${round}`);
    assert.deepEqual(
      {
        ...(f.db
          .prepare(
            "SELECT correctedAt IS NOT NULL AS corrected FROM task_execution_charges WHERE workId = ?",
          )
          .get(refused) as object),
      },
      { corrected: 1 },
    );
    refused = (await f.startAgain(refused)).workId;
  }
  await waitUntil(() => f.request(refused)?.state === "held", f.describe);
  assert.equal(f.allowance().corrected, 4);
  assert.equal(f.allowance().charged, 0);

  // startTurn was called: the submission is uncertain and stays charged.
  f.runtime.startThreadError = undefined;
  f.runtime.turnError = () => new Error("turn/start timed out");
  const uncertain = (await f.startAgain(refused)).workId;
  await waitUntil(() => f.intent(uncertain)?.state === "held", f.describe);
  assert.match(f.intent(uncertain)?.reason ?? "", /uncertain/);
  assert.equal(f.allowance().charged, 1);
  assert.equal(f.allowance().remaining, 0);
});

test("exhaustion holds the next turn visibly until the total is raised", async (t) => {
  const f = await serviceFixture(t);
  let release!: () => void;
  f.runtime.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await f.set(1);
  f.unpause();
  await waitUntil(() => f.intent(f.initial)?.state === "running", f.describe);
  // Lowering below consumption revokes nothing: the running turn continues.
  const lowered = await f.set(0);
  assert.ok(lowered.kind === "task-allowance");
  assert.equal(lowered.overBy, 1);
  let read = (await f.api.readTask(f.taskId)).data;
  assert.equal(read.execution.state, "running");
  assert.equal(read.executionAllowance?.provisional, 0, "its turn is bound");
  release();
  await waitUntil(() => f.intent(f.initial)?.state === "completed", f.describe);
  assert.deepEqual(
    f.service
      .inboxConditions(f.taskId)
      .filter((c) => c.code === "allowance-exhausted"),
    [],
    "a task whose last turn used the last unit raises nothing",
  );

  await f.service.coordinationView().postOperatorMessage({
    key: randomUUID(),
    taskId: f.taskId,
    recipientAssignmentId: f.assignmentId,
    expectedAssignmentVersion: Number(
      f.service.domain().assignment(f.assignmentId).version,
    ),
    message: "Continue",
  });
  const held = () =>
    f.service
      .turnRequests()
      .find((r) => /^Allowance waiting: /.test(r.reason ?? ""));
  await waitUntil(() => held() !== undefined, f.describe);
  const next = held()!.workId;
  assert.equal(f.request(next)?.state, "queued");
  read = (await f.api.readTask(f.taskId)).data;
  assert.equal(read.execution.state, "waiting");
  assert.deepEqual(read.execution.reasonCodes, ["allowance-held"]);
  assert.deepEqual(read.executionAllowance?.heldWorkIds, [next]);
  assert.ok(read.attention.codes.includes("allowance-exhausted"));
  const conditions = f.service
    .inboxConditions(f.taskId)
    .filter((c) => c.code === "allowance-exhausted");
  assert.deepEqual(
    conditions.map((c) => c.key),
    [`allowance-exhausted:${f.taskId}:2:${next}`],
  );

  await f.set(2);
  await waitUntil(() => f.intent(next)?.state === "completed", f.describe);
  assert.equal(
    f.service.turnRequests().filter((r) => r.taskId === f.taskId).length,
    2,
    "raising creates no new request",
  );
  assert.equal(f.allowance().charged, 2);
  assert.deepEqual(f.allowance().heldWorkIds, []);
});

test("the operator API refuses a stale version and unprovable history with 409 and changes nothing", async (t) => {
  const f = await serviceFixture(t);
  const conflict = (error: unknown) =>
    error instanceof OperatorApiError && error.status === 409;
  const command = {
    type: "task.allowance.set" as const,
    key: randomUUID(),
    taskId: f.taskId,
    expectedAllowanceVersion: 0,
    total: 3,
  };
  const receipt = await f.api.execute(command);
  assert.deepEqual(await f.api.execute(command), receipt);
  await assert.rejects(f.set(4, 0), conflict);
  assert.equal(f.allowance().total, 3);
  f.db.exec(
    "INSERT INTO task_execution_allowance_unprovable VALUES ('" +
      f.taskId +
      "')",
  );
  await f.set(null);
  await assert.rejects(
    f.set(1),
    (error: unknown) =>
      conflict(error) &&
      /admissions from before/.test(
        (error as OperatorApiError).publicMessage ?? "",
      ),
  );
  const read = (await f.api.readTask(f.taskId)).data.executionAllowance;
  assert.equal(read?.state, "history-unavailable");
  assert.equal(read?.total, null);
});

test("releasing a held generation that never bound a thread keeps its charge", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-allowance-release-"));
  const runtime = generationRuntime("no-turn");
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const g = await holdGeneration(service, runtime, "no-turn");
  const taskId = String(service.domain().assignment(g.assignmentId).taskId);
  const before = service.taskAllowance(taskId);
  assert.ok(before.charged >= 1);
  service.releaseUnboundHold({
    key: randomUUID(),
    assignmentId: g.assignmentId,
    workId: g.workId,
    workRevision: g.workRevision,
    requestSequence: g.requestSequence,
  });
  assert.equal(service.startAgainAvailability(taskId).available, true);
  const after = service.taskAllowance(taskId);
  assert.deepEqual(
    [after.charged, after.corrected],
    [before.charged, before.corrected],
    "an operator release is not a proved pre-turn refusal",
  );
});
