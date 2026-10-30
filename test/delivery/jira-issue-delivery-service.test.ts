import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { jiraIssue, json } from "../fixtures/fake-jira.js";
import {
  fakeJiraIssue,
  issueId,
  otherAccountId,
  target,
} from "../fixtures/fake-jira-issue.js";
import { tmpdir } from "../fixtures/temp.js";

class IdleRuntime implements Runtime {
  async start() {}
  async stop() {}
  async startThread(): Promise<string> {
    throw new Error("unused");
  }
  async resumeThread() {}
  async startTurn(): Promise<string> {
    throw new Error("unused");
  }
  async interruptTurn() {}
  async waitForTurn(): Promise<"completed"> {
    throw new Error("unused");
  }
  onUnexpectedRequest() {}
}

const site = "example.atlassian.net";
const names = {
  site: "FIXTURE_JIRA_SITE",
  email: "FIXTURE_JIRA_EMAIL",
  token: "FIXTURE_JIRA_TOKEN",
};
const values = {
  site: `https://${site}`,
  email: "cab@example.test",
  token: "jira-token-canary-1320",
};

/** A service on a scripted Jira site with ABC-7 imported into a project that grants issue actions. */
async function fixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  grants: ("issue.comment" | "issue.close")[] = [
    "issue.comment",
    "issue.close",
  ],
  readiness: unknown = null,
) {
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    const previous = process.env[names[key]];
    t.after(() => {
      if (previous === undefined) delete process.env[names[key]];
      else process.env[names[key]] = previous;
    });
    process.env[names[key]] = values[key];
  }
  const jira = fakeJiraIssue();
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/jql/parse")) return json({ queries: [{ query: "q" }] });
    if (path.endsWith("/search/jql"))
      return json({
        issues: [jiraIssue(7, { done: jira.state.status.category === "done" })],
      });
    return jira.fetcher(input, init);
  };
  const dataDir = join(mkdtempSync(join(tmpdir(), "cab-jira-")), "data");
  const service = new StandaloneService(
    dataDir,
    () => new IdleRuntime(),
    undefined,
    {
      runtimeHarnesses: ["codex"],
      power: { enabled: false },
      routingClient: null,
      issueTrackers: { jiraFetcher: fetcher, intervalMs: 3_600_000 },
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });
  await service.start();
  const api = new OperatorApi(service, [dataDir]);
  const projectId = randomUUID();
  const profileId = randomUUID();
  const domain = service.domain();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Alpha",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "Deliver the scoped task.",
  });
  await api.execute({
    type: "issue-tracker-credential.configure",
    key: randomUUID(),
    issueTracker: "jira",
    siteRef: `env:${names.site}`,
    emailRef: `env:${names.email}`,
    tokenRef: `env:${names.token}`,
  });
  await api.execute({
    type: "jira.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance: site,
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    readiness,
  } as never);
  await api.refreshSources();
  const store = service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const taskId = String(store.issue(issueId)?.taskId);
  const configureGrants = (
    next: ("issue.comment" | "issue.close")[],
    expectedVersion: number,
  ) =>
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: next.map((action) => ({
        action,
        repositoryId: target.repositoryId,
        mode: "allow" as const,
      })),
      requiredChecks: [],
    });
  configureGrants(grants, 1);
  // Jira blockers and readiness arrive with #1319; until then admission refuses an imported task.
  (service as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare(
      "UPDATE domain_tasks SET importedBlockers = 'clear', ready = 1 WHERE id = ?",
    )
    .run(taskId);
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    paused: false,
  });
  const commentPolicy = async () =>
    (await api.readTask(taskId)).data.commentPolicy;
  return { api, service, jira, store, taskId, projectId, commentPolicy };
}

test("the operator's comment on a Jira task is posted by the Jira writer and read back", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.commentPolicy(), {
    available: true,
    mode: "allow",
    reason: null,
    reasonCode: null,
  });
  const record = await f.service.postOperatorComment({
    key: randomUUID(),
    taskId: f.taskId,
    expectedTaskVersion: Number(f.service.domain().task(f.taskId).version),
    body: "Looking good",
  });
  assert.equal(record.state, "confirmed-success");
  assert.equal(f.jira.state.comments.length, 1);
  assert.deepEqual(f.jira.writes(), ["POST comment"]);
  assert.deepEqual(record.request.action, {
    kind: "issue.comment",
    target,
    body: "Looking good",
  });
});

test("the comment policy of a Jira task names its reason without GitHub wording", async (t) => {
  const none = await fixture(t, []);
  const noGrant = await none.commentPolicy();
  assert.equal(noGrant?.reasonCode, "no-comment-grant");
  assert.equal(noGrant?.available, false);
  assert.doesNotMatch(noGrant?.reason ?? "", /GitHub/);

  const f = await fixture(t);
  await f.api.execute({
    type: "issue-tracker-credential.configure",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    clear: true,
  });
  assert.equal((await f.commentPolicy())?.reasonCode, "no-delivery-credential");
});

/** Records a confirmed cab `issue.close` of ABC-7 and Jira's matching state, made by `who`. */
function closeAs(f: Awaited<ReturnType<typeof fixture>>, who: string) {
  const store = f.service.delivery();
  const operationId = randomUUID();
  store.prepareAction(
    {
      operationId,
      action: { kind: "issue.close", target, reviewedResultIds: [] },
    },
    {
      projectId: f.projectId,
      taskId: f.taskId,
      taskVersion: Number(f.service.domain().task(f.taskId).version),
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "w",
      workRevision: 1,
      conversationRevision: 1,
    },
    false,
  );
  store.beginAttempt(operationId, { state: "open", issueId });
  store.recordObservation(operationId, {
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: issueId, number: 7, issueClosed: true },
  });
  f.jira.state.status = { id: "9", name: "Done", category: "done" };
  f.jira.state.history.push({
    id: "700",
    accountId: who,
    items: [{ field: "status", to: "9" }],
  });
  return operationId;
}

test("cab's own Jira closure is recorded as its own and holds the task as closed", async (t) => {
  const f = await fixture(t);
  const operationId = closeAs(f, "acct-cab");
  await f.service.refreshGitHub();
  const closure = f.store.deliveryClosure(issueId);
  assert.deepEqual(closure, { operationId, closedEventId: "700" });
  assert.equal(f.store.hold(issueId)?.reason, "closed");
  assert.equal(f.store.issue(issueId)?.observedState, "closed");
  assert.deepEqual(JSON.parse(String(f.store.observedStatus(issueId))), {
    id: "9",
    name: "Done",
    categoryKey: "done",
  });
});

test("a Jira closure by another account holds the task as unproved, and a reopen supersedes cab's", async (t) => {
  const f = await fixture(t);
  closeAs(f, otherAccountId);
  await f.service.refreshGitHub();
  assert.equal(f.store.deliveryClosure(issueId), undefined);
  assert.equal(f.store.hold(issueId)?.reason, "closure-attribution-unproved");

  const reopened = await fixture(t);
  const operationId = closeAs(reopened, "acct-cab");
  reopened.jira.state.status = { id: "1", name: "To Do", category: "new" };
  await reopened.service.refreshGitHub();
  assert.equal(reopened.store.deliveryClosure(issueId), undefined);
  assert.equal(
    reopened.service.delivery().ownClosureOperation(reopened.taskId, issueId),
    undefined,
  );
  assert.ok(operationId);
});

test("cab's own closure under a status readiness rule is judged on the status before it moved", async (t) => {
  const f = await fixture(t, undefined, {
    mode: "all",
    conditions: [{ kind: "status", operator: "in", statusIds: ["1"] }],
  });
  closeAs(f, "acct-cab");
  await f.service.refreshGitHub();
  assert.equal(f.store.deliveryClosure(issueId)?.closedEventId, "700");
  assert.equal(f.store.hold(issueId)?.reason, "closed");
});
