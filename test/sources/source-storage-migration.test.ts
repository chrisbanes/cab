import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  effectiveOwnClosure,
  GitHubSourceStore,
} from "../../src/core/github-source.js";
import { projectFieldNames } from "../../src/core/project-field-names.js";
import { itemColumns, itemKey } from "../../src/core/source-storage.js";
import {
  previousSchemaDatabase,
  previousSourceTables,
} from "../fixtures/previous-source-schema.js";

/**
 * Each previous table beside a read of its neutral table, aliased back to the previous column
 * names and order, so a migrated row must equal the row it came from.
 */
const neutralReads: Record<(typeof previousSourceTables)[number], string> = {
  project_github_sources:
    "SELECT projectId, version, credentialRef, selections, readiness, closedIssues FROM project_task_sources",
  project_github_active:
    "SELECT projectId, selectionId, configVersion FROM project_active_selections",
  github_sync_state:
    "SELECT projectId, selectionId, complete, reason, refreshedAt, skippedClosedIds AS skippedClosedNodeIds FROM source_sync_state",
  github_external_issues:
    "SELECT instance AS providerInstance, externalId AS nodeId, taskId, containerId AS repositoryId, containerName AS repositoryName, number AS issueNumber, observedTitle, observedBody, observedState, labels FROM external_items",
  github_memberships:
    "SELECT projectId, selectionId, externalId AS nodeId, fields AS projectFields, itemId AS itemNodeId, readAt, missedReads FROM source_memberships",
  github_placement_decisions:
    "SELECT externalId AS nodeId, projectId FROM source_placement_decisions",
  github_native_blockers:
    "SELECT externalId AS nodeId, blockerExternalId AS blockerNodeId, containerId AS repositoryId, containerName AS repositoryName, number AS issueNumber, status FROM source_native_blockers",
  github_dependency_observations:
    "SELECT externalId AS nodeId, complete, reason, refreshedAt FROM source_dependency_observations",
  github_source_reviews:
    "SELECT externalId AS nodeId, observedDigest, acceptedDigest, decision, decidedAt FROM source_reviews",
  github_source_holds:
    "SELECT externalId AS nodeId, active, reason, generation FROM source_holds",
  github_imported_tasks:
    "SELECT taskId, instance AS providerInstance, externalId AS nodeId, containerId AS repositoryId FROM imported_tasks",
  github_issue_status:
    "SELECT externalId AS nodeId, status, reason, refreshedAt FROM external_item_status",
  github_delivery_closures:
    "SELECT externalId AS nodeId, operationId, closerChangeRequestId AS closerPrNodeId, snapshotJson, closedEventId FROM source_closures",
  github_delivery_closure_supersessions:
    "SELECT externalId AS nodeId, operationId, supersededAt FROM source_closure_supersessions",
  github_provider_completions:
    "SELECT taskId, externalId AS nodeId, completedAt FROM source_completions",
  github_project_fields:
    "SELECT scopeId AS projectNodeId, fieldId AS fieldNodeId, name, options FROM source_field_names",
};
const neutralTables = Object.values(neutralReads).map(
  (sql) => /FROM (\w+)$/.exec(sql)?.[1] as string,
);

const rows = (db: DatabaseSync, sql: string) =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
const tableNames = (db: DatabaseSync) =>
  rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) =>
    String(row.name),
  );

const [t1, t2, t3] = [randomUUID(), randomUUID(), randomUUID()];
const fieldsJson = (...ids: string[]) =>
  JSON.stringify(
    ids.map((id) => ({
      projectNodeId: "PRJ_1",
      fieldNodeId: "F_A",
      optionNodeId: id,
    })),
  );
const digest = (c: string) => c.repeat(64);
/** The saved rule of the first project as stored before operators, and as re-encoded. */
const legacyRule = JSON.stringify({
  mode: "all",
  conditions: [{ kind: "label", name: "ready" }],
});
const operatorRule = JSON.stringify({
  mode: "all",
  conditions: [{ kind: "label", operator: "has", name: "ready" }],
});

/** A previous-schema database with every kind of source record, in two projects. */
function seededPreviousDatabase() {
  const world = previousSchemaDatabase(2);
  const { db } = world;
  const [p1, p2] = world.projectIds as [string, string];
  const task = (id: string, projectId: string, state: string) => {
    db.prepare("INSERT INTO tasks (id, projectId, title) VALUES (?, ?, ?)").run(
      id,
      projectId,
      `Task ${id}`,
    );
    db.prepare(
      "INSERT INTO domain_tasks (id, projectId, version, outcome, ready, state, importedBlockers) VALUES (?, ?, 1, 'Body', 0, ?, 'unknown')",
    ).run(id, projectId, state);
  };
  task(t1, p1, "open");
  task(t2, p1, "done");
  task(t3, p2, "open");
  const run = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);

  run(
    "INSERT INTO project_github_sources VALUES (?, 3, 'env:TOKEN', ?, ?, 'done')",
    p1,
    JSON.stringify([
      { id: "S-1", kind: "search", query: "is:open label:ready" },
      { id: "S-2", kind: "project", projectNodeId: "PRJ_1", filter: "" },
    ]),
    legacyRule,
  );
  run(
    "INSERT INTO project_github_sources VALUES (?, 1, NULL, '[]', 'null', 'skip')",
    p2,
  );
  run("INSERT INTO project_github_active VALUES (?, 'S-1', 3)", p1);
  run("INSERT INTO project_github_active VALUES (?, 'S-2', 2)", p1);
  run(
    "INSERT INTO github_sync_state VALUES (?, 'S-1', 1, NULL, '2026-10-01T00:00:00Z', ?)",
    p1,
    '["I_X","I_Y"]',
  );
  run(
    "INSERT INTO github_sync_state VALUES (?, 'S-2', 0, 'rate-limited', '2026-10-02T00:00:00Z', '[]')",
    p1,
  );
  run(
    "INSERT INTO github_sync_state VALUES (?, 'S-9', 1, NULL, '2026-10-03T00:00:00Z', '[]')",
    p2,
  );

  // Issues inserted out of key order, so a reader sorting by key differs from one reading by row.
  run(
    `INSERT INTO github_external_issues VALUES ('github.com', 'I_3', '${t3}', 'R_1', 'org/repo', 3, 'Third \u{1F680}', 'Body 3', 'open', '[]')`,
  );
  run(
    `INSERT INTO github_external_issues VALUES ('github.com', 'I_1', '${t1}', 'R_1', 'org/repo', 1, 'First', 'Body "1"', 'open', '["ready","bug"]')`,
  );
  run(
    `INSERT INTO github_external_issues VALUES ('github.com', 'I_2', '${t2}', 'R_2', 'org/other', 2, 'Second', '', 'closed', '[]')`,
  );
  run(
    "INSERT INTO github_memberships VALUES (?, 'S-1', 'I_1', ?, 'ITEM_1', 1700000000000, 0)",
    p1,
    fieldsJson("O_1"),
  );
  run(
    "INSERT INTO github_memberships VALUES (?, 'S-1', 'I_2', '[]', NULL, NULL, NULL)",
    p1,
  );
  run(
    "INSERT INTO github_memberships VALUES (?, 'S-9', 'I_3', ?, 'ITEM_3', 5, 1)",
    p2,
    fieldsJson("O_2"),
  );
  run(
    "INSERT INTO github_memberships VALUES (?, 'S-1', 'I_3', '[]', NULL, NULL, NULL)",
    p1,
  );
  run("INSERT INTO github_placement_decisions VALUES ('I_3', ?)", p2);
  run(
    "INSERT INTO github_native_blockers VALUES ('I_1', 'B_9', 'R_9', 'outside/repo', 9, 'open')",
  );
  run(
    "INSERT INTO github_native_blockers VALUES ('I_1', 'B_8', 'R_9', 'outside/repo', 8, 'closed')",
  );
  run(
    "INSERT INTO github_dependency_observations VALUES ('I_1', 1, NULL, '2026-10-01T00:00:00Z')",
  );
  run(
    "INSERT INTO github_dependency_observations VALUES ('I_2', 0, 'source-read-incomplete', '2026-10-02T00:00:00Z')",
  );
  run(
    "INSERT INTO github_source_reviews VALUES ('I_1', ?, ?, NULL, NULL)",
    digest("a"),
    digest("a"),
  );
  run(
    "INSERT INTO github_source_reviews VALUES ('I_2', ?, ?, NULL, NULL)",
    digest("b"),
    digest("c"),
  );
  run(
    "INSERT INTO github_source_reviews VALUES ('I_3', ?, ?, 'clarification', '2026-10-03T00:00:00Z')",
    digest("d"),
    digest("d"),
  );
  run("INSERT INTO github_source_holds VALUES ('I_2', 1, 'closed', 2)");
  run("INSERT INTO github_source_holds VALUES ('I_1', 0, 'withdrawn', 1)");
  run(
    `INSERT INTO github_imported_tasks VALUES ('${t3}', 'github.com', 'I_3', 'R_1')`,
  );
  run(
    `INSERT INTO github_imported_tasks VALUES ('${t1}', 'github.com', 'I_1', 'R_1')`,
  );
  run(
    `INSERT INTO github_imported_tasks VALUES ('${t2}', 'github.com', 'I_2', 'R_2')`,
  );
  run(
    "INSERT INTO github_issue_status VALUES ('I_1', 'open', NULL, '2026-10-01T00:00:00Z')",
  );
  run(
    "INSERT INTO github_issue_status VALUES ('I_2', 'closed', NULL, '2026-10-02T00:00:00Z')",
  );
  run(
    "INSERT INTO github_issue_status VALUES ('I_3', 'unknown', 'startup-refresh-required', '2026-10-03T00:00:00Z')",
  );
  run(
    "INSERT INTO github_delivery_closures VALUES ('I_2', 'op-2', 'PR_2', '{\"state\":\"closed\"}', 'EV_2')",
  );
  run(
    "INSERT INTO github_delivery_closures VALUES ('I_1', 'op-0', NULL, '{}', NULL)",
  );
  run(
    "INSERT INTO github_delivery_closure_supersessions VALUES ('I_1', 'op-0', '2026-10-04T00:00:00Z')",
  );
  run(
    `INSERT INTO github_provider_completions VALUES ('${t2}', 'I_2', '2026-10-02T00:00:00Z')`,
  );
  // Options and fields deliberately out of alphabetical order.
  run(
    "INSERT INTO github_project_fields VALUES ('PRJ_1', 'F_B', 'Status', ?)",
    JSON.stringify([
      { optionNodeId: "O_3", name: "Zeta" },
      { optionNodeId: "O_1", name: "Alpha" },
    ]),
  );
  run(
    "INSERT INTO github_project_fields VALUES ('PRJ_1', 'F_A', 'Area', ?)",
    JSON.stringify([{ optionNodeId: "O_2", name: "Core" }]),
  );
  return { ...world, p1, p2 };
}

const capturePrevious = (db: DatabaseSync) =>
  Object.fromEntries(
    previousSourceTables.map((table) => [
      table,
      rows(db, `SELECT * FROM ${table} ORDER BY rowid`),
    ]),
  );
const readNeutral = (db: DatabaseSync) =>
  Object.fromEntries(
    previousSourceTables.map((table) => [
      table,
      rows(db, `${neutralReads[table]} ORDER BY rowid`),
    ]),
  );

test("source records from the previous schema migrate once and read back identically", () => {
  const { db, domain, p1, p2 } = seededPreviousDatabase();
  try {
    const before = capturePrevious(db);
    for (const table of previousSourceTables)
      assert.ok((before[table] ?? []).length > 0, `${table} is seeded`);

    domain.migrate();

    // Every column moves byte for byte, except the readiness rule, which is re-encoded.
    const migrated = structuredClone(before);
    assert.equal(migrated.project_github_sources?.[0]?.readiness, legacyRule);
    (migrated.project_github_sources as Record<string, unknown>[])[0] = {
      ...migrated.project_github_sources?.[0],
      readiness: operatorRule,
    };
    assert.deepEqual(readNeutral(db), migrated);
    for (const table of neutralTables.filter(
      (name) =>
        name !== "project_active_selections" && name !== "source_sync_state",
    ))
      assert.deepEqual(
        rows(db, `SELECT DISTINCT provider, instance FROM ${table}`),
        [{ provider: "github", instance: "github.com" }],
        table,
      );
    assert.deepEqual(
      previousSourceTables.filter((table) => tableNames(db).includes(table)),
      [],
    );
    assert.deepEqual(rows(db, "PRAGMA foreign_key_check"), []);

    // Running again changes nothing.
    domain.migrate();
    new GitHubSourceStore(db).migrate();
    assert.deepEqual(readNeutral(db), migrated);

    const sources = new GitHubSourceStore(db);
    assert.deepEqual(domain.githubConfiguration(p1), {
      version: 3,
      credentialRef: "env:TOKEN",
      selections: [
        { id: "S-1", kind: "search", query: "is:open label:ready" },
        { id: "S-2", kind: "project", projectNodeId: "PRJ_1", filter: "" },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
      closedIssues: "done",
    });
    assert.equal(domain.githubConfiguration(p2).closedIssues, "skip");
    // The stale configuration version is not active.
    assert.deepEqual(domain.githubActiveSelectionIds(p1), ["S-1"]);
    assert.deepEqual(
      { ...sources.issue("I_1") },
      {
        providerInstance: "github.com",
        nodeId: "I_1",
        taskId: t1,
        repositoryId: "R_1",
        repositoryName: "org/repo",
        issueNumber: 1,
        observedTitle: "First",
        observedBody: 'Body "1"',
        observedState: "open",
        labels: '["ready","bug"]',
      },
    );
    assert.deepEqual(
      sources.memberships("I_3").map((row) => [row.projectId, row.selectionId]),
      [
        [p1, "S-1"],
        [p2, "S-9"],
      ],
    );
    assert.equal(
      sources.membershipItem(p1, "S-1", "I_1")?.itemNodeId,
      "ITEM_1",
    );
    assert.deepEqual(
      sources
        .nativeBlockers("I_1")
        .map((row) => [row.blockerNodeId, row.status]),
      [
        ["B_8", "closed"],
        ["B_9", "open"],
      ],
    );
    assert.deepEqual(
      { ...sources.hold("I_2") },
      { active: 1, reason: "closed", generation: 2 },
    );
    assert.deepEqual(sources.conflicts(), []);
    assert.deepEqual(
      sources.activeHolds().map((hold) => [hold.nodeId, hold.reason]),
      [["I_2", "closed"]],
    );
    assert.deepEqual(sources.deliveryClosure("I_2"), {
      operationId: "op-2",
      closedEventId: "EV_2",
    });
    assert.deepEqual(
      { ...domain.importedTask(t1) },
      {
        taskId: t1,
        provider: "github",
        instance: "github.com",
        providerInstance: "github.com",
        nodeId: "I_1",
        repositoryId: "R_1",
      },
    );
    assert.equal(domain.providerClosure(t2), "completed");
    assert.ok(domain.admission(t2).reasons.includes("source-hold"));
    // The superseded closure no longer counts as an own closure.
    const ownClosure = (nodeId: string) =>
      Number(
        (
          db
            .prepare(
              `SELECT ${effectiveOwnClosure(["?", "?", "?"])} AS present`,
            )
            .get(...itemKey(nodeId)) as { present: number }
        ).present,
      );
    assert.deepEqual([ownClosure("I_1"), ownClosure("I_2")], [0, 1]);
    assert.equal(
      Number(
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM source_closures c WHERE ${effectiveOwnClosure(itemColumns("c"))}`,
            )
            .get() as { n: number }
        ).n,
      ),
      1,
    );
    assert.deepEqual(
      projectFieldNames(db, ["PRJ_1"]).map((field) => [
        field.fieldNodeId,
        field.options.map((option) => option.optionNodeId),
      ]),
      [
        ["F_B", ["O_3", "O_1"]],
        ["F_A", ["O_2"]],
      ],
    );
  } finally {
    db.close();
  }
});

test("a failed source migration leaves every previous table and row in place", () => {
  const { db, domain, p1 } = seededPreviousDatabase();
  try {
    const before = capturePrevious(db);
    // A membership of an issue that no longer exists, which only a corrupt database holds.
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO github_memberships VALUES (?, 'S-1', 'I_GONE', '[]', NULL, NULL, NULL)",
    ).run(p1);
    db.exec("PRAGMA foreign_keys = ON");
    const corrupt = capturePrevious(db);

    assert.throws(() => domain.migrate(), /FOREIGN KEY/);

    assert.deepEqual(capturePrevious(db), corrupt);
    assert.notDeepEqual(corrupt, before);
    assert.deepEqual(
      neutralTables.filter((table) => tableNames(db).includes(table)),
      [],
    );
  } finally {
    db.close();
  }
});

test("upgrading re-encodes readiness conditions without changing Ready, versions, holds or rule identity", () => {
  const { db, domain, p1 } = seededPreviousDatabase();
  try {
    const field = {
      kind: "project-field",
      projectNodeId: "PRJ_1",
      fieldNodeId: "F_A",
    };
    const legacy = {
      mode: "any",
      conditions: [
        { kind: "label", name: "ready" },
        { ...field, optionNodeId: "O_2" },
      ],
    };
    const stale = { mode: "all", conditions: [{ kind: "label", name: "old" }] };
    const upgraded = JSON.stringify({
      mode: "any",
      conditions: [
        { kind: "label", operator: "has", name: "ready" },
        { ...field, operator: "in", optionNodeIds: ["O_2"] },
      ],
    });
    const staleUpgraded = JSON.stringify({
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "old" }],
    });
    db.prepare(
      "UPDATE project_github_sources SET readiness = ? WHERE projectId = ?",
    ).run(JSON.stringify(legacy), p1);
    // Snapshots as the previous release stored them: equal to the rule, stale, and unreadable.
    for (const [id, text] of [
      [t1, JSON.stringify(legacy)],
      [t2, JSON.stringify(stale)],
      [t3, "not json"],
    ] as const)
      db.prepare("UPDATE domain_tasks SET readinessRule = ? WHERE id = ?").run(
        text,
        id,
      );
    const snapshot = (id: string) =>
      db.prepare("SELECT readinessRule FROM domain_tasks WHERE id = ?").get(id)
        ?.readinessRule;
    const saved = (table: string) =>
      db.prepare(`SELECT readiness FROM ${table} WHERE projectId = ?`).get(p1)
        ?.readiness;
    const tasks = () =>
      rows(
        db,
        "SELECT id, version, ready, state FROM domain_tasks ORDER BY id",
      );
    const holds = (table: string, key: string) =>
      rows(
        db,
        `SELECT ${key} AS nodeId, active, reason, generation FROM ${table} ORDER BY ${key}`,
      );
    const tasksBefore = tasks();
    const holdsBefore = holds("github_source_holds", "nodeId");
    assert.ok(holdsBefore.length > 0);

    // A failure partway through keeps every legacy text.
    db.exec(
      "CREATE TEMP TRIGGER refuse_snapshot BEFORE UPDATE OF readinessRule ON domain_tasks BEGIN SELECT RAISE(ABORT, 'snapshot refused'); END",
    );
    assert.throws(() => domain.migrate(), /snapshot refused/);
    assert.equal(saved("project_github_sources"), JSON.stringify(legacy));
    assert.equal(snapshot(t1), JSON.stringify(legacy));
    assert.equal(snapshot(t2), JSON.stringify(stale));
    db.exec("DROP TRIGGER refuse_snapshot");

    for (let pass = 0; pass < 2; pass++) {
      domain.migrate();
      assert.equal(saved("project_task_sources"), upgraded);
      // Equal texts stay equal, the stale one stays different, an unreadable one is untouched.
      assert.equal(snapshot(t1), upgraded);
      assert.equal(snapshot(t2), staleUpgraded);
      assert.equal(snapshot(t3), "not json");
      assert.deepEqual(tasks(), tasksBefore);
      assert.deepEqual(holds("source_holds", "externalId"), holdsBefore);
    }
  } finally {
    db.close();
  }
});
