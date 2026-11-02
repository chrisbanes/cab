import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { IssueSnapshot } from "../../src/core/github-source.js";
import type { Runtime } from "../../src/standalone/codex.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { fakeJira, jiraIssue, json } from "../fixtures/fake-jira.js";
import { databaseOf } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";

/**
 * A planned shutdown requeues the interrupted lead turn of an imported task. Startup
 * re-observes the provider and revises the task, so the requeue is admitted only if the
 * task is still admissible and otherwise holds with the structural reason.
 */

type Tracker = "github" | "jira";

/** What the provider reports; changed between runs while the service is down. */
interface World {
  ready: boolean;
  blocked: boolean;
  /** The GitHub issue's title, when edited from the fixture's. */
  title?: string;
}

const githubIssue: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Imported",
  body: "Ship",
  state: "open",
  labels: ["ready"],
  projectFields: [],
};

const jiraSite = "example.atlassian.net";
const jiraEnv = {
  FIXTURE_JIRA_SITE: `https://${jiraSite}`,
  FIXTURE_JIRA_EMAIL: "chris@example.test",
  FIXTURE_JIRA_TOKEN: "jira-token-canary-1454",
};
const jiraBlocker = {
  type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
  inwardIssue: {
    id: "10002",
    key: "ABC-2",
    fields: { status: { statusCategory: { key: "indeterminate" } } },
  },
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  describe: () => unknown = () => undefined,
) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A turn runs until interrupted, which fails it, unless `auto` completes turns at once. */
class Turns implements Runtime {
  auto = false;
  startedTurns = 0;
  readonly resumed: string[] = [];
  readonly prompts: string[] = [];
  private readonly waits = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();

  private wait(turnId: string) {
    let entry = this.waits.get(turnId);
    if (!entry) {
      entry = deferred();
      this.waits.set(turnId, entry);
    }
    return entry;
  }

  async start() {}
  async stop() {}
  async startThread() {
    return "thread-1";
  }
  async resumeThread(threadId: string) {
    this.resumed.push(threadId);
  }
  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    this.prompts.push(prompt);
    const turnId = `turn-${++this.startedTurns}`;
    if (this.auto) this.wait(turnId).resolve("completed");
    return turnId;
  }
  async interruptTurn(_threadId: string, turnId: string) {
    this.wait(turnId).resolve("failed");
  }
  waitForTurn(_threadId: string, turnId: string) {
    return this.wait(turnId).promise;
  }
  onUnexpectedRequest() {}
}

const sandbox = (t: { after(fn: () => unknown): void }) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-imported-shutdown-")),
  );
  const services: StandaloneService[] = [];
  t.after(async () => {
    for (const service of services) await service.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    track(service: StandaloneService) {
      services.push(service);
      return service;
    },
  };
};

function sourceRepository(root: string) {
  const path = join(root, "source");
  mkdirSync(path);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(path, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "fixture");
  return path;
}

/** The first service's imported task, with the lead's turn running. */
async function importedFixture(
  t: { after(fn: () => unknown): void },
  tracker: Tracker,
  options: { pausedAtStop?: boolean } = {},
) {
  const box = sandbox(t);
  const world: World = { ready: true, blocked: false };
  const environment = Object.keys(jiraEnv) as (keyof typeof jiraEnv)[];
  const previous = environment.map((name) => process.env[name]);
  for (const name of environment) process.env[name] = jiraEnv[name];
  t.after(() => {
    environment.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });
  const jira = fakeJira((request) => {
    if (request.url.pathname.endsWith("/myself"))
      return json({ accountId: "acct-1", displayName: "Chris" });
    if (request.url.pathname.endsWith("/jql/parse"))
      return json({ queries: [{ query: "project = ABC" }] });
    return json({
      issues: [
        jiraIssue(1, {
          ...(world.ready ? {} : { status: { id: "3", name: "In Progress" } }),
          issuelinks: world.blocked ? [jiraBlocker] : [],
        }),
      ],
    });
  });
  const githubReader = {
    async readSelection() {
      return {
        complete: true as const,
        issues: [
          {
            ...githubIssue,
            title: world.title ?? githubIssue.title,
            labels: world.ready ? ["ready"] : [],
          },
        ],
        reason: null,
      };
    },
    async readBlockers() {
      return {
        complete: true,
        blockers: world.blocked
          ? [{ ...githubIssue, nodeId: "B_7", number: 7, title: "Blocker" }]
          : [],
        reason: null,
      };
    },
    async readIssueStatus() {
      return { status: "open" as const };
    },
  };
  const serviceFor = (runtime: Turns) =>
    box.track(
      new StandaloneService(join(box.root, "data"), () => runtime, undefined, {
        runtimeHarnesses: ["codex"],
        power: { enabled: false },
        routingClient: null,
        supervisor: { shutdownWaitMs: 2000 },
        issueTrackers: {
          readerFactories: { github: () => githubReader },
          jiraFetcher: jira.fetcher,
          intervalMs: 3_600_000,
        },
      }),
    );
  const firstRuntime = new Turns();
  const service = serviceFor(firstRuntime);
  await service.start();
  const domain = service.domain();
  const projectId = randomUUID();
  const profileId = randomUUID();
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
    paused: false,
  });
  await domain.configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: domain.repositoryLinks(projectId).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: tracker === "github" ? "R_1" : "10000",
        path: sourceRepository(box.root),
        ref: "main",
      },
    ],
  });
  const refreshOf = async (running: StandaloneService) => {
    if (tracker === "github") await running.refreshGitHub();
    else
      await new OperatorApi(running, [join(box.root, "data")]).refreshSources();
  };
  const refresh = () => refreshOf(service);
  /** The same GitHub selection and rule, saved again and re-activated. */
  const reconfigureGitHub = (running: StandaloneService) => {
    const d = running.domain();
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(d.githubConfiguration(projectId).version),
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
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    d.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: Number(d.githubConfiguration(projectId).version),
    });
  };
  if (tracker === "github") reconfigureGitHub(service);
  else {
    const api = new OperatorApi(service, [join(box.root, "data")]);
    await api.execute({
      type: "issue-tracker-credential.configure",
      key: randomUUID(),
      issueTracker: "jira",
      siteRef: "env:FIXTURE_JIRA_SITE",
      emailRef: "env:FIXTURE_JIRA_EMAIL",
      tokenRef: "env:FIXTURE_JIRA_TOKEN",
    });
    await api.execute({
      type: "jira.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      instance: jiraSite,
      selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
      readiness: {
        mode: "all",
        conditions: [{ kind: "status", operator: "in", statusIds: ["1"] }],
      },
    } as never);
  }
  await refresh();
  await waitUntil(
    () => firstRuntime.startedTurns === 1,
    () => service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
  );
  const taskId = String(
    tracker === "github"
      ? service.githubSources().issue("I_1")?.taskId
      : service
          .githubSources()
          .forTracker({ provider: "jira", instance: jiraSite })
          .issue("10001")?.taskId,
  );
  const interruptedThread = service
    .list()
    .find((item) => item.threadId)?.threadId;
  assert.ok(interruptedThread);
  if (options.pausedAtStop) setPaused(service, projectId, true);
  await service.stop();
  const closed = <T>(sql: string, ...params: string[]) => {
    const db = new DatabaseSync(join(box.root, "data", "standalone.sqlite"), {
      readOnly: true,
    });
    try {
      return db
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })) as T[];
    } finally {
      db.close();
    }
  };
  const requeue = closed<{ requeueWorkId: string }>(
    "SELECT requeueWorkId FROM execution_shutdown_resolutions",
  )[0]?.requeueWorkId;
  if (!requeue?.startsWith("shutdown:"))
    throw new Error("no shutdown requeue exists");
  const before = closed<{ taskVersion: number }>(
    "SELECT taskVersion FROM turn_requests WHERE workId = ?",
    requeue,
  )[0]?.taskVersion;
  assert.equal(
    closed<{ version: number }>(
      "SELECT version FROM domain_tasks WHERE id = ?",
      taskId,
    )[0]?.version,
    before,
    "the requeue captured the task's version at shutdown",
  );
  return {
    world,
    taskId,
    requeue,
    interruptedThread,
    projectId,
    taskVersionAtShutdown: before,
    refresh: refreshOf,
    reconfigureGitHub,
    /** Restarts on the same data root with whatever `world` now reports. */
    async restart(auto: boolean) {
      const runtime = new Turns();
      runtime.auto = auto;
      const restarted = serviceFor(runtime);
      await restarted.start();
      assert.ok(
        Number(restarted.domain().task(taskId).version) > Number(before),
        "startup re-observation revised the task",
      );
      return { service: restarted, runtime };
    },
  };
}

function setPaused(
  service: StandaloneService,
  projectId: string,
  paused: boolean,
) {
  const domain = service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    paused,
  } as never);
}

const stateOf = (service: StandaloneService, workId: string) =>
  service.list().find((item) => item.workId === workId);

const describe = (service: StandaloneService) => () => ({
  intents: service.list().map((i) => [i.workId, i.state, i.reason]),
  requests: service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
});

const refusals = (service: StandaloneService) =>
  databaseOf(service)
    .prepare("SELECT COUNT(*) AS n FROM execution_request_refusals")
    .get()?.n;

/** The restart resumes the interrupted thread once, on the re-observed revision. */
async function assertResumedOnce(
  f: Awaited<ReturnType<typeof importedFixture>>,
  started: ReturnType<typeof f.restart> = f.restart(true),
) {
  const { service, runtime } = await started;
  await waitUntil(
    () => stateOf(service, f.requeue)?.state === "completed",
    describe(service),
  );
  // The first turn after restart resumes the interrupted thread. A completed lead turn
  // without a result may queue its own repair, which is not the requeue.
  assert.equal(runtime.resumed[0], f.interruptedThread);
  const once = () =>
    databaseOf(service)
      .prepare(
        "SELECT COUNT(*) AS n FROM execution_intents WHERE workId = ? AND state = 'completed'",
      )
      .get(f.requeue)?.n;
  assert.equal(once(), 1);
  assert.equal(
    databaseOf(service)
      .prepare(
        "SELECT COUNT(*) AS n FROM turn_requests WHERE workId LIKE 'shutdown:%'",
      )
      .get()?.n,
    1,
  );
  assert.equal(
    databaseOf(service)
      .prepare("SELECT taskVersion FROM turn_requests WHERE workId = ?")
      .get(f.requeue)?.taskVersion,
    Number(service.domain().task(f.taskId).version),
  );
  assert.equal(refusals(service), 0);
  // A further wake does not run the requeue again.
  await service.refreshGitHub();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(once(), 1);
}

/** The restart holds the requeue with `expected` reasons, never the revision change. */
async function assertHeld(
  f: Awaited<ReturnType<typeof importedFixture>>,
  expected: RegExp,
) {
  const { service, runtime } = await f.restart(true);
  await waitUntil(
    () => stateOf(service, f.requeue)?.state === "held",
    describe(service),
  );
  const reason = String(stateOf(service, f.requeue)?.reason);
  assert.match(reason, expected);
  assert.doesNotMatch(reason, /task-revision-changed/);
  assert.equal(runtime.startedTurns, 0);
  assert.equal(refusals(service), 1);
}

test("a GitHub-imported lead requeue resumes once after an unchanged restart", async (t) => {
  await assertResumedOnce(await importedFixture(t, "github"));
});

test("a Jira-imported lead requeue resumes once after an unchanged restart", async (t) => {
  await assertResumedOnce(await importedFixture(t, "jira"));
});

test("a GitHub text edit while down is no admission reason: the requeue resumes once with the current text and diff", async (t) => {
  const f = await importedFixture(t, "github");
  f.world.title = "Edited while down";
  const started = f.restart(true);
  await assertResumedOnce(f, started);
  const { service, runtime } = await started;
  // Text is live and bumps no revision of its own: only the re-observation was absorbed.
  assert.equal(service.domain().task(f.taskId).title, "Edited while down");
  assert.match(
    runtime.prompts[0] ?? "",
    /^Task: Edited while down\n[\s\S]*\nTitle:\n- Imported\n\+ Edited while down\n/,
  );
});

test("a GitHub readiness loss while down holds the requeue with its own reason", async (t) => {
  const f = await importedFixture(t, "github");
  f.world.ready = false;
  await assertHeld(f, /task-unready|source-hold/);
});

test("a GitHub blocker opened while down holds the requeue as blocked", async (t) => {
  const f = await importedFixture(t, "github");
  f.world.blocked = true;
  await assertHeld(f, /imported-blockers-blocked/);
});

test("a Jira readiness loss while down holds the requeue with its own reason", async (t) => {
  const f = await importedFixture(t, "jira");
  f.world.ready = false;
  await assertHeld(f, /task-unready|source-hold/);
});

test("a Jira blocker opened while down holds the requeue as blocked", async (t) => {
  const f = await importedFixture(t, "jira");
  f.world.blocked = true;
  await assertHeld(f, /imported-blockers-blocked/);
});

// -- Waiting while paused ---------------------------------------------------

/** A project paused at stop keeps the restarted requeue waiting, allowance intact. */
async function restartPaused(f: Awaited<ReturnType<typeof importedFixture>>) {
  const restarted = await f.restart(true);
  await waitUntil(
    () =>
      /project-paused/.test(
        String(stateOf(restarted.service, f.requeue)?.reason),
      ),
    describe(restarted.service),
  );
  assert.equal(stateOf(restarted.service, f.requeue)?.state, "ready");
  assert.equal(restarted.runtime.startedTurns, 0);
  return restarted;
}

test("a paused project keeps an unchanged imported requeue waiting, then it resumes once when resumed", async (t) => {
  const f = await importedFixture(t, "github", { pausedAtStop: true });
  const restarted = await restartPaused(f);
  setPaused(restarted.service, f.projectId, false);
  await assertResumedOnce(f, Promise.resolve(restarted));
});

test("readiness lost while a paused requeue waits holds it with its own reason", async (t) => {
  const f = await importedFixture(t, "github", { pausedAtStop: true });
  const { service, runtime } = await restartPaused(f);
  f.world.ready = false;
  await f.refresh(service);
  await waitUntil(
    () => stateOf(service, f.requeue)?.state === "held",
    describe(service),
  );
  const reason = String(stateOf(service, f.requeue)?.reason);
  assert.match(reason, /task-unready|source-hold/);
  assert.doesNotMatch(reason, /task-revision-changed/);
  assert.equal(runtime.startedTurns, 0);
});

test("a clean re-observation while a paused requeue waits is absorbed and the requeue is admitted", async (t) => {
  const f = await importedFixture(t, "github", { pausedAtStop: true });
  const restarted = await restartPaused(f);
  const before = Number(restarted.service.domain().task(f.taskId).version);
  f.reconfigureGitHub(restarted.service);
  await f.refresh(restarted.service);
  assert.ok(
    Number(restarted.service.domain().task(f.taskId).version) > before,
    "the reconfiguration revised the task again",
  );
  setPaused(restarted.service, f.projectId, false);
  await assertResumedOnce(f, Promise.resolve(restarted));
});

// -- Local control ---------------------------------------------------------

/** A local task with a running worker assignment, stopped into a shutdown requeue. */
async function localFixture(
  t: { after(fn: () => unknown): void },
  pauseBeforeStop: boolean,
) {
  const box = sandbox(t);
  const make = (runtime: Turns) =>
    box.track(
      new StandaloneService(join(box.root, "data"), () => runtime, undefined, {
        runtimeHarnesses: ["codex"],
        power: { enabled: false },
        routingClient: null,
        supervisor: { shutdownWaitMs: 2000 },
      }),
    );
  const firstRuntime = new Turns();
  const service = make(firstRuntime);
  await service.start();
  const domain = service.domain();
  const execute = (command: Record<string, unknown>) =>
    domain.execute({
      key: randomUUID(),
      actor: "operator",
      ...command,
    } as never);
  const lead = randomUUID(),
    worker = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  for (const [profileId, name] of [
    [lead, "Lead"],
    [worker, "Worker"],
  ] as const)
    execute({
      type: "profile.create",
      profileId,
      name,
      instructions: name,
      capabilities: "code",
      runtime: { harness: "codex" },
    });
  execute({
    type: "project.create",
    projectId,
    name: "Local",
    leadProfileId: lead,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [worker],
  });
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Local",
    outcome: "Restart safely",
    ready: false,
  });
  await service.provisionTask(taskId);
  execute({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId: worker,
    brief: "build",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(() => firstRuntime.startedTurns === 1, describe(service));
  if (pauseBeforeStop)
    execute({
      type: "project.configure",
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
      paused: true,
    });
  const thread = service.list().find((item) => item.threadId)?.threadId;
  await service.stop();
  const shutdownRow = new DatabaseSync(
    join(box.root, "data", "standalone.sqlite"),
    { readOnly: true },
  );
  const requeue = (
    shutdownRow
      .prepare("SELECT requeueWorkId FROM execution_shutdown_resolutions")
      .get() as { requeueWorkId: string }
  ).requeueWorkId;
  shutdownRow.close();
  return {
    requeue,
    thread,
    projectId,
    taskId,
    async restart() {
      const runtime = new Turns();
      runtime.auto = true;
      const restarted = make(runtime);
      await restarted.start();
      return { service: restarted, runtime };
    },
  };
}

test("a local task's shutdown requeue resumes once after restart", async (t) => {
  const f = await localFixture(t, false);
  const { service, runtime } = await f.restart();
  await waitUntil(
    () => stateOf(service, f.requeue)?.state === "completed",
    describe(service),
  );
  // Only the requeue resumes the interrupted thread first; a repair turn may follow.
  assert.equal(runtime.resumed[0], f.thread);
  assert.equal(
    databaseOf(service)
      .prepare(
        "SELECT COUNT(*) AS n FROM execution_intents WHERE workId = ? AND state = 'completed'",
      )
      .get(f.requeue)?.n,
    1,
  );
});

test("a local task revised after restart still holds as stale, so the allowance is imported-only", async (t) => {
  const f = await localFixture(t, true);
  const { service, runtime } = await f.restart();
  const domain = service.domain();
  // The paused project keeps the requeue waiting; revising the task now is a bump after startup.
  await waitUntil(
    () => stateOf(service, f.requeue)?.state === "ready",
    describe(service),
  );
  const revise = (command: Record<string, unknown>) =>
    domain.execute({
      key: randomUUID(),
      actor: "operator",
      projectId: f.projectId,
      ...command,
    } as never);
  revise({
    type: "task.configure",
    taskId: f.taskId,
    expectedVersion: Number(domain.task(f.taskId).version),
    title: "Revised",
  });
  revise({
    type: "project.configure",
    expectedVersion: Number(domain.project(f.projectId).version),
    paused: false,
  });
  await waitUntil(
    () => stateOf(service, f.requeue)?.state === "held",
    describe(service),
  );
  assert.match(
    String(stateOf(service, f.requeue)?.reason),
    /task-revision-changed/,
  );
  assert.equal(runtime.startedTurns, 0);
});
