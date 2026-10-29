import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import { GitHubSourceStore } from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import type { IssueSnapshot } from "../../src/standalone/github-source.js";

const issue = (number: number): IssueSnapshot => ({
  providerInstance: "github.com",
  nodeId: `I_${number}`,
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number,
  title: `Issue ${number}`,
  body: "Ship",
  state: "open",
  labels: ["ready"],
  projectFields: [],
});

test("the GitHub adapter's sweeps leave another provider's items alone", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-sweep-scope-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const domain = new DomainStore(db);
  const sources = new GitHubSourceStore(db);
  const first = randomUUID();
  const second = randomUUID();
  try {
    new Store(db).ensureHost("test");
    domain.migrate();
    sources.migrate();
    for (const [projectId, name] of [
      [first, "Alpha"],
      [second, "Beta"],
    ] as const)
      domain.execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        name,
        leadProfileId: null,
      });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: first,
      expectedVersion: 1,
      credentialRef: "env:TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId: first,
      selectionId: "repo",
      expectedVersion: 2,
    });
    sources.reconcileSelection(first, "repo", {
      complete: true,
      issues: [issue(1), issue(2)],
      reason: null,
    });
    for (const id of ["I_1", "I_2"]) {
      sources.reconcileBlockers(id, {
        complete: true,
        blockers: [],
        reason: null,
      });
      sources.recordIssueStatus(id, { status: "closed" });
      db.prepare(
        "INSERT INTO source_holds (provider, instance, externalId, active, reason, generation) VALUES ('github', 'github.com', ?, 1, 'test', 1)",
      ).run(id);
      db.prepare(
        "INSERT INTO source_memberships (projectId, selectionId, provider, instance, externalId, fields) VALUES (?, 'repo', 'github', 'github.com', ?, '[]')",
      ).run(second, id);
    }
    // The second issue now belongs to another provider's tracker.
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of [
      "external_items",
      "imported_tasks",
      "source_memberships",
      "source_holds",
      "source_reviews",
      "external_item_status",
      "source_dependency_observations",
    ])
      db.exec(
        `UPDATE ${table} SET provider = 'other' WHERE externalId = 'I_2'`,
      );
    db.exec("PRAGMA foreign_keys = ON");
    const otherTask = String(
      (
        db
          .prepare("SELECT taskId FROM external_items WHERE provider = 'other'")
          .get() as { taskId: string }
      ).taskId,
    );

    assert.deepEqual(
      sources.conflicts().map((c) => c.nodeId),
      ["I_1"],
    );
    assert.deepEqual(
      sources.activeHolds().map((h) => h.nodeId),
      ["I_1"],
    );

    const snapshot = () => ({
      task: db
        .prepare(
          "SELECT version, importedBlockers FROM domain_tasks WHERE id = ?",
        )
        .get(otherTask),
      status: db
        .prepare(
          "SELECT status, reason FROM external_item_status WHERE provider = 'other'",
        )
        .get(),
      observation: db
        .prepare(
          "SELECT complete, reason FROM source_dependency_observations WHERE provider = 'other'",
        )
        .get(),
    });
    const before = snapshot();
    sources.invalidateProviderObservations();
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT status, reason FROM external_item_status WHERE provider = 'github'",
          )
          .get(),
      },
      { status: "unknown", reason: "startup-refresh-required" },
    );
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT complete, reason FROM source_dependency_observations WHERE provider = 'github'",
          )
          .get(),
      },
      { complete: 0, reason: "startup-refresh-required" },
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
