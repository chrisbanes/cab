import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { databaseOf } from "../fixtures/service-internals.js";
import { jiraIssue, json } from "../fixtures/fake-jira.js";
import { tmpdir } from "../fixtures/temp.js";

async function fixture(
  t: { after: (f: () => Promise<void> | void) => void },
  mode: "skip" | "done" = "done",
) {
  const names = {
    FIXTURE_CLOSURE_SITE: "https://example.atlassian.net",
    FIXTURE_CLOSURE_SECOND_SITE: "https://second.atlassian.net",
    FIXTURE_CLOSURE_EMAIL: "test@example.test",
    FIXTURE_CLOSURE_TOKEN: "fake-token",
  };
  for (const [name, value] of Object.entries(names)) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
  const first = { closed: false, partial: false, title: "Issue 7" };
  const second = { closed: false, partial: false, title: "Issue 7" };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const observed = url.hostname === "second.atlassian.net" ? second : first;
    const path = url.pathname;
    if (path.endsWith("/jql/parse")) return json({ queries: [{ query: "q" }] });
    if (path.endsWith("/search/jql"))
      return observed.partial
        ? new Response("", { status: 503 })
        : json({
            issues: [
              jiraIssue(7, { done: observed.closed, summary: observed.title }),
            ],
          });
    return json(
      jiraIssue(7, { done: observed.closed, summary: observed.title }),
    );
  };
  const root = mkdtempSync(join(tmpdir(), "cab-jira-closure-"));
  const runtime: Runtime = {
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      throw new Error("unused");
    },
    async resumeThread() {},
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {},
    async waitForTurn() {
      throw new Error("unused");
    },
  };
  const make = () =>
    new StandaloneService(join(root, "data"), () => runtime, undefined, {
      runtimeHarnesses: ["codex"],
      power: { enabled: false },
      routingClient: null,
      issueTrackers: { jiraFetcher: fetcher, intervalMs: 3_600_000 },
    });
  let service = make();
  await service.start();
  t.after(async () => {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const projectId = randomUUID();
  service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Closure",
    leadProfileId: null,
  });
  service.domain().execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: "example.atlassian.net",
    credential: {
      siteRef: "env:FIXTURE_CLOSURE_SITE",
      emailRef: "env:FIXTURE_CLOSURE_EMAIL",
      tokenRef: "env:FIXTURE_CLOSURE_TOKEN",
    },
  });
  await new OperatorApi(service, [root]).execute({
    type: "jira.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance: "example.atlassian.net",
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    closedIssues: mode,
  });
  await service.refreshGitHub();
  const sources = () =>
    service
      .githubSources()
      .forTracker({ provider: "jira", instance: "example.atlassian.net" });
  const taskId = String(sources().issue("10007")?.taskId);
  assert.equal(service.domain().task(taskId).state, "open");
  return {
    get service() {
      return service;
    },
    observed: first,
    second,
    taskId,
    sources,
    projectId,
    addSecond: async () => {
      const projectId = randomUUID();
      service.domain().execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        name: "Second",
        leadProfileId: null,
      });
      service.domain().execute({
        type: "issue-tracker-credential.configure",
        actor: "operator",
        key: randomUUID(),
        issueTracker: "jira",
        instance: "second.atlassian.net",
        credential: {
          siteRef: "env:FIXTURE_CLOSURE_SECOND_SITE",
          emailRef: "env:FIXTURE_CLOSURE_EMAIL",
          tokenRef: "env:FIXTURE_CLOSURE_TOKEN",
        },
      });
      await new OperatorApi(service, [root]).execute({
        type: "jira.configure",
        key: randomUUID(),
        projectId,
        expectedVersion: 1,
        instance: "second.atlassian.net",
        closedIssues: "done",
        selections: [{ id: "S-1", kind: "jql", jql: "q" }],
      });
      await service.refreshGitHub();
      return String(
        service
          .githubSources()
          .forTracker({ provider: "jira", instance: "second.atlassian.net" })
          .issue("10007")?.taskId,
      );
    },
    read: async () =>
      (await new OperatorApi(service, [root]).readTask(taskId)).data,
    restart: async () => {
      await service.stop();
      service = make();
      await service.start();
    },
  };
}

for (const mode of ["skip", "done"] as const)
  test(`Jira ${mode} closure converges on refresh and reverses on external reopen`, async (t) => {
    const f = await fixture(t, mode);
    f.observed.closed = true;
    await f.service.refreshGitHub();
    assert.equal(
      f.service.domain().task(f.taskId).state,
      mode === "done" ? "done" : "open",
    );
    assert.equal(f.sources().hold("10007")?.reason, "closed");
    assert.equal(
      Boolean(f.sources().providerCompletion(f.taskId)),
      mode === "done",
    );
    assert.equal(
      (await f.read()).source?.closure,
      mode === "done" ? "completed" : "held",
    );
    f.observed.closed = false;
    await f.service.refreshGitHub();
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.sources().providerCompletion(f.taskId), undefined);
    assert.equal(f.sources().hold("10007")?.reason, "closed");
  });

test("startup completes a newly visible Jira closure only after complete current evidence", async (t) => {
  const f = await fixture(t);
  f.observed.closed = true;
  f.observed.partial = true;
  await f.restart();
  assert.equal(f.service.domain().task(f.taskId).state, "open");
  assert.equal(f.sources().providerCompletion(f.taskId), undefined);
  f.observed.partial = false;
  await f.restart();
  assert.equal(f.service.domain().task(f.taskId).state, "done");
  assert.ok(f.sources().providerCompletion(f.taskId));
});

test("changed text remains stricter than a Jira closure", async (t) => {
  const f = await fixture(t);
  f.observed.title = "Changed scope";
  await f.service.refreshGitHub();
  f.observed.closed = true;
  await f.service.refreshGitHub();
  assert.equal(f.sources().hold("10007")?.reason, "changed-text");
  assert.equal(f.service.domain().task(f.taskId).state, "open");
});

for (const hold of ["stop", "uncertain"] as const)
  test(`Jira closure preserves ${hold} ownership across restart`, async (t) => {
    const f = await fixture(t);
    if (hold === "stop")
      await f.service.controlTask({
        type: "task.stop",
        key: randomUUID(),
        taskId: f.taskId,
      });
    else
      databaseOf(f.service)
        .prepare(
          "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'uncertain execution owner')",
        )
        .run(f.taskId);
    f.observed.closed = true;
    await f.restart();
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.sources().hold("10007")?.reason, "closed");
    assert.equal(f.sources().providerCompletion(f.taskId), undefined);
  });

test("startup and ordinary refresh keep colliding Jira issue IDs on separate sites independent", async (t) => {
  const f = await fixture(t);
  const secondTask = await f.addSecond();
  assert.notEqual(f.taskId, secondTask);
  f.observed.closed = true;
  await f.restart();
  assert.equal(f.service.domain().task(f.taskId).state, "done");
  assert.equal(f.service.domain().task(secondTask).state, "open");
  f.second.closed = true;
  await f.service.refreshGitHub();
  assert.equal(f.service.domain().task(secondTask).state, "done");
  f.observed.closed = false;
  await f.service.refreshGitHub();
  assert.equal(f.service.domain().task(f.taskId).state, "open");
  assert.equal(f.service.domain().task(secondTask).state, "done");
});

test("operator reopen under Jira Done recompletes only while settled; Skip keeps it open", async (t) => {
  const f = await fixture(t);
  f.observed.closed = true;
  await f.service.refreshGitHub();
  const reopen = () =>
    f.service.domain().execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: Number(f.service.domain().task(f.taskId).version),
      state: "open",
    });
  reopen();
  await f.service.refreshGitHub();
  assert.equal(f.service.domain().task(f.taskId).state, "done");
  f.service.domain().execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.service.domain().jiraConfiguration(f.projectId)!.version,
    instance: "example.atlassian.net",
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    closedIssues: "skip",
  });
  await f.service.refreshGitHub();
  assert.equal(f.service.domain().task(f.taskId).state, "open");
});
