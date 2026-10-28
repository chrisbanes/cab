import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createReleaseDeliveryFixture,
  until,
  scriptedDeliveryProvider,
} from "../fixtures/delivery-integration.js";
import {
  githubCompareUrl,
  OperatorApi,
} from "../../src/standalone/operator-api.js";
import {
  absentBranchHead,
  canonicalMaterial,
} from "../../src/core/delivery.js";

for (const mode of ["reviewable-pr", "through-merge"] as const) {
  test(`assembled ${mode} uses production HTTP parsing, own closure, terminal completion and durable reopen`, async () => {
    const f = await createReleaseDeliveryFixture(mode);
    try {
      await f.register();
      const premature = await f.call("ensemble_request_completion", {
        reviewedResultIds: [],
      });
      assert.equal(premature.success, false, premature.text);
      assert.equal(f.service.domain().task(f.taskId).state, "open");
      const operationId = randomUUID();
      f.scripted.state.check = "failure";
      const failed = await f.merge(operationId);
      assert.equal(failed.success, false, failed.text);
      assert.equal(f.scripted.state.writes, 0);
      f.scripted.state.check = "success";
      if (mode === "reviewable-pr") {
        assert.equal((await f.merge()).success, false);
        await f.terminal(1);
        await f.service.settleHandback(f.settlement());
      } else {
        const merged = await f.merge();
        assert.equal(merged.success, true, merged.text);
        assert.equal(f.scripted.state.writes, 1);
        assert.equal(
          f.service.githubSources().issue("I1")?.observedState,
          "closed",
        );
        assert.equal(f.service.githubSources().memberships("I1").length, 0);
        assert.equal(
          f.service.domain().admission(f.taskId, true).eligible,
          true,
        );
        assert.equal(f.service.domain().task(f.taskId).state, "open");
        await f.terminal(1);
      }
      await f.waitTurn(2);
      const completion = await f.call(
        "ensemble_request_completion",
        { reviewedResultIds: [] },
        2,
      );
      assert.equal(completion.success, true, completion.text);
      assert.equal(f.service.domain().task(f.taskId).state, "open");
      await f.terminal(2);
      await until(
        () => f.service.domain().task(f.taskId).state === "done",
        "eligible Done",
      );
      const binding = f.service.delivery().delivery(f.taskId);
      assert.ok(binding);
      const persisted = f.readDb(
        (db) =>
          db
            .prepare(
              "SELECT recordJson FROM delivery_pr_bindings WHERE taskId=?",
            )
            .get(f.taskId) as { recordJson: string },
      );
      assert.deepEqual(JSON.parse(persisted.recordJson), binding);
      const receipts = f.readDb(
        (db) =>
          db
            .prepare("SELECT COUNT(*) AS n FROM delivery_settlement_receipts")
            .get() as { n: number },
      );
      assert.equal(receipts.n, mode === "reviewable-pr" ? 1 : 0);
      const effects = f.scripted.state.writes;
      await f.reopen();
      assert.equal(f.service.domain().task(f.taskId).state, "done");
      assert.deepEqual(
        f.service.delivery().delivery(f.taskId)?.settlement,
        binding.settlement,
      );
      assert.equal(
        f.service.delivery().delivery(f.taskId)?.observationDigest,
        binding.observationDigest,
      );
      await f.service.coordinationView().refreshDelivery(f.taskId);
      assert.equal(f.scripted.state.writes, effects);
      assert.equal(f.runtime.turns, 0);
    } finally {
      await f.close();
      assert.equal(existsSync(f.directory), false);
    }
  });
}

test("the delivery read links an imported task's pull request in its own repository", async () => {
  const f = await createReleaseDeliveryFixture("reviewable-pr");
  try {
    await f.register();
    const read = (
      await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
    ).data.delivery;
    assert.equal(read?.binding?.url, "https://github.com/org/repo/pull/7");
    assert.equal(read.binding.repositoryName, "org/repo");
    assert.equal(read.binding.draft, false);
  } finally {
    await f.close();
  }
});

test("the delivery read gives no link and no source repository name for a pull request in another repository", async () => {
  const f = await createReleaseDeliveryFixture("reviewable-pr");
  try {
    await f.register();
    await f.terminal(1);
    f.moveBoundPullRequestToRepository("R_kgDOcross");
    await f.reopen();
    const binding = (
      await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
    ).data.delivery?.binding;
    assert.equal(binding?.url, undefined);
    assert.equal(binding?.repositoryName, "R_kgDOcross");
  } finally {
    await f.close();
  }
});

test("connected feedback is literal and deduplicated; changed settlement, outage and task Stop remain conservative across restart", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    await f.register();
    await f.terminal(1);
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 3,
      paused: true,
    });
    const before = f.service.coordinationView().readTask(f.taskId);
    f.scripted.state.feedback = true;
    await f.service.coordinationView().refreshDelivery(f.taskId);
    const feedback = f.service.delivery().delivery(f.taskId)
      ?.observation.feedback;
    assert.equal(feedback?.[0]?.nodeId, "C1");
    assert.equal(feedback?.[0]?.body, "Repair literal feedback C1");
    const observed = f.service.coordinationView().readTask(f.taskId);
    await f.service.coordinationView().refreshDelivery(f.taskId);
    const repeated = f.service.coordinationView().readTask(f.taskId);
    assert.deepEqual(repeated.messages, observed.messages);
    assert.deepEqual(repeated.requests, observed.requests);
    assert.equal(
      repeated.delivery?.binding?.revision,
      observed.delivery?.binding?.revision,
    );
    assert.equal(f.runtime.turns, 1);
    assert.notDeepEqual(observed, before);
    await until(
      () =>
        f.service
          .turnRequests()
          .some((r) => r.state === "queued" && r.workId.includes(":inbox:")),
      "queued feedback capture",
    );
    const oldWork = f.service
      .turnRequests()
      .find(
        (r) => r.state === "queued" && r.workId.includes(":inbox:"),
      )!.workId;
    const oldCapture = f.readDb((db) =>
      db
        .prepare("SELECT recordJson FROM task_review_contexts WHERE workId=?")
        .get(oldWork),
    );
    await f.reopen();
    assert.equal(f.runtime.turns, 0);
    await f.reopen();
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.deepEqual(
      f.readDb((db) =>
        db
          .prepare("SELECT recordJson FROM task_review_contexts WHERE workId=?")
          .get(oldWork),
      ),
      oldCapture,
    );
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      2,
    );
    assert.equal(f.runtime.turns, 0);
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 4,
      paused: false,
    });
    await f.service.refreshGitHub();
    await f.waitTurn(1);
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.equal(f.runtime.turns, 1);
    await f.terminal(1);
    await f.service.settleHandback(f.settlement());
    const stale = f.settlement();
    f.scripted.state.head = "3".repeat(40);
    await assert.rejects(() => f.service.settleHandback(stale), /changed/);
    assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
    f.scripted.state.outage = true;
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.ok(f.service.delivery().delivery(f.taskId)?.readError);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    await f.service.stopTask(f.taskId);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "Stop settles turns",
    );
    await f.reopen();
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM task_writer_holds WHERE taskId=?",
              )
              .get(f.taskId) as { n: number }
          ).n,
      ),
      1,
    );
    assert.equal(f.scripted.state.writes, 0);
    assert.equal(f.runtime.turns, 0);
  } finally {
    await f.close();
  }
});

test("unknown merge effect is held and same-operation replay never repeats the write across restart", async () => {
  const f = await createReleaseDeliveryFixture("through-merge");
  try {
    await f.register();
    f.scripted.state.unknownEffect = true;
    const operationId = randomUUID();
    const result = await f.merge(operationId);
    assert.equal(result.success, false, result.text);
    assert.equal(f.scripted.state.writes, 1);
    assert.equal((await f.merge(operationId)).success, false);
    assert.equal(f.scripted.state.writes, 1);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    await f.service.stopTask(f.taskId);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "uncertain Stop",
    );
    await f.reopen();
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.equal(f.scripted.state.writes, 1);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.runtime.turns, 0);
    assert.ok(
      f.service
        .delivery()
        .actions(f.taskId)
        .some((a) => a.state === "uncertain"),
    );
  } finally {
    await f.close();
  }
});

test("scripted provider refuses unknown endpoints instead of forwarding fetch", async () => {
  const f = scriptedDeliveryProvider();
  await assert.rejects(
    () =>
      f.provider.inspectPr(
        {
          repositoryId: "R1",
          prNumber: 99,
          expectedPrNodeId: "P99",
          expectedHeadSha: f.state.head,
        },
        {
          version: 1,
          mode: "reviewable-pr",
          credentialRef: null,
          grants: [],
          requiredChecks: [],
        },
      ),
    /Unhandled scripted endpoint/,
  );
  assert.equal(f.state.writes, 0);
});

async function pausedFeedback(
  f: Awaited<ReturnType<typeof createReleaseDeliveryFixture>>,
) {
  await f.register();
  await f.terminal(1);
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: 3,
    paused: true,
  });
  f.scripted.state.feedback = true;
  await f.service.refreshGitHub();
  await until(
    () =>
      f.service
        .list()
        .some((i) => i.workId.includes(":inbox:") && i.state === "ready"),
    "never-admitted inbox intent",
  );
  return f.service
    .turnRequests()
    .find((r) => r.state === "queued" && r.workId.includes(":inbox:"))!;
}

test("startup waits for complete provider/source revalidation before superseding paused inbox work", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    const queued = await pausedFeedback(f);
    let release!: () => void;
    f.scripted.state.sourceWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads = f.scripted.state.sourceReads;
    const reopening = f.reopen();
    await until(
      () => f.scripted.state.sourceReads > reads,
      "delayed startup source read",
    );
    assert.equal(f.runtime.turns, 0);
    // Read from SQLite: the service is unpublished until start-up finishes.
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT state FROM turn_requests WHERE workId = ?")
              .get(queued.workId) as { state: string } | undefined
          )?.state,
      ),
      "queued",
    );
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      0,
    );
    release();
    await reopening;
    assert.equal(f.runtime.turns, 0);
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      1,
    );
  } finally {
    await f.close();
  }
});

test("an unproved status-mapping write does not stop startup from superseding paused inbox work, unlike an agent action", async () => {
  for (const actor of ["service", "agent"] as const) {
    const f = await createReleaseDeliveryFixture();
    try {
      const queued = await pausedFeedback(f);
      const operationId = randomUUID();
      const caller =
        actor === "service"
          ? {
              actor: "service",
              purpose: "status-mapping",
              projectId: f.projectId,
              taskId: f.taskId,
              mappingVersion: 1,
              event: "turnStarted",
            }
          : {
              projectId: f.projectId,
              taskId: f.taskId,
              taskVersion: 1,
              assignmentId: randomUUID(),
              assignmentVersion: 1,
              workId: "work",
              workRevision: 1,
              conversationRevision: 1,
            };
      f.seedPersistedState((db) =>
        db.prepare("INSERT INTO delivery_actions VALUES (?,?,?,?)").run(
          operationId,
          f.taskId,
          "0".repeat(64),
          JSON.stringify({
            operationId,
            request: {
              operationId,
              action: {
                kind: "issue.comment",
                target: { repositoryId: "R1", number: 1, nodeId: "I1" },
                body: "Unproved",
              },
            },
            binding: caller,
            policyVersion: 1,
            state: "uncertain",
            attempts: 1,
            beforeState: {},
            observation: {
              state: "uncertain",
              reason: "provider-effect-unproved",
              receipt: null,
            },
            createdAt: 1,
            updatedAt: 1,
          }),
        ),
      );
      assert.ok(queued);
      await f.reopen();
      assert.equal(
        f.readDb(
          (db) =>
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM inbox_request_supersessions",
                )
                .get() as { n: number }
            ).n,
        ),
        actor === "service" ? 1 : 0,
        actor,
      );
    } finally {
      await f.close();
    }
  }
});

for (const fault of [
  "source",
  "permission",
  "held",
  "admitted",
  "Stop",
  "effect",
  "absent anchor",
  "cancelled then reopened",
] as const) {
  test(`startup never revives inbox work after ${fault} changes`, async () => {
    const f = await createReleaseDeliveryFixture();
    try {
      const queued = await pausedFeedback(f);
      if (fault === "cancelled then reopened")
        for (const state of ["cancelled", "open"] as const)
          f.service.domain().execute({
            type: "task.configure",
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            taskId: f.taskId,
            expectedVersion: Number(f.service.domain().task(f.taskId).version),
            state,
          });
      if (fault === "source")
        f.scripted.state.sourceBody = "Changed outcome requiring review";
      if (fault === "permission")
        f.service.domain().execute({
          type: "delivery.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: f.projectId,
          expectedVersion: 2,
          mode: "reviewable-pr",
          credentialRef: null,
          grants: [],
          requiredChecks: [],
        });
      if (fault === "absent anchor")
        f.seedPersistedState((db) =>
          db
            .prepare("DELETE FROM inbox_request_anchors WHERE workId=?")
            .run(queued.workId),
        );
      if (fault === "Stop") await f.service.stopTask(f.taskId);
      if (fault === "held")
        f.seedPersistedState((db) =>
          db
            .prepare(
              "UPDATE execution_intents SET state='held',reason='Independent uncertain execution' WHERE workId=?",
            )
            .run(queued.workId),
        );
      if (fault === "admitted")
        f.seedPersistedState((db) =>
          db
            .prepare(
              "UPDATE execution_intents SET threadId='known-admission' WHERE workId=?",
            )
            .run(queued.workId),
        );
      if (fault === "effect")
        f.seedPersistedState((db) =>
          db
            .prepare(
              "INSERT INTO execution_pending_effects VALUES (?,'fixture-effect','pending','uncertain')",
            )
            .run(queued.workId),
        );
      await f.reopen();
      assert.equal(f.runtime.turns, 0);
      assert.equal(
        f.readDb(
          (db) =>
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM inbox_request_supersessions",
                )
                .get() as { n: number }
            ).n,
        ),
        0,
      );
      assert.equal(f.service.domain().task(f.taskId).state, "open");
    } finally {
      await f.close();
    }
  });
}

test("lost merge response becomes confirmed only after fresh readback and never replays the write", async () => {
  const f = await createReleaseDeliveryFixture("through-merge");
  try {
    await f.register();
    f.scripted.state.lostResponse = true;
    const result = await f.merge();
    assert.equal(result.success, false);
    assert.equal(f.scripted.state.writes, 1);
    await f.service.stopTask(f.taskId);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "lost-response stop",
    );
    await f.reopen();
    assert.ok(
      f.service
        .delivery()
        .actions(f.taskId)
        .some((a) => a.state === "confirmed-success"),
    );
    assert.equal(f.scripted.state.writes, 1);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.runtime.turns, 0);
  } finally {
    await f.close();
  }
});

test("assembled active child and successful worker terminal cannot independently complete the parent", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    await f.register();
    const worker = randomUUID(),
      assignmentId = randomUUID();
    const d = f.service.domain();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: worker,
      name: "Worker",
      instructions: "Worker",
      capabilities: "work",
    });
    d.execute({
      type: "routing.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      credentialRef: null,
      candidateProfileIds: [worker],
    });
    d.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      assignmentId,
      profileId: worker,
      brief: "Bound child responsibility",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.equal(
      (
        await f.call(
          "ensemble_request_completion",
          { reviewedResultIds: [] },
          1,
        )
      ).success,
      false,
    );
    await f.terminal(1);
    await f.waitTurn(2);
    assert.equal(
      (
        await f.call(
          "ensemble_request_completion",
          { reviewedResultIds: [] },
          2,
        )
      ).success,
      false,
    );
    const result = await f.call(
      "ensemble_report_result",
      { summary: "Worker successful result" },
      2,
    );
    assert.equal(result.success, true, result.text);
    await f.terminal(2);
    assert.equal(d.task(f.taskId).state, "open");
    assert.equal(f.scripted.state.writes, 0);
  } finally {
    await f.close();
  }
});

test("startup supersession rolls back the entire request and batch change after persistence failure", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    const queued = await pausedFeedback(f);
    const count = f.service.turnRequests().length;
    f.seedPersistedState((db) =>
      db.exec(
        "CREATE TRIGGER fixture_abort_supersession BEFORE INSERT ON inbox_request_supersessions BEGIN SELECT RAISE(ABORT, 'fixture transaction failure'); END",
      ),
    );
    await assert.rejects(() => f.reopen(), /fixture transaction failure/);
    assert.equal(f.runtime.turns, 0);
    f.readDb((db) => {
      assert.equal(
        (
          db.prepare("SELECT COUNT(*) AS n FROM turn_requests").get() as {
            n: number;
          }
        ).n,
        count,
      );
      assert.equal(
        (
          db
            .prepare("SELECT state FROM turn_requests WHERE workId=?")
            .get(queued.workId) as { state: string }
        ).state,
        "held",
      );
      assert.equal(
        (
          db
            .prepare("SELECT state FROM execution_intents WHERE workId=?")
            .get(queued.workId) as { state: string }
        ).state,
        "held",
      );
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
            .get() as { n: number }
        ).n,
        0,
      );
      assert.ok(
        db
          .prepare(
            "SELECT 1 FROM coordination_delivery_batches WHERE deliveryWorkId=? AND state='queued'",
          )
          .get(queued.workId),
      );
    });
    f.seedPersistedState((db) =>
      db.exec("DROP TRIGGER fixture_abort_supersession"),
    );
    await f.service.start();
    assert.equal(f.runtime.turns, 0);
    assert.equal(f.service.turnRequests().length, count);
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      0,
    );
  } finally {
    await f.close();
  }
});

for (const control of ["Ready off/on", "dependency add/remove"] as const) {
  test(`startup preserves local task invalidation after ${control}`, async () => {
    const f = await createReleaseDeliveryFixture("reviewable-pr", {}, true);
    try {
      await f.register();
      await f.terminal(1);
      const d = f.service.domain();
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: f.projectId,
        expectedVersion: 3,
        paused: true,
      });
      const assignment = d.assignments(f.taskId)[0]!;
      await f.service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId: f.taskId,
        recipientAssignmentId: String(assignment.id),
        expectedAssignmentVersion: Number(assignment.version),
        message: "Literal local feedback C1",
      });
      await f.service.refreshGitHub();
      await until(
        () =>
          f.service
            .turnRequests()
            .some((r) => r.state === "queued" && r.workId.includes(":inbox:")),
        "local queued inbox",
      );
      if (control === "Ready off/on") {
        for (const ready of [false, true])
          d.execute({
            type: "task.configure",
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            taskId: f.taskId,
            expectedVersion: Number(d.task(f.taskId).version),
            ready,
          });
      } else {
        const blockerTaskId = randomUUID();
        d.execute({
          type: "task.create",
          actor: "operator",
          key: randomUUID(),
          projectId: f.projectId,
          taskId: blockerTaskId,
          title: "Blocker",
          outcome: "Blocked",
          ready: false,
        });
        for (const type of ["dependency.add", "dependency.remove"] as const)
          d.execute({
            type,
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            taskId: f.taskId,
            blockerTaskId,
            expectedVersion: Number(d.task(f.taskId).version),
          });
      }
      await f.reopen();
      assert.equal(f.runtime.turns, 0);
      assert.equal(
        f.readDb(
          (db) =>
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM inbox_request_supersessions",
                )
                .get() as { n: number }
            ).n,
        ),
        0,
      );
      assert.equal(f.service.domain().task(f.taskId).state, "open");
    } finally {
      await f.close();
    }
  });
}

/** A registered PR with one unresolved thread whose only comment is the reviewer's C1. */
async function threadWorld(mode: "allow" | "approval" | null = "allow") {
  const f = await createReleaseDeliveryFixture();
  f.scripted.state.thread = {
    resolved: false,
    resolvedBy: null,
    comments: [
      { id: "C1", body: "Please fix", state: "SUBMITTED", author: "U_REV" },
    ],
  };
  if (mode)
    f.grant(
      { action: "pr.thread.reply", mode },
      { action: "pr.thread.resolve", mode },
    );
  const registered = await f.register();
  const reply = (body = "Fixed in abc") => ({
    kind: "pr.thread.reply",
    body,
  });
  const resolve = (expectedLatestCommentNodeId: string) => ({
    kind: "pr.thread.resolve",
    expectedLatestCommentNodeId,
  });
  const threadStates = () =>
    f.service
      .delivery()
      .actions(f.taskId)
      .map((a) => [a.request.action.kind, a.state, a.observation?.reason]);
  return { f, reply, resolve, threadStates, registered };
}

test("thread reply and resolve write once each, refuse stale or repeated resolves without writing, and reach the lead and task view", async () => {
  const { f, reply, resolve, threadStates, registered } = await threadWorld();
  try {
    const thread = f.scripted.state.thread;
    assert.ok(thread);
    // The lead's first view of the binding names the thread it can act on.
    assert.match(registered.text, /\nreview-thread T1 latest C1$/);
    assert.deepEqual(
      f.service.delivery().delivery(f.taskId)?.observation.reviewThreads,
      [
        {
          nodeId: "T1",
          isResolved: false,
          firstCommentNodeId: "C1",
          latestCommentNodeId: "C1",
        },
      ],
    );
    const replied = await f.threadAction(reply());
    assert.equal(replied.success, true, replied.text);
    assert.equal(f.scripted.state.threadReplies, 1);
    assert.equal(thread.comments.length, 2);
    assert.equal(
      thread.comments[1]?.body.match(/ensemble-operation:/g)?.length,
      1,
    );
    // The post-success refresh shows the lead the thread's new latest comment.
    assert.equal(
      f.service.delivery().delivery(f.taskId)?.observation.reviewThreads?.[0]
        ?.latestCommentNodeId,
      "C2",
    );
    const feedback = f.readDb((db) =>
      (
        db
          .prepare(
            "SELECT payload FROM coordination_inbox_events WHERE eventType='pr-delivery' ORDER BY sequence",
          )
          .all() as { payload: string }[]
      ).map((row) => String(JSON.parse(row.payload).reason)),
    );
    assert.match(feedback.at(-1) ?? "", /review-thread T1 latest C2/);

    // Resolving against the comment seen before the reply is stale.
    const stale = await f.threadAction(resolve("C1"));
    assert.equal(stale.success, false);
    assert.match(stale.text, /provider-preflight-held/);
    assert.equal(f.scripted.state.threadResolves, 0);
    const resolved = await f.threadAction(resolve("C2"));
    assert.equal(resolved.success, true, resolved.text);
    assert.equal(f.scripted.state.threadResolves, 1);
    assert.equal(thread.resolved, true);
    const again = await f.threadAction(resolve("C2"));
    assert.equal(again.success, false);
    assert.match(again.text, /provider-preflight-held/);
    assert.equal(f.scripted.state.threadResolves, 1);

    assert.deepEqual(threadStates(), [
      ["pr.thread.reply", "confirmed-success", null],
      ["pr.thread.resolve", "confirmed-failure", "provider-preflight-held"],
      ["pr.thread.resolve", "confirmed-success", null],
      ["pr.thread.resolve", "confirmed-failure", "provider-preflight-held"],
    ]);
    const shown = (
      await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
    ).data.delivery?.actions.map((a) => [a.kind, a.state, a.reason]);
    assert.deepEqual(shown, threadStates());
  } finally {
    await f.close();
  }
});

test("thread actions are denied without a grant", async () => {
  const { f, reply, resolve, threadStates } = await threadWorld(null);
  try {
    for (const action of [reply(), resolve("C1")]) {
      const denied = await f.threadAction(action);
      assert.equal(denied.success, false);
      assert.match(denied.text, /denied \(delivery-authority-denied\)/);
    }
    assert.equal(
      f.scripted.state.threadReplies + f.scripted.state.threadResolves,
      0,
    );
    assert.deepEqual(
      threadStates().map((s) => s[1]),
      ["denied", "denied"],
    );
  } finally {
    await f.close();
  }
});

for (const kind of ["reply", "resolve"] as const)
  test(`a lost ${kind} response is held uncertain and never rewritten across restart`, async () => {
    const { f, reply, resolve, threadStates } = await threadWorld();
    try {
      f.scripted.state[
        kind === "reply" ? "lostThreadReply" : "lostThreadResolve"
      ] = true;
      const operationId = randomUUID();
      const action = kind === "reply" ? reply() : resolve("C1");
      const lost = await f.threadAction(action, operationId);
      assert.equal(lost.success, false);
      assert.deepEqual(threadStates(), [
        [`pr.thread.${kind}`, "uncertain", "provider-effect-unproved"],
      ]);
      const writes = () =>
        kind === "reply"
          ? f.scripted.state.threadReplies
          : f.scripted.state.threadResolves;
      assert.equal(writes(), 1);
      assert.equal((await f.threadAction(action, operationId)).success, false);
      assert.equal(writes(), 1);
      // The task stays held while the outcome is unproved.
      assert.equal(
        (await f.threadAction(reply("Another reply"))).success,
        false,
      );
      assert.equal(f.scripted.state.threadReplies, kind === "reply" ? 1 : 0);
      await f.service.stopTask(f.taskId);
      await until(
        () => !f.service.list().some((i) => i.state === "running"),
        "uncertain Stop",
      );
      await f.reopen();
      await f.service.coordinationView().refreshDelivery(f.taskId);
      // Reconciliation reads the thread back; it never issues a second mutation.
      assert.equal(writes(), 1);
      assert.equal(f.scripted.state.threadReplies, kind === "reply" ? 1 : 0);
      assert.deepEqual(
        threadStates()
          .slice(0, 1)
          .map((s) => s[1]),
        ["confirmed-success"],
      );
    } finally {
      await f.close();
    }
  });

test("approval mode refuses thread actions until the operator approves the exact material", async () => {
  const { f, reply } = await threadWorld("approval");
  try {
    const action = {
      ...reply(),
      target: {
        repositoryId: "R1",
        nodeId: "P7",
        number: 7,
        threadNodeId: "T1",
      },
    };
    assert.equal((await f.threadAction(reply())).success, false);
    const requested = await f.call("ensemble_request_approval", {
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    assert.equal(requested.success, true, requested.text);
    const interaction = f.service.coordinationView().readTask(f.taskId)
      .approvals[0];
    assert.ok(interaction);
    await f.terminal(1);
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    await f.waitTurn(2);
    const approval = {
      interactionId: interaction.interactionId,
      expectedRevision: 2,
    };
    assert.equal(
      (
        await f.threadAction(
          reply("Changed unapproved text"),
          randomUUID(),
          2,
          approval,
        )
      ).success,
      false,
    );
    assert.equal(f.scripted.state.threadReplies, 0);
    const done = await f.threadAction(reply(), randomUUID(), 2, approval);
    assert.equal(done.success, true, done.text);
    assert.equal(f.scripted.state.threadReplies, 1);
    assert.equal(
      (await f.threadAction(reply(), randomUUID(), 2, approval)).success,
      false,
    );
    assert.equal(f.scripted.state.threadReplies, 1);
  } finally {
    await f.close();
  }
});

import {
  mkdtempSync as makeTemp,
  writeFileSync as writeFile,
  realpathSync,
} from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { git as runGit } from "../fixtures/publication.js";

/** A repository with one commit, provisioned as R1 for the task. */
async function publicationWorld(mode: "allow" | "approval") {
  const source = realpathSync(makeTemp(join(osTmp(), "ensemble-publish-src-")));
  runGit(source, "init", "-q", "-b", "main");
  writeFile(join(source, "a.txt"), "a\n");
  runGit(source, "add", ".");
  runGit(source, "commit", "-q", "-m", "base");
  const f = await createReleaseDeliveryFixture(
    "reviewable-pr",
    {},
    true,
    null,
    source,
  );
  f.grant(
    { action: "branch.push", mode },
    // Recovery is approval-gated whatever the grant: an overwrite is granted as allow on purpose.
    { action: "branch.force-push", mode: "allow" },
    { action: "branch.adopt", mode: "approval" },
    { action: "pr.create", mode: "allow" },
  );
  const binding = await f.service.taskWorkspace(f.taskId);
  const workspace = binding?.repositories[0]?.workspacePath;
  assert.ok(workspace);
  const commit = (name: string) => {
    writeFile(join(workspace, name), `${name}\n`);
    runGit(workspace, "add", ".");
    runGit(workspace, "commit", "-q", "-m", name);
    return runGit(workspace, "rev-parse", "HEAD");
  };
  const push = (commitSha: string, index?: number, approval?: object) =>
    f.call(
      "ensemble_external_action",
      {
        operationId: randomUUID(),
        action: {
          kind: "branch.push",
          target: { repositoryId: "R1" },
          commitSha,
        },
        ...(approval ? { approval } : {}),
      },
      index,
    );
  const createPr = (headRef: string, expectedHeadSha: string) =>
    f.call("ensemble_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.create",
        target: {
          repositoryId: "R1",
          baseRef: "main",
          headRef,
          expectedHeadSha,
        },
        title: "Change",
        body: "Body",
        draft: true,
      },
    });
  const action = (
    kind: "branch.force-push" | "branch.adopt",
    material: Record<string, unknown>,
  ) => ({ kind, target: { repositoryId: "R1" }, ...material });
  const recover = (
    recovery: Record<string, unknown>,
    index: number,
    approval?: object,
  ) =>
    f.call(
      "ensemble_external_action",
      {
        operationId: randomUUID(),
        action: recovery,
        ...(approval ? { approval } : {}),
      },
      index,
    );
  /** The lead requests approval of exact recovery material and the operator approves it. */
  const approve = async (recovery: Record<string, unknown>, turn: number) => {
    const requested = await f.call(
      "ensemble_request_approval",
      {
        action: recovery.kind,
        target: canonicalMaterial(recovery.target),
        material: recovery,
      },
      turn,
    );
    assert.equal(requested.success, true, requested.text);
    const interaction = f.service
      .coordinationView()
      .readTask(f.taskId)
      .approvals.at(-1);
    assert.ok(interaction);
    await f.terminal(turn);
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: String(recovery.kind),
      target: canonicalMaterial(recovery.target),
      material: recovery,
    });
    await f.waitTurn(turn + 1);
    return { interactionId: interaction.interactionId, expectedRevision: 2 };
  };
  return { f, commit, push, createPr, action, recover, approve };
}

test("an allowed push publishes the lead's commit to the assigned branch and pr.create targets only that branch", async () => {
  const { f, commit, push, createPr } = await publicationWorld("allow");
  try {
    const sha = commit("one.txt");
    const pushed = await push(sha);
    assert.equal(pushed.success, true, pushed.text);
    const branch = f.service.delivery().taskBranch(f.taskId, "R1")?.branch;
    assert.ok(branch);
    assert.match(pushed.text, new RegExp(branch));
    assert.deepEqual(f.scripted.state.pushes, [
      { branch, commitSha: sha, lease: null },
    ]);
    assert.equal((await createPr("cb/other", sha)).success, false);
    assert.equal(f.scripted.state.created, null);
    const created = await createPr(branch, sha);
    assert.equal(created.success, true, created.text);
    assert.equal(
      (f.scripted.state.created as { head: string } | null)?.head,
      branch,
    );
    // The same branch takes a repair push.
    const repair = commit("two.txt");
    assert.equal((await push(repair)).success, true);
    assert.equal(f.scripted.state.refs[branch], repair);
  } finally {
    await f.close();
  }
});

test("an approval-mode push waits for the operator to approve the exact commit", async () => {
  const { f, commit, push } = await publicationWorld("approval");
  try {
    const sha = commit("one.txt");
    const action = {
      kind: "branch.push",
      target: { repositoryId: "R1" },
      commitSha: sha,
    };
    assert.equal((await push(sha)).success, false);
    assert.deepEqual(f.scripted.state.pushes, []);
    const requested = await f.call("ensemble_request_approval", {
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    assert.equal(requested.success, true, requested.text);
    const interaction = f.service.coordinationView().readTask(f.taskId)
      .approvals[0];
    assert.ok(interaction);
    await f.terminal(1);
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    await f.waitTurn(2);
    const approval = {
      interactionId: interaction.interactionId,
      expectedRevision: 2,
    };
    const other = commit("other.txt");
    assert.equal((await push(other, 2, approval)).success, false);
    assert.deepEqual(f.scripted.state.pushes, []);
    const done = await push(sha, 2, approval);
    assert.equal(done.success, true, done.text);
    assert.equal(f.scripted.state.pushes.length, 1);
  } finally {
    await f.close();
  }
});

/** A pushed commit, then an outside writer moves the branch and the lead's next push records it. */
async function outsideChange(
  world: Awaited<ReturnType<typeof publicationWorld>>,
) {
  const { f, commit, push } = world;
  const first = commit("one.txt");
  assert.equal((await push(first)).success, true);
  const branch = f.service.delivery().taskBranch(f.taskId, "R1")?.branch;
  assert.ok(branch);
  const outside = "5".repeat(40);
  f.scripted.state.refs[branch] = outside;
  const next = commit("two.txt");
  assert.equal((await push(next)).success, false);
  const recorded = f.service.delivery().taskBranch(f.taskId, "R1");
  assert.equal(recorded?.outsideHeadSha, outside);
  return {
    branch,
    first,
    outside,
    next,
    material: {
      branch,
      outsideHeadSha: outside,
      lastPushedSha: first,
    },
  };
}

test("an overwrite of an outside head waits for the operator to approve its exact material, even under an allow grant", async () => {
  const world = await publicationWorld("allow");
  const { f, action, recover, approve } = world;
  try {
    const { branch, outside, next, material } = await outsideChange(world);
    const overwrite = action("branch.force-push", {
      commitSha: next,
      ...material,
    });
    assert.equal((await recover(overwrite, 1)).success, false);
    assert.equal(f.scripted.state.refs[branch], outside);
    const approval = await approve(overwrite, 1);
    // The approval view names GitHub's comparison from the last push to the outside head.
    const shown = (
      await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
    ).data.approvals.at(-1);
    assert.equal(
      shown?.compareUrl,
      `https://github.com/org/repo/compare/${material.lastPushedSha}...${outside}`,
    );
    // Other material, or a different commit, is not what was approved.
    const other = action("branch.force-push", {
      commitSha: next,
      ...material,
      outsideHeadSha: "6".repeat(40),
    });
    assert.equal((await recover(other, 2, approval)).success, false);
    const done = await recover(overwrite, 2, approval);
    assert.equal(done.success, true, done.text);
    assert.equal(f.scripted.state.refs[branch], next);
    assert.equal(f.scripted.state.pushes.at(-1)?.lease, outside);
    const recorded = f.service.delivery().taskBranch(f.taskId, "R1");
    assert.equal(recorded?.outsideHeadSha, null);
    assert.equal(recorded?.lastPushedSha, next);
  } finally {
    await f.close();
  }
});

test("an adoption of an outside head waits for the operator to approve its exact material and records the head as the lead's own", async () => {
  const world = await publicationWorld("allow");
  const { f, action, recover, approve } = world;
  try {
    const { branch, outside, material } = await outsideChange(world);
    const adoption = action("branch.adopt", material);
    assert.equal((await recover(adoption, 1)).success, false);
    assert.deepEqual(f.scripted.state.adopts, []);
    const approval = await approve(adoption, 1);
    const done = await recover(adoption, 2, approval);
    assert.equal(done.success, true, done.text);
    assert.deepEqual(f.scripted.state.adopts, [{ branch, commitSha: outside }]);
    const recorded = f.service.delivery().taskBranch(f.taskId, "R1");
    assert.equal(recorded?.outsideHeadSha, null);
    assert.equal(recorded?.lastPushedSha, outside);
    // The approval is spent: the same approval cannot adopt again.
    assert.equal((await recover(adoption, 2, approval)).success, false);
  } finally {
    await f.close();
  }
});

test("a compare link names a verified repository and the outside change only", () => {
  const last = "a".repeat(40),
    outside = "b".repeat(40);
  assert.equal(
    githubCompareUrl("acme/app", last, outside),
    `https://github.com/acme/app/compare/${last}...${outside}`,
  );
  assert.equal(
    githubCompareUrl("acme/app", null, outside),
    `https://github.com/acme/app/commit/${outside}`,
  );
  for (const name of [null, "../app", "acme/..", "acme/app/extra", "a b/c"])
    assert.equal(githubCompareUrl(name, last, outside), null, String(name));
  assert.equal(githubCompareUrl("acme/app", last, absentBranchHead), null);
});
