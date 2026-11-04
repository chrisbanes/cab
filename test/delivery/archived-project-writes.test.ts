import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProjectArchiveBlockedError } from "../../src/core/project-lifecycle.js";
import {
  deliveryFixture,
  fixtureProject,
} from "../fixtures/delivery-fixture.js";
import { databaseOf } from "../fixtures/service-internals.js";
import { until } from "../fixtures/until.js";

const mapping = {
  selectionId: "repo",
  projectNodeId: fixtureProject.projectNodeId,
  fieldNodeId: fixtureProject.fieldNodeId,
  events: {
    turnStarted: fixtureProject.inProgress,
    handedBack: fixtureProject.inReview,
    held: fixtureProject.todo,
    done: fixtureProject.done,
  },
};

test("a held status provider operation is registered in the service archive authority before its first await", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    f.holdStatusWrites(undefined);
    await f.close();
  });
  f.holdStatusWrites(gate);
  f.domain.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.domain.statusMapping(f.projectId).version,
    mapping,
  });
  const pending = f.service.runStatusMapping();
  await until(
    () =>
      f.service
        .delivery()
        .actions(f.taskId)
        .some(
          (action) =>
            action.request.action.kind === "project.field" &&
            action.state === "prepared",
        ),
    "held status action",
  );
  f.domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: Number(f.domain.project(f.projectId).version),
    paused: true,
  });
  assert.throws(
    () =>
      f.domain.execute({
        type: "project.archive",
        actor: "operator",
        key: randomUUID(),
        projectId: f.projectId,
        expectedVersion: Number(f.domain.project(f.projectId).version),
      }),
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some((blocker) => blocker.kind === "provider-write"),
  );
  release();
  await pending;
});

test("archived delivery/status sweeps issue no provider effects and do not revise saved policy or mapping rows", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true, true),
    db = databaseOf(f.service);
  // Adversarial disposable state exercises bypasses independently of archive's drain gate.
  t.after(async () => {
    db.prepare("UPDATE domain_projects SET archived=0 WHERE id=?").run(
      f.projectId,
    );
    await f.close();
  });
  f.domain.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.domain.statusMapping(f.projectId).version,
    mapping,
  });
  await f.service.runStatusMapping();
  db.prepare(
    "UPDATE domain_projects SET archived=1,paused=1,version=version+1 WHERE id=?",
  ).run(f.projectId);
  const snapshot = () =>
    JSON.stringify([
      f.domain.project(f.projectId),
      f.domain.task(f.taskId),
      f.service.delivery().actions(f.taskId),
      f.domain.statusMapping(f.projectId),
      db
        .prepare("SELECT * FROM status_mapping_task_state WHERE taskId=?")
        .all(f.taskId),
      db
        .prepare("SELECT * FROM delivery_pr_bindings WHERE taskId=?")
        .all(f.taskId),
    ]);
  const before = snapshot(),
    effects = f.effects.length;
  await f.service.runStatusMapping();
  await f.service.refreshGitHub();
  assert.equal(f.effects.length, effects);
  assert.equal(snapshot(), before);
  assert.throws(() =>
    f.service
      .delivery()
      .configureWithinTransaction(
        f.projectId,
        f.service.delivery().configuration(f.projectId).version,
        {
          mode: "reviewable-pr",
          credentialRef: null,
          grants: [],
          requiredChecks: [],
        },
      ),
  );
});
