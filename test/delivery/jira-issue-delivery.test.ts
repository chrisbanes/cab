import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { test } from "node:test";
import {
  type DeliveryCaller,
  DeliveryStore,
  type ExternalAction,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import {
  GitHubSourceStore,
  type IssueSnapshot,
} from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import { JiraIssueTrackerWriter } from "../../src/standalone/jira-delivery.js";
import {
  fakeJiraIssue,
  issueId,
  otherAccountId,
  projectId as jiraProjectId,
  target,
} from "../fixtures/fake-jira-issue.js";

const site = "example.atlassian.net";
const jiraTracker = { provider: "jira", instance: site } as const;
const issue: IssueSnapshot = {
  providerInstance: site,
  nodeId: issueId,
  repositoryId: jiraProjectId,
  repositoryName: "ABC",
  number: 7,
  title: "Fix the login bug",
  body: "From Jira",
  state: "open",
  labels: ["ready"],
  status: { id: "1", name: "To Do", categoryKey: "new" },
  projectFields: [],
};
const label = (name: string) => ({
  kind: "label" as const,
  operator: "has" as const,
  name,
});

/** Real SQLite, a Jira task imported as ABC-7, the real writer over a scripted Jira, and a file to restart from. */
function world(
  t: TestContext,
  grants: ("issue.comment" | "issue.labels" | "issue.close")[] = [
    "issue.comment",
    "issue.labels",
    "issue.close",
  ],
  mode: "allow" | "approval" = "allow",
  readiness: unknown = null,
) {
  const directory = mkdtempSync(join(tmpdir(), "cab-jira-delivery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "db.sqlite");
  let db = new DatabaseSync(file);
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Alpha",
    leadProfileId: null,
  });
  domain.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    credential: {
      siteRef: "env:FIXTURE_JIRA_SITE",
      emailRef: "env:FIXTURE_JIRA_EMAIL",
      tokenRef: "env:FIXTURE_JIRA_TOKEN",
    },
  });
  domain.execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance: site,
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    readiness,
  } as never);
  const sources = new GitHubSourceStore(db, jiraTracker);
  sources.reconcileSelection(
    projectId,
    "S-1",
    { complete: true, issues: [issue], reason: null },
    {
      projectId,
      configVersion: domain.jiraConfiguration(projectId)?.version ?? 0,
      credentialRef: null,
    },
  );
  const taskId = String(sources.issue(issueId)?.taskId);
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [
      ...grants.map((action) => ({
        action,
        repositoryId: jiraProjectId,
        mode,
      })),
      ...(["pr.create", "pr.edit"] as const).map((action) => ({
        action,
        repositoryId: "R1",
        mode: "allow" as const,
      })),
    ],
    requiredChecks: [],
  });
  const jira = fakeJiraIssue();
  // The state of the delivery record when each write reaches Jira.
  const seen: string[] = [];
  let store = new DeliveryStore(db);
  store.migrate();
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && String(input).endsWith("/comment"))
      for (const record of store.actions())
        seen.push(`${record.request.action.kind}:${record.state}`);
    return jira.fetcher(input, init);
  };
  const options = () => ({
    authorize: () => {},
    approved: () => false,
    issueTrackerOf: () => ({ issueTracker: "jira" as const, instance: site }),
    issueTrackerFactories: {
      jira: () =>
        new JiraIssueTrackerWriter(
          () => ({ instance: site, email: "cab@example.test", token: "t" }),
          fetcher,
        ),
    },
  });
  let coordinator = new DeliveryCoordinator(store, options());
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  t.after(async () => {
    await coordinator.stop();
    db.close();
  });
  return {
    db,
    domain,
    sources,
    jira,
    seen,
    projectId,
    taskId,
    caller,
    get store() {
      return store;
    },
    get coordinator() {
      return coordinator;
    },
    submit: (action: ExternalAction, operationId = randomUUID()) =>
      coordinator.submit({ operationId, action }, caller),
    /** A new service process on the same database; Jira keeps its state. */
    async restart() {
      await coordinator.stop();
      db.close();
      db = new DatabaseSync(file);
      store = new DeliveryStore(db);
      store.migrate();
      coordinator = new DeliveryCoordinator(store, options());
    },
  };
}
const comment = (body = "Progress"): ExternalAction => ({
  kind: "issue.comment",
  target,
  body,
});
const close: ExternalAction = {
  kind: "issue.close",
  target,
  reviewedResultIds: [],
};

test("a Jira comment is recorded before it is sent and confirmed from the readback", async (t) => {
  const w = world(t);
  const record = await w.submit(comment());
  assert.equal(record.state, "confirmed-success");
  assert.deepEqual(w.seen, ["issue.comment:attempting"]);
  assert.equal(w.jira.state.comments.length, 1);
  assert.equal(
    record.observation?.receipt?.nodeId,
    w.jira.state.comments[0]?.id,
  );
  assert.equal(record.beforeState?.accountId, "acct-cab");
});

test("a Jira action needs a grant on the Jira project, and an approval grant waits for approval", async (t) => {
  const none = world(t, []);
  assert.equal((await none.submit(comment())).state, "denied");
  const approval = world(t, ["issue.comment"], "approval");
  assert.equal((await approval.submit(comment())).state, "denied");
  const elsewhere = world(t);
  const other = { ...target, repositoryId: "10099" };
  assert.equal(
    (
      await elsewhere.submit({
        kind: "issue.comment",
        target: other,
        body: "B",
      })
    ).state,
    "denied",
  );
  for (const w of [none, approval, elsewhere])
    assert.deepEqual(w.jira.requests, []);
});

test("an agent cannot add or remove a Jira readiness label, but can change any other", async (t) => {
  // The rule is saved through jira.configure, as an operator would.
  const w = world(t, undefined, "allow", {
    mode: "any",
    conditions: [label("Ready")],
  });
  const labels = (add: string[], remove: string[]): ExternalAction => ({
    kind: "issue.labels",
    target,
    add,
    remove,
  });
  assert.equal((await w.submit(labels(["ready"], []))).state, "denied");
  assert.equal((await w.submit(labels([], ["READY"]))).state, "denied");
  assert.deepEqual(w.jira.writes(), []);
  const allowed = await w.submit(labels(["backend"], []));
  assert.equal(allowed.state, "confirmed-success");
  assert.deepEqual(w.jira.state.labels, ["ready", "backend"]);
});

test("a comment whose response is lost is found by the marker after a restart, or stays uncertain, and is never resent", async (t) => {
  const landed = world(t);
  landed.jira.state.fail["POST comment"] = { apply: true };
  const request = randomUUID();
  assert.equal((await landed.submit(comment(), request)).state, "uncertain");
  await landed.restart();
  await landed.coordinator.reconcile();
  assert.equal(landed.store.action(request).state, "confirmed-success");
  assert.deepEqual(landed.jira.writes(), ["POST comment"]);

  const lost = world(t);
  lost.jira.state.fail["POST comment"] = {};
  const second = randomUUID();
  assert.equal((await lost.submit(comment(), second)).state, "uncertain");
  await lost.restart();
  await lost.coordinator.reconcile();
  await lost.coordinator.reconcile();
  assert.equal(lost.store.action(second).state, "uncertain");
  assert.deepEqual(lost.jira.writes(), ["POST comment"]);
  // The block holds the task until the operator settles it.
  assert.ok(lost.store.actionBlockers(lost.taskId).length > 0);
});

test("closure is Cab's own transition, proven from the changelog, and a later reopen supersedes it", async (t) => {
  const w = world(t);
  const operationId = randomUUID();
  const record = await w.submit(close, operationId);
  assert.equal(record.state, "confirmed-success");
  assert.equal(record.observation?.receipt?.issueClosed, true);
  assert.equal(
    w.store.ownClosureOperation(w.taskId, issueId)?.operationId,
    operationId,
  );

  const inspected = await w.coordinator.inspectOwnClosure(w.taskId, target);
  assert.equal(inspected.kind, "proved");
  const eventId = inspected.kind === "proved" ? inspected.closedEventId : "";

  // A person reopens the issue and closes it again: a different closure, not cab's.
  const jira = w.jira.state;
  jira.history.push(
    {
      id: "800",
      accountId: otherAccountId,
      items: [{ field: "status", to: "1" }],
    },
    {
      id: "801",
      accountId: otherAccountId,
      items: [{ field: "status", to: "9" }],
    },
  );
  const later = await w.coordinator.inspectOwnClosure(w.taskId, target, {
    operationId,
    closedEventId: eventId,
  });
  assert.equal(later.kind, "reopened");
  w.sources.supersedeDeliveryClosure(issueId, operationId);
  assert.equal(w.store.ownClosureOperation(w.taskId, issueId), undefined);
});

test("a closure by another account is not attributed to cab's confirmed closure", async (t) => {
  const w = world(t);
  const operationId = randomUUID();
  await w.submit(close, operationId);
  // The issue was reopened and closed by a person before cab looked again.
  w.jira.state.history.push(
    {
      id: "800",
      accountId: otherAccountId,
      items: [{ field: "status", to: "1" }],
    },
    {
      id: "801",
      accountId: otherAccountId,
      items: [{ field: "status", to: "9" }],
    },
  );
  const inspected = await w.coordinator.inspectOwnClosure(w.taskId, target);
  assert.equal(inspected.kind, "attribution-unproved");
});

test("a closure the completion conditions hold sends no transition", async (t) => {
  const w = world(t);
  w.store.transaction(() =>
    w.store.assignTaskBranchWithinTransaction(w.taskId, "R1"),
  );
  w.db
    .prepare("UPDATE delivery_task_branches SET outsideHeadSha = ?")
    .run("5".repeat(40));
  const record = await w.submit(close);
  assert.notEqual(record.state, "confirmed-success");
  assert.deepEqual(w.jira.writes(), []);
  assert.equal(w.jira.state.status.category, "new");
});

test("a Jira task's branch carries its key, is assigned once and keeps it when the title changes", (t) => {
  const w = world(t);
  const branch = w.store.transaction(() =>
    w.store.assignTaskBranchWithinTransaction(w.taskId, "R1"),
  );
  const hex = w.taskId.replaceAll("-", "").slice(0, 8);
  assert.equal(branch.branch, `cab/ABC-7-${hex}-fix-the-login-bug`);
  w.db.prepare("UPDATE tasks SET title = 'Renamed' WHERE id = ?").run(w.taskId);
  assert.equal(
    w.store.transaction(() =>
      w.store.assignTaskBranchWithinTransaction(w.taskId, "R1"),
    ).branch,
    branch.branch,
  );
  // A task of the same project that did not come from Jira has no key.
  const localId = randomUUID();
  w.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    taskId: localId,
    title: "Local work",
    outcome: "O",
  });
  assert.match(
    w.store.transaction(() =>
      w.store.assignTaskBranchWithinTransaction(localId, "R1"),
    ).branch,
    /^cab\/[0-9a-f]{8}-local-work$/,
  );
});

function changeRequest(w: ReturnType<typeof world>, taskId = w.taskId) {
  const caller = { ...w.caller, taskId };
  const branch = w.store.transaction(() =>
    w.store.assignTaskBranchWithinTransaction(taskId, "R1"),
  );
  const sha = "a".repeat(40);
  w.db
    .prepare(
      "UPDATE delivery_task_branches SET lastPushedSha = ? WHERE taskId = ?",
    )
    .run(sha, taskId);
  const pr = { repositoryId: "R1", baseRef: "main", headRef: branch.branch };
  const authorize = (action: ExternalAction) =>
    w.store.authorize({ operationId: randomUUID(), action }, caller, true);
  return {
    create: (title: string, body = "Body") =>
      authorize({
        kind: "pr.create",
        target: { ...pr, expectedHeadSha: sha },
        title,
        body,
        draft: false,
      }),
    edit: (fields: { title?: string; body?: string }) =>
      authorize({
        kind: "pr.edit",
        target: { ...pr, expectedHeadSha: sha, number: 3, nodeId: "P3" },
        fields,
      }),
  };
}

test("a change request for a Jira task must start its title with the key", (t) => {
  const cr = changeRequest(world(t));
  assert.throws(() => cr.create("Fix login"), /ABC-7/);
  assert.throws(() => cr.create("Fix ABC-7 login"), /ABC-7/);
  assert.throws(() => cr.create("ABC-70 Fix login"), /ABC-7/);
  assert.throws(() => cr.edit({ title: "Fix login" }), /ABC-7/);
  cr.create("ABC-7 Fix login");
  cr.create("ABC-7: Fix login");
  cr.edit({ title: "ABC-7 Fix login" });
  // An edit that leaves the title alone is not a title change.
  cr.edit({ body: "More detail" });
});

test("change request text in a Jira project never closes a Jira issue with a keyword", (t) => {
  const cr = changeRequest(world(t));
  for (const text of [
    "Closes ABC-7",
    "fixes: XYZ-12",
    "Resolves ABC-7, ABC-8",
    "Implementing ABC-7",
    "Some detail\nclosed ABC-7 in this change",
    "CLOSING ABC-9",
    "Closes ABC-7x",
  ]) {
    assert.throws(
      () => cr.create("ABC-7 Fix", text),
      /closing keyword|close a Jira/,
    );
    assert.throws(() => cr.edit({ body: text }), /close a Jira/);
  }
  assert.throws(() => cr.create("ABC-7 Closes ABC-8"), /close a Jira/);
  cr.create("ABC-7 Fix", "Relates to ABC-7\nSee also ABC-8");
  cr.create("ABC-7 Fix", "Fixes the login bug");
});

test("a local task in a Jira project needs no key in its title but still never closes a Jira issue", (t) => {
  const w = world(t);
  const localId = randomUUID();
  w.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    taskId: localId,
    title: "Local work",
    outcome: "O",
  });
  const cr = changeRequest(w, localId);
  cr.create("Any title");
  assert.throws(() => cr.create("Any title", "Closes ABC-7"), /close a Jira/);
});
