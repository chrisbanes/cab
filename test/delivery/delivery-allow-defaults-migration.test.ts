import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeliveryStore, type DeliveryPolicy } from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";

type Grant = DeliveryPolicy["grants"][number];
const migrationId = "allow-default-kinds-v1";
const switched = [
  "branch.push",
  "pr.create",
  "pr.edit",
  "pr.ready",
  "pr.thread.reply",
  "pr.thread.resolve",
  "issue.comment",
  "issue.labels",
] as const;
const kept = [
  "pr.merge",
  "issue.close",
  "issue.edit",
  "issue.create",
  "branch.force-push",
  "branch.adopt",
] as const;
const projectGrants: Grant[] = [
  {
    action: "project.item.add",
    repositoryId: "R",
    mode: "approval",
    projectNodeId: "PVT",
  },
  {
    action: "project.field",
    repositoryId: "R",
    mode: "approval",
    projectNodeId: "PVT",
    fieldNodeId: "F",
    optionNodeIds: ["O1", "O2"],
  },
];
const approvalGrants: Grant[] = [
  ...switched.map((action) => ({
    action,
    repositoryId: "R",
    mode: "approval" as const,
  })),
  ...projectGrants,
  ...kept.map((action) => ({
    action,
    repositoryId: "R",
    mode: "approval" as const,
  })),
  { action: "issue.comment", repositoryId: "R2", mode: "allow" },
];

/** Real SQLite stores; policies are saved through `delivery.configure`, then the migration re-runs. */
function world() {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const delivery = new DeliveryStore(db);
  delivery.migrate();
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
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "through-merge",
      credentialRef: "env:TEST_DELIVERY",
      branchPrefix: "cab/",
      grants,
      requiredChecks: [],
    });
    return projectId;
  };
  const stored = (projectId: string) =>
    db
      .prepare(
        "SELECT version, policyJson FROM delivery_policies WHERE projectId=?",
      )
      .get(projectId) as { version: number; policyJson: string };
  // Policies saved after the store's own migration: run it again as an upgraded store would.
  const remigrate = () => {
    db.prepare("DELETE FROM delivery_migrations WHERE migrationId=?").run(
      migrationId,
    );
    delivery.migrate();
  };
  return { db, domain, delivery, project, stored, remigrate };
}

test("the migration switches only listed approval grants and keeps every other field and the version", () => {
  const w = world();
  try {
    const projectId = w.project(approvalGrants);
    const before = w.stored(projectId);
    w.remigrate();
    const after = w.stored(projectId);
    assert.equal(after.version, before.version);
    const policy = JSON.parse(after.policyJson) as DeliveryPolicy;
    const previous = JSON.parse(before.policyJson) as DeliveryPolicy;
    assert.deepEqual(
      policy.grants,
      previous.grants.map((grant) =>
        (kept as readonly string[]).includes(grant.action)
          ? grant
          : { ...grant, mode: "allow" },
      ),
    );
    assert.deepEqual({ ...policy, grants: [] }, { ...previous, grants: [] });
    assert.equal(policy.mode, "through-merge");
    assert.equal(policy.credentialRef, "env:TEST_DELIVERY");
  } finally {
    w.db.close();
  }
});

test("the migration adds no grant and leaves policies with nothing to switch byte-identical", () => {
  const w = world();
  try {
    const empty = w.project([]);
    const allowed = w.project([
      { action: "pr.edit", repositoryId: "R", mode: "allow" },
    ]);
    const before = [w.stored(empty), w.stored(allowed)];
    w.db.exec("PRAGMA foreign_keys = OFF");
    const malformed = randomUUID();
    w.db
      .prepare("INSERT INTO delivery_policies VALUES (?, 3, ?)")
      .run(malformed, "{not json");
    const migrated = w.project([
      { action: "pr.edit", repositoryId: "R", mode: "approval" },
    ]);
    w.remigrate();
    assert.deepEqual([w.stored(empty), w.stored(allowed)], before);
    assert.equal(w.stored(malformed).policyJson, "{not json");
    assert.equal(w.delivery.configuration(migrated).grants[0]?.mode, "allow");
  } finally {
    w.db.close();
  }
});

test("an in-flight approval keeps its binding while its grant switches to allow", () => {
  const w = world();
  try {
    const projectId = w.project([
      { action: "pr.edit", repositoryId: "R", mode: "approval" },
    ]);
    const { version } = w.stored(projectId);
    w.db.exec("PRAGMA foreign_keys = OFF");
    const interactionId = randomUUID();
    w.db
      .prepare(
        "INSERT INTO delivery_approval_bindings VALUES (?,?,?,1,1,1,1,?,?,NULL)",
      )
      .run(interactionId, randomUUID(), randomUUID(), version, "hash");
    const binding = () =>
      w.db
        .prepare(
          "SELECT * FROM delivery_approval_bindings WHERE interactionId=?",
        )
        .get(interactionId);
    const bound = binding();
    w.remigrate();
    assert.equal(w.stored(projectId).version, version);
    assert.equal(w.delivery.configuration(projectId).grants[0]?.mode, "allow");
    assert.deepEqual(binding(), bound);
  } finally {
    w.db.close();
  }
});

test("a grant the operator sets back to approval stays, and only the once-guard keeps it", () => {
  const w = world();
  try {
    const projectId = w.project([
      { action: "pr.edit", repositoryId: "R", mode: "approval" },
    ]);
    w.remigrate();
    const { version } = w.stored(projectId);
    w.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: version,
      mode: "through-merge",
      credentialRef: "env:TEST_DELIVERY",
      branchPrefix: "cab/",
      grants: [{ action: "pr.edit", repositoryId: "R", mode: "approval" }],
      requiredChecks: [],
    });
    assert.equal(w.stored(projectId).version, version + 1);
    w.delivery.migrate();
    new DeliveryStore(w.db).migrate();
    assert.equal(
      w.delivery.configuration(projectId).grants[0]?.mode,
      "approval",
    );
    // Sensitivity: without the recorded migration the reset would be switched again.
    w.remigrate();
    assert.equal(w.delivery.configuration(projectId).grants[0]?.mode, "allow");
  } finally {
    w.db.close();
  }
});

test("a fresh store records the migration with nothing to change", () => {
  const w = world();
  try {
    assert.ok(
      w.db
        .prepare("SELECT 1 FROM delivery_migrations WHERE migrationId=?")
        .get(migrationId),
    );
  } finally {
    w.db.close();
  }
});
