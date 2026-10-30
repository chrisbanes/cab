import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { z } from "zod";
import type { jiraReadinessSchema } from "../../src/core/github-source-contracts.js";
import type { Runtime } from "../../src/standalone/codex.js";
import {
  deliveryRepositoryLabel,
  OperatorApi,
} from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  adfParagraph,
  fakeJira,
  jiraIssue,
  json,
} from "../fixtures/fake-jira.js";
import { tmpdir } from "../fixtures/temp.js";

type JiraReadiness = z.output<typeof jiraReadinessSchema>;

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
  email: "chris@example.test",
  token: "jira-token-canary-1318",
};

/** What the scripted site returns for each JQL: its issues, or a failure. */
interface JiraState {
  issues: Record<string, ReturnType<typeof jiraIssue>[]>;
  fail: Record<string, number>;
  /** JQL whose response is cut off mid-body. */
  truncated: Set<string>;
}

async function fixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  options: { lead?: boolean } = {},
) {
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    const previous = process.env[names[key]];
    t.after(() => {
      if (previous === undefined) delete process.env[names[key]];
      else process.env[names[key]] = previous;
    });
    process.env[names[key]] = values[key];
  }
  const state: JiraState = { issues: {}, fail: {}, truncated: new Set() };
  const jira = fakeJira((request) => {
    if (request.url.pathname.endsWith("/myself"))
      return json({ accountId: "acct-1", displayName: "Chris" });
    const jql =
      (request.body as { jql?: string; queries?: string[] }).jql ??
      (request.body as { queries: string[] }).queries[0] ??
      "";
    if (request.url.pathname.endsWith("/jql/parse"))
      return json({
        queries: [
          jql.includes("BAD")
            ? { query: jql, errors: ["Error in the JQL Query: BAD."] }
            : { query: jql },
        ],
      });
    const status = state.fail[jql];
    if (status) return new Response("", { status });
    if (state.truncated.has(jql))
      return new Response('{"issues":[{"id":"1', { status: 200 });
    return json({ issues: state.issues[jql] ?? [] });
  });
  const dataDir = join(mkdtempSync(join(tmpdir(), "cab-jira-")), "data");
  const service = new StandaloneService(
    dataDir,
    () => new IdleRuntime(),
    undefined,
    {
      runtimeHarnesses: ["codex"],
      power: { enabled: false },
      routingClient: null,
      issueTrackers: { jiraFetcher: jira.fetcher, intervalMs: 3_600_000 },
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });
  await service.start();
  const api = new OperatorApi(service, [dataDir]);
  const projectId = randomUUID();
  const leadProfileId = options.lead ? randomUUID() : null;
  if (leadProfileId)
    service.domain().execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Lead",
      capabilities: "work",
    });
  service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Alpha",
    leadProfileId,
  });
  const configureCredential = () =>
    api.execute({
      type: "issue-tracker-credential.configure",
      key: randomUUID(),
      issueTracker: "jira",
      siteRef: `env:${names.site}`,
      emailRef: `env:${names.email}`,
      tokenRef: `env:${names.token}`,
    });
  const configureJira = (
    selections: { id: string; kind: "jql"; jql: string }[],
    expectedVersion = service.domain().jiraConfiguration(projectId)?.version ??
      1,
    readiness?: JiraReadiness | null,
  ) =>
    api.execute({
      type: "jira.configure",
      key: randomUUID(),
      projectId,
      expectedVersion,
      instance: site,
      selections,
      ...(readiness === undefined ? {} : { readiness }),
    });
  return {
    api,
    service,
    dataDir,
    state,
    jira,
    projectId,
    configureCredential,
    configureJira,
  };
}

test("a Jira credential reports its account, never its references or values", async (t) => {
  const f = await fixture(t);
  const receipt = await f.configureCredential();
  assert.ok("result" in receipt);
  assert.deepEqual(receipt.result, {
    commandType: "issue-tracker-credential.configure",
    resourceId: `system:issue-tracker-credential:jira:${site}`,
    configured: true,
  });
  const status = await f.api.readIssueTrackerCredentials();
  assert.deepEqual(status.data.credentials, [
    {
      issueTracker: "jira",
      instance: site,
      usable: true,
      account: { accountId: "acct-1", displayName: "Chris" },
      reason: null,
    },
  ]);
  const text = JSON.stringify([receipt, status]);
  for (const secret of [...Object.values(values), ...Object.values(names)])
    assert.equal(text.includes(secret), false);
  // The site variable changing after configure fails closed.
  process.env[names.site] = "https://other.atlassian.net";
  assert.equal(
    (await f.api.readIssueTrackerCredentials()).data.credentials[0]?.reason,
    "site-mismatch",
  );
  process.env[names.site] = values.site;
  await f.api.execute({
    type: "issue-tracker-credential.configure",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    clear: true,
  });
  assert.deepEqual(
    (await f.api.readIssueTrackerCredentials()).data.credentials,
    [],
  );
});

test("a site variable that is not an https origin is refused before anything is saved", async (t) => {
  const f = await fixture(t);
  process.env[names.site] = "http://example.atlassian.net";
  await assert.rejects(f.configureCredential(), { status: 400 });
  assert.deepEqual(f.service.domain().issueTrackerCredentials(), []);
});

test("JQL preview lists matches without saving, and bad JQL is refused with nothing saved", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  f.state.issues["project = ABC"] = [jiraIssue(1), jiraIssue(2)];
  const preview = await f.api.readJiraPreview(
    new URLSearchParams({ instance: site, jql: "project = ABC" }),
  );
  assert.deepEqual(preview.data.matches, [
    { key: "ABC-1", title: "Issue 1", status: "To Do" },
    { key: "ABC-2", title: "Issue 2", status: "To Do" },
  ]);
  assert.equal(preview.data.more, false);
  await assert.rejects(
    f.api.readJiraPreview(
      new URLSearchParams({ instance: site, jql: "BAD =" }),
    ),
    (error: { status: number; publicMessage?: string }) =>
      error.status === 400 && /BAD/.test(error.publicMessage ?? ""),
  );
  const before = f.service.domain().jiraConfiguration(f.projectId);
  assert.equal(before, null);
  await assert.rejects(
    f.configureJira([{ id: "S-1", kind: "jql", jql: "BAD =" }], 1),
    (error: { status: number; fieldPaths?: string[] }) =>
      error.status === 400 && error.fieldPaths?.[0] === "selections.0.jql",
  );
  assert.equal(f.service.domain().jiraConfiguration(f.projectId), null);
  assert.equal(f.service.domain().githubConfiguration(f.projectId).version, 1);
});

test("a Jira project imports, deduplicates, updates, withdraws, holds and survives partial reads", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  f.state.issues["project = ABC"] = [jiraIssue(1), jiraIssue(2)];
  f.state.issues["labels = ready"] = [jiraIssue(2)];
  await f.configureJira([
    { id: "S-1", kind: "jql", jql: "project = ABC" },
    { id: "S-2", kind: "jql", jql: "labels = ready" },
  ]);
  const observations = await f.api.refreshSources();
  const observed = observations.data.projects.find(
    (p) => p.projectId === f.projectId,
  );
  assert.equal(observed?.tracker, "jira");
  assert.equal(observed?.credential, undefined);
  assert.deepEqual(
    observed?.selections.map((s) => [s.selectionId, s.state]),
    [
      ["S-1", "complete"],
      ["S-2", "complete"],
    ],
  );
  assert.ok(observed?.selections.every((s) => s.lastSuccessfulAt));
  const domain = f.service.domain();
  assert.equal(domain.tasks(f.projectId).length, 2);
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  assert.equal(stores.memberships("10002").length, 2);

  // An update to one issue changes its stored text and holds the task for review.
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { summary: "Renamed" }),
    jiraIssue(2),
  ];
  await f.api.refreshSources();
  assert.equal(stores.issue("10001")?.observedTitle, "Renamed");
  assert.equal(stores.hold("10001")?.reason, "changed-text");

  // A partial read withdraws nothing, and imported Jira tasks are not admitted.
  f.state.fail["project = ABC"] = 500;
  f.state.fail["labels = ready"] = 500;
  await f.api.refreshSources();
  assert.equal(stores.memberships("10001").length, 1);
  assert.equal(stores.hold("10002")?.active ?? 0, 0);
  const taskId = String(stores.issue("10002")?.taskId);
  assert.ok(
    domain.admission(taskId).reasons.includes("imported-blockers-unknown"),
  );
  delete f.state.fail["project = ABC"];
  delete f.state.fail["labels = ready"];

  // Closing an issue in Jira holds its task as an external closure.
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { summary: "Renamed" }),
    jiraIssue(2, { done: true }),
  ];
  f.state.issues["labels = ready"] = [jiraIssue(2, { done: true })];
  await f.api.refreshSources();
  assert.equal(stores.issue("10002")?.observedState, "closed");
  assert.equal(stores.hold("10002")?.reason, "closed");
  // Dropping an issue from every selection withdraws it.
  f.state.issues["project = ABC"] = [jiraIssue(1, { summary: "Renamed" })];
  f.state.issues["labels = ready"] = [];
  await f.api.refreshSources();
  await f.api.refreshSources();
  assert.equal(stores.memberships("10002").length, 0);
});

test("a task imported from Jira reports its key, site, status and link, and offers neither edit nor publication", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  f.state.issues["project = ABC"] = [
    jiraIssue(12, { description: adfParagraph("Read only") }),
  ];
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }]);
  await f.api.refreshSources();
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const taskId = String(stores.issue("10012")?.taskId);
  const task = (await f.api.readTask(taskId)).data;
  assert.deepEqual(task.source?.identity, {
    provider: site,
    tracker: "jira",
    nodeId: "10012",
    repositoryId: "10000",
  });
  assert.equal(task.source?.key, "ABC-12");
  assert.equal(task.source?.url, `https://${site}/browse/ABC-12`);
  assert.deepEqual(task.source?.status, { name: "To Do", categoryKey: "new" });
  assert.equal(task.source?.body, "Read only");
  assert.equal(task.source?.memberships[0]?.sync.complete, true);
  assert.equal(task.issueEdit?.available, false);
  assert.equal(task.issueEdit?.reasonCode, "issue-tracker-unsupported");
  assert.match(task.issueEdit?.reason ?? "", /Jira/);

  // A local task in the Jira project cannot be published either.
  const localId = randomUUID();
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    taskId: localId,
    title: "Local",
    outcome: "Do it",
    ready: false,
  });
  const local = (await f.api.readTask(localId)).data;
  assert.equal(local.publication?.available, false);
  assert.equal(local.publication?.reasonCode, "issue-tracker-unsupported");
  assert.match(local.publication?.reason ?? "", /Jira/);
});

test("switching a project that has imported tasks between trackers is refused both ways", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  f.state.issues["project = ABC"] = [jiraIssue(1)];
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }]);
  await f.api.refreshSources();
  await assert.rejects(
    f.api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion:
        f.service.domain().jiraConfiguration(f.projectId)?.version ?? 1,
      credentialRef: "env:TEST_GITHUB",
      selections: [],
      readiness: null,
    }),
    { status: 409 },
  );
  assert.equal(
    f.service.domain().jiraConfiguration(f.projectId)?.selections.length,
    1,
  );

  // A GitHub project with selections cannot become a Jira project.
  const githubProject = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: githubProject,
    name: "Beta",
    leadProfileId: null,
  });
  await f.api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: githubProject,
    expectedVersion: 1,
    credentialRef: "env:TEST_GITHUB",
    selections: [{ id: "q", kind: "search", query: "repo:org/repo" }],
    readiness: null,
  });
  await assert.rejects(
    f.api.execute({
      type: "jira.configure",
      key: randomUUID(),
      projectId: githubProject,
      expectedVersion: 2,
      instance: site,
      selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    }),
    { status: 409 },
  );
  assert.equal(f.service.domain().jiraConfiguration(githubProject), null);
});

test("a Jira issue matched in two projects on one site offers a placement choice", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  f.state.issues["project = ABC"] = [jiraIssue(1)];
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }]);
  const second = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: second,
    name: "Beta",
    leadProfileId: null,
  });
  await f.api.execute({
    type: "jira.configure",
    key: randomUUID(),
    projectId: second,
    expectedVersion: 1,
    instance: site,
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
  });
  await f.api.refreshSources();
  for (const projectId of [f.projectId, second]) {
    const { placements } = (await f.api.readProjectConfiguration(projectId))
      .data;
    assert.equal(placements.length, 1);
    assert.deepEqual(
      placements[0]?.choices.map((c) => c.id).sort(),
      [f.projectId, second].sort(),
    );
  }
});

test("a Jira project ID that equals a linked repository ID never names the delivery branch's repository", () => {
  const jira = {
    identity: { repositoryId: "10000", tracker: "jira" as const },
    repositoryName: "ABC",
  };
  assert.equal(deliveryRepositoryLabel(jira, "10000"), "10000");
  const github = {
    identity: { repositoryId: "R_1" },
    repositoryName: "org/repo",
  };
  assert.equal(deliveryRepositoryLabel(github, "R_1"), "org/repo");
  assert.equal(deliveryRepositoryLabel(github, "R_2"), "R_2");
  assert.equal(deliveryRepositoryLabel(null, "R_2"), "R_2");
});

const link = (inward: string, n: number, done = false) => ({
  type: { name: "Blocks", inward, outward: "blocks" },
  inwardIssue: {
    id: String(10000 + n),
    key: `ABC-${n}`,
    fields: {
      status: { statusCategory: { key: done ? "done" : "indeterminate" } },
    },
  },
});

test("'is blocked by' links gate admission until the blocker is done, and other links are ignored", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }]);
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const domain = f.service.domain();
  const reasons = (nodeId: string) =>
    domain.admission(String(stores.issue(nodeId)?.taskId)).reasons;
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { issuelinks: [link("is blocked by", 2)] }),
    jiraIssue(2),
    jiraIssue(3, { issuelinks: [link("relates to", 2)] }),
  ];
  await f.api.refreshSources();
  assert.ok(reasons("10001").includes("imported-blockers-blocked"));
  assert.deepEqual(
    stores.nativeBlockers("10001").map((b) => [b.blockerNodeId, b.status]),
    [["10002", "open"]],
  );
  assert.ok(!reasons("10002").some((r) => r.startsWith("imported-blockers-")));
  assert.ok(!reasons("10003").some((r) => r.startsWith("imported-blockers-")));

  // The blocker is done in Jira: the next complete read clears the dependent.
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { issuelinks: [link("is blocked by", 2, true)] }),
    jiraIssue(2, { done: true }),
    jiraIssue(3),
  ];
  await f.api.refreshSources();
  assert.ok(!reasons("10001").some((r) => r.startsWith("imported-blockers-")));
  assert.ok(!reasons("10001").includes("imported-blockers-blocked"));
});

test("a failed, truncated or rate-limited read keeps a dependency and never clears it", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }]);
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const domain = f.service.domain();
  const taskId = () => String(stores.issue("10001")?.taskId);
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { issuelinks: [link("is blocked by", 2)] }),
  ];
  await f.api.refreshSources();
  assert.ok(
    domain.admission(taskId()).reasons.includes("imported-blockers-blocked"),
  );
  const jql = "project = ABC";
  // The blocker is done upstream, but no complete read says so.
  f.state.issues[jql] = [
    jiraIssue(1, { issuelinks: [link("is blocked by", 2, true)] }),
  ];
  const failures: (() => void)[] = [
    () => {
      f.state.fail[jql] = 500;
    },
    () => {
      delete f.state.fail[jql];
      f.state.truncated.add(jql);
    },
    () => {
      f.state.truncated.delete(jql);
      f.state.fail[jql] = 429;
    },
  ];
  for (const fail of failures) {
    fail();
    await f.api.refreshSources();
    const reasons = domain.admission(taskId()).reasons;
    assert.ok(reasons.includes("imported-blockers-unknown"));
    assert.deepEqual(
      stores.nativeBlockers("10001").map((b) => [b.blockerNodeId, b.status]),
      [["10002", "open"]],
    );
  }
});

test("a select-field rule is read from the scripted custom field and gates readiness", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }], 1, {
    mode: "all",
    conditions: [
      {
        kind: "select-field",
        fieldId: "customfield_10010",
        operator: "in",
        optionIds: ["20"],
      },
    ],
  });
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const domain = f.service.domain();
  f.state.issues["project = ABC"] = [
    jiraIssue(1, {
      fields: { customfield_10010: { id: "20", value: "High" } },
    }),
    jiraIssue(2, {
      fields: { customfield_10010: { id: "21", value: "Low" } },
    }),
  ];
  await f.api.refreshSources();
  const search = f.jira.requests.findLast((r) =>
    r.url.pathname.endsWith("/search/jql"),
  );
  assert.ok(
    (search?.body as { fields: string[] } | undefined)?.fields.includes(
      "customfield_10010",
    ),
  );
  const unready = (nodeId: string) =>
    domain
      .admission(String(stores.issue(nodeId)?.taskId))
      .reasons.includes("task-unready");
  assert.equal(unready("10001"), false);
  assert.equal(unready("10002"), true);
});

test("the operator sees a Jira rule with observed names, unmet conditions and Jira-keyed blockers", async (t) => {
  const f = await fixture(t);
  await f.configureCredential();
  const rule = {
    mode: "all" as const,
    conditions: [
      {
        kind: "status" as const,
        operator: "in" as const,
        statusIds: ["1", "7"],
      },
    ],
  };
  await f.configureJira(
    [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    1,
    rule,
  );
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { issuelinks: [link("is blocked by", 3)] }),
    jiraIssue(2, { status: { id: "3", name: "In Progress" } }),
  ];
  await f.api.refreshSources();
  const view = (await f.api.readProjectConfiguration(f.projectId)).data.source
    .readiness;
  assert.deepEqual(view, {
    kind: "rule",
    mode: "all",
    conditions: [{ ...rule.conditions[0], statusNames: { "1": "To Do" } }],
  });
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const taskOf = (nodeId: string) => String(stores.issue(nodeId)?.taskId);
  const unmet = (await f.api.readTask(taskOf("10002"))).data.source;
  assert.equal(unmet?.readiness.outcome, "unmet");
  assert.deepEqual(
    unmet?.readiness.unmet,
    view.kind === "rule" ? view.conditions : [],
  );
  const blocked = (await f.api.readTask(taskOf("10001"))).data.source;
  assert.equal(blocked?.readiness.outcome, "matched");
  const expected = { label: "ABC-3", url: `https://${site}/browse/ABC-3` };
  assert.deepEqual(
    blocked?.nativeBlockers.map((b) => ({ label: b.label, url: b.url })),
    [expected],
  );
  const listed = (await f.api.readTaskListPage()).data.tasks.find(
    (task) => task.id === taskOf("10001"),
  );
  assert.deepEqual(
    listed?.source?.openBlockers.map((b) => ({ label: b.label, url: b.url })),
    [expected],
  );
});

test("a Jira readiness loss gives the lead one source-hold notice, and a repeat read none", async (t) => {
  const f = await fixture(t, { lead: true });
  await f.configureCredential();
  await f.configureJira([{ id: "S-1", kind: "jql", jql: "project = ABC" }], 1, {
    mode: "all",
    conditions: [{ kind: "status", operator: "in", statusIds: ["1"] }],
  });
  f.state.issues["project = ABC"] = [jiraIssue(1)];
  await f.api.refreshSources();
  const domain = f.service.domain();
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const taskId = String(stores.issue("10001")?.taskId);
  const leadId = String(domain.ensureLeadAssignment(taskId)?.id);
  const db = new DatabaseSync(join(f.dataDir, "standalone.sqlite"));
  t.after(() => db.close());
  db.prepare("UPDATE domain_assignments SET state = 'held' WHERE id = ?").run(
    leadId,
  );
  const notices = () =>
    Number(
      (
        db
          .prepare(
            "SELECT count(*) AS count FROM coordination_inbox_events WHERE recipientAssignmentId = ? AND eventType = 'source-hold'",
          )
          .get(leadId) as { count: number }
      ).count,
    );
  f.state.issues["project = ABC"] = [
    jiraIssue(1, { status: { id: "3", name: "In Progress" } }),
  ];
  await f.api.refreshSources();
  assert.equal(stores.hold("10001")?.reason, "readiness-lost");
  assert.equal(notices(), 1);
  await f.api.refreshSources();
  assert.equal(notices(), 1);
});
