import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CoordinationStore,
  type CoordinationCall,
  type TaskCompletionRequest,
} from "../../src/core/coordination.js";
import {
  DelegateWithdrawalRefusedError,
  DelegatesUnfinishedError,
} from "../../src/core/delegate-withdrawal.js";
import { DomainStore, type DomainCommand } from "../../src/core/domain.js";
import { Store, transaction } from "../../src/core/store.js";
import { ExecutionState } from "../../src/standalone/state.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const leadProfile = "30000000-0000-4000-8000-000000000001";
const workerProfile = "30000000-0000-4000-8000-000000000002";
let sequence = 0;
const nextId = (prefix = "50000000-0000-4000-8000-") =>
  `${prefix}${String(++sequence).padStart(12, "0")}`;
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cab-withdrawal-"));
  const db = new DatabaseSync(join(directory, "coordination.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const state = new ExecutionState(db);
  const coordination = new CoordinationStore(
    db,
    domain,
    (workId) => state.isNeverAdmittedRefusedAssignmentWork(workId),
    undefined,
    (workId) => state.refusedBeforeStart(workId),
  );
  coordination.migrate();
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: nextId() } as DomainCommand);
  for (const [profileId, name] of [
    [leadProfile, "Lead"],
    [workerProfile, "Worker"],
  ] as const)
    run({
      type: "profile.create",
      actor: "operator",
      profileId,
      name,
      instructions: name,
      capabilities: "code",
    });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Withdrawal test",
    leadProfileId: leadProfile,
  });
  for (const [index, taskId] of [taskA, taskB].entries()) {
    run({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: `Task ${index}`,
      outcome: "Deliver",
      ready: true,
    });
    run({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: index + 1,
      paused: false,
    });
  }
  run({
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfile],
  });
  const leadA = String(domain.ensureLeadAssignment(taskA)?.id);
  const leadB = String(domain.ensureLeadAssignment(taskB)?.id);

  /** A running turn bound to the assignment, as the service records one. */
  function addWork(assignmentId: string, name: string) {
    const assignment = domain.assignment(assignmentId);
    const workId = `work-${name}`;
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
        "VALUES (?, ?, 'work', '/tmp/work', 'running', NULL, ?, ?, 'chatgpt', 'workspaceWrite', 'never')",
    ).run(nextId(), workId, `thread-${name}`, `turn-${name}`);
    state.bindTask(workId, {
      taskId: String(assignment.taskId),
      assignmentId,
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
    });
    const binding = db
      .prepare(
        "SELECT conversationRevision FROM task_execution_bindings WHERE workId = ?",
      )
      .get(workId) as { conversationRevision: number };
    db.prepare(
      "INSERT INTO task_work_revisions (workId, assignmentId, conversationRevision, workRevision) VALUES (?, ?, ?, 1)",
    ).run(workId, assignmentId, binding.conversationRevision);
    db.prepare(
      "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'assignment-result', 'pending', 'Assignment result has not been committed')",
    ).run(workId);
    db.prepare(
      "UPDATE domain_assignments SET state = 'running' WHERE id = ?",
    ).run(assignmentId);
    return workId;
  }

  function delegate(requesterAssignmentId: string, taskId = taskA) {
    const assignmentId = nextId("40000000-0000-4000-8000-");
    run({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId: workerProfile,
      brief: "Delegated work",
      resultDestination: "requester",
      requesterAssignmentId,
    });
    return assignmentId;
  }

  /** An interrupted turn that was reconciled with no live execution left. */
  function reconciled(assignmentId: string, name: string) {
    const workId = addWork(assignmentId, name);
    db.prepare(
      "UPDATE execution_intents SET state = 'reconciled' WHERE workId = ?",
    ).run(workId);
    db.prepare(
      "UPDATE execution_pending_effects SET state = 'settled' WHERE workId = ?",
    ).run(workId);
    return workId;
  }

  const leadWork = addWork(leadA, "lead");
  const call = (
    tool: string,
    args: Record<string, unknown>,
    callId = nextId("call-"),
    name = "lead",
  ): CoordinationCall => ({
    threadId: `thread-${name}`,
    turnId: `turn-${name}`,
    callId,
    tool,
    arguments: args,
  });
  const leadWithdraw = (assignmentId: string, callId?: string) =>
    coordination.withdrawDelegate(
      call(
        "cab_withdraw_delegate",
        { assignmentId, reason: "Replaced by a new delegate" },
        callId,
      ),
    );
  const operatorWithdraw = (assignmentId: string, expectedVersion?: number) =>
    transaction(db, () =>
      coordination.withdrawDelegateWithinTransaction({
        assignmentId,
        actor: "operator",
        reason: "Stranded after recovery",
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
    );
  const leadReport = (callId = nextId("call-")) =>
    coordination.recordResult(
      call("cab_report_result", { summary: "Lead done" }, callId),
    );
  return {
    db,
    domain,
    coordination,
    leadA,
    leadB,
    leadWork,
    addWork,
    delegate,
    reconciled,
    call,
    leadWithdraw,
    operatorWithdraw,
    leadReport,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const refusedWith = (code: string, text: RegExp) => (error: unknown) =>
  error instanceof DelegateWithdrawalRefusedError &&
  error.code === code &&
  text.test(error.message);

test("a lead withdraws a reconciled running delegate and can then report", () => {
  const f = fixture();
  try {
    const delegateId = f.delegate(f.leadA);
    f.reconciled(delegateId, "delegate");
    assert.throws(() => f.leadReport(), DelegatesUnfinishedError);
    const before = f.domain.assignment(delegateId);
    const response = f.leadWithdraw(delegateId);
    assert.equal(response.success, true);
    const after = f.domain.assignment(delegateId);
    assert.equal(after.state, "withdrawn");
    assert.equal(after.version, Number(before.version) + 1);
    const record = f.coordination.assignmentWithdrawal(delegateId);
    assert.equal(record?.actor, "lead");
    assert.equal(record?.leadAssignmentId, f.leadA);
    assert.equal(record?.priorState, "running");
    assert.equal(record?.reason, "Replaced by a new delegate");
    assert.ok(record && record.withdrawnAt > 0);
    assert.deepEqual(f.coordination.inboxEvents(f.leadA), []);
    assert.equal(f.leadReport().response.success, true);
  } finally {
    f.close();
  }
});

test("a never-started pending delegate is withdrawn and stops blocking the lead", () => {
  const f = fixture();
  try {
    const delegateId = f.delegate(f.leadA);
    assert.equal(f.domain.assignment(delegateId).state, "pending");
    f.leadWithdraw(delegateId);
    assert.equal(
      f.coordination.assignmentWithdrawal(delegateId)?.priorState,
      "pending",
    );
    assert.equal(f.leadReport().response.success, true);
  } finally {
    f.close();
  }
});

test("withdrawal names the condition and its way out and changes nothing", () => {
  const f = fixture();
  try {
    const cases: Array<[string, () => string, string, RegExp]> = [
      [
        "live",
        () => {
          const id = f.delegate(f.leadA);
          f.addWork(id, "live");
          return id;
        },
        "live-execution",
        /still running.*Wait for its result/,
      ],
      [
        "held intent",
        () => {
          const id = f.delegate(f.leadA);
          const work = f.reconciled(id, "held");
          f.db
            .prepare(
              "UPDATE execution_intents SET state = 'held' WHERE workId = ?",
            )
            .run(work);
          return id;
        },
        "held-execution",
        /held execution.*cab recovery get .*cab recovery release/,
      ],
      [
        "held assignment",
        () => {
          const id = f.delegate(f.leadA);
          f.db
            .prepare(
              "UPDATE domain_assignments SET state = 'held' WHERE id = ?",
            )
            .run(id);
          return id;
        },
        "held-execution",
        /held execution/,
      ],
      [
        "uncertain",
        () => {
          const id = f.delegate(f.leadA);
          const work = f.reconciled(id, "uncertain");
          f.db
            .prepare(
              "UPDATE execution_intents SET state = 'held' WHERE workId = ?",
            )
            .run(work);
          f.db
            .prepare(
              "INSERT INTO task_writer_admissions (workId, workspace) VALUES (?, '/tmp/work')",
            )
            .run(work);
          f.db
            .prepare(
              "INSERT INTO execution_recovery_identities (workId, requestSequence) VALUES (?, 1)",
            )
            .run(work);
          return id;
        },
        "uncertain-execution",
        /outcome is uncertain.*cab recovery get/,
      ],
      [
        "question",
        () => {
          const id = f.delegate(f.leadA);
          const work = f.addWork(id, "question");
          f.coordination.requestQuestion(
            f.call(
              "cab_ask_question",
              { question: "Which format?" },
              undefined,
              "question",
            ),
          );
          f.db
            .prepare(
              "UPDATE execution_intents SET state = 'reconciled' WHERE workId = ?",
            )
            .run(work);
          f.db
            .prepare(
              "UPDATE execution_pending_effects SET state = 'settled' WHERE workId = ?",
            )
            .run(work);
          return id;
        },
        "open-request",
        /open question or approval.*Inbox/,
      ],
      [
        "approval",
        () => {
          const id = f.delegate(f.leadA);
          const work = f.addWork(id, "approval");
          f.coordination.requestApproval(
            f.call(
              "cab_request_approval",
              { action: "publish", material: { artifact: 1 } },
              undefined,
              "approval",
            ),
          );
          f.db
            .prepare(
              "UPDATE execution_intents SET state = 'reconciled' WHERE workId = ?",
            )
            .run(work);
          f.db
            .prepare(
              "UPDATE execution_pending_effects SET state = 'settled' WHERE workId = ?",
            )
            .run(work);
          return id;
        },
        "open-request",
        /open question or approval/,
      ],
      [
        "grandchild",
        () => {
          const id = f.delegate(f.leadA);
          f.delegate(id);
          return id;
        },
        "unfinished-delegates",
        /unfinished delegates of its own/,
      ],
      [
        "another lead's delegate",
        () => f.delegate(f.leadB, taskB),
        "not-requester",
        /Only the lead that requested/,
      ],
      ["the lead itself", () => f.leadA, "lead-assignment", /task lead/],
      [
        "an assignment with no requester",
        () => {
          const id = f.delegate(f.leadA);
          f.db
            .prepare(
              "UPDATE domain_assignments SET requesterAssignmentId = NULL WHERE id = ?",
            )
            .run(id);
          return id;
        },
        "not-delegate",
        /Only a delegated assignment/,
      ],
      [
        "an already-withdrawn delegate",
        () => {
          const id = f.delegate(f.leadA);
          f.operatorWithdraw(id);
          return id;
        },
        "already-final",
        /already completed or was withdrawn/,
      ],
    ];
    for (const [name, setup, code, text] of cases) {
      const id = setup();
      const before = f.domain.assignment(id);
      assert.throws(() => f.leadWithdraw(id), refusedWith(code, text), name);
      if (code !== "not-requester")
        assert.throws(
          () => f.operatorWithdraw(id),
          refusedWith(code, text),
          `${name} (operator)`,
        );
      assert.deepEqual(f.domain.assignment(id), before, name);
    }
    // A live delegate still blocks the lead, and says it is running.
    assert.throws(() => f.leadReport(), /still running/);
  } finally {
    f.close();
  }
});

test("an operator withdrawal tells the lead; a stale version is refused", () => {
  const f = fixture();
  try {
    const delegateId = f.delegate(f.leadA);
    const version = Number(f.domain.assignment(delegateId).version);
    assert.throws(
      () => f.operatorWithdraw(delegateId, version + 1),
      refusedWith("version-changed", /changed since it was read/),
    );
    const withdrawal = f.operatorWithdraw(delegateId, version);
    assert.equal(withdrawal.actor, "operator");
    const events = f.coordination.inboxEvents(f.leadA);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "delegate-withdrawn");
    assert.deepEqual(JSON.parse(String(events[0]?.payload)), {
      message: `The operator withdrew delegate ${delegateId}: Stranded after recovery`,
      assignmentId: delegateId,
      reason: "Stranded after recovery",
    });
  } finally {
    f.close();
  }
});

test("a withdrawn delegate's undelivered events stop counting and its callbacks are refused", () => {
  const f = fixture();
  try {
    const delegateId = f.delegate(f.leadA);
    const work = f.reconciled(delegateId, "late");
    f.db
      .prepare(`INSERT INTO coordination_inbox_events
        (eventId, taskId, recipientAssignmentId, eventType, payload)
        VALUES (?, ?, ?, 'operator-message', '{"message":"hello"}')`)
      .run(nextId(), taskA, delegateId);
    assert.equal(f.coordination.pendingEvents(delegateId).length, 1);
    assert.ok(f.coordination.pendingEventRecipients().includes(delegateId));
    f.leadWithdraw(delegateId);
    assert.deepEqual(f.coordination.pendingEvents(delegateId), []);
    assert.ok(!f.coordination.pendingEventRecipients().includes(delegateId));
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM coordination_undeliverable_inbox_events WHERE assignmentId = ? AND reason = 'delegate-withdrawn'",
        )
        .get(delegateId)?.n,
      1,
    );
    const blockers = (
      f.coordination as unknown as {
        completionBlockers(
          request: TaskCompletionRequest,
          terminal: "completed",
        ): string[];
      }
    ).completionBlockers(
      {
        requestId: nextId(),
        taskId: taskA,
        leadAssignmentId: f.leadA,
        leadWorkId: f.leadWork,
        leadWorkRevision: 1,
        taskVersion: Number(f.domain.task(taskA).version),
        reviewedResultIds: [],
        status: "pending",
        rejectionReasons: [],
        revision: 1,
        createdAt: 0,
        finalizedAt: null,
      },
      "completed",
    );
    assert.ok(!blockers.includes("assignments-not-complete"), String(blockers));
    assert.ok(!blockers.includes("pending-inbox-event"), String(blockers));
    // Even a turn that still claims to run is no longer bound to current work.
    f.db
      .prepare(
        "UPDATE execution_intents SET state = 'running' WHERE workId = ?",
      )
      .run(work);
    assert.throws(
      () =>
        f.coordination.recordResult(
          f.call("cab_report_result", { summary: "Late" }, undefined, "late"),
        ),
      /not bound to current work/,
    );
    assert.throws(
      () =>
        f.coordination.delegate(
          f.call(
            "cab_delegate",
            { profileId: workerProfile, brief: "More" },
            undefined,
            "late",
          ),
        ),
      /not bound to current work/,
    );
  } finally {
    f.close();
  }
});

test("a replayed withdrawal returns its receipt; reused identity with other arguments is refused", () => {
  const f = fixture();
  try {
    const delegateId = f.delegate(f.leadA);
    const first = f.leadWithdraw(delegateId, "call-withdraw");
    assert.deepEqual(f.leadWithdraw(delegateId, "call-withdraw"), first);
    assert.throws(
      () => f.leadWithdraw(f.delegate(f.leadA), "call-withdraw"),
      /reused with different content/,
    );
  } finally {
    f.close();
  }
});

test("the report refusal lists each blocking delegate, its state and its way out", () => {
  const f = fixture();
  try {
    const idle = f.delegate(f.leadA);
    const live = f.delegate(f.leadA);
    f.addWork(live, "listed-live");
    const asking = f.delegate(f.leadA);
    f.delegate(asking);
    const error = (() => {
      try {
        f.leadReport();
      } catch (caught) {
        return caught;
      }
      assert.fail("report was not refused");
    })();
    assert.ok(error instanceof DelegatesUnfinishedError);
    assert.deepEqual(
      error.delegates.map((delegate) => [
        delegate.assignmentId,
        delegate.withdrawable,
      ]),
      [
        [idle, true],
        [live, false],
        [asking, false],
      ],
    );
    const lines = error.message.split("\n");
    assert.equal(
      lines[0],
      "Assignment cannot report while delegated assignments are not completed:",
    );
    assert.equal(
      lines[1],
      `- ${idle.slice(0, 8)} pending; no live execution; withdraw it with cab_withdraw_delegate or ask the operator`,
    );
    assert.match(String(lines[2]), /running; still running; wait/);
    assert.match(String(lines[3]), /pending; has unfinished delegates/);
    for (let index = 0; index < 4; index++) f.delegate(f.leadA);
    const many = (() => {
      try {
        f.leadReport();
      } catch (caught) {
        return caught as Error;
      }
      assert.fail("report was not refused");
    })();
    assert.equal(many.message.split("\n").length, 7);
    assert.match(many.message, /- and 2 more$/);
  } finally {
    f.close();
  }
});
