import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import type { StandaloneService } from "../../src/standalone/service.js";
import {
  command,
  db,
  refusedInitial,
  unpause,
  waitUntil,
} from "../fixtures/refused-turn.js";

type Refused = Awaited<ReturnType<typeof refusedInitial>>;

const version = (service: StandaloneService, taskId: string) =>
  Number(service.domain().task(taskId).version);

const startAgain = (
  f: Refused,
  workId = f.workId,
  expectedVersion?: number,
) => ({
  type: "task.start-again" as const,
  key: randomUUID(),
  taskId: f.taskId,
  expectedVersion: expectedVersion ?? version(f.service, f.taskId),
  workId,
});

const reset = (f: Refused, expectedVersion?: number) => ({
  type: "task.reset" as const,
  key: randomUUID(),
  taskId: f.taskId,
  expectedVersion: expectedVersion ?? version(f.service, f.taskId),
});

const conflict = (message?: RegExp) => (error: unknown) =>
  error instanceof OperatorApiError &&
  error.status === 409 &&
  (message === undefined || message.test(error.publicMessage ?? ""));

const count = (service: StandaloneService, sql: string, ...args: string[]) =>
  Number(
    (
      db(service)
        .prepare(sql)
        .get(...args) as { n: number }
    ).n,
  );

const requests = (service: StandaloneService, taskId: string) =>
  count(
    service,
    "SELECT COUNT(*) AS n FROM turn_requests WHERE taskId=?",
    taskId,
  );

const history = (service: StandaloneService, workId: string) => ({
  request: service.turnRequests().find((r) => r.workId === workId),
  intent: service.list().find((i) => i.workId === workId),
  refusal: db(service)
    .prepare("SELECT * FROM execution_request_refusals WHERE workId = ?")
    .get(workId),
});

async function readStartAgain(f: Refused) {
  return (await new OperatorApi(f.service).readTask(f.taskId)).data;
}

/** The lead's completion request, so a restarted turn can finish the task. */
function completeTask(f: Refused) {
  f.runtime.handleTurn = async (threadId, turnId) => {
    const result = await f.runtime.callTool({
      threadId,
      turnId,
      callId: `restart-completion-${turnId}`,
      tool: "cab_request_completion",
      arguments: { reviewedResultIds: [] },
    });
    assert.equal(result.success, true);
  };
}

test("Start again requeues a refused first turn at the current revisions in the same workspace", async () => {
  const f = await refusedInitial();
  try {
    const before = await readStartAgain(f);
    assert.equal(before.execution.state, "not-started");
    assert.deepEqual(before.execution.reasonCodes, ["refused-before-start"]);
    assert.ok(before.attention.codes.includes("not-started"));
    assert.ok(!before.attention.codes.includes("execution-uncertain"));
    assert.deepEqual(before.startAgain, {
      available: true,
      assignmentId: f.assignmentId,
      workId: f.workId,
    });
    const refused = history(f.service, f.workId);
    const events = count(
      f.service,
      "SELECT COUNT(*) AS n FROM coordination_inbox_events WHERE taskId=?",
      f.taskId,
    );
    const inbox = (
      await new OperatorApi(f.service).readInbox()
    ).data.items.find((item) => item.kind === "intervention");
    assert.equal(
      inbox?.kind === "intervention" && inbox.attentionCode,
      "not-started",
    );
    unpause(f);
    completeTask(f);

    const current = version(f.service, f.taskId);
    const receipt = await new OperatorApi(f.service).execute(startAgain(f));
    assert.equal(receipt.kind, "start-again");
    assert.ok(receipt.kind === "start-again");
    assert.equal(receipt.refusedWorkId, f.workId);
    assert.equal(receipt.assignmentId, f.assignmentId);
    await waitUntil(
      () => f.service.domain().task(f.taskId).state === "done",
      "restarted turn completes the task",
      () => f.service.turnRequests(),
    );

    assert.deepEqual(history(f.service, f.workId), refused);
    const restarted = f.service
      .turnRequests()
      .find((r) => r.workId === receipt.workId);
    assert.ok(restarted);
    assert.equal(restarted.taskVersion, current);
    assert.ok(restarted.taskVersion > (refused.request?.taskVersion ?? 0));
    assert.equal(f.runtime.turns, 1);
    assert.match(f.runtime.prompts[0] ?? "", /CURRENT_TITLE/);
    assert.match(f.runtime.prompts[0] ?? "", /CURRENT_OUTCOME/);
    assert.equal(
      f.runtime.workspaces[0],
      (await f.service.taskWorkspace(f.taskId))?.path,
    );
    assert.equal(
      count(
        f.service,
        "SELECT COUNT(*) AS n FROM coordination_inbox_events WHERE taskId=?",
        f.taskId,
      ),
      events,
      "nothing is sent to the lead",
    );
    assert.equal(
      count(
        f.service,
        "SELECT COUNT(*) AS n FROM turn_request_restarts WHERE refusedWorkId=? AND workId=?",
        f.workId,
        receipt.workId,
      ),
      1,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Start again moves a refused follow-up's inbox batch to the new request", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    unpause(f);
    f.runtime.handleTurn = async (threadId, turnId) => {
      if (f.runtime.turns > 1) return;
      const result = await f.runtime.callTool({
        threadId,
        turnId,
        callId: "first-turn-result",
        tool: "cab_report_result",
        arguments: { summary: "First pass done" },
      });
      assert.equal(result.success, true, result.text);
    };
    await api.execute(startAgain(f));
    await waitUntil(
      () => f.service.domain().assignment(f.assignmentId).state === "completed",
      "first turn completes",
      () => f.service.turnRequests(),
    );
    // A paused project queues the follow-up; a profile change then refuses it at admission.
    command(f.service, {
      type: "project.configure",
      projectId: f.projectId,
      expectedVersion: Number(f.service.domain().project(f.projectId).version),
      paused: true,
    });
    await f.service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId: f.taskId,
      recipientAssignmentId: f.assignmentId,
      expectedAssignmentVersion: Number(
        f.service.domain().assignment(f.assignmentId).version,
      ),
      message: "FOLLOW_UP_MESSAGE",
    });
    command(f.service, {
      type: "profile.configure",
      profileId: f.profileId,
      expectedVersion: 1,
      instructions: "CHANGED_PROFILE",
    });
    await waitUntil(
      () =>
        f.service
          .turnRequests()
          .some(
            (r) => r.workId.includes(":inbox:") || r.workId.includes(":v2:"),
          ),
      "follow-up queued",
      () => f.service.turnRequests(),
    );
    unpause(f);
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    const read = (await api.readTask(f.taskId)).data;
    assert.ok(read.startAgain?.available, JSON.stringify(read.startAgain));
    const refusedId = read.startAgain.workId ?? "";
    const batches = () =>
      db(f.service)
        .prepare(
          "SELECT deliveryWorkId, state FROM coordination_delivery_batches WHERE taskId = ?",
        )
        .all(f.taskId) as Array<{ deliveryWorkId: string; state: string }>;
    assert.ok(batches().some((b) => b.deliveryWorkId === refusedId));
    const refused = history(f.service, refusedId);

    const receipt = await api.execute(startAgain(f, refusedId));
    assert.ok(receipt.kind === "start-again");
    await waitUntil(
      () => f.runtime.prompts.some((p) => p.includes("FOLLOW_UP_MESSAGE")),
      "follow-up runs",
      () => f.service.turnRequests(),
    );
    assert.deepEqual(history(f.service, refusedId), refused);
    assert.deepEqual(
      batches().filter((b) => b.deliveryWorkId === refusedId),
      [],
    );
    assert.equal(
      batches().filter((b) => b.deliveryWorkId === receipt.workId).length,
      1,
    );
    assert.match(f.runtime.prompts.at(-1) ?? "", /CHANGED_PROFILE/);
    assert.equal(
      f.runtime.prompts.filter((p) => p.includes("FOLLOW_UP_MESSAGE")).length,
      1,
      "the message is delivered once",
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a refused request still reads as not started after the assignment version moved on", async () => {
  const f = await refusedInitial();
  try {
    // An assignment apply bumps the version past the refused request's captured one.
    db(f.service)
      .prepare(
        "UPDATE domain_assignments SET version = version + 1 WHERE id = ?",
      )
      .run(f.assignmentId);
    const read = (await new OperatorApi(f.service).readTask(f.taskId)).data;
    assert.equal(read.startAgain?.available, true);
    assert.equal(read.execution.state, "not-started");
    assert.ok(read.attention.codes.includes("not-started"));
    assert.ok(!read.attention.codes.includes("execution-uncertain"));
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Start again replays by key, conflicts on other content and on a stale read", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    const first = startAgain(f);
    const stale = startAgain(f, f.workId, version(f.service, f.taskId) + 1);
    await assert.rejects(api.execute(stale), conflict());
    await assert.rejects(
      api.execute(startAgain(f, `assignment:${f.assignmentId}:initial:other`)),
      conflict(),
    );
    assert.equal(requests(f.service, f.taskId), 1, "refusals record nothing");

    const receipt = await api.execute(first);
    assert.deepEqual(await api.execute(first), receipt);
    assert.equal(requests(f.service, f.taskId), 2);
    await assert.rejects(
      api.execute({ ...first, workId: `${f.workId}-other` }),
      conflict(),
    );
    assert.equal(requests(f.service, f.taskId), 2);
    // The refused request is history now; a second start again has nothing to do.
    assert.equal((await readStartAgain(f)).startAgain?.available, false);
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Start again is refused with its reason when something may have run", async (t) => {
  const seeds: Array<[string, string, (f: Refused) => void]> = [
    ...(["thread", "turn"] as const).map(
      (name): [string, string, (f: Refused) => void] => [
        name,
        "execution-unresolved",
        (f) =>
          db(f.service)
            .prepare(
              `UPDATE execution_intents SET ${name}Id = 'observed' WHERE workId = ?`,
            )
            .run(f.workId),
      ],
    ),
    [
      "writer",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO task_writer_admissions (workId, workspace) SELECT workId, workspace FROM execution_intents WHERE workId = ?",
          )
          .run(f.workId),
    ],
    [
      "capacity",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO execution_capacity_reservations (workId, projectId) VALUES (?, ?)",
          )
          .run(f.workId, f.projectId),
    ],
    [
      "effect",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'other-callback', 'pending', 'unresolved')",
          )
          .run(f.workId),
    ],
    [
      "stop target",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO execution_stop_targets (taskId, workId, interruptState, terminalState, requestedAt) VALUES (?, ?, 'unbound', 'unknown', 1)",
          )
          .run(f.taskId, f.workId),
    ],
    [
      "recovery identity",
      "submission-interrupted",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO execution_recovery_identities (workId, requestSequence) VALUES (?, ?)",
          )
          .run(f.workId, f.old.sequence),
    ],
    [
      "submitting intent",
      "submission-interrupted",
      (f) =>
        db(f.service)
          .prepare(
            "UPDATE execution_intents SET state = 'submitting' WHERE workId = ?",
          )
          .run(f.workId),
    ],
    [
      "held assignment",
      "assignment-held",
      (f) =>
        db(f.service)
          .prepare("UPDATE domain_assignments SET state = 'held' WHERE id = ?")
          .run(f.assignmentId),
    ],
    [
      "writer hold",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent pending callback')",
          )
          .run(f.taskId),
    ],
    [
      "closed task",
      "task-not-open",
      (f) =>
        db(f.service)
          .prepare("UPDATE domain_tasks SET state = 'cancelled' WHERE id = ?")
          .run(f.taskId),
    ],
    [
      "refused draft turn",
      "nothing-refused",
      (f) =>
        db(f.service)
          .prepare("UPDATE turn_requests SET draftTurn = 1 WHERE workId = ?")
          .run(f.workId),
    ],
  ];
  for (const [name, reason, seed] of seeds)
    await t.test(name, async () => {
      const f = await refusedInitial();
      try {
        seed(f);
        const read = await readStartAgain(f);
        assert.deepEqual(read.startAgain, { available: false, reason });
        const before = requests(f.service, f.taskId);
        await assert.rejects(
          new OperatorApi(f.service).execute(startAgain(f)),
          conflict(/Start again unavailable/),
        );
        assert.equal(requests(f.service, f.taskId), before);
        assert.deepEqual(
          db(f.service).prepare("SELECT * FROM turn_request_restarts").all(),
          [],
        );
        if (
          name !== "closed task" &&
          name !== "held assignment" &&
          name !== "refused draft turn"
        ) {
          unpause(f);
          await f.service.configureCapacity({
            key: randomUUID(),
            globalLimit: 1,
          });
          assert.equal(f.runtime.turns, 0, `${name} never runs`);
        }
      } finally {
        await f.service.stop();
        rmSync(f.root, { recursive: true, force: true });
      }
    });
});

test("a restarted request that is refused again stays eligible across a restart", async () => {
  const f = await refusedInitial();
  let service = f.service;
  try {
    const api = new OperatorApi(service);
    const first = await api.execute(startAgain(f));
    assert.ok(first.kind === "start-again");
    // The paused project keeps the new request queued until the task changes under it.
    command(service, {
      type: "task.configure",
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: version(service, f.taskId),
      outcome: "SECOND_OUTCOME",
    });
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    await waitUntil(
      () =>
        service.turnRequests().find((r) => r.workId === first.workId)?.state ===
        "held",
      "restarted request refused again",
      () => service.turnRequests(),
    );
    await service.stop();
    service = f.makeService();
    await service.start();
    assert.equal(
      db(service)
        .prepare("SELECT 1 FROM execution_pending_effects WHERE workId = ?")
        .get(first.workId),
      undefined,
    );
    const read = (await new OperatorApi(service).readTask(f.taskId)).data;
    assert.deepEqual(read.startAgain, {
      available: true,
      assignmentId: f.assignmentId,
      workId: first.workId,
    });
    // The first refusal is history: the task still completes once the restarted work runs.
    unpause(f, service);
    f.runtime.handleTurn = async (threadId, turnId) => {
      const result = await f.runtime.callTool({
        threadId,
        turnId,
        callId: "second-restart-completion",
        tool: "cab_request_completion",
        arguments: { reviewedResultIds: [] },
      });
      assert.equal(result.success, true);
    };
    const second = await new OperatorApi(service).execute({
      type: "task.start-again",
      key: randomUUID(),
      taskId: f.taskId,
      expectedVersion: version(service, f.taskId),
      workId: first.workId,
    });
    assert.ok(second.kind === "start-again");
    await waitUntil(
      () => service.domain().task(f.taskId).state === "done",
      "second restart completes the task",
      () => service.turnRequests(),
    );
    assert.equal(f.runtime.turns, 1);
  } finally {
    await service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Reset replaces the conversation of a refused lead and runs a fresh first turn", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    const read = (await api.readTask(f.taskId)).data;
    assert.deepEqual(read.reset, { available: true });
    const workspace = (await f.service.taskWorkspace(f.taskId))?.path;
    const refused = history(f.service, f.workId);
    unpause(f);
    completeTask(f);
    const receipt = await api.execute(reset(f));
    assert.ok(receipt.kind === "task-reset");
    assert.equal(receipt.leadAssignmentId, f.assignmentId);
    assert.deepEqual(receipt.conversations, [
      { assignmentId: f.assignmentId, revision: 2 },
    ]);
    await waitUntil(
      () => f.service.domain().task(f.taskId).state === "done",
      "reset turn completes the task",
      () => f.service.turnRequests(),
    );
    assert.deepEqual(history(f.service, f.workId), refused);
    assert.equal(f.runtime.starts, 1, "a new thread");
    assert.equal(f.runtime.workspaces[0], workspace);
    assert.equal(
      f.service.turnRequests().find((r) => r.workId === receipt.workId)
        ?.previousWorkId,
      null,
    );
    assert.equal(
      count(
        f.service,
        "SELECT COUNT(*) AS n FROM turn_request_restarts WHERE refusedWorkId=?",
        f.workId,
      ),
      1,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Reset after completed turns replaces every conversation and restarts only the lead", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    unpause(f);
    f.runtime.handleTurn = async (threadId, turnId) => {
      const result = await f.runtime.callTool({
        threadId,
        turnId,
        callId: `result-${turnId}`,
        tool: "cab_report_result",
        arguments: { summary: `Done in ${turnId}` },
      });
      assert.equal(result.success, true, result.text);
    };
    await api.execute(startAgain(f));
    await waitUntil(
      () => f.service.domain().assignment(f.assignmentId).state === "completed",
      "lead completes",
      () => f.service.turnRequests(),
    );
    const workerId = randomUUID();
    command(f.service, {
      type: "assignment.create",
      actor: "agent",
      projectId: f.projectId,
      taskId: f.taskId,
      assignmentId: workerId,
      profileId: f.profileId,
      brief: "Worker brief",
      resultDestination: "lead",
      requesterAssignmentId: f.assignmentId,
    });
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    const settled = () =>
      f.service.domain().assignment(workerId).state === "completed" &&
      !f.service
        .turnRequests()
        .some((r) => r.state === "queued" || r.state === "active");
    await waitUntil(settled, "worker and follow-ups settle", () =>
      f.service.turnRequests(),
    );
    // Whatever the worker's result woke up has settled too.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitUntil(settled, "everything settles", () =>
      f.service.turnRequests(),
    );
    const read = (await api.readTask(f.taskId)).data;
    assert.deepEqual(read.reset, { available: true });
    const turns = f.runtime.turns;
    const total = requests(f.service, f.taskId);
    const workspace = f.runtime.workspaces[0];
    const workerRequests = f.service
      .turnRequests()
      .filter((r) => r.assignmentId === workerId);
    const oldLead = f.service
      .turnRequests()
      .filter((r) => r.assignmentId === f.assignmentId);
    f.runtime.handleTurn = undefined;

    const receipt = await api.execute(reset(f));
    assert.ok(receipt.kind === "task-reset");
    await waitUntil(() => f.runtime.turns === turns + 1, "fresh lead turn");
    const revisions = (id: string) =>
      count(
        f.service,
        "SELECT revision AS n FROM assignment_conversations WHERE assignmentId=?",
        id,
      );
    assert.equal(revisions(f.assignmentId), 2);
    assert.equal(revisions(workerId), 2);
    assert.deepEqual(
      receipt.conversations.map((c) => c.assignmentId).sort(),
      [f.assignmentId, workerId].sort(),
    );
    assert.equal(
      requests(f.service, f.taskId),
      total + 1,
      "only the lead gets a request",
    );
    assert.deepEqual(
      f.service.turnRequests().filter((r) => r.assignmentId === workerId),
      workerRequests,
    );
    const fresh = f.service
      .turnRequests()
      .find((r) => r.workId === receipt.workId);
    assert.equal(fresh?.assignmentId, f.assignmentId);
    assert.equal(fresh?.previousWorkId, null);
    assert.equal(
      f.runtime.workspaces.at(-1),
      workspace,
      "the workspace is kept",
    );
    assert.match(f.runtime.prompts.at(-1) ?? "", /CURRENT_TITLE/);
    // History stays readable: the old turns and their results are still there.
    for (const old of oldLead)
      assert.deepEqual(
        f.service.turnRequests().find((r) => r.workId === old.workId),
        old,
      );
    const after = (await api.readTask(f.taskId)).data;
    assert.ok(after.results.length > 0);
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Reset is refused with its reason and records nothing while anything may be live", async (t) => {
  const seeds: Array<[string, string, (f: Refused) => void]> = [
    [
      "queued request",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "UPDATE turn_requests SET state = 'queued', reason = NULL WHERE workId = ?",
          )
          .run(f.workId),
    ],
    [
      "turn id",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "UPDATE execution_intents SET turnId = 'observed' WHERE workId = ?",
          )
          .run(f.workId),
    ],
    [
      "writer admission",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO task_writer_admissions (workId, workspace) SELECT workId, workspace FROM execution_intents WHERE workId = ?",
          )
          .run(f.workId),
    ],
    [
      "capacity reservation",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO execution_capacity_reservations (workId, projectId) VALUES (?, ?)",
          )
          .run(f.workId, f.projectId),
    ],
    [
      "pending effect",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'other-callback', 'pending', 'unresolved')",
          )
          .run(f.workId),
    ],
    [
      "writer hold",
      "task-held",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent hold')",
          )
          .run(f.taskId),
    ],
    [
      "ambiguity hold",
      "task-held",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Ambiguous')",
          )
          .run(f.taskId),
    ],
    [
      "held assignment",
      "task-held",
      (f) =>
        db(f.service)
          .prepare("UPDATE domain_assignments SET state = 'held' WHERE id = ?")
          .run(f.assignmentId),
    ],
    [
      "task not Ready",
      "task-not-ready",
      (f) =>
        db(f.service)
          .prepare("UPDATE domain_tasks SET ready = 0 WHERE id = ?")
          .run(f.taskId),
    ],
    [
      "closed task",
      "task-not-open",
      (f) =>
        db(f.service)
          .prepare("UPDATE domain_tasks SET state = 'done' WHERE id = ?")
          .run(f.taskId),
    ],
    [
      "Stop hold",
      "task-held",
      (f) =>
        db(f.service)
          .prepare(
            "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
          )
          .run(f.taskId),
    ],
    [
      "active request",
      "execution-unresolved",
      (f) =>
        db(f.service)
          .prepare(
            "UPDATE turn_requests SET state = 'active', reason = NULL WHERE workId = ?",
          )
          .run(f.workId),
    ],
  ];
  for (const [name, reason, seed] of seeds)
    await t.test(name, async () => {
      const f = await refusedInitial();
      try {
        seed(f);
        const read = (await new OperatorApi(f.service).readTask(f.taskId)).data;
        assert.deepEqual(read.reset, { available: false, reason });
        const before = requests(f.service, f.taskId);
        await assert.rejects(
          new OperatorApi(f.service).execute(reset(f)),
          conflict(/Reset unavailable/),
        );
        assert.equal(requests(f.service, f.taskId), before);
        assert.equal(
          count(
            f.service,
            "SELECT revision AS n FROM assignment_conversations WHERE assignmentId=?",
            f.assignmentId,
          ),
          1,
          "the conversation is not replaced",
        );
      } finally {
        await f.service.stop();
        rmSync(f.root, { recursive: true, force: true });
      }
    });
});

test("Reset ignores held work that a planned restart already resolved", async () => {
  const f = await refusedInitial();
  try {
    // The turn was interrupted by a planned shutdown and requeued; its old request stays held.
    db(f.service)
      .prepare(
        "UPDATE execution_intents SET state = 'resolved-failed', threadId = 'old-thread', turnId = 'old-turn' WHERE workId = ?",
      )
      .run(f.workId);
    db(f.service)
      .prepare(
        `INSERT INTO execution_shutdown_resolutions
          (interruptedWorkId, requeueWorkId, workRevision, requestSequence, threadId, turnId, harness, createdAt)
        VALUES (?, ?, NULL, ?, 'old-thread', 'old-turn', 'codex', 1)`,
      )
      .run(f.workId, f.workId, f.old.sequence);
    const read = (await new OperatorApi(f.service).readTask(f.taskId)).data;
    assert.deepEqual(read.reset, { available: true });
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Reset replays by key and conflicts on a stale read", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    await assert.rejects(
      api.execute(reset(f, version(f.service, f.taskId) + 1)),
      conflict(),
    );
    assert.equal(requests(f.service, f.taskId), 1);
    const first = reset(f);
    const receipt = await api.execute(first);
    assert.deepEqual(await api.execute(first), receipt);
    assert.equal(requests(f.service, f.taskId), 2);
    assert.equal(
      count(
        f.service,
        "SELECT revision AS n FROM assignment_conversations WHERE assignmentId=?",
        f.assignmentId,
      ),
      2,
      "replay replaces nothing again",
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
