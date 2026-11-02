import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DeliveryStore } from "../../src/core/delivery.js";
import {
  repositoryDeliveryLevel,
  repositoryLevelGrants,
} from "../../src/core/delivery-levels.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import type { Runtime } from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { tmpdir } from "../fixtures/temp.js";

type Grant = ReturnType<typeof repositoryLevelGrants>[number];
const issueComment = (repositoryId: string): Grant => ({
  action: "issue.comment",
  repositoryId,
  mode: "allow",
});

/** Real SQLite with every schema the migration reads, as at service start. */
function world() {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  new ExecutionState(db);
  new CoordinationStore(db).migrate();
  const delivery = new DeliveryStore(db);
  delivery.migrate();
  // The checks read persisted rows only; seeding raw rows needs no parents.
  db.exec("PRAGMA foreign_keys = OFF");
  const project = (
    repositories: string[],
    policy?: {
      grants: Grant[];
      mode?: "reviewable-pr" | "through-merge";
      credentialRef?: string | null;
      branchPrefix?: string;
    },
  ) => {
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: `P-${projectId}`,
      leadProfileId: null,
    });
    db.prepare(
      "UPDATE project_repository_links SET links = ? WHERE projectId = ?",
    ).run(
      JSON.stringify(
        repositories.map((repositoryId) => ({
          repositoryId,
          path: `/tmp/${repositoryId}`,
          ref: "main",
          gitCommonDirectory: `/tmp/${repositoryId}/.git`,
          codeHost: "github",
          host: "github.com",
        })),
      ),
      projectId,
    );
    if (policy)
      domain.execute({
        type: "delivery.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: 1,
        mode: policy.mode ?? "reviewable-pr",
        credentialRef: policy.credentialRef ?? null,
        ...(policy.branchPrefix === undefined
          ? {}
          : { branchPrefix: policy.branchPrefix }),
        grants: policy.grants,
        requiredChecks: [],
      });
    return projectId;
  };
  const task = (projectId: string) => {
    const taskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
    });
    return taskId;
  };
  const migrate = () =>
    delivery.applyOpenPrsDefault(
      domain.projects().map((p) => ({
        projectId: String(p.id),
        repositoryIds: domain
          .repositoryLinks(String(p.id))
          .links.map((link) => link.repositoryId),
      })),
    );
  const read = (projectId: string) => delivery.configuration(projectId);
  return { db, domain, delivery, project, task, migrate, read };
}

const levelOf = (grants: Grant[], id: string) =>
  repositoryDeliveryLevel(grants, id);

test("repositories without code-host grants gain Open PRs; issue grants, mode, credential and prefix stay; the version moves once", () => {
  const w = world();
  const projectId = w.project(["R1", "R2"], {
    grants: [issueComment("R1")],
    mode: "through-merge",
    credentialRef: "env:FIXTURE_DELIVERY",
    branchPrefix: "cab/",
  });
  const before = w.read(projectId);
  w.migrate();
  const after = w.read(projectId);
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.grants, [
    issueComment("R1"),
    ...repositoryLevelGrants("R1", "open-prs"),
    ...repositoryLevelGrants("R2", "open-prs"),
  ]);
  assert.equal(after.mode, "through-merge");
  assert.equal(after.credentialRef, "env:FIXTURE_DELIVERY");
  assert.equal(after.branchPrefix, "cab/");
});

test("a partially configured repository is untouched while an empty one is added", () => {
  const w = world();
  const custom: Grant = {
    action: "branch.push",
    repositoryId: "R1",
    mode: "allow",
  };
  const projectId = w.project(["R1", "R2"], { grants: [custom] });
  const before = w.read(projectId);
  w.migrate();
  const after = w.read(projectId);
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.grants, [
    custom,
    ...repositoryLevelGrants("R2", "open-prs"),
  ]);
  assert.equal(levelOf(after.grants, "R1"), "custom");
});

test("a project whose repositories are all set up keeps its version", () => {
  const w = world();
  const projectId = w.project(["R1", "R2"], {
    grants: [
      ...repositoryLevelGrants("R1", "merge-when-ready"),
      ...repositoryLevelGrants("R2", "open-prs"),
    ],
    mode: "through-merge",
  });
  const before = w.read(projectId);
  w.migrate();
  assert.deepEqual(w.read(projectId), before);
});

test("a project with no stored policy is written at version 2", () => {
  const w = world();
  const projectId = w.project(["R1"]);
  assert.equal(w.read(projectId).version, 1);
  w.migrate();
  const after = w.read(projectId);
  assert.equal(after.version, 2);
  assert.equal(levelOf(after.grants, "R1"), "open-prs");
  assert.equal(after.mode, "reviewable-pr");
  assert.equal(after.credentialRef, null);
});

test("a project that would exceed the grant cap is skipped, never truncated", () => {
  const w = world();
  const grants = Array.from({ length: 250 }, (_, i) => issueComment(`I${i}`));
  const projectId = w.project(["R1"], { grants });
  const before = w.read(projectId);
  w.migrate();
  assert.deepEqual(w.read(projectId), before);
});

const inFlight: [string, (w: ReturnType<typeof world>, p: string) => void][] = [
  [
    "an open pull request binding",
    (w, projectId) =>
      w.db
        .prepare("INSERT INTO delivery_pr_bindings VALUES (?, ?)")
        .run(
          w.task(projectId),
          JSON.stringify({ projectId, observation: { state: "OPEN" } }),
        ),
  ],
  [
    "an open approval",
    (w, projectId) =>
      w.db
        .prepare(
          "INSERT INTO coordination_interactions (interactionId, taskId, requestingAssignmentId, requestingWorkId, requestingWorkRevision, requestingAssignmentVersion, conversationRevision, kind, status, prompt, action, materialHash, revision) VALUES (?, ?, ?, ?, 1, 1, 1, 'approval', 'open', 'p', 'pr.merge', 'h', 1)",
        )
        .run(randomUUID(), w.task(projectId), randomUUID(), randomUUID()),
  ],
  [
    "an uncertain action",
    (w, projectId) =>
      w.db
        .prepare("INSERT INTO delivery_actions VALUES (?, ?, ?, ?)")
        .run(
          randomUUID(),
          w.task(projectId),
          "hash",
          JSON.stringify({ state: "uncertain" }),
        ),
  ],
];
for (const [name, seed] of inFlight)
  test(`a project with ${name} is skipped and its repository stays Not set up`, () => {
    const w = world();
    const skipped = w.project(["R1"], { grants: [issueComment("R1")] });
    const changed = w.project(["R2"]);
    seed(w, skipped);
    const before = w.read(skipped);
    w.migrate();
    assert.deepEqual(w.read(skipped), before);
    assert.equal(levelOf(w.read(skipped).grants, "R1"), "not-set-up");
    assert.equal(levelOf(w.read(changed).grants, "R2"), "open-prs");
  });

test("the migration runs once: a repository added later stays Not set up", () => {
  const w = world();
  const projectId = w.project(["R1"]);
  w.migrate();
  const migrated = w.read(projectId);
  w.db
    .prepare(
      "UPDATE project_repository_links SET links = json_insert(links, '$[#]', json(?)) WHERE projectId = ?",
    )
    .run(
      JSON.stringify({
        repositoryId: "R2",
        path: "/tmp/R2",
        ref: "main",
        gitCommonDirectory: "/tmp/R2/.git",
        codeHost: "github",
        host: "github.com",
      }),
      projectId,
    );
  w.migrate();
  assert.deepEqual(w.read(projectId), migrated);
});

test("a fresh store records the marker with no projects, so projects created afterwards are never migrated", () => {
  const w = world();
  w.migrate();
  const projectId = w.project(["R1"]);
  w.migrate();
  assert.equal(w.read(projectId).version, 1);
  assert.deepEqual(w.read(projectId).grants, []);
});

test("service start applies it once to an upgraded store and never again", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-open-prs-migration-"));
  const data = join(root, "data");
  const stub = () =>
    ({
      async start() {},
      async stop() {},
      onUnexpectedRequest() {},
    }) as unknown as Runtime;
  const cycle = async (use: (service: StandaloneService) => void) => {
    const service = new StandaloneService(data, stub);
    await service.start();
    try {
      use(service);
    } finally {
      await service.stop();
    }
  };
  const raw = <T>(use: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    try {
      return use(db);
    } finally {
      db.close();
    }
  };
  try {
    const projectId = randomUUID();
    await cycle((service) =>
      service.domain().execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        name: "Upgraded",
        leadProfileId: null,
      }),
    );
    raw((db) => {
      db.prepare(
        "UPDATE project_repository_links SET links = ? WHERE projectId = ?",
      ).run(
        JSON.stringify([
          {
            repositoryId: "R1",
            path: "/tmp/R1",
            ref: "main",
            gitCommonDirectory: "/tmp/R1/.git",
            codeHost: "github",
            host: "github.com",
          },
        ]),
        projectId,
      );
      // An upgraded store: the marker table has never recorded this migration.
      db.exec("DELETE FROM delivery_migrations");
    });
    let version = 0;
    await cycle((service) => {
      const policy = service.delivery().configuration(projectId);
      version = policy.version;
      assert.equal(levelOf(policy.grants, "R1"), "open-prs");
    });
    assert.equal(version, 2);
    await cycle((service) =>
      assert.equal(service.delivery().configuration(projectId).version, 2),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
