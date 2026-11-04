import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import {
  GitHubSourceStore,
  type IssueSnapshot,
} from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { GitHubSynchronizer } from "../../src/standalone/github-sync.js";

const issue: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_archived_owner",
  repositoryId: "R_shared",
  repositoryName: "org/shared",
  number: 1,
  title: "Original",
  body: "Original body",
  state: "open",
  labels: [],
  projectFields: [],
};

function world(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  t.after(() => db.close());
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  const create = (name: string) => {
    const projectId = randomUUID();
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
      projectId,
      expectedVersion: 1,
      credentialRef: "env:ARCHIVED_SOURCE_FIXTURE",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_shared",
          owner: "org",
          name: "shared",
        },
      ],
      readiness: null,
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    return projectId;
  };
  const projectId = create("Owner"),
    other = create("Other");
  const binding = () => ({
    projectId,
    configVersion: 2,
    credentialRef: "env:ARCHIVED_SOURCE_FIXTURE",
    projectVersion: Number(domain.project(projectId).version),
  });
  const read = (owner = projectId, next = issue) =>
    sources.reconcileSelection(owner, "repo", {
      complete: true,
      issues: [next],
      reason: null,
    });
  const freeze = () =>
    db
      .prepare(
        "UPDATE domain_projects SET archived = 1, version = version + 1 WHERE id = ?",
      )
      .run(projectId);
  return { db, domain, sources, projectId, other, binding, read, freeze };
}

test("a late selection commit is refused after archive and remains stale after restore", (t) => {
  const w = world(t),
    binding = w.binding();
  w.freeze();
  assert.equal(
    w.sources.reconcileSelection(
      w.projectId,
      "repo",
      { complete: true, issues: [issue], reason: null },
      binding,
    ),
    false,
  );
  assert.equal(w.sources.issue(issue.nodeId), undefined);
  w.db
    .prepare(
      "UPDATE domain_projects SET archived = 0, paused = 1, version = version + 1 WHERE id = ?",
    )
    .run(w.projectId);
  assert.equal(
    w.sources.reconcileSelection(
      w.projectId,
      "repo",
      { complete: true, issues: [issue], reason: null },
      binding,
    ),
    false,
  );
  assert.ok(
    w.sources.reconcileSelection(
      w.projectId,
      "repo",
      { complete: true, issues: [issue], reason: null },
      w.binding(),
    ),
  );
});

test("an active project's shared selection cannot change archived-owner task text, brief or frozen memberships", (t) => {
  const w = world(t);
  w.read();
  const imported = w.sources.issue(issue.nodeId);
  assert.ok(imported);
  const taskId = String(imported.taskId),
    before = w.domain.task(taskId);
  const memberships = w.sources
    .memberships(issue.nodeId)
    .filter((m) => m.projectId === w.projectId);
  const brief = w.sources.issueBrief(taskId);
  w.freeze();
  assert.ok(
    w.read(w.other, {
      ...issue,
      title: "Outside change",
      body: "Outside body",
      labels: ["new"],
    }),
  );
  assert.deepEqual(w.domain.task(taskId), before);
  assert.deepEqual(w.sources.issue(issue.nodeId), imported);
  assert.deepEqual(w.sources.issueBrief(taskId), brief);
  assert.deepEqual(
    w.sources
      .memberships(issue.nodeId)
      .filter((m) => m.projectId === w.projectId),
    memberships,
  );
  assert.ok(
    w.sources.memberships(issue.nodeId).some((m) => m.projectId === w.other),
  );
  assert.equal(
    w.sources.reconcileIssueBrief(issue.nodeId, {
      complete: true,
      comments: [],
      reason: null,
    }),
    false,
  );
  assert.equal(
    w.sources.reconcileBlockers(issue.nodeId, {
      complete: true,
      blockers: [],
      reason: null,
    }),
    false,
  );
  w.sources.invalidateProviderObservations();
  assert.deepEqual(w.domain.task(taskId), before);
  assert.deepEqual(
    w.sources
      .memberships(issue.nodeId)
      .filter((m) => m.projectId === w.projectId),
    memberships,
  );
});

test("the GitHub driver captures lifecycle before awaiting a read and skips archived projects on the next pass", async (t) => {
  const w = world(t);
  // This case has one active selection, so only its deliberately held read can commit.
  w.db
    .prepare("UPDATE domain_projects SET archived = 1 WHERE id = ?")
    .run(w.other);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  const synchronizer = new GitHubSynchronizer(w.domain, w.sources, () => ({
    readSelection: async () => {
      reads++;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { complete: true as const, issues: [issue], reason: null };
    },
    readBlockers: async () => ({ complete: true, blockers: [], reason: null }),
    readIssueStatus: async () => ({ status: "open" as const }),
  }));
  const pending = synchronizer.refresh();
  await entered;
  w.freeze();
  // Restore before read completion: archived alone is not a sufficient stale-read fence.
  w.db
    .prepare(
      "UPDATE domain_projects SET archived = 0, version = version + 1 WHERE id = ?",
    )
    .run(w.projectId);
  release();
  await pending;
  assert.equal(w.sources.issue(issue.nodeId), undefined);
  w.freeze();
  await synchronizer.refresh();
  assert.equal(reads, 1);
  await synchronizer.stop();
});

test("archived source completion and closure mutation entry points are read-only without changing closure proof semantics", (t) => {
  const w = world(t);
  w.read();
  const imported = w.sources.issue(issue.nodeId);
  assert.ok(imported);
  const taskId = String(imported.taskId),
    before = w.domain.task(taskId);
  w.freeze();
  const closures = w.db.prepare("SELECT * FROM source_closures").all();
  const holds = w.db.prepare("SELECT * FROM source_holds").all();
  w.sources.updateReadiness(taskId);
  assert.equal(
    w.sources.completeFromProviderClosure(taskId, () => true),
    false,
  );
  assert.equal(
    w.sources.recordDeliveryClosure(
      w.projectId,
      2,
      { ...issue, state: "closed" },
      randomUUID(),
      null,
      null,
    ),
    false,
  );
  w.sources.recordDeliveryClosureUnavailable(issue.nodeId);
  w.sources.recordDeliveryClosureAttributionUnproved(issue.nodeId);
  w.sources.supersedeDeliveryClosure(issue.nodeId, randomUUID());
  assert.deepEqual(w.domain.task(taskId), before);
  assert.deepEqual(w.sources.issue(issue.nodeId), imported);
  assert.deepEqual(
    w.db.prepare("SELECT * FROM source_closures").all(),
    closures,
  );
  assert.deepEqual(w.db.prepare("SELECT * FROM source_holds").all(), holds);
  assert.deepEqual(
    w.db.prepare("SELECT * FROM source_closure_supersessions").all(),
    [],
  );
});

for (const stage of ["selection", "brief"] as const)
  test(`the Jira driver discards a ${stage} read crossing archive and restore and resumes only from a fresh version`, async (t) => {
    const { JiraSynchronizer } = await import(
      "../../src/standalone/jira-sync.js"
    );
    const { JiraSourceReader } = await import(
      "../../src/standalone/jira-source.js"
    );
    const w = world(t),
      instance = "archive-fixture.atlassian.net";
    w.db
      .prepare("UPDATE domain_projects SET archived=1 WHERE id=?")
      .run(w.other);
    w.domain.execute({
      type: "issue-tracker-credential.configure",
      actor: "operator",
      key: randomUUID(),
      issueTracker: "jira",
      instance,
      credential: {
        siteRef: "env:ARCHIVE_JIRA_SITE",
        emailRef: "env:ARCHIVE_JIRA_EMAIL",
        tokenRef: "env:ARCHIVE_JIRA_TOKEN",
      },
    });
    w.domain.execute({
      type: "jira.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      expectedVersion: 2,
      instance,
      selections: [{ id: "jql", kind: "jql", jql: "project = ARCH" }],
      readiness: null,
    });
    w.domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      selectionId: "jql",
      expectedVersion: 3,
    });
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = true,
      reads = 0;
    const reader = new JiraSourceReader(() => {
      throw new Error("No live Jira access is permitted in this fixture");
    });
    reader.readSelection = async () => {
      reads++;
      if (held && stage === "selection") {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {
        complete: true,
        issues: [{ ...issue, providerInstance: instance, projectFields: [] }],
        reason: null,
      };
    };
    reader.readIssueComments = async () => {
      if (held && stage === "brief") {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {
        complete: true,
        comments: ["## Agent Brief\nLate Jira brief"],
        reason: null,
      };
    };
    const sources = w.sources.forTracker({ provider: "jira", instance });
    const synchronizer = new JiraSynchronizer(
      w.domain,
      () => sources,
      () => reader,
    );
    const pending = synchronizer.refresh();
    await started;
    const priorIssue = sources.issue(issue.nodeId);
    const priorBrief = priorIssue
      ? sources.issueBrief(String(priorIssue.taskId))
      : undefined;
    w.freeze();
    w.db
      .prepare(
        "UPDATE domain_projects SET archived=0,version=version+1 WHERE id=?",
      )
      .run(w.projectId);
    release();
    await pending;
    assert.deepEqual(sources.issue(issue.nodeId), priorIssue);
    if (priorIssue)
      assert.deepEqual(
        sources.issueBrief(String(priorIssue.taskId)),
        priorBrief,
      );
    held = false;
    await synchronizer.refresh();
    assert.ok(sources.issue(issue.nodeId));
    assert.equal(reads, 2);
    await synchronizer.stop();
  });

for (const stage of ["blockers", "brief"] as const)
  test(`a delayed GitHub ${stage} read cannot rewrite frozen history after archive and restore`, async (t) => {
    const w = world(t);
    w.db
      .prepare("UPDATE domain_projects SET archived=1 WHERE id=?")
      .run(w.other);
    w.read();
    const taskId = String(w.sources.issue(issue.nodeId)!.taskId);
    w.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      taskId,
      expectedVersion: Number(w.domain.task(taskId).version),
      ready: true,
    });
    let release!: () => void, enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const wait = async () => {
      enter();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const synchronizer = new GitHubSynchronizer(w.domain, w.sources, () => ({
      readSelection: async () => ({
        complete: true,
        issues: [issue],
        reason: null,
      }),
      readBlockers: async () => {
        if (stage === "blockers") await wait();
        return { complete: true, blockers: [], reason: null };
      },
      readIssueComments: async () => {
        if (stage === "brief") await wait();
        return {
          complete: true,
          comments: ["## Agent Brief\nLate private brief"],
          reason: null,
        };
      },
      readIssueStatus: async () => ({ status: "open" as const }),
    }));
    const pending = synchronizer.refresh();
    await entered;
    w.freeze();
    w.db
      .prepare(
        "UPDATE domain_projects SET archived=0,paused=1,version=version+1 WHERE id=?",
      )
      .run(w.projectId);
    const snapshot = () =>
      JSON.stringify([
        w.domain.task(taskId),
        w.sources.issue(issue.nodeId),
        w.sources.issueBrief(taskId),
        w.db.prepare("SELECT * FROM source_native_blockers").all(),
      ]);
    const before = snapshot();
    release();
    await pending;
    assert.equal(snapshot(), before);
    await synchronizer.stop();
  });
