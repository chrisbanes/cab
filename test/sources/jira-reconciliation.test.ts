import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import {
  type IssueSnapshot,
  GitHubSourceStore,
} from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";

const instance = "example.atlassian.net";
const jira = { provider: "jira", instance } as const;
const issue = (over: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  providerInstance: instance,
  nodeId: "10001",
  repositoryId: "10000",
  repositoryName: "ABC",
  number: 12,
  title: "Jira issue",
  body: "From Jira",
  state: "open",
  labels: [],
  status: { id: "1", name: "To Do", categoryKey: "new" },
  projectFields: [],
  ...over,
});

function setup() {
  const db = new DatabaseSync(":memory:");
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
    instance,
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
    instance,
    selections: [
      { id: "S-1", kind: "jql", jql: "project = ABC" },
      { id: "S-2", kind: "jql", jql: "labels = ready" },
    ],
  });
  const sources = new GitHubSourceStore(db, jira);
  const config = () => ({
    projectId,
    configVersion: domain.jiraConfiguration(projectId)?.version ?? 0,
    credentialRef: null,
  });
  return { db, domain, sources, projectId, config };
}
const complete = (...issues: IssueSnapshot[]) => ({
  complete: true as const,
  issues,
  reason: null,
});

test("a complete Jira read imports a task keyed by provider and instance, with its status", () => {
  const { db, domain, sources, projectId, config } = setup();
  assert.equal(
    sources.reconcileSelection(projectId, "S-1", complete(issue()), config()),
    true,
  );
  const row = db
    .prepare(
      "SELECT provider, instance, externalId, containerId, containerName, number, observedStatus FROM external_items",
    )
    .get() as Record<string, string | number>;
  assert.deepEqual(
    { ...row },
    {
      provider: "jira",
      instance,
      externalId: "10001",
      containerId: "10000",
      containerName: "ABC",
      number: 12,
      observedStatus: JSON.stringify({
        id: "1",
        name: "To Do",
        categoryKey: "new",
      }),
    },
  );
  const imported = domain.importedTask(String(sources.issue("10001")?.taskId));
  assert.equal(imported?.provider, "jira");
  assert.equal(imported?.instance, instance);
  // Blockers are unread until #1319, so admission refuses the task.
  assert.ok(
    domain
      .admission(String(imported?.taskId))
      .reasons.includes("imported-blockers-unknown"),
  );
});

test("a later read updates the item, and changed text sets the ordinary hold", () => {
  const { sources, projectId, config } = setup();
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  sources.reconcileSelection(
    projectId,
    "S-1",
    complete(
      issue({
        status: { id: "3", name: "In Progress", categoryKey: "indeterminate" },
      }),
    ),
    config(),
  );
  assert.equal(sources.hold("10001")?.active ?? 0, 0);
  sources.reconcileSelection(
    projectId,
    "S-1",
    complete(issue({ title: "Renamed" })),
    config(),
  );
  assert.equal(sources.issue("10001")?.observedTitle, "Renamed");
  assert.equal(sources.hold("10001")?.reason, "changed-text");
});

test("one issue in two selections is one task with two memberships", () => {
  const { domain, sources, projectId, config } = setup();
  for (const id of ["S-1", "S-2"])
    sources.reconcileSelection(projectId, id, complete(issue()), config());
  assert.equal(domain.tasks(projectId).length, 1);
  assert.deepEqual(
    sources.memberships("10001").map((m) => m.selectionId),
    ["S-1", "S-2"],
  );
});

test("a complete read without the issue withdraws it after the missed-read rule", () => {
  const { sources, projectId, config } = setup();
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  sources.reconcileSelection(projectId, "S-2", complete(), config());
  // Ready, then it leaves its only selection.
  sources.reconcileSelection(projectId, "S-1", complete(), config());
  assert.equal(sources.memberships("10001").length, 0);
  assert.equal(sources.hold("10001")?.reason, "withdrawn");
});

test("an issue Jira reports done holds its open task as an external closure", () => {
  const { sources, projectId, config } = setup();
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  sources.reconcileSelection(
    projectId,
    "S-1",
    complete(
      issue({
        state: "closed",
        status: { id: "9", name: "Done", categoryKey: "done" },
      }),
    ),
    config(),
  );
  assert.equal(sources.issue("10001")?.observedState, "closed");
  assert.equal(sources.hold("10001")?.reason, "closed");
});

test("a closed Jira issue is not imported while the source skips closed issues", () => {
  const { db, sources, projectId, config } = setup();
  sources.reconcileSelection(
    projectId,
    "S-1",
    complete(issue({ state: "closed" })),
    config(),
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM external_items").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("an incomplete read keeps memberships and tasks and never holds", () => {
  const { domain, sources, projectId, config } = setup();
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  sources.reconcileSelection(
    projectId,
    "S-1",
    { complete: false, issues: [], reason: "rate-limited" },
    config(),
  );
  assert.equal(sources.memberships("10001").length, 1);
  assert.equal(domain.tasks(projectId).length, 1);
  assert.equal(sources.hold("10001"), undefined);
});

test("a GitHub item and a Jira item with the same external ID stay separate", () => {
  const { db, domain, sources, projectId, config } = setup();
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  // A second project on GitHub with the colliding external ID.
  const githubProject = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: githubProject,
    name: "Beta",
    leadProfileId: null,
  });
  domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: githubProject,
    expectedVersion: 1,
    credentialRef: "env:TEST_GITHUB",
    selections: [{ id: "search", kind: "search", query: "x" }],
    readiness: null,
  });
  domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: githubProject,
    selectionId: "search",
    expectedVersion: 2,
  });
  new GitHubSourceStore(db).reconcileSelection(
    githubProject,
    "search",
    complete(
      issue({ providerInstance: "github.com", repositoryName: "org/repo" }),
    ),
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM external_items").get() as {
        n: number;
      }
    ).n,
    2,
  );
  assert.equal(
    new GitHubSourceStore(db).issue("10001")?.providerInstance,
    "github.com",
  );
  assert.equal(sources.issue("10001")?.providerInstance, instance);
});

test("a GitHub-bound store updates a Jira task under the Jira key", () => {
  const { db, sources, projectId, config } = setup();
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  const taskId = String(sources.issue("10001")?.taskId);
  new GitHubSourceStore(db).updateReadiness(taskId);
  sources.reconcileSelection(
    projectId,
    "S-1",
    complete(issue({ state: "closed" })),
    config(),
  );
  new GitHubSourceStore(db).updateReadiness(taskId);
  assert.equal(sources.hold("10001")?.reason, "closed");
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM source_holds").get() as {
        n: number;
      }
    ).n,
    1,
  );
});

test("a Jira project has an empty GitHub view and refuses a GitHub save while in use", () => {
  const { domain, sources, projectId, config } = setup();
  assert.deepEqual(domain.githubConfiguration(projectId).selections, []);
  sources.reconcileSelection(projectId, "S-1", complete(issue()), config());
  assert.throws(
    () =>
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: domain.jiraConfiguration(projectId)?.version ?? 0,
        credentialRef: "env:TEST_GITHUB",
        selections: [],
        readiness: null,
      }),
    /Issue tracker in use/,
  );
  assert.equal(domain.jiraConfiguration(projectId)?.selections.length, 2);
});

test("an existing database gains the observed status column once, keeping its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE external_items (
    provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
    taskId TEXT NOT NULL UNIQUE, containerId TEXT NOT NULL,
    containerName TEXT NOT NULL, number INTEGER NOT NULL,
    observedTitle TEXT NOT NULL, observedBody TEXT NOT NULL, observedState TEXT NOT NULL,
    labels TEXT NOT NULL, PRIMARY KEY(provider, instance, externalId));
    INSERT INTO external_items VALUES ('github','github.com','I_1','t1','R_1','org/repo',1,'T','B','open','[]');`);
  new GitHubSourceStore(db).migrate();
  new GitHubSourceStore(db).migrate();
  assert.deepEqual(
    {
      ...(db
        .prepare("SELECT externalId, observedStatus FROM external_items")
        .get() as object),
    },
    { externalId: "I_1", observedStatus: null },
  );
});
