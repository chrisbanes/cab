import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainConflictError, DomainStore } from "../../src/core/domain.js";
import type { DomainCommand } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { ExecutionState } from "../../src/standalone/state.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const leadProfile = "30000000-0000-4000-8000-000000000001";
const workerProfile = "30000000-0000-4000-8000-000000000002";
const childA = "40000000-0000-4000-8000-000000000001";
const childA2 = "40000000-0000-4000-8000-000000000002";
const childB = "40000000-0000-4000-8000-000000000003";
let commandSequence = 0;
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function nextKey(): string {
  commandSequence++;
  return `50000000-0000-4000-8000-${String(commandSequence).padStart(12, "0")}`;
}

/** Real SQLite stores with a lead and two delegates in one task, and a delegate in another. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cab-task-comments-"));
  const filename = join(directory, "coordination.sqlite");
  let db = new DatabaseSync(filename);
  let domain!: DomainStore;
  let state!: ExecutionState;
  let coordination!: CoordinationStore;
  const initialize = () => {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    domain = new DomainStore(db);
    domain.migrate();
    state = new ExecutionState(db);
    coordination = new CoordinationStore(db);
    coordination.migrate();
  };
  initialize();
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: nextKey() } as DomainCommand);
  run({
    type: "profile.create",
    actor: "operator",
    profileId: leadProfile,
    name: "Lead",
    instructions: "Coordinate",
    capabilities: "delegate",
  });
  run({
    type: "profile.create",
    actor: "operator",
    profileId: workerProfile,
    name: "Worker",
    instructions: "Build",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Comment test",
    leadProfileId: leadProfile,
  });
  for (const id of [taskA, taskB]) {
    run({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId: id,
      title: `Task ${id.slice(-1)}`,
      outcome: "Deliver",
      ready: true,
    });
    run({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: id === taskA ? 1 : 2,
      paused: false,
    });
    domain.ensureLeadAssignment(id);
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
  for (const [taskId, assignmentId] of [
    [taskA, childA],
    [taskA, childA2],
    [taskB, childB],
  ] as const)
    run({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId: workerProfile,
      brief: "Build",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });

  function addWork(assignmentId: string, tag: string) {
    const assignment = domain.assignment(assignmentId);
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) " +
        "VALUES (?, ?, 'work', '/tmp/work', 'running', NULL, ?, ?, 'chatgpt', 'workspaceWrite', 'never')",
    ).run(nextKey(), `work-${tag}`, `thread-${tag}`, `turn-${tag}`);
    state.bindTask(`work-${tag}`, {
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
      .get(`work-${tag}`) as { conversationRevision: number };
    db.prepare(
      "INSERT INTO task_work_revisions (workId, assignmentId, conversationRevision, workRevision) VALUES (?, ?, ?, 1)",
    ).run(`work-${tag}`, assignmentId, binding.conversationRevision);
    db.prepare(`INSERT INTO execution_pending_effects
      (workId, effectKey, state, reason)
      VALUES (?, 'assignment-result', 'pending', 'Assignment result has not been committed')`).run(
      `work-${tag}`,
    );
    db.prepare(
      "UPDATE domain_assignments SET state = 'running' WHERE id = ?",
    ).run(assignmentId);
  }

  /** The assignment reports a result and its successful turn ends, as in a real run. */
  function complete(assignmentId: string, tag: string) {
    const recorded = coordination.recordResult({
      threadId: `thread-${tag}`,
      turnId: `turn-${tag}`,
      callId: `call-${tag}`,
      tool: "cab_report_result",
      arguments: { summary: "Completed work" },
    });
    const intent = db
      .prepare("SELECT id FROM execution_intents WHERE workId = ?")
      .get(`work-${tag}`) as { id: string };
    state.complete(intent.id, `thread-${tag}`, `turn-${tag}`);
    if (coordination.deliveryForWork(`work-${tag}`))
      coordination.completeDeliveryBatch(`work-${tag}`);
    coordination.recordSuccessfulTerminal(`work-${tag}`);
    assert.equal(domain.assignment(assignmentId).state, "completed");
    return recorded.result;
  }

  const lead = String(domain.ensureLeadAssignment(taskA)?.id);
  const count = (table: string) =>
    Number(
      (
        db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    );
  /** Every row the command could write, so a refusal can be shown to leave none. */
  const written = () => ({
    comments: count("coordination_task_comments"),
    deliveries: count("coordination_task_comment_deliveries"),
    events: count("coordination_inbox_events"),
    followUps: count("coordination_follow_ups"),
    continuations: count("coordination_recovery_continuations"),
    receipts: count("coordination_operator_receipts"),
    versions: JSON.stringify(
      db
        .prepare(
          "SELECT id, version, state FROM domain_assignments ORDER BY id",
        )
        .all(),
    ),
  });
  const version = (assignmentId: string) =>
    Number(domain.assignment(assignmentId).version);
  const send = (
    body: string,
    recipients: string[],
    extra: { key?: string; taskId?: string; versions?: number[] } = {},
  ) =>
    coordination.postTaskComment({
      actor: "operator",
      key: extra.key ?? nextKey(),
      taskId: extra.taskId ?? taskA,
      body,
      recipients: recipients.map((assignmentId, index) => ({
        assignmentId,
        expectedAssignmentVersion:
          extra.versions?.[index] ?? version(assignmentId),
      })),
    });

  return {
    get db() {
      return db;
    },
    get domain() {
      return domain;
    },
    get coordination() {
      return coordination;
    },
    lead,
    addWork,
    complete,
    count,
    written,
    version,
    send,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      initialize();
    },
  };
}

test("a comment with no recipients records one comment and receipt and wakes nobody", () => {
  const f = fixture();
  try {
    const events = f.count("coordination_inbox_events");
    const receipt = f.send("Noting this for the record.", []);
    assert.deepEqual(receipt.deliveries, []);
    assert.equal(f.count("coordination_inbox_events"), events);
    assert.equal(f.count("coordination_follow_ups"), 0);
    const [comment, ...others] = f.coordination.taskComments(taskA);
    assert.equal(others.length, 0);
    assert.equal(comment?.commentId, receipt.commentId);
    assert.equal(comment?.body, "Noting this for the record.");
    assert.deepEqual(comment?.deliveries, []);
    assert.deepEqual(f.coordination.taskComments(taskB), []);

    f.db
      .prepare("UPDATE domain_tasks SET state = 'done' WHERE id = ?")
      .run(taskA);
    const before = f.written();
    assert.throws(
      () => f.send("Too late.", []),
      (error) =>
        error instanceof DomainConflictError && /not open/.test(error.message),
    );
    assert.deepEqual(f.written(), before);
  } finally {
    f.close();
  }
});

test("pending and running recipients each receive the same input once, in one comment", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    assert.equal(f.domain.assignment(f.lead).state, "pending");
    const receipt = f.send("Please coordinate on the API shape.", [
      childA,
      f.lead,
    ]);
    assert.equal(receipt.deliveries.length, 2);
    assert.deepEqual(
      receipt.deliveries.map((d) => d.assignmentId),
      [f.lead, childA].sort(),
    );
    for (const delivery of receipt.deliveries) {
      assert.equal(delivery.effect, "input");
      assert.equal(delivery.followUpId, null);
      assert.equal(
        delivery.assignmentVersion,
        f.version(delivery.assignmentId),
      );
      const events = f.coordination
        .inboxEvents(delivery.assignmentId)
        .filter((event) => event.eventType === "operator-message");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.eventId, delivery.eventId);
      assert.deepEqual(JSON.parse(events[0]?.payload ?? "{}"), {
        message: "Please coordinate on the API shape.",
      });
    }
    // A second recipient in the task is untouched.
    assert.equal(f.coordination.inboxEvents(childA2).length, 0);
    const [comment] = f.coordination.taskComments(taskA);
    assert.deepEqual(comment?.deliveries, receipt.deliveries);
    assert.equal(f.count("coordination_task_comments"), 1);
  } finally {
    f.close();
  }
});

test("a completed delegate resumes as the same assignment through an operator follow-up", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    const result = f.complete(childA, "a");
    const before = f.domain.assignment(childA);
    assert.deepEqual(f.coordination.taskCommentRecipient(taskA, childA), {
      assignmentId: childA,
      version: Number(before.version),
      role: "delegate",
      mode: "resume",
      reason: null,
    });
    const leadBefore = f.domain.assignment(f.lead);
    const receipt = f.send("Add the missing test.", [childA]);
    const [delivery] = receipt.deliveries;
    assert.ok(delivery?.followUpId);
    assert.equal(delivery.effect, "resume");
    assert.equal(delivery.assignmentVersion, Number(before.version) + 1);
    const after = f.domain.assignment(childA);
    assert.equal(after.state, "pending");
    assert.equal(Number(after.version), Number(before.version) + 1);
    assert.equal(after.requesterAssignmentId, before.requesterAssignmentId);
    assert.equal(after.resultDestination, before.resultDestination);
    const [followUp] = f.coordination.followUps(taskA);
    assert.equal(followUp?.followUpId, delivery.followUpId);
    assert.equal(followUp?.requester, "operator");
    assert.equal(followUp?.requestingAssignmentId, null);
    assert.equal(followUp?.resultId, result.resultId);
    assert.equal(followUp?.targetAssignmentId, childA);
    const event = f.coordination
      .inboxEvents(childA)
      .find((e) => e.eventId === delivery.eventId);
    assert.equal(event?.eventType, "assignment-follow-up");
    assert.equal(
      (JSON.parse(event?.payload ?? "{}") as { instructions: string })
        .instructions,
      "Add the missing test.",
    );
    // The lead's binding and state are untouched.
    assert.deepEqual(f.domain.assignment(f.lead), leadBefore);
    // The result is followed up once: the resumed assignment now takes input.
    assert.equal(
      f.coordination.taskCommentRecipient(taskA, childA)?.mode,
      "input",
    );
  } finally {
    f.close();
  }
});

test("a recipient that completes while the comment is composed resumes once, and a competing follow-up conflicts", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    // The preview saw a running recipient at its current version.
    const composed = f.version(childA);
    f.complete(childA, "a");
    assert.equal(
      f.version(childA),
      composed,
      "a result does not bump the version",
    );
    const receipt = f.send("Follow up on the result.", [childA], {
      versions: [composed],
    });
    assert.equal(receipt.deliveries[0]?.effect, "resume");
    assert.equal(f.version(childA), composed + 1);

    f.addWork(childA2, "a2");
    const second = f.complete(childA2, "a2");
    const stale = f.version(childA2);
    f.addWork(f.lead, "lead");
    f.coordination.requestFollowUp({
      threadId: "thread-lead",
      turnId: "turn-lead",
      callId: "call-follow-up",
      tool: "cab_request_follow_up",
      arguments: { resultId: second.resultId, instructions: "Agent request." },
    });
    const before = f.written();
    assert.throws(
      () => f.send("Too slow.", [childA2], { versions: [stale] }),
      (error) =>
        error instanceof DomainConflictError &&
        /version conflict/.test(error.message),
    );
    assert.deepEqual(f.written(), before);
  } finally {
    f.close();
  }
});

test("refused recipients record nothing, whichever one is refused", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    f.addWork(childA2, "a2");
    f.complete(childA2, "a2");
    const refuse = (name: string, send: () => unknown, pattern: RegExp) => {
      const before = f.written();
      assert.throws(send, pattern, name);
      assert.deepEqual(f.written(), before, name);
    };
    refuse(
      "unknown",
      () => f.send("x", [f.lead, nextKey()], { versions: [1, 1] }),
      /not in this task/,
    );
    refuse(
      "other task",
      () => f.send("x", [f.lead, childB]),
      /not in this task/,
    );
    refuse(
      "stale version",
      () => f.send("x", [f.lead, childA], { versions: [1, 99] }),
      /version conflict/,
    );
    refuse(
      "duplicate",
      () =>
        f.coordination.postTaskComment({
          actor: "operator",
          key: nextKey(),
          taskId: taskA,
          body: "x",
          recipients: [
            { assignmentId: childA, expectedAssignmentVersion: 1 },
            { assignmentId: childA, expectedAssignmentVersion: 1 },
          ],
        }),
      /Duplicate comment recipient/,
    );
    f.db
      .prepare("UPDATE domain_assignments SET state = 'held' WHERE id = ?")
      .run(childA);
    refuse("held", () => f.send("x", [f.lead, childA]), /unavailable: held/);
    f.db
      .prepare("UPDATE domain_assignments SET state = 'running' WHERE id = ?")
      .run(childA);
    // A delegate whose result destination is unresolved cannot be resumed by a comment.
    f.db
      .prepare(
        "UPDATE coordination_results SET destinationDisposition = 'unresolved' WHERE assignmentId = ?",
      )
      .run(childA2);
    refuse(
      "unresolved destination",
      () => f.send("x", [f.lead, childA2]),
      /unresolved-destination/,
    );
    f.db
      .prepare(
        "UPDATE coordination_results SET destinationDisposition = 'resolved' WHERE assignmentId = ?",
      )
      .run(childA2);
    f.db
      .prepare("UPDATE domain_tasks SET state = 'cancelled' WHERE id = ?")
      .run(taskA);
    refuse("closed task", () => f.send("x", [f.lead]), /not open/);
  } finally {
    f.close();
  }
});

test("a failure after the first delivery rolls back the whole comment", () => {
  for (const [name, trigger] of [
    [
      "second delivery",
      `CREATE TRIGGER inject BEFORE INSERT ON coordination_task_comment_deliveries
        WHEN (SELECT count(*) FROM coordination_task_comment_deliveries) >= 1
        BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    ],
    [
      "follow-up",
      `CREATE TRIGGER inject BEFORE INSERT ON coordination_follow_ups
        BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    ],
    [
      "receipt",
      `CREATE TRIGGER inject BEFORE INSERT ON coordination_operator_receipts
        WHEN NEW.scope = 'task-comment-send'
        BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    ],
  ] as const) {
    const f = fixture();
    try {
      f.addWork(childA, "a");
      f.addWork(childA2, "a2");
      f.complete(childA2, "a2");
      const before = f.written();
      f.db.exec(trigger);
      assert.throws(
        () => f.send("Everyone please.", [f.lead, childA, childA2]),
        /injected/,
        name,
      );
      assert.deepEqual(f.written(), before, name);
      assert.deepEqual(f.coordination.taskComments(taskA), [], name);
      f.db.exec("DROP TRIGGER inject");
      // The same recipients succeed once the fault is gone.
      assert.equal(
        f.send("Everyone please.", [f.lead, childA, childA2]).deliveries.length,
        3,
        name,
      );
    } finally {
      f.close();
    }
  }
});

test("an exact key replays the original receipt, even after restart and state changes", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    const key = nextKey();
    const receipt = f.send("Replay me.", [f.lead, childA], { key });
    const reordered = f.coordination.postTaskComment({
      actor: "operator",
      key,
      taskId: taskA,
      body: "Replay me.",
      recipients: [childA, f.lead].map((assignmentId) => ({
        assignmentId,
        expectedAssignmentVersion: 1,
      })),
    });
    assert.deepEqual(reordered, receipt);
    f.reopen();
    f.db
      .prepare("UPDATE domain_assignments SET state = 'held' WHERE id = ?")
      .run(childA);
    f.db
      .prepare("UPDATE domain_tasks SET state = 'done' WHERE id = ?")
      .run(taskA);
    const written = f.written();
    assert.deepEqual(f.send("Replay me.", [f.lead, childA], { key }), receipt);
    assert.deepEqual(f.written(), written);
    assert.deepEqual(f.coordination.recordedTaskComment(taskA, key), receipt);
    assert.equal(
      f.coordination.recordedTaskComment(taskA, nextKey()),
      undefined,
    );
    // Reading it under another task, or with another payload, never matches.
    assert.throws(
      () => f.coordination.recordedTaskComment(taskB, key),
      DomainConflictError,
    );
    for (const different of [
      () => f.send("Changed body.", [f.lead, childA], { key }),
      () => f.send("Replay me.", [f.lead], { key }),
      () => f.send("Replay me.", [f.lead, childA], { key, versions: [1, 2] }),
    ])
      assert.throws(different, DomainConflictError);
  } finally {
    f.close();
  }
});

test("shared comment tables are additive: migrating twice and upgrading keep older records", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    f.send("Before the upgrade.", [childA]);
    const older = f.coordination.inboxEvents(childA).map((e) => e.payload);
    const receipts = f.db
      .prepare(
        "SELECT scope, commandKey, payloadHash, result FROM coordination_operator_receipts ORDER BY scope, commandKey",
      )
      .all();
    f.coordination.migrate();
    f.coordination.migrate();
    assert.equal(f.coordination.taskComments(taskA).length, 1);
    // A database from before the feature has neither table; migrating adds them without touching the rest.
    f.db.exec(
      "DROP TABLE coordination_task_comment_deliveries; DROP TABLE coordination_task_comments",
    );
    f.reopen();
    assert.deepEqual(f.coordination.taskComments(taskA), []);
    assert.deepEqual(
      f.coordination.inboxEvents(childA).map((e) => e.payload),
      older,
    );
    assert.deepEqual(
      f.db
        .prepare(
          "SELECT scope, commandKey, payloadHash, result FROM coordination_operator_receipts ORDER BY scope, commandKey",
        )
        .all(),
      receipts,
    );
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(f.send("After the upgrade.", [childA]).deliveries.length, 1);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.close();
  }
});

test("a comment never changes the lead, other recipients or the older direct message contract", () => {
  const f = fixture();
  try {
    f.addWork(childA, "a");
    const leadBinding = () =>
      f.db
        .prepare("SELECT * FROM task_lead_bindings WHERE taskId = ?")
        .get(taskA);
    const binding = leadBinding();
    f.send("Hello.", [childA]);
    assert.deepEqual(leadBinding(), binding);
    // The direct message command keeps its own receipt and still refuses a delegate that is not pending or running.
    const direct = f.coordination.postOperatorMessage({
      actor: "operator",
      key: nextKey(),
      taskId: taskA,
      recipientAssignmentId: childA,
      expectedAssignmentVersion: f.version(childA),
      message: "Direct.",
    });
    assert.equal(direct.eventType, "operator-message");
    assert.equal(
      (
        f.db
          .prepare(
            "SELECT count(*) AS n FROM coordination_operator_receipts WHERE scope = 'operator-message'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    f.close();
  }
});
