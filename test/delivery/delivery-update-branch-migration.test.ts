import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DeliveryStore } from "../../src/core/delivery.js";
import {
  applyRepositoryLevel,
  repositoryDeliveryLevel,
  repositoryLevelGrants,
} from "../../src/core/delivery-levels.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { ExecutionState } from "../../src/standalone/state.js";

type Grant = ReturnType<typeof repositoryLevelGrants>[number];
const levels = ["open-prs", "merge-with-approval", "merge-when-ready"] as const;
/** A preset's rows as stored before `pr.update-branch` joined it. */
const oldPreset = (repositoryId: string, level: (typeof levels)[number]) =>
  repositoryLevelGrants(repositoryId, level).filter(
    (g) => g.action !== "pr.update-branch",
  );
const migrationId = "update-branch-preset-v1";

/** Real SQLite with the schemas the migration reads; `upgrade` reruns it as on a store from before it. */
function world() {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  new ExecutionState(db);
  new CoordinationStore(db).migrate();
  const delivery = new DeliveryStore(db);
  delivery.migrate();
  const configure = (projectId: string, grants: Grant[]) =>
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: delivery.configuration(projectId).version,
      mode: "through-merge",
      credentialRef: null,
      grants,
      requiredChecks: [],
    });
  const project = (grants: Grant[]) => {
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: `P-${projectId}`,
      leadProfileId: null,
    });
    configure(projectId, grants);
    return projectId;
  };
  const upgrade = () => {
    db.prepare("DELETE FROM delivery_migrations WHERE migrationId=?").run(
      migrationId,
    );
    delivery.migrate();
  };
  const read = (projectId: string) => delivery.configuration(projectId);
  return { db, delivery, project, configure, upgrade, read };
}

test("a fresh store records the migration with nothing to change", () => {
  const w = world();
  assert.ok(
    w.db
      .prepare("SELECT 1 FROM delivery_migrations WHERE migrationId=?")
      .get(migrationId),
  );
});

test("a repository stored at a preset from before pr.update-branch still reads as that level, at the same version", () => {
  const w = world();
  const custom: Grant = {
    action: "branch.push",
    repositoryId: "R4",
    mode: "allow",
  };
  const comment: Grant = {
    action: "issue.comment",
    repositoryId: "R1",
    mode: "allow",
  };
  const projectId = w.project([
    ...levels.flatMap((level, i) => oldPreset(`R${i + 1}`, level)),
    custom,
    comment,
  ]);
  const before = w.read(projectId);
  for (const [i] of levels.entries())
    assert.equal(repositoryDeliveryLevel(before.grants, `R${i + 1}`), "custom");
  w.upgrade();
  const after = w.read(projectId);
  assert.equal(after.version, before.version);
  for (const [i, level] of levels.entries())
    assert.equal(repositoryDeliveryLevel(after.grants, `R${i + 1}`), level);
  assert.deepEqual(after.grants, [
    ...before.grants,
    ...levels.map((_, i) => ({
      action: "pr.update-branch",
      mode: "allow",
      repositoryId: `R${i + 1}`,
    })),
  ]);
  assert.equal(repositoryDeliveryLevel(after.grants, "R4"), "custom");
});

test("the migration runs once: a row the operator removes is not added back", () => {
  const w = world();
  const projectId = w.project(oldPreset("R1", "open-prs"));
  w.upgrade();
  const withRow = w.read(projectId).grants;
  w.configure(
    projectId,
    withRow.filter((g) => g.action !== "pr.update-branch"),
  );
  const removed = w.read(projectId);
  w.delivery.migrate();
  assert.deepEqual(w.read(projectId), removed);
  assert.equal(repositoryDeliveryLevel(removed.grants, "R1"), "custom");
});

test("a policy at the grant cap is skipped, never truncated", () => {
  const w = world();
  const grants = [
    ...Array.from(
      { length: 256 - oldPreset("R1", "open-prs").length },
      (_, i): Grant => ({
        action: "issue.comment",
        repositoryId: `I${i}`,
        mode: "allow",
      }),
    ),
    ...oldPreset("R1", "open-prs"),
  ];
  assert.equal(grants.length, 256);
  const projectId = w.project(grants);
  const before = w.read(projectId);
  w.upgrade();
  assert.deepEqual(w.read(projectId), before);
});

test("current presets carry pr.update-branch as allow, and custom can require approval", () => {
  for (const level of levels) {
    const grants = repositoryLevelGrants("R1", level);
    assert.deepEqual(
      grants.filter((g) => g.action === "pr.update-branch"),
      [{ action: "pr.update-branch", mode: "allow", repositoryId: "R1" }],
    );
    assert.equal(
      repositoryDeliveryLevel(
        grants.map((g) =>
          g.action === "pr.update-branch" ? { ...g, mode: "approval" } : g,
        ),
        "R1",
      ),
      "custom",
    );
    assert.equal(
      repositoryDeliveryLevel(applyRepositoryLevel([], "R1", level), "R1"),
      level,
    );
  }
});
