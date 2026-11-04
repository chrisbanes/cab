import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { assertCleanupOwnershipAvailableWithinTransaction } from "../../src/core/project-cleanup-reservations.js";
import { transaction } from "../../src/core/store.js";
import { projectCleanupSchema } from "../../src/standalone/project-deletion.js";
import { extractLegacyRepositoryLinks } from "../../src/core/github-source-migration.js";
import { linkedRepositorySchema } from "../../src/core/github-source.js";
import { z } from "zod";

function reservation(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE project_tombstones (cleanupJson TEXT NOT NULL,cleanupState TEXT NOT NULL)",
  );
  const workspaceId = randomUUID(),
    taskId = randomUUID(),
    root = `/managed/${workspaceId}`;
  const item = {
    id: randomUUID(),
    kind: "workspace" as const,
    state: "pending" as const,
    reason: "not-attempted" as const,
    captured: {
      kind: "workspace" as const,
      managedRoot: "/managed",
      filesystem: { unavailable: true as const },
      binding: {
        taskId,
        workspaceId,
        path: root,
        repositories: [],
        state: "ready" as const,
        reason: null,
        gitUncertain: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  };
  const cleanup = projectCleanupSchema.parse({ version: 1, items: [item] });
  db.prepare("INSERT INTO project_tombstones VALUES (?,'pending')").run(
    JSON.stringify(cleanup),
  );
  const admit = (paths: string[], task?: string) =>
    transaction(db, () =>
      assertCleanupOwnershipAvailableWithinTransaction(db, paths, task),
    );
  return { db, root, taskId, item, admit };
}

test("ownership acquisition requires a transaction and fences roots, descendants and task identity", (t) => {
  const f = reservation(t);
  assert.throws(
    () => assertCleanupOwnershipAvailableWithinTransaction(f.db, ["/outside"]),
    /transaction/,
  );
  for (const path of [
    f.root,
    `${f.root}/checkout/subdir`,
    `${f.root}/metadata`,
    `${f.root}/child/../checkout`,
  ])
    assert.throws(() => f.admit([path]), /reserved/);
  assert.throws(() => f.admit(["/outside"], f.taskId), /reserved/);
  assert.doesNotThrow(() =>
    f.admit([`${f.root}-sibling/checkout`, "/outside/metadata"]),
  );
});

for (const malformed of [
  "version",
  "items",
  "state",
  "task",
  "workspace",
  "relative-root",
  "managed-root",
  "complete-with-capture",
  "aggregate",
] as const) {
  test(`ownership admission fails closed on malformed ${malformed}`, (t) => {
    const f = reservation(t);
    const item = structuredClone(f.item) as unknown as Record<string, unknown>;
    const binding = (item.captured as { binding: Record<string, unknown> })
      .binding;
    const cleanup: Record<string, unknown> = { version: 1, items: [item] };
    if (malformed === "version") cleanup.version = 2;
    if (malformed === "items") cleanup.items = {};
    if (malformed === "state") item.state = "uncertain-future-phase";
    if (malformed === "complete-with-capture") item.state = "complete";
    if (malformed === "task") delete binding.taskId;
    if (malformed === "workspace") binding.workspaceId = 42;
    if (malformed === "relative-root") binding.path = "managed/relative";
    if (malformed === "managed-root")
      (item.captured as Record<string, unknown>).managedRoot =
        "/different-root";
    f.db
      .prepare("UPDATE project_tombstones SET cleanupJson=?,cleanupState=?")
      .run(
        JSON.stringify(cleanup),
        malformed === "aggregate" || malformed === "complete-with-capture"
          ? "complete"
          : "pending",
      );
    assert.throws(() => f.admit(["/outside/checkout"]), /unavailable/);
  });
}

test("pending ownership projection is bounded, while proved completed history releases its paths", (t) => {
  const f = reservation(t);
  const items = Array.from({ length: 10001 }, () => ({
    ...f.item,
    id: randomUUID(),
  }));
  f.db
    .prepare("UPDATE project_tombstones SET cleanupJson=?")
    .run(JSON.stringify({ version: 1, items }));
  assert.throws(() => f.admit(["/outside/checkout"]), /unavailable/);
  const completed = items.map(({ id, kind }) => ({
    id,
    kind,
    state: "complete",
  }));
  f.db
    .prepare(
      "UPDATE project_tombstones SET cleanupJson=?,cleanupState='complete'",
    )
    .run(JSON.stringify({ version: 1, items: completed }));
  assert.doesNotThrow(() => f.admit([f.root, `${f.root}/metadata`]));
});

test("legacy repository-link extraction cannot acquire reserved checkout or common-directory ownership", (t) => {
  const f = reservation(t);
  f.db.exec(
    "CREATE TABLE project_github_sources (projectId TEXT,repositories TEXT); CREATE TABLE project_repository_links(projectId TEXT PRIMARY KEY,version INTEGER,links TEXT)",
  );
  const projectId = randomUUID();
  for (const field of ["path", "gitCommonDirectory"] as const) {
    const link = {
      repositoryId: "R",
      ref: "main",
      path: "/outside/checkout",
      gitCommonDirectory: "/outside/metadata",
      [field]: `${f.root}/owned`,
    };
    f.db.prepare("DELETE FROM project_github_sources").run();
    f.db
      .prepare("INSERT INTO project_github_sources VALUES (?,?)")
      .run(projectId, JSON.stringify([link]));
    assert.throws(
      () =>
        transaction(f.db, () =>
          extractLegacyRepositoryLinks(f.db, (value) =>
            z.array(linkedRepositorySchema).parse(value),
          ),
        ),
      /reserved/,
    );
    assert.equal(
      f.db.prepare("SELECT 1 FROM project_repository_links").get(),
      undefined,
    );
    assert.ok(
      f.db
        .prepare("PRAGMA table_info(project_github_sources)")
        .all()
        .some((column) => column.name === "repositories"),
    );
  }
});
