import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainStore } from "../../src/core/domain.js";
import { transaction } from "../../src/core/store.js";
import { stackedDeliveryFixture } from "../fixtures/stacked-delivery.js";
import { auditPreparedStack } from "./github-qualification/stack-audit.js";
import { offlineStackResources } from "./github-qualification/stack-offline-resources.js";

for (const pending of [
  "undelivered notice",
  "queued inbox batch",
  "ready execution",
  "reporting repair",
  "eligible pending assignment",
] as const) {
  test(`stack settlement audit refuses ${pending} after earlier completed turns`, async (t) => {
    const f = await offlineStackResources(t);
    await f.guard.open();
    const db = new DatabaseSync(
      join(f.guard.manifest.authority.host.dataDirectory, "standalone.sqlite"),
    );
    try {
      const coordination = new CoordinationStore(db, new DomainStore(db));
      for (const batch of coordination.queuedDeliveries()) {
        coordination.completeDeliveryBatch(batch.deliveryWorkId);
      }
      for (const recipient of coordination.pendingEventRecipients()) {
        const original = db
          .prepare("SELECT state FROM domain_assignments WHERE id=?")
          .get(recipient) as { state: string };
        db.prepare(
          "UPDATE domain_assignments SET state='pending' WHERE id=?",
        ).run(recipient);
        const batch = coordination.bindDeliveryBatch(
          recipient,
          `offline-audit-preparation:${recipient}`,
        );
        assert.ok(batch);
        coordination.completeDeliveryBatch(batch.deliveryWorkId);
        db.prepare("UPDATE domain_assignments SET state=? WHERE id=?").run(
          original.state,
          recipient,
        );
      }
      // Earlier completed turns can leave ready inbox executions. Preserve that
      // baseline and require this specific new fault to add one unfinished item.
      const baseline = auditPreparedStack(f.guard).unfinished;
      const task =
        pending === "eligible pending assignment"
          ? randomUUID()
          : f.resource.upperTask;
      if (pending === "eligible pending assignment") {
        const domain = new DomainStore(db);
        domain.execute({
          type: "task.create",
          actor: "operator",
          key: randomUUID(),
          projectId: f.resource.projectId,
          taskId: task,
          title: "Unstarted fixture task",
          outcome: "Offline audit",
          ready: true,
        });
        assert.ok(domain.ensureLeadAssignment(task));
      }
      const assignment = db
        .prepare("SELECT assignmentId FROM task_lead_bindings WHERE taskId=?")
        .get(task) as { assignmentId: string };
      const work = db
        .prepare(
          "SELECT b.workId FROM task_execution_bindings b JOIN execution_intents e ON e.workId=b.workId WHERE b.assignmentId=? AND b.workId=? AND e.state='completed'",
        )
        .get(
          assignment.assignmentId,
          `assignment:${assignment.assignmentId}:initial`,
        ) as { workId: string } | undefined;
      if (pending === "eligible pending assignment") {
        db.prepare("UPDATE domain_projects SET paused=0 WHERE id=?").run(
          f.resource.projectId,
        );
        db.prepare(
          "UPDATE domain_assignments SET state='pending' WHERE id=?",
        ).run(assignment.assignmentId);
        assert.equal(
          new DomainStore(db).assignmentAdmission(assignment.assignmentId)
            .eligible,
          true,
        );
      } else if (pending === "ready execution") {
        db.prepare(
          "UPDATE execution_intents SET state='ready' WHERE workId=?",
        ).run(work!.workId);
      } else if (pending === "reporting repair") {
        db.prepare(
          "INSERT INTO coordination_reporting_repairs (assignmentId,assignmentVersion,taskId,missedWorkId,repairWorkId,attempts,state,reason) VALUES (?,1,?,?,?,1,'queued',NULL)",
        ).run(assignment.assignmentId, task, work!.workId, randomUUID());
      } else {
        transaction(db, () => {
          coordination.ensureDeliveryEventWithinTransaction(
            task,
            "The provider rebased this task",
            "offline-audit-notice",
          );
          if (pending === "queued inbox batch") {
            db.prepare(
              "UPDATE domain_assignments SET state='pending' WHERE id=?",
            ).run(assignment.assignmentId);
            assert.ok(
              coordination.bindDeliveryBatchWithinTransaction(
                assignment.assignmentId,
                "offline-audit-inbox",
              ),
            );
            assert.equal(
              coordination.pendingEvents(assignment.assignmentId).length,
              0,
            );
          } else {
            db.prepare(
              "UPDATE domain_assignments SET state='completed' WHERE id=?",
            ).run(assignment.assignmentId);
          }
        });
      }
      assert.equal(auditPreparedStack(f.guard).unfinished, baseline + 1);
    } finally {
      try {
        db.close();
      } finally {
        await f.guard.close();
      }
    }
  });
}

test("registered initial reports retain assignment v1 and process a later delivery notice", async (t) => {
  const f = await stackedDeliveryFixture(t);
  const [lower, upper] = f.tasks as [string, string];
  for (const task of [lower, upper]) {
    await f.waitTurn(task);
    assert.equal((await f.push(task, await f.commit(task))).success, true);
    await f.showPr(task);
  }
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    paused: true,
  });
  for (const task of [lower, upper]) {
    assert.equal(
      (
        await f.call(task, "cab_report_result", {
          summary: "Initial registration complete",
        })
      ).success,
      true,
    );
    await f.complete(task);
    f.readDb((db) => {
      const row = db
        .prepare(
          "SELECT a.id,a.version,a.state FROM domain_assignments a JOIN task_lead_bindings b ON b.assignmentId=a.id WHERE b.taskId=?",
        )
        .get(task)!;
      assert.equal(row.version, 1);
      assert.notEqual(row.state, "completed");
      assert.equal(
        db
          .prepare(
            "SELECT assignmentId FROM delivery_waiting_work WHERE workId=?",
          )
          .get(`assignment:${row.id}:initial`)?.assignmentId,
        row.id,
      );
      transaction(db, () =>
        new CoordinationStore(
          db,
          new DomainStore(db),
        ).ensureDeliveryEventWithinTransaction(
          task,
          "D107 offline delivery notice",
          "d107-offline-notice",
        ),
      );
    });
  }
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    paused: false,
  });
  for (const task of [lower, upper]) {
    await f.waitTurn(task, 2);
    const turn = (await f.turnsOf(task))[1]!;
    assert.match(turn.prompt, /D107 offline delivery notice/);
    assert.equal(
      (
        await f.call(task, "cab_report_result", {
          summary: "Delivery notice processed",
        })
      ).success,
      true,
    );
    await f.complete(task);
    f.readDb((db) => {
      const row = db
        .prepare(
          "SELECT a.id,a.version FROM domain_assignments a JOIN task_lead_bindings b ON b.assignmentId=a.id WHERE b.taskId=?",
        )
        .get(task)!;
      assert.equal(row.version, 1);
      const coordination = new CoordinationStore(db, new DomainStore(db));
      assert.equal(coordination.pendingEvents(String(row.id)).length, 0);
      assert.equal(
        coordination
          .queuedDeliveries()
          .filter((batch) => batch.recipientAssignmentId === row.id).length,
        0,
      );
    });
  }
});
