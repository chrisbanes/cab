import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type DomainCommand, DomainStore } from "../../src/core/domain.js";
import { syncDependencyRecords } from "../../src/core/stacked-dependencies.js";
import { Store } from "../../src/core/store.js";

const p = "10000000-0000-4000-8000-000000000001";
const lead = "20000000-0000-4000-8000-000000000001";
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(
  (n) => `30000000-0000-4000-8000-00000000000${n}`,
) as [string, string, string, string, string];
const head = (c: string) => c.repeat(40);
let serial = 0;
const key = () =>
  `50000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "cab-stack-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "db.sqlite"));
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({ ...command, key: key() } as DomainCommand);
  run({
    type: "profile.create",
    actor: "operator",
    profileId: lead,
    name: "Lead",
    instructions: "Lead",
    capabilities: "lead",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId: p,
    name: "Project",
    leadProfileId: lead,
  });
  run({
    type: "project.configure",
    actor: "operator",
    projectId: p,
    expectedVersion: Number(domain.project(p).version),
    paused: false,
  });
  db.prepare(
    "UPDATE project_repository_links SET links = ? WHERE projectId = ?",
  ).run(
    JSON.stringify(
      ["R1", "R2"].map((repositoryId) => ({
        repositoryId,
        path: `/tmp/${repositoryId}`,
        ref: "main",
        gitCommonDirectory: `/tmp/${repositoryId}/.git`,
        codeHost: "github",
        host: "github.com",
      })),
    ),
    p,
  );
  for (const taskId of [A, B, C, D, E])
    run({
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId,
      title: taskId,
      outcome: "Work",
      ready: true,
    });
  const version = (taskId: string) => Number(domain.task(taskId).version);
  const depend = (taskId: string, blockerTaskId: string) =>
    run({
      type: "dependency.add",
      actor: "operator",
      projectId: p,
      taskId,
      blockerTaskId,
      expectedVersion: version(taskId),
    });
  const stacking = (enabled: boolean) =>
    run({
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: Number(domain.project(p).version),
      stacking: enabled,
    });
  /** The blocker's task branch at its last push, and its PR observation. */
  const publish = (
    taskId: string,
    options: {
      repositoryId?: string;
      pushed?: string | null;
      prHead?: string;
      state?: "OPEN" | "CLOSED" | "MERGED";
      readError?: string | null;
      outside?: string | null;
      headRef?: string;
    } = {},
  ) => {
    const repositoryId = options.repositoryId ?? "R1";
    const pushed = options.pushed === undefined ? head("a") : options.pushed;
    db.prepare(
      "INSERT INTO delivery_task_branches VALUES (?,?,?,?,?,?) ON CONFLICT(taskId,repositoryId) DO UPDATE SET lastPushedSha=excluded.lastPushedSha, outsideHeadSha=excluded.outsideHeadSha",
    ).run(
      taskId,
      repositoryId,
      `cab/${taskId}`,
      pushed,
      options.outside ?? null,
      Date.now(),
    );
    db.prepare(
      "INSERT INTO delivery_pr_bindings VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET recordJson=excluded.recordJson",
    ).run(
      taskId,
      JSON.stringify({
        taskId,
        projectId: p,
        leadAssignmentId: "60000000-0000-4000-8000-000000000001",
        registeredWorkId: "work",
        revision: 1,
        mode: "reviewable-pr",
        observation: {
          repositoryId,
          nodeId: `PR-${taskId}`,
          number: 1,
          baseRef: "main",
          headRef: options.headRef ?? `cab/${taskId}`,
          headSha: options.prHead ?? pushed ?? head("f"),
          baseSha: head("0"),
          state: options.state ?? "OPEN",
          draft: false,
          merged: options.state === "MERGED",
          reviewDecision: null,
          checks: [],
          mergeBlockers: [],
          closedIssueNodeIds: [],
          allowedMethods: ["squash"],
        },
        observationDigest: "0".repeat(64),
        observedAt: 1,
        readError: options.readError ?? null,
        settlement: null,
      }),
    );
  };
  const reasons = (taskId: string) => domain.admission(taskId).reasons;
  return { db, domain, run, depend, stacking, publish, reasons, version };
}

test("a local single-blocker dependent starts on its blocker's open PR at its last push", (t) => {
  const f = fixture(t);
  f.depend(D, B);
  assert.equal(f.domain.stacking(p), false, "off by default");
  assert.equal(f.domain.stackFacts(D)?.repositoryId, null, "no PR yet");
  f.publish(B);
  assert.deepEqual(f.domain.stackFacts(D), {
    state: "waiting",
    reason: "stacking-off",
    blockerTaskId: B,
    repositoryId: "R1",
    parentHead: null,
    restack: null,
  });
  assert.deepEqual(f.reasons(D), ["local-dependency"], "today's behaviour");
  f.stacking(true);
  assert.equal(f.domain.stacking(p), true);
  assert.deepEqual(f.domain.stackFacts(D), {
    state: "stacked",
    reason: null,
    blockerTaskId: B,
    repositoryId: "R1",
    parentHead: null,
    restack: null,
  });
  assert.deepEqual(f.domain.admission(D), { eligible: true, reasons: [] });
  assert.deepEqual(f.domain.recordStackedDependency(D), {
    blockerTaskId: B,
    repositoryId: "R1",
    parentHead: head("a"),
    restack: "current",
  });
  f.stacking(false);
  assert.equal(f.domain.stackFacts(D)?.state, "stacked", "recorded stays");
  assert.deepEqual(f.reasons(D), []);
  // Removing the edge removes its records.
  f.run({
    type: "dependency.remove",
    actor: "operator",
    projectId: p,
    taskId: D,
    blockerTaskId: B,
    expectedVersion: f.version(D),
  });
  assert.equal(f.domain.stackedDependency(D), null);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM task_dependency_records").get()?.n,
    0,
  );
  assert.equal(f.domain.stackFacts(D), null);
});

test("an unpublished or unknown blocker keeps a stacked dependent waiting", (t) => {
  const f = fixture(t);
  f.stacking(true);
  f.depend(D, B);
  const expect = (reason: string, label: string) => {
    assert.deepEqual(f.reasons(D), [`stacked-blocker-${reason}`], label);
    assert.equal(f.domain.stackFacts(D)?.reason, `blocker-${reason}`, label);
    assert.throws(() => f.domain.recordStackedDependency(D), /waiting/, label);
  };
  expect("unpublished", "no PR");
  f.publish(B, { prHead: head("b") });
  expect("unpublished", "PR head is not the last push");
  f.publish(B, { pushed: null });
  expect("unpublished", "never pushed");
  f.publish(B, { state: "CLOSED" });
  expect("unpublished", "closed PR");
  f.publish(B, { headRef: "other" });
  expect("unpublished", "PR is not the task branch");
  f.publish(B, { readError: "provider-unavailable" });
  expect("unknown", "PR read failed");
  f.publish(B, { outside: head("c") });
  expect("unknown", "branch moved outside cab");
  f.publish(B);
  assert.deepEqual(f.reasons(D), []);
  // Other controls still apply.
  f.run({
    type: "project.configure",
    actor: "operator",
    projectId: p,
    expectedVersion: Number(f.domain.project(p).version),
    paused: true,
  });
  assert.deepEqual(f.reasons(D), ["project-paused"]);
  f.run({
    type: "project.configure",
    actor: "operator",
    projectId: p,
    expectedVersion: Number(f.domain.project(p).version),
    paused: false,
  });
  f.run({
    type: "task.configure",
    actor: "operator",
    projectId: p,
    taskId: D,
    expectedVersion: f.version(D),
    ready: false,
  });
  assert.deepEqual(f.reasons(D), ["task-unready"]);
  // A Done blocker no longer blocks, so nothing stacks.
  f.run({
    type: "task.configure",
    actor: "operator",
    projectId: p,
    taskId: B,
    expectedVersion: f.version(B),
    state: "done",
  });
  assert.equal(f.domain.stackFacts(D), null);
});

test("only linear same-repository chains stack; other shapes wait with their reason", (t) => {
  const f = fixture(t);
  f.stacking(true);
  f.publish(A);
  f.publish(B);
  // Two blockers.
  f.depend(C, A);
  f.depend(C, B);
  assert.equal(f.domain.stackFacts(C)?.reason, "multiple-blockers");
  assert.deepEqual(f.reasons(C), ["local-dependency"]);
  // Siblings: the first recorded edge wins until one is recorded.
  f.depend(D, B);
  f.depend(E, B);
  assert.equal(f.domain.stackFacts(D)?.state, "stacked");
  assert.equal(f.domain.stackFacts(E)?.reason, "sibling-stacked");
  assert.deepEqual(f.reasons(E), ["local-dependency"]);
  f.domain.recordStackedDependency(D);
  assert.equal(f.domain.stackFacts(E)?.reason, "sibling-stacked");
  assert.equal(f.domain.recordStackedDependency(E), null);
  // A blocker working in another repository than the dependent's.
  f.db
    .prepare(
      "UPDATE project_repository_links SET links = json_remove(links, '$[1]') WHERE projectId = ?",
    )
    .run(p);
  f.publish(A, { repositoryId: "R2" });
  f.run({
    type: "dependency.remove",
    actor: "operator",
    projectId: p,
    taskId: C,
    blockerTaskId: B,
    expectedVersion: f.version(C),
  });
  assert.equal(f.domain.stackFacts(C)?.reason, "cross-repository");
  assert.deepEqual(f.reasons(C), ["local-dependency"]);
  // Stacking off: the waiting shapes have no stack facts.
  f.stacking(false);
  assert.equal(f.domain.stackFacts(C), null);
  assert.equal(f.domain.stackFacts(E), null);
});

test("a dependent that already has a workspace is never newly stacked", (t) => {
  const f = fixture(t);
  f.stacking(true);
  f.depend(D, B);
  f.publish(B);
  f.db.exec(
    "CREATE TABLE IF NOT EXISTS task_workspace_bindings (taskId TEXT PRIMARY KEY)",
  );
  f.db.prepare("INSERT INTO task_workspace_bindings VALUES (?)").run(D);
  assert.equal(f.domain.stackFacts(D)?.reason, "dependent-started");
  assert.deepEqual(f.reasons(D), ["local-dependency"]);
  assert.equal(f.domain.recordStackedDependency(D), null);
});

test("imported native edges stack only between same-project tasks", (t) => {
  const f = fixture(t);
  f.stacking(true);
  const item = (taskId: string, nodeId: string) => {
    f.domain.markImportedTask(taskId, nodeId, "R1");
    f.db
      .prepare(
        "INSERT INTO external_items (provider, instance, externalId, taskId, containerId, containerName, number, observedTitle, observedBody, observedState, labels) VALUES ('github', 'github.com', ?, ?, 'R1', 'o/r', 1, 't', 'b', 'open', '[]')",
      )
      .run(nodeId, taskId);
    f.db
      .prepare(
        "INSERT INTO external_item_status (provider, instance, externalId, status, refreshedAt) VALUES ('github', 'github.com', ?, 'open', 'now')",
      )
      .run(nodeId);
  };
  item(D, "I_D");
  item(B, "I_B");
  const blockedBy = (nodeId: string) => {
    f.db
      .prepare(
        "INSERT INTO source_native_blockers VALUES ('github', 'github.com', 'I_D', ?, 'R1', 'o/r', 2, 'open')",
      )
      .run(nodeId);
    syncDependencyRecords(f.db, D);
  };
  const importedBlockers = (state: string) =>
    f.db
      .prepare("UPDATE domain_tasks SET importedBlockers = ? WHERE id = ?")
      .run(state, D);
  importedBlockers("blocked");
  blockedBy("I_B");
  f.publish(B);
  assert.equal(f.domain.stackFacts(D)?.state, "stacked");
  assert.ok(!f.reasons(D).includes("imported-blockers-blocked"));
  assert.ok(!f.reasons(D).some((r) => r.startsWith("stacked-")));
  // A second native blocker that is not a task in the project.
  f.db.prepare("DELETE FROM source_native_blockers").run();
  blockedBy("I_OUTSIDE");
  assert.equal(f.domain.stackFacts(D)?.reason, "outside-project");
  assert.ok(f.reasons(D).includes("imported-blockers-blocked"));
  blockedBy("I_B");
  assert.equal(f.domain.stackFacts(D)?.reason, "multiple-blockers");
  // Unknown imported-blocker state holds with the unknown reason.
  importedBlockers("unknown");
  assert.equal(f.domain.stackFacts(D)?.reason, "blocker-unknown");
  assert.ok(f.reasons(D).includes("imported-blockers-unknown"));
});

test("restack reconcile queues once per blocker head and advances after the dependent's push", (t) => {
  const f = fixture(t);
  f.stacking(true);
  f.depend(D, B);
  f.publish(B);
  f.domain.recordStackedDependency(D);
  f.domain.ensureLeadAssignment(D);
  const queued: string[] = [];
  const advanced: string[] = [];
  const reconcile = () =>
    f.domain.reconcileRestacks({
      queue: (_task, _reason, identity) => queued.push(identity),
      advance: (_task, _repo, commit) => advanced.push(commit),
    });
  reconcile();
  assert.deepEqual(queued, [], "head unchanged");
  f.publish(B, { pushed: head("b") });
  reconcile();
  reconcile();
  assert.deepEqual(queued, [`restack:R1:${head("b")}`]);
  assert.equal(f.domain.stackFacts(D)?.restack, "pending");
  assert.equal(f.domain.stackFacts(D)?.parentHead, head("b"));
  f.publish(D, { pushed: head("d") });
  reconcile();
  assert.deepEqual(advanced, [head("b")]);
  assert.equal(f.domain.stackFacts(D)?.restack, "current");
  // A Done blocker queues nothing.
  f.run({
    type: "task.configure",
    actor: "operator",
    projectId: p,
    taskId: B,
    expectedVersion: f.version(B),
    state: "done",
  });
  f.publish(B, { pushed: head("c") });
  reconcile();
  assert.equal(queued.length, 1);
});
