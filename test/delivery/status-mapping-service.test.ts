import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  type DeliveryActionRecord,
  isServiceDeliveryCaller,
} from "../../src/core/delivery.js";
import { StatusMappingStore } from "../../src/core/status-mapping.js";
import type { StatusMapping } from "../../src/core/status-mapping-contracts.js";
import { projectFieldChangedReason } from "../../src/operator/github-reasons.js";
import { statusMappingEvent } from "../../src/standalone/status-mapping.js";
import {
  deliveryFixture,
  fixtureProject,
} from "../fixtures/delivery-fixture.js";
import { databaseOf, startedOf } from "../fixtures/service-internals.js";

type Fixture = Awaited<ReturnType<typeof deliveryFixture>>;
const { projectNodeId, fieldNodeId, todo, inProgress, inReview, done } =
  fixtureProject;

const mapping = (
  events: Partial<StatusMapping["events"]> = {},
): StatusMapping => ({
  selectionId: "repo",
  projectNodeId,
  fieldNodeId,
  events: {
    turnStarted: inProgress,
    handedBack: inReview,
    held: todo,
    done,
    ...events,
  },
});

/** An imported task in a Project selection, mapped and with its lead turn already started. */
async function mapped(
  events?: Partial<StatusMapping["events"]>,
  statusWriteTimeoutMs?: number,
) {
  const f = await deliveryFixture(
    "reviewable-pr",
    true,
    true,
    statusWriteTimeoutMs,
  );
  save(f, mapping(events));
  return f;
}
function save(f: Fixture, value: StatusMapping | null) {
  return f.domain.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.domain.statusMapping(f.projectId).version,
    mapping: value,
  });
}
const writes = (f: Fixture): DeliveryActionRecord[] =>
  f.service
    .delivery()
    .actions(f.taskId)
    .filter((a) => isServiceDeliveryCaller(a.binding));
const optionsWritten = (f: Fixture) =>
  f.effects.flatMap((e) =>
    e.kind === "project.field" ? [e.optionNodeId] : [],
  );
const registerPr = async (f: Fixture) =>
  assert.equal(
    (
      await f.call("ensemble_register_pr", {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: f.getPr().headSha,
      })
    ).success,
    true,
  );

test("each event is written once per transition and confirmed by readback", async () => {
  const f = await mapped();
  try {
    assert.equal(f.status(), todo);
    // The lead's turn has bound: the first event.
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress]);
    assert.equal(f.status(), inProgress);
    assert.equal(writes(f)[0]?.state, "confirmed-success");
    // Nothing changed, so a second pass writes nothing.
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress]);

    await registerPr(f);
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview]);
    assert.equal(f.status(), inReview);

    // Stopped: held. The mapped option here is Todo, which readiness still accepts.
    await f.service.controlTask({
      type: "task.stop",
      key: randomUUID(),
      taskId: f.taskId,
    });
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview, todo]);

    // Resumed, the task re-enters an earlier event: a new transition writes again.
    await f.service.controlTask({
      type: "task.resume",
      key: randomUUID(),
      taskId: f.taskId,
    });
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview, todo, inReview]);

    f.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: Number(f.domain.task(f.taskId).version),
      state: "done",
    });
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [
      inProgress,
      inReview,
      todo,
      inReview,
      done,
    ]);
    assert.ok(
      writes(f).every((w) => w.state === "confirmed-success"),
      JSON.stringify(writes(f).map((w) => w.state)),
    );
    assert.equal(writes(f).length, 5);
    // Each write names the event it was minted for.
    assert.deepEqual(
      writes(f).map(
        (w) => isServiceDeliveryCaller(w.binding) && w.binding.event,
      ),
      ["turnStarted", "handedBack", "held", "handedBack", "done"],
    );
    assert.deepEqual(
      f.service
        .delivery()
        .publicTask(f.taskId)
        .actions.map((a) => a.caller),
      ["service", "service", "service", "service", "service"],
    );
  } finally {
    await f.close();
  }
});

/** The mapped task with its first event written: the baseline every later transition starts from. */
async function started() {
  const f = await mapped();
  await f.service.runStatusMapping();
  assert.deepEqual(optionsWritten(f), [inProgress]);
  return f;
}

test("a Status that moved on GitHub since Ensemble last saw it skips the write and shows on the task", async () => {
  const f = await started();
  try {
    // A human moved the card; the source read has not seen it yet.
    f.setStatus(todo);
    await registerPr(f);
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress]);
    const skipped = writes(f)[1];
    assert.equal(skipped?.state, "confirmed-failure");
    assert.equal(skipped?.observation?.reason, projectFieldChangedReason);
    assert.equal(f.status(), todo);
    assert.deepEqual(
      f.service
        .delivery()
        .publicTask(f.taskId)
        .actions.map((a) => a.reason),
      [null, projectFieldChangedReason],
    );
    // The transition is spent: the skipped write is not retried.
    await f.service.runStatusMapping();
    assert.equal(writes(f).length, 2);
  } finally {
    await f.close();
  }
});

test("a move that lands with the write stays uncertain and never holds the task; the next write re-reads and does not overwrite the moved card", async () => {
  const f = await started();
  try {
    f.moveStatusAfterWrite(todo);
    await registerPr(f);
    await f.service.runStatusMapping();
    assert.equal(writes(f)[1]?.state, "uncertain");
    assert.equal(writes(f)[1]?.observation?.reason, "unproved");
    // Independent of the work: no admission, completion or action hold.
    assert.deepEqual(
      f.domain
        .admission(f.taskId)
        .reasons.filter((r) => r.startsWith("external-action-")),
      [],
    );
    assert.deepEqual(
      f.service
        .delivery()
        .completionBlockers(f.taskId)
        .filter((r) => r.startsWith("external-action-")),
      [],
    );
    assert.deepEqual(f.service.delivery().actionBlockers(f.taskId), []);

    // The uncertain write does not stop the mapping: the next event is written against the
    // Status Ensemble last confirmed, so it is skipped rather than overwriting the moved card.
    f.moveStatusAfterWrite(undefined);
    await f.service.controlTask({
      type: "task.stop",
      key: randomUUID(),
      taskId: f.taskId,
    });
    await f.service.runStatusMapping();
    assert.equal(writes(f).length, 3);
    assert.equal(writes(f)[2]?.observation?.reason, projectFieldChangedReason);
    assert.deepEqual(optionsWritten(f), [inProgress, inReview]);
    assert.equal(f.status(), todo);

    // The skipped record sent nothing, so the late proof of the write that did land is observed.
    f.setStatus(inReview);
    await startedOf(f.service).deliveryCoordinator.reconcile();
    assert.equal(writes(f)[1]?.state, "confirmed-success");
    assert.equal(
      startedOf(f.service).statusMappings.taskState(f.taskId)
        .observedOptionNodeId,
      inReview,
    );
  } finally {
    await f.close();
  }
});

test("a merged PR stays handed back, and a partial read does not release a held task", async () => {
  const f = await started();
  try {
    await registerPr(f);
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview]);
    f.setPr({ ...f.getPr(), state: "MERGED", merged: true });
    await startedOf(f.service).deliveryCoordinator.refresh();
    await f.service.runStatusMapping();
    // Merged but not yet Done: the card is not moved back to In Progress.
    assert.deepEqual(optionsWritten(f), [inProgress, inReview]);

    await f.service.controlTask({
      type: "task.stop",
      key: randomUUID(),
      taskId: f.taskId,
    });
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview, todo]);
    // A partial source read makes the imported blockers unknown; the task stays held.
    databaseOf(f.service).exec(
      "UPDATE domain_tasks SET importedBlockers='unknown'",
    );
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview, todo]);
    assert.equal(writes(f).length, 3);
  } finally {
    await f.close();
  }
});

test("a project without a mapping, and an unmapped event, create no delivery records", async () => {
  const f = await deliveryFixture("reviewable-pr", true, true);
  try {
    const before = JSON.stringify(f.service.delivery().actions());
    await f.service.runStatusMapping();
    assert.equal(JSON.stringify(f.service.delivery().actions()), before);
    save(f, mapping({ turnStarted: null, handedBack: null }));
    await registerPr(f);
    await f.service.runStatusMapping();
    assert.equal(JSON.stringify(f.service.delivery().actions()), before);
    assert.deepEqual(f.effects, []);
    assert.equal(f.status(), todo);
  } finally {
    await f.close();
  }
});

test("a task that is not Ready, or has no Project item, gets no write", async () => {
  const f = await started();
  try {
    // Status Done is outside the readiness rule.
    f.setStatus(done);
    await f.service.refreshGitHub();
    assert.equal(f.domain.task(f.taskId).ready, 0);
    await f.service.controlTask({
      type: "task.stop",
      key: randomUUID(),
      taskId: f.taskId,
    });
    await f.service.runStatusMapping();
    assert.equal(writes(f).length, 1);

    // Ready again, but the membership has lost its item.
    f.setStatus(todo);
    await f.service.refreshGitHub();
    assert.equal(f.domain.task(f.taskId).ready, 1);
    databaseOf(f.service).exec(
      "UPDATE github_memberships SET itemNodeId = NULL",
    );
    await f.service.controlTask({
      type: "task.resume",
      key: randomUUID(),
      taskId: f.taskId,
    });
    await f.service.runStatusMapping();
    assert.equal(writes(f).length, 1);
    assert.deepEqual(optionsWritten(f), [inProgress]);
  } finally {
    await f.close();
  }
});

test("a grant revoked after the save records the denial on the task", async () => {
  const f = await started();
  try {
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: f.service.delivery().configuration(f.projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    await registerPr(f);
    await f.service.runStatusMapping();
    const denied = writes(f)[1];
    assert.equal(denied?.state, "denied");
    assert.equal(denied?.observation?.reason, "delivery-authority-denied");
    assert.deepEqual(optionsWritten(f), [inProgress]);
    // The transition is spent: another pass does not mint a second operation.
    await f.service.runStatusMapping();
    assert.equal(writes(f).length, 2);
  } finally {
    await f.close();
  }
});

test("a write minted for an event the task has left is refused before it is sent", async () => {
  const f = await started();
  try {
    const { deliveryCoordinator } = startedOf(f.service);
    const record = await deliveryCoordinator.submit(
      {
        operationId: randomUUID(),
        action: {
          kind: "project.field",
          target: { repositoryId: "R1", number: 1, nodeId: "I1" },
          projectNodeId,
          itemNodeId: fixtureProject.itemNodeId,
          fieldNodeId,
          optionNodeId: done,
        },
      },
      {
        actor: "service",
        purpose: "status-mapping",
        projectId: f.projectId,
        taskId: f.taskId,
        mappingVersion: f.domain.statusMapping(f.projectId).version,
        // The task has started a turn but is not Done.
        event: "done",
      },
    );
    assert.equal(record.state, "denied");
    assert.deepEqual(optionsWritten(f), [inProgress]);
  } finally {
    await f.close();
  }
});

/** The mapped task with automatic passes stopped, so a test controls exactly when the writer runs. */
async function mappedManually() {
  const f = await deliveryFixture("reviewable-pr", true, true);
  const writer = startedOf(f.service).statusMappingWriter;
  const run = writer.run.bind(writer);
  // Lets a pass already running end before the mapping exists.
  await run();
  writer.run = () => Promise.resolve();
  save(f, mapping());
  return { f, run };
}

test("a restart between recording the operation and preparing it resumes the same operation", async () => {
  const { f, run } = await mappedManually();
  try {
    // The writer stored the transition and its operation id, then stopped before the write.
    const operationId = randomUUID();
    new StatusMappingStore(databaseOf(f.service)).enter(
      f.taskId,
      "turnStarted",
      operationId,
    );
    await run();
    assert.deepEqual(
      writes(f).map((w) => w.operationId),
      [operationId],
    );
    assert.deepEqual(optionsWritten(f), [inProgress]);
    await run();
    assert.equal(writes(f).length, 1);
  } finally {
    await f.close();
  }
});

test("a prepared status write left by a crash is attempted once by reconcile", async () => {
  const { f } = await mappedManually();
  try {
    const { deliveryStore, deliveryCoordinator } = startedOf(f.service);
    const operationId = randomUUID();
    deliveryStore.prepareAction(
      {
        operationId,
        action: {
          kind: "project.field",
          target: { repositoryId: "R1", number: 1, nodeId: "I1" },
          projectNodeId,
          itemNodeId: fixtureProject.itemNodeId,
          fieldNodeId,
          optionNodeId: inProgress,
          expected: { optionNodeId: todo },
        },
      },
      {
        actor: "service",
        purpose: "status-mapping",
        projectId: f.projectId,
        taskId: f.taskId,
        mappingVersion: f.domain.statusMapping(f.projectId).version,
        event: "turnStarted",
      },
      false,
    );
    assert.equal(deliveryStore.action(operationId).state, "prepared");
    await deliveryCoordinator.reconcile();
    assert.equal(deliveryStore.action(operationId).state, "confirmed-success");
    assert.deepEqual(optionsWritten(f), [inProgress]);
    await deliveryCoordinator.reconcile();
    assert.deepEqual(optionsWritten(f), [inProgress]);
  } finally {
    await f.close();
  }
});

test("a hung status write is given up and never delays an agent action or completion qualification", async () => {
  const f = await mapped(undefined, 2000);
  try {
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress]);
    f.holdStatusWrites(new Promise<void>(() => {}));
    await registerPr(f);
    let settled = false;
    const run = f.service.runStatusMapping().then(() => {
      settled = true;
    });
    const deadline = Date.now() + 3000;
    while (writes(f).length < 2) {
      assert.ok(Date.now() < deadline, "the status write was never prepared");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const comment = await f.call("ensemble_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", nodeId: "I1", number: 1 },
        body: "While the status write hangs",
      },
    });
    assert.equal(comment.success, true, comment.text);
    await startedOf(f.service).deliveryCoordinator.qualifyCompletion(f.taskId);
    // Both finished while the status write was still waiting on GitHub.
    assert.equal(settled, false);
    await run;
    // Given up before any effect: refused, never sent, and not held.
    assert.equal(writes(f)[1]?.state, "confirmed-failure");
    assert.deepEqual(optionsWritten(f), [inProgress]);
  } finally {
    await f.close();
  }
});

test("a partial source read that did not read the item does not make a stale Status look newer than a confirmed write", async () => {
  const { f, run } = await mappedManually();
  try {
    await run();
    assert.deepEqual(optionsWritten(f), [inProgress]);
    await registerPr(f);
    startedOf(f.service).githubSources.reconcileSelection(f.projectId, "repo", {
      complete: false,
      issues: [],
      reason: "http-403",
    });
    await run();
    assert.deepEqual(optionsWritten(f), [inProgress, inReview]);
    assert.equal(writes(f)[1]?.state, "confirmed-success");
  } finally {
    await f.close();
  }
});

test("Done is written for a done task whose issue is observed closed, though it is no longer Ready", async () => {
  const f = await started();
  try {
    // GitHub closes the issue: the next read makes the task not Ready.
    f.setIssueOpen(false);
    await f.service.refreshGitHub();
    assert.equal(f.domain.task(f.taskId).ready, 0);
    await f.service.runStatusMapping();
    // Not done yet: nothing is written.
    assert.deepEqual(optionsWritten(f), [inProgress]);
    f.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: Number(f.domain.task(f.taskId).version),
      state: "done",
    });
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress, done]);
    assert.equal(f.domain.task(f.taskId).ready, 0);
    assert.equal(writes(f)[1]?.state, "confirmed-success");
  } finally {
    await f.close();
  }
});

test("Done is not written for a done task that is not Ready while its issue is still open", async () => {
  const f = await started();
  try {
    // A human moved the card to Done: outside the readiness rule, the open issue is not Ready.
    f.setStatus(done);
    await f.service.refreshGitHub();
    assert.equal(f.domain.task(f.taskId).ready, 0);
    f.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: Number(f.domain.task(f.taskId).version),
      state: "done",
    });
    await f.service.runStatusMapping();
    assert.deepEqual(optionsWritten(f), [inProgress]);
    assert.equal(writes(f).length, 1);
  } finally {
    await f.close();
  }
});

test("a handed-back PR stays handed back when it closes, merges or is settled closed, until Done", () => {
  const binding = (change: Record<string, unknown>) => ({
    mode: "reviewable-pr",
    observation: { state: "OPEN", draft: false },
    settlement: null,
    ...change,
  });
  const event = (value: unknown) =>
    statusMappingEvent(
      {
        domain: {
          task: () => ({ state: "open", importedBlockers: "clear" }),
          blockingDependencies: () => [],
        },
        state: { taskHold: () => undefined, taskHasStartedTurn: () => true },
        deliveryStore: { actionBlockers: () => [], delivery: () => value },
      } as never,
      "task",
    );
  assert.equal(event(binding({})), "handedBack");
  for (const state of ["CLOSED", "MERGED"])
    assert.equal(
      event(binding({ observation: { state, draft: false } })),
      "handedBack",
      state,
    );
  assert.equal(
    event(binding({ settlement: { decision: "closed" } })),
    "handedBack",
  );
  assert.equal(
    event(binding({ observation: { state: "OPEN", draft: true } })),
    "turnStarted",
  );
  assert.equal(event(null), "turnStarted");
  assert.equal(event(binding({ mode: "through-merge" })), "turnStarted");
});
