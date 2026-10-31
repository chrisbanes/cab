import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type DeliveryActionRecord,
  type PrDeliveryObservation,
  isServiceDeliveryCaller,
} from "../../src/core/delivery.js";
import type { StatusMapping } from "../../src/core/status-mapping-contracts.js";
import { statusMappingActionNote } from "../../src/operator/status-mapping-copy.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { jiraIssue, json } from "../fixtures/fake-jira.js";
import { fakeJiraIssue, issueId, target } from "../fixtures/fake-jira-issue.js";
import { databaseOf, startedOf } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";

const site = "example.atlassian.net";
const names = {
  site: "FIXTURE_JIRA_SITE",
  email: "FIXTURE_JIRA_EMAIL",
  token: "FIXTURE_JIRA_TOKEN",
};
const values = {
  site: `https://${site}`,
  email: "cab@example.test",
  token: "jira-token-canary-1321",
};
const TODO = "1",
  PROGRESS = "3",
  REVIEW = "4",
  DONE = "9";
const transition = (id: string, name: string, category: string) => ({
  id: `t${id}`,
  to: { id, name, category },
});

const mapping = (
  events: Partial<Extract<StatusMapping, { tracker: "jira" }>["events"]> = {},
): StatusMapping => ({
  tracker: "jira",
  events: {
    turnStarted: PROGRESS,
    handedBack: REVIEW,
    held: TODO,
    done: DONE,
    ...events,
  },
});

const pr: PrDeliveryObservation = {
  repositoryId: "R1",
  nodeId: "P7",
  number: 7,
  baseRef: "main",
  headRef: "cb/change",
  headSha: "1".repeat(40),
  baseSha: "2".repeat(40),
  state: "OPEN",
  draft: false,
  merged: false,
  reviewDecision: null,
  checks: [],
  closedIssueNodeIds: [],
  mergeBlockers: [],
  allowedMethods: ["squash"],
};

/**
 * A service on a scripted Jira site with ABC-7 imported, mapped, and its lead turn started. The
 * scripted site offers a transition to every status, as a team-managed project does.
 */
async function fixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  statusWriteTimeoutMs?: number,
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
  jira.state.transitions = [
    transition(TODO, "To Do", "new"),
    transition(PROGRESS, "In Progress", "indeterminate"),
    transition(REVIEW, "In Review", "indeterminate"),
    transition(DONE, "Done", "done"),
  ];
  let hold: Promise<void> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/jql/parse")) return json({ queries: [{ query: "q" }] });
    if (path.endsWith("/search/jql")) {
      const status = jira.state.status;
      return json({
        issues: [
          jiraIssue(7, {
            done: status.category === "done",
            status: { id: status.id, name: status.name },
          }),
        ],
      });
    }
    if (hold && init?.method === "POST" && path.endsWith("/transitions"))
      await hold;
    return jira.fetcher(input, init);
  };
  const root = mkdtempSync(join(tmpdir(), "cab-jira-status-"));
  const dataDir = join(root, "data");
  let started = false;
  let sequence = 0;
  let waiter: (() => void) | undefined;
  const turns: { threadId: string; turnId: string }[] = [];
  let tool: ((call: RuntimeToolCall) => Promise<RuntimeToolResult>) | undefined;
  const runtime: Runtime = {
    async start() {
      started = true;
    },
    async stop() {
      started = false;
      waiter?.();
    },
    onUnexpectedRequest() {},
    onToolCall(handler) {
      tool = handler;
    },
    async startThread() {
      return `thread-${++sequence}`;
    },
    async resumeThread() {},
    async startTurn(threadId) {
      const turnId = `turn-${++sequence}`;
      turns.push({ threadId, turnId });
      return turnId;
    },
    async interruptTurn() {
      waiter?.();
    },
    async waitForTurn() {
      await new Promise<void>((resolve) => {
        waiter = resolve;
        if (!started) resolve();
      });
      return "completed";
    },
  };
  const codeHost = {
    inspectPr: async () => pr,
  } as unknown as CodeHostDeliveryProvider;
  const make = () =>
    new StandaloneService(dataDir, () => runtime, undefined, {
      runtimeHarnesses: ["codex"],
      power: { enabled: false },
      routingClient: null,
      delivery: {
        providerFactories: { github: () => codeHost },
        ...(statusWriteTimeoutMs ? { statusWriteTimeoutMs } : {}),
      },
      issueTrackers: { jiraFetcher: fetcher, intervalMs: 3_600_000 },
    });
  const f = { service: make() } as {
    service: StandaloneService;
  } & Record<string, never>;
  t.after(async () => {
    started = false;
    waiter?.();
    await f.service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await f.service.start();
  const domain = () => f.service.domain();
  const projectId = randomUUID();
  const profileId = randomUUID();
  domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Alpha",
    leadProfileId: profileId,
  });
  domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "Deliver the scoped task.",
  });
  domain().execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    credential: {
      siteRef: `env:${names.site}`,
      emailRef: `env:${names.email}`,
      tokenRef: `env:${names.token}`,
    },
  });
  domain().execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance: site,
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    readiness: {
      mode: "all",
      conditions: [
        { kind: "status", operator: "in", statusIds: [TODO, PROGRESS, REVIEW] },
        { kind: "label", operator: "has", name: "ready" },
      ],
    },
  });
  await f.service.refreshGitHub();
  const taskId = String(
    f.service
      .githubSources()
      .forTracker({ provider: "jira", instance: site })
      .issue(issueId)?.taskId,
  );
  domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [
      ...(["issue.comment", "issue.close"] as const).map((action) => ({
        action,
        repositoryId: target.repositoryId,
        mode: "allow" as const,
      })),
      {
        action: "issue.status" as const,
        repositoryId: target.repositoryId,
        mode: "allow" as const,
        statusIds: [TODO, PROGRESS, REVIEW, DONE],
      },
    ],
    requiredChecks: [],
  });
  domain().execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mapping: mapping(),
  });
  await f.service.provisionTask(taskId);
  domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    paused: false,
  });
  const deadline = Date.now() + 5000;
  while (
    !turns[0] ||
    !f.service
      .list()
      .some((i) => i.turnId === turns[0]?.turnId && i.state === "running")
  ) {
    if (Date.now() > deadline) throw new Error("Bound turn did not start");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const turn = turns.at(-1);
    assert.ok(turn && tool);
    return tool({
      threadId: turn.threadId,
      turnId: turn.turnId,
      callId: randomUUID(),
      tool: name,
      arguments: args,
    });
  };
  const writes = (): DeliveryActionRecord[] =>
    f.service
      .delivery()
      .actions(taskId)
      .filter((a) => isServiceDeliveryCaller(a.binding));
  /** The status IDs transition POSTs were sent for, in order. */
  const posted = () =>
    jira.requests.flatMap((r) =>
      r.method === "POST" && r.url.pathname.endsWith("/transitions")
        ? [
            jira.state.transitions.find(
              (x) =>
                x.id ===
                (r.body as { transition: { id: string } }).transition.id,
            )?.to.id,
          ]
        : [],
    );
  return {
    jira,
    taskId,
    projectId,
    call,
    writes,
    posted,
    get service() {
      return f.service;
    },
    domain,
    holdPosts: (value: Promise<void> | undefined) => {
      hold = value;
    },
    run: () => f.service.runStatusMapping(),
    registerPr: async () =>
      assert.equal(
        (
          await call("cab_register_pr", {
            repositoryId: "R1",
            prNumber: 7,
            expectedPrNodeId: "P7",
            expectedHeadSha: pr.headSha,
          })
        ).success,
        true,
      ),
    stop: () =>
      f.service.controlTask({
        type: "task.stop",
        key: randomUUID(),
        taskId,
      }),
    resume: () =>
      f.service.controlTask({
        type: "task.resume",
        key: randomUUID(),
        taskId,
      }),
    finish: () =>
      domain().execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        expectedVersion: Number(domain().task(taskId).version),
        state: "done",
      }),
    restart: async () => {
      started = false;
      waiter?.();
      await f.service.stop();
      f.service = make();
      await f.service.start();
    },
  };
}
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

test("each event is written once per transition as one transition POST and confirmed by readback", async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  assert.equal(f.jira.state.status.id, PROGRESS);
  assert.equal(f.writes()[0]?.state, "confirmed-success");
  // Nothing changed, so a second pass writes nothing.
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);

  await f.registerPr();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW]);

  // Stopped: held. The mapped status is To Do, which readiness still accepts.
  await f.stop();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW, TODO]);
  // Resumed, the task re-enters an earlier event: a new transition writes again.
  await f.resume();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW, TODO, REVIEW]);
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW, TODO, REVIEW]);

  f.finish();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW, TODO, REVIEW, DONE]);
  assert.ok(f.writes().every((w) => w.state === "confirmed-success"));
  assert.deepEqual(
    f
      .writes()
      .map((w) => isServiceDeliveryCaller(w.binding) && w.binding.event),
    ["turnStarted", "handedBack", "held", "handedBack", "done"],
  );
  assert.deepEqual(
    f.writes().map((w) => w.request.action.kind),
    Array(5).fill("issue.status"),
  );
});

test("a status that moved in Jira since cab last saw it skips the write and shows on the task; a refresh while Ready re-bases the next write", async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  // A person moved the issue; no source read has seen it yet.
  f.jira.state.status = { id: TODO, name: "To Do", category: "new" };
  await f.registerPr();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  const skipped = f.writes()[1];
  assert.equal(skipped?.state, "confirmed-failure");
  assert.equal(skipped?.observation?.reason, "provider-issue-status-changed");
  assert.equal(
    statusMappingActionNote(skipped?.observation?.reason ?? null),
    "Skipped: the status changed in Jira since cab last saw it.",
  );
  // The transition is spent: the skipped write is not retried.
  await f.run();
  assert.equal(f.writes().length, 2);

  // A refresh while Ready observes the move; the next event writes against it.
  await later();
  await f.service.refreshGitHub();
  assert.equal(f.domain().task(f.taskId).ready, 1);
  await f.stop();
  await f.run();
  // Held maps to To Do, which the issue is already in.
  assert.equal(
    f.writes()[2]?.observation?.reason,
    "provider-issue-status-current",
  );
  assert.deepEqual(f.posted(), [PROGRESS]);
});

test("a refresh while Ready makes the newly observed status the next write's expectation", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.jira.state.status = { id: TODO, name: "To Do", category: "new" };
  await later();
  await f.service.refreshGitHub();
  await f.registerPr();
  await f.run();
  // Expected is the observed To Do, so the write is sent rather than skipped as changed.
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW]);
  assert.equal(f.writes()[1]?.state, "confirmed-success");
});

test("Done after the issue was closed by cab's own transition is a recorded no-op, not a second POST", async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  // The closure moved the issue to Done; the next source read observes it closed.
  f.jira.state.status = { id: DONE, name: "Done", category: "done" };
  await f.service.refreshGitHub();
  assert.equal(f.domain().task(f.taskId).ready, 0);
  f.finish();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  assert.equal(f.writes()[1]?.state, "confirmed-failure");
  assert.equal(
    f.writes()[1]?.observation?.reason,
    "provider-issue-status-current",
  );
  await f.run();
  assert.equal(f.writes().length, 2);
});

test("a done task that is not Ready while its issue is open, or was first seen done, writes nothing", async (t) => {
  const f = await fixture(t);
  await f.run();
  // A person moved it outside the rule while the issue stays open.
  f.jira.state.status = { id: "10", name: "Won't do", category: "new" };
  await f.service.refreshGitHub();
  assert.equal(f.domain().task(f.taskId).ready, 0);
  f.finish();
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  assert.equal(f.writes().length, 1);

  const g = await fixture(t);
  await g.run();
  assert.deepEqual(g.posted(), [PROGRESS]);
  // First seen done and closed: not worked on under the mapping.
  startedOf(g.service).statusMappings.forget(g.projectId);
  databaseOf(g.service).exec(
    "UPDATE domain_tasks SET state='done', ready=0; UPDATE external_items SET observedState='closed'",
  );
  await g.run();
  await g.run();
  assert.equal(g.writes().length, 1);
  assert.deepEqual(g.posted(), [PROGRESS]);
});

async function hungPost(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t, 200);
  await f.run();
  assert.deepEqual(f.posted(), [PROGRESS]);
  let release = () => {};
  f.holdPosts(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  t.after(() => release());
  await f.registerPr();
  return { f, release };
}

test("a transition POST that hangs past the limit is unproved, and the task's own comment still settles meanwhile", async (t) => {
  const { f, release } = await hungPost(t);
  const run = f.run();
  const deadline = Date.now() + 3000;
  while (f.writes().length < 2) {
    assert.ok(Date.now() < deadline, "the status write was never prepared");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const comment = await f.call("cab_external_action", {
    operationId: randomUUID(),
    action: {
      kind: "issue.comment",
      target,
      body: "While the status write hangs",
    },
  });
  assert.equal(comment.success, true, comment.text);
  await run;
  // Given up before it was proved: unproved, never held, and the POST was received once.
  assert.equal(f.writes()[1]?.state, "uncertain");
  assert.deepEqual(
    f
      .domain()
      .admission(f.taskId)
      .reasons.filter((r) => r.startsWith("external-action-")),
    [],
  );
  assert.deepEqual(f.service.delivery().actionBlockers(f.taskId), []);
  assert.deepEqual(
    f.service
      .delivery()
      .completionBlockers(f.taskId)
      .filter((r) => r.startsWith("external-action-")),
    [],
  );
  release();
});

test("an unproved transition is never resent after a restart; a newer event writes, and the older record is not inspected again", async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.registerPr();
  f.jira.state.fail["POST transitions"] = { status: 503 };
  await f.run();
  assert.equal(f.writes()[1]?.state, "uncertain");
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW]);
  f.jira.state.fail["POST transitions"] = {};
  delete f.jira.state.fail["POST transitions"];

  await f.restart();
  await f.run();
  // Same event, same operation: nothing is sent again.
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW]);
  assert.equal(f.writes().length, 2);

  // A newer event writes (the issue never moved, so the expectation holds).
  await f.stop();
  await f.run();
  assert.equal(f.writes()[2]?.state, "confirmed-success");
  assert.deepEqual(f.posted(), [PROGRESS, REVIEW, TODO]);
  // Were the older record inspected, a status of In Review would prove it.
  f.jira.state.status = {
    id: REVIEW,
    name: "In Review",
    category: "indeterminate",
  };
  await startedOf(f.service).deliveryCoordinator.reconcile();
  assert.equal(f.writes()[1]?.state, "uncertain");
});

test("status-write records never block actions or hold admission and completion", async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.registerPr();
  f.jira.state.fail["POST transitions"] = { status: 503 };
  await f.run();
  assert.equal(f.writes()[1]?.state, "uncertain");
  assert.deepEqual(
    f
      .domain()
      .admission(f.taskId)
      .reasons.filter((r) => r.startsWith("external-action-")),
    [],
  );
  assert.deepEqual(f.service.delivery().actionBlockers(f.taskId), []);
  assert.deepEqual(
    f.service
      .delivery()
      .completionBlockers(f.taskId)
      .filter((r) => r.startsWith("external-action-")),
    [],
  );
});

test("a task can be Ready while blocked: it is written as held, and readiness is untouched", async (t) => {
  const f = await fixture(t);
  await f.run();
  databaseOf(f.service).exec(
    "UPDATE domain_tasks SET importedBlockers='blocked'",
  );
  assert.equal(f.domain().task(f.taskId).ready, 1);
  await f.run();
  const held = f.writes()[1];
  assert.ok(held && isServiceDeliveryCaller(held.binding));
  assert.equal(held.binding.event, "held");
  assert.equal(held.state, "confirmed-success");
  assert.deepEqual(f.posted(), [PROGRESS, TODO]);
  assert.equal(f.domain().task(f.taskId).ready, 1);
});
