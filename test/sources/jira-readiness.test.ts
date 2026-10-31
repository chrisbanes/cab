import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { insertExternalItem } from "../fixtures/source-rows.js";
import type { z } from "zod";
import { DomainStore } from "../../src/core/domain.js";
import type { jiraReadinessSchema } from "../../src/core/github-source-contracts.js";
import {
  GitHubSourceStore,
  type IssueSnapshot,
} from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";

const instance = "example.atlassian.net";
const jira = { provider: "jira", instance } as const;
type JiraRule = z.output<typeof jiraReadinessSchema>;
type Rule = JiraRule | null;

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
  status: { id: "10001", name: "Selected", categoryKey: "new" },
  selectFields: [],
  projectFields: [],
  ...over,
});
const complete = (...issues: IssueSnapshot[]) => ({
  complete: true as const,
  issues,
  reason: null,
});
const select = (optionId: string) => ({
  fieldId: "customfield_10010",
  optionId,
  name: `Option ${optionId}`,
});

function setup(initial: Rule = null) {
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
  const configure = (rule: Rule | undefined) =>
    domain.execute({
      type: "jira.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: domain.jiraConfiguration(projectId)?.version ?? 1,
      instance,
      selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
      ...(rule === undefined ? {} : { readiness: rule }),
    });
  configure(initial);
  const sources = new GitHubSourceStore(db, jira);
  const config = () => ({
    projectId,
    configVersion: domain.jiraConfiguration(projectId)?.version ?? 0,
    credentialRef: null,
  });
  const read = (...issues: IssueSnapshot[]) =>
    sources.reconcileSelection(projectId, "S-1", complete(...issues), config());
  const taskId = (nodeId = "10001") => String(sources.issue(nodeId)?.taskId);
  const view = (nodeId = "10001") =>
    sources.readinessByTask([taskId(nodeId)]).get(taskId(nodeId));
  return { db, domain, sources, projectId, configure, read, taskId, view };
}

const status = (
  operator: "in" | "not-in",
  ...statusIds: string[]
): JiraRule["conditions"][number] => ({ kind: "status", operator, statusIds });
const options = (
  operator: "in" | "not-in",
  ...optionIds: string[]
): JiraRule["conditions"][number] => ({
  kind: "select-field",
  fieldId: "customfield_10010",
  operator,
  optionIds,
});
const rule = (
  mode: "all" | "any",
  ...conditions: JiraRule["conditions"]
): JiraRule => ({ mode, conditions });

const outcome = (
  conditions: JiraRule["conditions"],
  over: Partial<IssueSnapshot>,
  mode: "all" | "any" = "all",
) => {
  const w = setup(rule(mode, ...conditions));
  w.read(issue(over));
  return w.view()?.outcome;
};

test("status conditions match by status ID, and not-in is the complement", () => {
  assert.equal(outcome([status("in", "10001")], {}), "matched");
  assert.equal(
    outcome([status("in", "10001")], {
      status: { id: "10002", name: "Other", categoryKey: "new" },
    }),
    "unmet",
  );
  assert.equal(outcome([status("not-in", "10002")], {}), "matched");
  assert.equal(outcome([status("not-in", "10001")], {}), "unmet");
});

test("label conditions match by name without regard to case", () => {
  assert.equal(
    outcome([{ kind: "label", operator: "has", name: "Ready" }], {
      labels: ["ready"],
    }),
    "matched",
  );
  assert.equal(
    outcome([{ kind: "label", operator: "lacks", name: "Ready" }], {
      labels: ["READY"],
    }),
    "unmet",
  );
  assert.equal(
    outcome([{ kind: "label", operator: "lacks", name: "Ready" }], {}),
    "matched",
  );
});

test("select-field conditions match by option ID; an unobserved value never satisfies one", () => {
  assert.equal(
    outcome([options("in", "20")], { selectFields: [select("20")] }),
    "matched",
  );
  assert.equal(
    outcome([options("in", "20")], { selectFields: [select("21")] }),
    "unmet",
  );
  assert.equal(outcome([options("in", "20")], {}), "unmet");
  assert.equal(
    outcome([options("not-in", "20")], { selectFields: [select("21")] }),
    "matched",
  );
  assert.equal(
    outcome([options("not-in", "20")], { selectFields: [select("20")] }),
    "unmet",
  );
  // `not-in` needs a value, as for a GitHub Project field.
  assert.equal(outcome([options("not-in", "20")], {}), "unmet");
});

test("all and any modes list exactly the unmet conditions, and counts agree with Ready", () => {
  const conditions = [
    status("in", "10001"),
    options("in", "20"),
    { kind: "label" as const, operator: "has" as const, name: "go" },
  ];
  const all = setup(rule("all", ...conditions));
  all.read(issue({ selectFields: [select("21")], labels: ["go"] }));
  assert.deepEqual(all.view()?.unmet, [conditions[1]]);
  assert.equal(all.view()?.outcome, "unmet");
  assert.equal(
    all.sources.selectionCounts(all.projectId).get("S-1")?.matching,
    0,
  );
  const any = setup(rule("any", ...conditions));
  any.read(issue({ selectFields: [select("21")], labels: ["go"] }));
  assert.equal(any.view()?.outcome, "matched");
  assert.deepEqual(any.view()?.unmet, []);
  assert.equal(
    any.sources.selectionCounts(any.projectId).get("S-1")?.matching,
    1,
  );
  any.read(
    issue({
      selectFields: [select("21")],
      status: { id: "10009", name: "Other", categoryKey: "new" },
    }),
  );
  assert.deepEqual(any.view()?.unmet, conditions);
  assert.equal(
    any.sources.selectionCounts(any.projectId).get("S-1")?.matching,
    0,
  );
});

test("losing readiness holds the task, a partial read releases nothing, and a complete read in rule releases it", () => {
  const w = setup(rule("all", status("in", "10001")));
  w.read(issue());
  w.sources.reconcileBlockers("10001", {
    complete: true,
    blockers: [],
    reason: null,
  });
  const reasons = () => w.domain.admission(w.taskId()).reasons;
  for (const reason of [
    "task-unready",
    "source-hold",
    "imported-blockers-unknown",
  ])
    assert.ok(!reasons().includes(reason), reason);
  const moved = issue({
    status: { id: "10002", name: "Done?", categoryKey: "new" },
  });
  w.read(moved);
  assert.ok(reasons().includes("task-unready"));
  assert.ok(reasons().includes("source-hold"));
  // A partial read that still shows the old status does not release the hold.
  w.sources.reconcileSelection(
    w.projectId,
    "S-1",
    { complete: false, issues: [issue()], reason: "rate-limited" },
    { projectId: w.projectId, configVersion: 2, credentialRef: null },
  );
  assert.ok(reasons().includes("source-hold"));
  w.read(issue());
  assert.ok(!reasons().includes("source-hold"));
  assert.ok(!reasons().includes("task-unready"));
});

test("a Jira rule accepts only Jira conditions and a GitHub source refuses them", () => {
  const w = setup();
  assert.throws(() =>
    w.configure({
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: "P",
          fieldNodeId: "F",
          operator: "in",
          optionNodeIds: ["O"],
        },
      ],
    } as never),
  );
  assert.throws(() =>
    w.configure({
      mode: "all",
      conditions: [
        {
          kind: "select-field",
          fieldId: "priority",
          operator: "in",
          optionIds: ["1"],
        },
      ],
    } as never),
  );
  const w2 = setup();
  assert.throws(
    () =>
      w2.domain.execute({
        type: "github.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: w2.projectId,
        expectedVersion: 2,
        credentialRef: "env:TEST_GITHUB",
        selections: [],
        readiness: { mode: "all", conditions: [status("in", "1")] } as never,
      }),
    /readiness|invalid/i,
  );
});

test("jira.configure keeps the saved rule when readiness is omitted and clears it on null", () => {
  const saved = rule("all", status("in", "10001"));
  const w = setup(saved);
  w.configure(undefined);
  assert.deepEqual(w.domain.jiraConfiguration(w.projectId)?.readiness, saved);
  w.configure(null);
  assert.equal(w.domain.jiraConfiguration(w.projectId)?.readiness, null);
});

test("an existing database gains the observed fields column once, keeping its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE external_items (
    provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
    taskId TEXT NOT NULL UNIQUE, containerId TEXT NOT NULL,
    containerName TEXT NOT NULL, number INTEGER NOT NULL,
    observedTitle TEXT NOT NULL, observedBody TEXT NOT NULL, observedState TEXT NOT NULL,
    labels TEXT NOT NULL, observedStatus TEXT, PRIMARY KEY(provider, instance, externalId));`);
  insertExternalItem(db, {
    provider: "jira",
    instance,
    externalId: "10001",
    taskId: "t1",
    containerId: "10000",
    containerName: "ABC",
    number: 1,
    observedTitle: "T",
    observedBody: "B",
    observedState: "open",
    labels: "[]",
    observedStatus: '{"id":"1","name":"To Do","categoryKey":"new"}',
  });
  new GitHubSourceStore(db).migrate();
  new GitHubSourceStore(db).migrate();
  assert.deepEqual(
    {
      ...(db
        .prepare(
          "SELECT externalId, observedStatus, observedFields FROM external_items",
        )
        .get() as object),
    },
    {
      externalId: "10001",
      observedStatus: '{"id":"1","name":"To Do","categoryKey":"new"}',
      observedFields: null,
    },
  );
});
