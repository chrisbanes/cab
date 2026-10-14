import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainPolicyError, DomainStore } from "../../src/core/domain.js";
import { GitHubSourceStore } from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { LocalOperatorUi } from "../../src/standalone/operator.js";
import type { IssueSnapshot } from "../../src/standalone/github-source.js";

const issue: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Imported issue",
  body: "Ship this",
  state: "open",
  labels: ["ready"],
  projectFields: [
    { projectNodeId: "P_1", fieldNodeId: "F_1", optionNodeId: "O_1" },
  ],
};

test("overlapping complete selections converge on one imported task; partial reads retain memberships", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-reconcile-"));
  const file = join(root, "db.sqlite");
  const projectId = randomUUID();
  let db = new DatabaseSync(file);
  try {
    new Store(db).ensureHost("test");
    let domain = new DomainStore(db);
    domain.migrate();
    let sources = new GitHubSourceStore(db);
    sources.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
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
        { id: "search", kind: "search", query: "repo:org/repo" },
        {
          id: "project",
          kind: "project",
          projectNodeId: "P_1",
          filter: "status:ready",
        },
      ],
      readiness: {
        mode: "all",
        conditions: [
          { kind: "label", name: "ready" },
          {
            kind: "project-field",
            projectNodeId: "P_1",
            fieldNodeId: "F_1",
            optionNodeId: "O_1",
          },
        ],
      },
      repositories: [],
    });
    for (const selectionId of ["repo", "search", "project"])
      domain.execute({
        type: "github.activate",
        actor: "operator",
        key: randomUUID(),
        projectId,
        selectionId,
        expectedVersion: 2,
      });
    for (const selectionId of ["repo", "search", "project"])
      sources.reconcileSelection(projectId, selectionId, {
        complete: true,
        issues: [issue],
        reason: null,
      });
    const imported = sources.issue("I_1");
    assert.equal(imported?.providerInstance, "github.com");
    assert.deepEqual(
      sources.memberships("I_1").map((membership) => membership.selectionId),
      ["project", "repo", "search"],
    );
    assert.equal(domain.tasks(projectId).length, 1);
    assert.equal(domain.tasks(projectId)[0]?.ready, 1);
    const importedVersion = Number(
      domain.task(String(imported?.taskId)).version,
    );
    assert.throws(
      () =>
        domain.execute({
          type: "task.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          taskId: String(imported?.taskId),
          expectedVersion: importedVersion,
          ready: false,
        }),
      /imported.*provider/i,
    );
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, state: "closed" }],
      reason: null,
    });
    assert.equal(domain.task(String(imported?.taskId)).ready, 0);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, labels: [] }],
      reason: null,
    });
    assert.equal(domain.task(String(imported?.taskId)).ready, 0);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    assert.equal(domain.task(String(imported?.taskId)).ready, 1);
    sources.reconcileSelection(projectId, "repo", {
      complete: false,
      issues: [],
      reason: "http-403",
    });
    assert.equal(sources.memberships("I_1").length, 3);
    assert.equal(sources.syncState(projectId, "repo")?.complete, 0);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [],
      reason: null,
    });
    assert.equal(sources.memberships("I_1").length, 2);
    const localId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local",
      outcome: "Keep local",
      ready: true,
    });
    sources.reconcileSelection(projectId, "search", {
      complete: true,
      issues: [],
      reason: null,
    });
    sources.reconcileSelection(projectId, "project", {
      complete: true,
      issues: [],
      reason: null,
    });
    assert.equal(sources.memberships("I_1").length, 0);
    assert.equal(domain.task(String(imported?.taskId)).ready, 0);
    assert.equal(domain.task(localId).ready, 1);
    db.close();
    db = new DatabaseSync(file);
    new Store(db).ensureHost("test");
    domain = new DomainStore(db);
    domain.migrate();
    sources = new GitHubSourceStore(db);
    sources.migrate();
    assert.equal(sources.issue("I_1")?.taskId, imported?.taskId);
    assert.equal(domain.tasks(projectId).length, 2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unowned cross-project overlap waits for operator placement; assigned task keeps its chosen project", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-placement-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const first = randomUUID();
  const second = randomUUID();
  const profileId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    domain.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: "Lead",
      instructions: "Lead",
      capabilities: "work",
    });
    for (const projectId of [first, second]) {
      domain.execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        name: projectId,
        leadProfileId: profileId,
      });
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
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
          conditions: [
            {
              kind: "label",
              name: projectId === first ? "ready" : "approved-for-second",
            },
          ],
        },
        repositories: [],
      });
      domain.execute({
        type: "github.activate",
        actor: "operator",
        key: randomUUID(),
        projectId,
        selectionId: "repo",
        expectedVersion: 2,
      });
      sources.reconcileSelection(projectId, "repo", {
        complete: true,
        issues: [issue],
        reason: null,
      });
    }
    const taskId = String(sources.issue("I_1")?.taskId);
    assert.equal(domain.tasks(first).length, 1);
    assert.equal(domain.tasks(second).length, 0);
    assert.equal(sources.conflicts().length, 1);
    assert.ok(
      domain.admission(taskId).reasons.includes("source-placement-conflict"),
    );
    const originalProjectConfigure = {
      type: "task.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId: first,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      state: "open" as const,
    };
    const originalConfigureReceipt = domain.execute(originalProjectConfigure);
    assert.deepEqual(
      domain.execute(originalProjectConfigure),
      originalConfigureReceipt,
    );
    const blockerTaskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: first,
      taskId: blockerTaskId,
      title: "Local blocker",
      outcome: "Remain in the original project",
      ready: true,
    });
    const originalDependencyRemoval = {
      type: "dependency.remove" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId: first,
      taskId,
      blockerTaskId,
      expectedVersion: Number(domain.task(taskId).version),
    };
    const originalDependencyReceipt = domain.execute(originalDependencyRemoval);
    assert.deepEqual(
      domain.execute(originalDependencyRemoval),
      originalDependencyReceipt,
    );
    const version = Number(domain.task(taskId).version);
    assert.throws(
      () =>
        domain.execute({
          type: "github.place",
          actor: "agent",
          key: randomUUID(),
          projectId: first,
          taskId,
          chosenProjectId: second,
          expectedVersion: version,
        }),
      /operator/i,
    );
    const ui = new LocalOperatorUi(domain, undefined, sources);
    const html = ui.project(first, "test-csrf");
    assert.match(html, /data-command="github.place"/);
    assert.match(html, new RegExp(`name="taskId"[^>]*value="${taskId}"`));
    assert.match(html, /name="chosenProjectId"/);
    await ui.submit({
      type: "github.place",
      key: randomUUID(),
      projectId: first,
      taskId,
      chosenProjectId: second,
      expectedVersion: String(version),
    });
    assert.throws(
      () => domain.execute(originalProjectConfigure),
      (error) =>
        error instanceof DomainPolicyError &&
        error.code === "forbidden" &&
        error.message === "Task belongs to another project",
    );
    assert.throws(
      () => domain.execute(originalDependencyRemoval),
      (error) =>
        error instanceof DomainPolicyError &&
        error.code === "forbidden" &&
        error.message === "Task belongs to another project",
    );
    await assert.rejects(
      () =>
        ui.submit({
          type: "github.place",
          key: randomUUID(),
          projectId: first,
          taskId,
          chosenProjectId: second,
          expectedVersion: String(version),
        }),
      /project|version/i,
    );
    assert.equal(sources.conflicts().length, 0);
    assert.equal(domain.tasks(second).length, 1);
    assert.equal(domain.task(taskId).ready, 0);
    assert.equal(domain.admission(taskId).eligible, false);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: second,
      expectedVersion: 2,
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
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId: second,
      expectedVersion: 3,
      selectionId: "repo",
    });
    sources.reconcileSelection(second, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    domain.execute({
      type: "assignment.create",
      actor: "agent",
      key: randomUUID(),
      projectId: second,
      taskId,
      assignmentId: randomUUID(),
      profileId,
      brief: "Work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.throws(
      () =>
        domain.execute({
          type: "github.place",
          actor: "operator",
          key: randomUUID(),
          projectId: second,
          taskId,
          chosenProjectId: first,
          expectedVersion: Number(domain.task(taskId).version),
        }),
      /assigned imported task/i,
    );
    sources.reconcileSelection(first, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    assert.equal(sources.conflicts().length, 0);
    assert.equal(String(domain.task(taskId).projectId), second);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function closedIssueWorld(closedIssues: "skip" | "done") {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-closed-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Closed",
    leadProfileId: null,
  });
  const configure = (mode: "skip" | "done") => {
    const { version } = domain.githubConfiguration(projectId);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: version,
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
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      closedIssues: mode,
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: version + 1,
    });
  };
  configure(closedIssues);
  const observe = (
    changes: Partial<IssueSnapshot>,
    complete = true,
  ): ReturnType<DomainStore["task"]> | undefined => {
    const issues = [{ ...issue, ...changes }];
    sources.reconcileSelection(
      projectId,
      "repo",
      complete
        ? { complete, issues, reason: null }
        : { complete, issues, reason: "http-403" },
    );
    const taskId = sources.issue("I_1")?.taskId;
    return taskId === undefined ? undefined : domain.task(String(taskId));
  };
  return {
    db,
    domain,
    sources,
    projectId,
    configure,
    observe,
    completion: (taskId: unknown) =>
      sources.providerCompletion(String(taskId)) !== undefined,
    hold: () => sources.hold("I_1"),
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("skip mode does not import an issue first observed closed", () => {
  const w = closedIssueWorld("skip");
  try {
    assert.equal(w.observe({ state: "closed" }), undefined);
    assert.equal(w.domain.tasks(w.projectId).length, 0);
    assert.equal(w.sources.memberships("I_1").length, 0);
  } finally {
    w.close();
  }
});

test("done mode imports a first-observed closed issue as Done only on a complete read", () => {
  const w = closedIssueWorld("done");
  try {
    assert.equal(w.observe({ state: "closed" }, false), undefined);
    const task = w.observe({ state: "closed" });
    assert.equal(task?.state, "done");
    assert.equal(task?.ready, 0);
    assert.equal(w.completion(task?.id), true);
    assert.equal(w.hold(), undefined);
    // Reopening returns it to the normal readiness flow without a hold.
    const reopened = w.observe({ state: "open" });
    assert.equal(reopened?.state, "open");
    assert.equal(reopened?.ready, 1);
    assert.equal(w.completion(task?.id), false);
    assert.equal(w.hold(), undefined);
  } finally {
    w.close();
  }
});

for (const mode of ["skip", "done"] as const)
  test(`${mode} mode holds an unready imported task that closes after import`, () => {
    const w = closedIssueWorld(mode);
    try {
      const imported = w.observe({ labels: [] });
      assert.equal(imported?.ready, 0);
      assert.equal(w.hold(), undefined);
      const closed = w.observe({ labels: [], state: "closed" });
      assert.equal(closed?.state, "open");
      assert.equal(closed?.ready, 0);
      assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
      assert.ok(
        w.domain.admission(String(closed?.id)).reasons.includes("source-hold"),
      );
      assert.equal(w.completion(closed?.id), false);
      // Reopening keeps the closure hold and grants nothing beyond the rule.
      const reopened = w.observe({ state: "open", labels: [] });
      assert.equal(reopened?.ready, 0);
      assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
      assert.equal(w.observe({ state: "open" })?.ready, 1);
      assert.equal(w.hold()?.reason, "closed");
    } finally {
      w.close();
    }
  });

test("a closure hold never replaces a changed-text hold", () => {
  const w = closedIssueWorld("skip");
  try {
    w.observe({});
    w.observe({ body: "Changed scope" });
    assert.equal(w.hold()?.reason, "changed-text");
    w.observe({ body: "Changed scope", state: "closed" });
    assert.equal(w.hold()?.reason, "changed-text");
  } finally {
    w.close();
  }
});

test("switching done to skip reopens a provider-completed task under a closure hold", () => {
  const w = closedIssueWorld("done");
  try {
    const task = w.observe({ state: "closed" });
    assert.equal(task?.state, "done");
    w.configure("skip");
    const reverted = w.observe({ state: "closed" });
    assert.equal(reverted?.id, task?.id);
    assert.equal(reverted?.state, "open");
    assert.equal(w.completion(task?.id), false);
    assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
    assert.equal(w.domain.tasks(w.projectId).length, 1);
  } finally {
    w.close();
  }
});

test("provider-closure completion requires done mode, complete membership, settlement and no own closure", () => {
  const w = closedIssueWorld("done");
  try {
    const taskId = String(w.observe({})?.id);
    w.observe({ state: "closed" });
    assert.equal(w.hold()?.reason, "closed");
    assert.equal(
      w.sources.completeFromProviderClosure(taskId, () => false),
      false,
    );
    assert.equal(w.domain.task(taskId).state, "open");
    // An incomplete read leaves membership evidence incomplete.
    w.observe({ state: "closed" }, false);
    let calls = 0;
    assert.equal(
      w.sources.completeFromProviderClosure(taskId, () => ++calls > 0),
      false,
    );
    assert.equal(calls, 0);
    w.observe({ state: "closed" });
    w.db
      .prepare(
        "INSERT INTO github_delivery_closures VALUES ('I_1', 'op', NULL, '{}')",
      )
      .run();
    assert.equal(
      w.sources.completeFromProviderClosure(taskId, () => true),
      false,
    );
    w.db.prepare("DELETE FROM github_delivery_closures").run();
    w.configure("skip");
    w.observe({ state: "closed" });
    assert.equal(
      w.sources.completeFromProviderClosure(taskId, () => true),
      false,
    );
    w.configure("done");
    w.observe({ state: "closed" });
    const version = Number(w.domain.task(taskId).version);
    assert.equal(
      w.sources.completeFromProviderClosure(taskId, () => true),
      true,
    );
    const done = w.domain.task(taskId);
    assert.equal(done.state, "done");
    assert.equal(Number(done.version), version + 1);
    assert.equal(w.completion(taskId), true);
    assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
    // A provider completion after import reopens with its closure hold retained.
    assert.equal(w.observe({ state: "open" })?.state, "open");
    assert.equal(w.completion(taskId), false);
    assert.equal(w.hold()?.reason, "closed");
  } finally {
    w.close();
  }
});

test("manual state changes never carry a provider-completion record", () => {
  const w = closedIssueWorld("done");
  try {
    const task = w.observe({ state: "closed" });
    const taskId = String(task?.id);
    w.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      taskId,
      expectedVersion: Number(task?.version),
      state: "open",
    });
    assert.equal(w.completion(taskId), false);
    const reopened = w.domain.task(taskId);
    w.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      taskId,
      expectedVersion: Number(reopened.version),
      state: "done",
    });
    assert.equal(w.domain.task(taskId).state, "done");
    assert.equal(w.completion(taskId), false);
  } finally {
    w.close();
  }
});
