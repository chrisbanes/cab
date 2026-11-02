import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import type {
  GitHubSourceReader,
  IssueSnapshot,
} from "../../src/standalone/github-source.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { databaseOf } from "../fixtures/service-internals.js";

/** An imported task whose issue text the test edits, and a runtime whose turns it ends. */
async function liveTextWorld(labels = ["ready"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-lead-text-")));
  const issue: IssueSnapshot = {
    providerInstance: "github.com",
    nodeId: "I_1",
    repositoryId: "R_1",
    repositoryName: "org/repo",
    number: 1,
    title: "Original title",
    body: "Original body",
    state: "open",
    labels,
    projectFields: [],
  };
  let text = { title: issue.title, body: issue.body, labels: issue.labels };
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [{ ...issue, ...text }], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
  };
  const prompts: string[] = [];
  const ends = new Map<string, () => void>();
  let toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  /** When set, the next `startTurn` fails as if its response were lost. */
  let loseNextResponse = false;
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    onToolCall(listener) {
      toolCall = listener;
    },
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn(_thread, _workspace, prompt) {
      prompts.push(prompt);
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("turn start response lost");
      }
      const turnId = `turn-${prompts.length}`;
      ends.set(turnId, () => {});
      return turnId;
    },
    async interruptTurn() {},
    async waitForTurn(_thread, turnId) {
      await new Promise<void>((resolve) => ends.set(turnId, resolve));
      return "completed";
    },
  });
  const service = new StandaloneService(
    join(root, "data"),
    runtime,
    undefined,
    {
      issueTrackers: {
        readerFactories: { github: () => reader },
        intervalMs: 60_000,
      },
      power: { enabled: false },
    },
  );
  await service.start();
  const domain = service.domain();
  const projectId = randomUUID(),
    leadProfileId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: leadProfileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Live text",
    leadProfileId,
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
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  await service.refreshGitHub();
  const taskId = String(service.githubSources().issue("I_1")?.taskId);
  const db = databaseOf(service);
  const count = (sql: string) =>
    Number((db.prepare(sql).get(taskId) as { n: number }).n);
  const settle = async () => {
    for (let i = 0; i < 200; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const until = async (condition: () => boolean, label: string) => {
    for (let i = 0; i < 2000 && !condition(); i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), label);
  };
  return {
    root,
    service,
    domain,
    projectId,
    taskId,
    prompts,
    /** Syncs an edit of the issue's title and body. */
    async edit(title: string, body: string) {
      text = { ...text, title, body };
      await service.refreshGitHub();
    },
    /** Records a read of the edited issue directly, without re-reading blockers. */
    syncText(title: string, body: string) {
      text = { ...text, title, body };
      service.githubSources().reconcileSelection(projectId, "repo", {
        complete: true,
        issues: [{ ...issue, ...text }],
        reason: null,
      });
    },
    /** Syncs the loss of the readiness label: a structural change. */
    async unready() {
      text = { ...text, labels: [] };
      await service.refreshGitHub();
    },
    pause() {
      domain.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: Number(domain.project(projectId).version),
        paused: true,
      });
    },
    unpause() {
      domain.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: Number(domain.project(projectId).version),
        paused: false,
      });
    },
    lead: () => String(domain.ensureLeadAssignment(taskId)?.id),
    end(turnId: string) {
      ends.get(turnId)?.();
    },
    tool: (call: RuntimeToolCall) => {
      assert.ok(toolCall);
      return toolCall(call);
    },
    loseNextResponse() {
      loseNextResponse = true;
    },
    async message(text: string) {
      const recipient = String(domain.ensureLeadAssignment(taskId)?.id);
      await service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId,
        recipientAssignmentId: recipient,
        expectedAssignmentVersion: Number(domain.assignment(recipient).version),
        message: text,
      });
    },
    /** Inbox events, turn requests and runtime turns: what a wake would change. */
    activity: () => ({
      events: count(
        "SELECT count(*) AS n FROM coordination_inbox_events WHERE taskId = ?",
      ),
      requests: count(
        "SELECT count(*) AS n FROM turn_requests WHERE taskId = ?",
      ),
      turns: prompts.length,
    }),
    settle,
    until,
    async close() {
      for (const end of ends.values()) end();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a lead's turns carry the current issue text, a capped diff only after a change, and edits wake nothing", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  // The first turn is queued while the project is paused, then the issue is edited.
  await w.service.provisionTask(w.taskId);
  await w.settle();
  assert.equal(w.prompts.length, 0);
  const version = Number(w.domain.task(w.taskId).version);
  const quiet = w.activity();
  await w.edit("Edited title", "Edited body");
  await w.settle();
  assert.deepEqual(w.activity(), quiet);
  assert.equal(Number(w.domain.task(w.taskId).version), version);
  w.unpause();
  await w.until(() => w.prompts.length === 1, "first turn");
  assert.match(
    w.prompts[0] ?? "",
    /^Task: Edited title\nOutcome: Edited body\n/,
  );
  assert.doesNotMatch(w.prompts[0] ?? "", /Original|Changes \(/);

  // Edited while the lead runs: nothing is queued or delivered, and reporting is not blocked.
  const running = w.activity();
  await w.edit("Mid-turn title", "Edited body");
  await w.settle();
  assert.deepEqual(w.activity(), running);
  const report = await w.tool({
    threadId: "thread",
    turnId: "turn-1",
    callId: "report-after-edit",
    tool: "cab_report_result",
    arguments: { summary: "Reported after the edit" },
  });
  assert.equal(report.success, true, report.text);
  assert.equal(w.domain.assignment(w.lead()).state, "running");
  w.end("turn-1");
  await w.until(
    () => !w.service.list().some((work) => work.state === "running"),
    "first turn end",
  );
  assert.deepEqual(w.activity(), running);
  // The result handed back work that carried "Edited title"; the issue has moved on since.
  const api = new OperatorApi(w.service, [w.root]);
  const read = async () =>
    (await api.readTask(w.taskId)).data.task.issueChangedSinceHandback;
  assert.equal(await read(), true);
  assert.equal(w.domain.task(w.taskId).state, "open");

  // The next turn, woken by an operator message, carries the change since the confirmed turn.
  await w.message("Please continue.");
  await w.until(() => w.prompts.length === 2, "second turn");
  const second = w.prompts[1] ?? "";
  assert.match(second, /^Task: Mid-turn title\nOutcome: Edited body\n/);
  assert.match(
    second,
    /Changes \(- before, \+ now\):\nTitle:\n- Edited title\n\+ Mid-turn title\n\nDurable assignment inbox through event \d+:\n- [a-z-]+: .*Please continue\./,
  );
  assert.equal(second.match(/Please continue\./g)?.length, 1);
  w.end("turn-2");
  await w.until(
    () => !w.service.list().some((work) => work.state === "running"),
    "second turn end",
  );

  // No change since the confirmed turn: no diff section.
  await w.message("One more.");
  await w.until(() => w.prompts.length === 3, "third turn");
  assert.match(
    w.prompts[2] ?? "",
    /^Task: Mid-turn title\nOutcome: Edited body\n/,
  );
  assert.doesNotMatch(w.prompts[2] ?? "", /Changes \(/);
});

test("a lead turn whose start response is lost does not count as seen", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  w.unpause();
  await w.service.provisionTask(w.taskId);
  await w.until(() => w.prompts.length === 1, "first turn");
  w.end("turn-1");
  await w.until(
    () => !w.service.list().some((work) => work.state === "running"),
    "first turn end",
  );
  const lead = w.lead();
  assert.equal(w.service.leadText().confirmed(lead, "thread")?.title, "Original title");
  await w.edit("Changed title", "Original body");
  w.loseNextResponse();
  await w.message("Continue.");
  await w.until(() => w.prompts.length === 2, "second submission");
  await w.settle();
  assert.match(w.prompts[1] ?? "", /\+ Changed title/);
  // The submission is uncertain, so the lead's last seen text is still the original.
  assert.equal(w.service.leadText().confirmed(lead, "thread")?.title, "Original title");
});

test("a queued lead follow-up survives a text edit and is refused after a readiness change", async (t) => {
  for (const change of ["text", "readiness"] as const) {
    const w = await liveTextWorld();
    t.after(() => w.close());
    w.unpause();
    await w.service.provisionTask(w.taskId);
    await w.until(() => w.prompts.length === 1, "first turn");
    await w.tool({
      threadId: "thread",
      turnId: "turn-1",
      callId: "report",
      tool: "cab_report_result",
      arguments: { summary: "First pass" },
    });
    w.end("turn-1");
    await w.until(
      () => !w.service.list().some((work) => work.state === "running"),
      "first turn end",
    );
    // Paused, the follow-up waits in the queue with the task version it captured.
    w.pause();
    await w.message("Queued follow-up.");
    await w.settle();
    const queued = w.service
      .turnRequests()
      .find((request) => request.state === "queued");
    assert.ok(queued, change);
    if (change === "text") await w.edit("Edited title", "Original body");
    else await w.unready();
    w.unpause();
    if (change === "text") {
      await w.until(() => w.prompts.length === 2, "follow-up turn");
      assert.equal(
        w.service.turnRequests().find((r) => r.workId === queued.workId)
          ?.taskVersion,
        queued.taskVersion,
      );
      assert.match(w.prompts[1] ?? "", /^Task: Edited title\n/);
      assert.match(w.prompts[1] ?? "", /Queued follow-up\./);
    } else {
      await w.settle();
      assert.equal(w.prompts.length, 1);
      assert.notEqual(
        w.service.turnRequests().find((r) => r.workId === queued.workId)?.state,
        "completed",
      );
    }
  }
});

test("a specialist keeps its lead-authored brief and is told nothing of text edits", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  w.unpause();
  await w.service.provisionTask(w.taskId);
  await w.until(() => w.prompts.length === 1, "lead turn");
  const lead = w.domain.assignment(w.lead());
  w.domain.execute({
    type: "assignment.create",
    actor: "agent",
    key: randomUUID(),
    projectId: w.projectId,
    taskId: w.taskId,
    assignmentId: randomUUID(),
    profileId: String(lead.profileId),
    brief: "Specialist brief",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await w.settle();
  // Queued behind the lead's turn, then the issue is edited.
  await w.edit("Edited title", "Edited body");
  w.end("turn-1");
  await w.until(() => w.prompts.length === 2, "specialist turn");
  assert.match(w.prompts[1] ?? "", /^Specialist brief/);
  assert.doesNotMatch(w.prompts[1] ?? "", /Edited title|Changes \(/);
});

test("an Improve draft turn queued before a text edit is refused although the task version is unchanged", async (t) => {
  for (const edited of [true, false]) {
    const w = await liveTextWorld([]);
    t.after(() => w.close());
    const api = new OperatorApi(w.service, [w.root]);
    // An unready issue's blockers are read only once it is Ready; a draft turn needs them known.
    w.service.githubSources().reconcileBlockers("I_1", {
      complete: true,
      blockers: [],
      reason: null,
    });
    await w.service.provisionTask(w.taskId);
    // Paused, the draft turn waits in the queue with the text it was asked about.
    await api.execute({
      type: "task.draft-turn",
      key: randomUUID(),
      taskId: w.taskId,
      expectedVersion: Number(w.domain.task(w.taskId).version),
      message: "What is missing?",
    });
    const version = Number(w.domain.task(w.taskId).version);
    if (edited) w.syncText("Edited title", "Edited body");
    assert.equal(Number(w.domain.task(w.taskId).version), version);
    w.unpause();
    if (edited) {
      await w.until(
        () =>
          w.service
            .turnRequests()
            .some((request) => request.draftTurn && request.state === "held"),
        "refused draft turn",
      );
      assert.equal(w.prompts.length, 0);
    } else {
      await w.until(() => w.prompts.length === 1, "draft turn");
      assert.match(w.prompts[0] ?? "", /^Task: Original title\n/);
    }
  }
});
