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
    async readIssueComments() {
      return { complete: true, comments, reason: null };
    },
  };
  /** The issue's counted comments; none makes no issue brief. */
  let comments: string[] = [];
  const prompts: string[] = [];
  /** Each turn's terminal status, settled by the test or by an interrupt. */
  const turns = new Map<
    string,
    {
      promise: Promise<"completed" | "failed">;
      resolve: (status: "completed" | "failed") => void;
    }
  >();
  const turn = (turnId: string) => {
    let entry = turns.get(turnId);
    if (!entry) {
      let resolve!: (status: "completed" | "failed") => void;
      const promise = new Promise<"completed" | "failed">((done) => {
        resolve = done;
      });
      entry = { promise, resolve };
      turns.set(turnId, entry);
    }
    return entry;
  };
  /** Turns that failed with transient, retryable evidence. */
  const transient = new Set<string>();
  let threads = 0;
  let toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  /** When set, the next `startTurn` fails as if its response were lost. */
  let loseNextResponse = false;
  const runtime = () => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    onToolCall(
      listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
    ) {
      toolCall = listener;
    },
    async startThread() {
      return `thread-${++threads}`;
    },
    async resumeThread() {},
    async startTurn(_thread: string, _workspace: string, prompt: string) {
      prompts.push(prompt);
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("turn start response lost");
      }
      return `turn-${prompts.length}`;
    },
    async interruptTurn(_thread: string, turnId: string) {
      turn(turnId).resolve("failed");
    },
    waitForTurn(_thread: string, turnId: string) {
      return turn(turnId).promise;
    },
    failureEvidence(threadId: string, turnId: string) {
      return transient.has(turnId)
        ? {
            threadId,
            turnId,
            status: "failed" as const,
            classification: "transient" as const,
            reasonCode: "serverOverloaded" as const,
            source: "harness" as const,
            harnessRetries: 0,
          }
        : undefined;
    },
  });
  const make = () =>
    new StandaloneService(
      join(root, "data"),
      () => runtime() as Runtime,
      undefined,
      {
        issueTrackers: {
          readerFactories: { github: () => reader },
          intervalMs: 60_000,
        },
        power: { enabled: false },
        retry: { fallbackBackoffMs: 0 },
      },
    );
  let service = make();
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
  const count = (sql: string) =>
    Number((databaseOf(service).prepare(sql).get(taskId) as { n: number }).n);
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
    get service() {
      return service;
    },
    get domain() {
      return service.domain();
    },
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
    /** Syncs a change of the issue's counted comments. */
    async comment(next: string[]) {
      comments = next;
      await service.refreshGitHub();
    },
    /** Syncs the loss of the readiness label: a structural change. */
    async unready() {
      text = { ...text, labels: [] };
      await service.refreshGitHub();
    },
    pause() {
      service.domain().execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: Number(service.domain().project(projectId).version),
        paused: true,
      });
    },
    unpause() {
      service.domain().execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: Number(service.domain().project(projectId).version),
        paused: false,
      });
    },
    lead: () => String(service.domain().ensureLeadAssignment(taskId)?.id),
    end(turnId: string) {
      turn(turnId).resolve("completed");
    },
    /** Ends the turn as a confirmed transient failure, which queues a retry. */
    failTransiently(turnId: string) {
      transient.add(turnId);
      turn(turnId).resolve("failed");
    },
    /** A planned shutdown, then a fresh service over the same data. */
    async restart() {
      await service.stop();
      service = make();
      await service.start();
    },
    tool: (call: RuntimeToolCall) => {
      assert.ok(toolCall);
      return toolCall(call);
    },
    loseNextResponse() {
      loseNextResponse = true;
    },
    async message(text: string) {
      const recipient = String(
        service.domain().ensureLeadAssignment(taskId)?.id,
      );
      await service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId,
        recipientAssignmentId: recipient,
        expectedAssignmentVersion: Number(
          service.domain().assignment(recipient).version,
        ),
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
      for (const entry of turns.values()) entry.resolve("completed");
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
    threadId: "thread-1",
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
  assert.equal(
    w.service.leadText().confirmed(lead, "thread-1")?.title,
    "Original title",
  );
  await w.edit("Changed title", "Original body");
  w.loseNextResponse();
  await w.message("Continue.");
  await w.until(() => w.prompts.length === 2, "second submission");
  await w.settle();
  assert.match(w.prompts[1] ?? "", /\+ Changed title/);
  // The submission is uncertain, so the lead's last seen text is still the original.
  assert.equal(
    w.service.leadText().confirmed(lead, "thread-1")?.title,
    "Original title",
  );
});

test("a queued lead follow-up survives a text edit and is refused after a readiness change", async (t) => {
  for (const change of ["text", "readiness"] as const) {
    const w = await liveTextWorld();
    t.after(() => w.close());
    w.unpause();
    await w.service.provisionTask(w.taskId);
    await w.until(() => w.prompts.length === 1, "first turn");
    await w.tool({
      threadId: "thread-1",
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

/** Starts the lead's first turn and ends it, reporting a result unless `report` is false. */
async function firstLeadTurn(
  w: Awaited<ReturnType<typeof liveTextWorld>>,
  report = true,
) {
  w.unpause();
  await w.service.provisionTask(w.taskId);
  await w.until(() => w.prompts.length === 1, "first turn");
  if (report)
    await w.tool({
      threadId: "thread-1",
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
}

const repairInstruction = /Reporting repair: the previous successful turn/;

/** Reports a result in the turn, so its failure leaves no unresolved effect to recover. */
const reportIn = (
  w: Awaited<ReturnType<typeof liveTextWorld>>,
  turnId: string,
  threadId = "thread-1",
) =>
  w.tool({
    threadId,
    turnId,
    callId: `report-${turnId}`,
    tool: "cab_report_result",
    arguments: { summary: `Reported in ${turnId}` },
  });

test("a retried lead turn keeps the inbox material its original request had bound", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  await firstLeadTurn(w);
  await w.message("Bound operator message.");
  await w.until(() => w.prompts.length === 2, "message turn");
  assert.match(w.prompts[1] ?? "", /Bound operator message\./);
  await reportIn(w, "turn-2");
  w.failTransiently("turn-2");
  await w.until(() => w.prompts.length === 3, "retried turn");
  assert.ok(
    w.service.turnRequests().some((r) => r.workId.startsWith("retry:")),
  );
  assert.match(w.prompts[2] ?? "", /^Task: Original title\n/);
  assert.equal(w.prompts[2]?.match(/Bound operator message\./g)?.length, 1);
});

type World = Awaited<ReturnType<typeof liveTextWorld>>;

/** The task's inbox batches, oldest first. */
const batches = (w: World) =>
  databaseOf(w.service)
    .prepare(
      `SELECT deliveryWorkId, state, completedAt FROM coordination_delivery_batches
      WHERE taskId = ? ORDER BY createdAt, rowid`,
    )
    .all(w.taskId) as {
    deliveryWorkId: string;
    state: string;
    completedAt: number | null;
  }[];

const workWith = (w: World, prefix: string) =>
  String(
    w.service.turnRequests().find((r) => r.workId.startsWith(prefix))?.workId,
  );

/** Delivers a message, fails its turn transiently, and leaves the retry turn running. */
async function retryRunning(w: World) {
  await firstLeadTurn(w);
  await w.message("Bound operator message.");
  await w.until(() => w.prompts.length === 2, "message turn");
  await reportIn(w, "turn-2");
  w.failTransiently("turn-2");
  await w.until(() => w.prompts.length === 3, "retried turn");
  return workWith(w, "retry:");
}

test("a retried lead turn completes its inbox batch, and the next message starts a turn", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  const retryWorkId = await retryRunning(w);
  assert.deepEqual(
    batches(w).map((b) => [b.deliveryWorkId, b.state]),
    [[retryWorkId, "queued"]],
  );
  await reportIn(w, "turn-3", "thread-2");
  w.end("turn-3");
  await w.until(() => batches(w)[0]?.state === "completed", "batch completed");
  await w.until(
    () => !w.service.list().some((work) => work.state === "running"),
    "retry turn end",
  );
  assert.equal(batches(w).length, 1);
  assert.notEqual(batches(w)[0]?.completedAt, null);
  await w.message("Second message.");
  await w.until(() => w.prompts.length === 4, "next message turn");
  assert.match(w.prompts[3] ?? "", /Second message\./);
});

test("a retried lead turn that a planned shutdown requeues completes its inbox batch", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  await retryRunning(w);
  await w.restart();
  await w.until(() => w.prompts.length === 4, "requeued retry turn");
  const requeueWorkId = workWith(w, "shutdown:");
  assert.deepEqual(
    batches(w).map((b) => [b.deliveryWorkId, b.state]),
    [[requeueWorkId, "queued"]],
  );
  await reportIn(w, "turn-4", "thread-2");
  w.end("turn-4");
  await w.until(() => batches(w)[0]?.state === "completed", "batch completed");
  await w.until(
    () => !w.service.list().some((work) => work.state === "running"),
    "retry turn end",
  );
  await w.message("Second message.");
  await w.until(() => w.prompts.length === 5, "next message turn");
  assert.match(w.prompts[4] ?? "", /Second message\./);
});

test("a retried lead turn completes an inbox batch still bound to the failed work", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  const retryWorkId = await retryRunning(w);
  await reportIn(w, "turn-3", "thread-2");
  // The state a build that left the batch behind produced.
  const { failedWorkId } = databaseOf(w.service)
    .prepare(
      "SELECT failedWorkId FROM execution_retry_resolutions WHERE retryWorkId = ?",
    )
    .get(retryWorkId) as { failedWorkId: string };
  databaseOf(w.service)
    .prepare(
      "UPDATE coordination_delivery_batches SET deliveryWorkId = ? WHERE deliveryWorkId = ?",
    )
    .run(failedWorkId, retryWorkId);
  w.end("turn-3");
  await w.until(() => batches(w)[0]?.state === "completed", "batch completed");
  assert.equal(batches(w)[0]?.deliveryWorkId, failedWorkId);
  await w.until(
    () => !w.service.list().some((work) => work.state === "running"),
    "retry turn end",
  );
  await w.message("Second message.");
  await w.until(() => w.prompts.length === 4, "next message turn");
  assert.match(w.prompts[3] ?? "", /Second message\./);
});

test("a retried reporting repair keeps its repair instruction", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  await firstLeadTurn(w, false);
  await w.until(() => w.prompts.length === 2, "repair turn");
  assert.match(w.prompts[1] ?? "", repairInstruction);
  await reportIn(w, "turn-2");
  w.failTransiently("turn-2");
  await w.until(() => w.prompts.length === 3, "retried repair turn");
  assert.match(w.prompts[2] ?? "", repairInstruction);
});

test("a reporting repair requeued by a planned shutdown keeps its repair instruction", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  await firstLeadTurn(w, false);
  await w.until(() => w.prompts.length === 2, "repair turn");
  assert.match(w.prompts[1] ?? "", repairInstruction);
  await w.restart();
  await w.until(() => w.prompts.length === 3, "requeued repair turn");
  assert.ok(
    w.service.turnRequests().some((r) => r.workId.startsWith("shutdown:")),
  );
  assert.match(w.prompts[2] ?? "", repairInstruction);
});

test("a lead's turns carry the issue brief after the outcome and diff its changes without a hold or wake", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  const brief = "## Agent Brief\nBuild it";
  await w.comment([brief, "Note one"]);
  w.unpause();
  await w.service.provisionTask(w.taskId);
  await w.until(() => w.prompts.length === 1, "first turn");
  assert.ok(
    (w.prompts[0] ?? "").startsWith(
      `Task: Original title\nOutcome: Original body\n\nIssue brief (the issue's brief comment and the notes after it):\n${brief}\n\n--- Later note ---\n\nNote one`,
    ),
  );
  assert.doesNotMatch(w.prompts[0] ?? "", /Changes \(/);
  const turnDone = async (n: number) => {
    await reportIn(w, `turn-${n}`);
    w.end(`turn-${n}`);
    await w.until(
      () => !w.service.list().some((work) => work.state === "running"),
      `turn ${n} end`,
    );
  };
  await turnDone(1);
  // A new note: a live text change, with no hold, admission reason, version change or wake.
  const version = Number(w.domain.task(w.taskId).version);
  const reasons = w.domain.admission(w.taskId).reasons;
  const quiet = w.activity();
  await w.comment([brief, "Note one", "Note two"]);
  await w.settle();
  assert.deepEqual(w.activity(), quiet);
  assert.equal(Number(w.domain.task(w.taskId).version), version);
  assert.deepEqual(w.domain.admission(w.taskId).reasons, reasons);
  assert.equal(w.service.githubSources().hold("I_1"), undefined);
  const api = new OperatorApi(w.service, [w.root]);
  assert.equal(
    (await api.readTask(w.taskId)).data.task.issueChangedSinceHandback,
    true,
  );
  await w.message("Continue.");
  await w.until(() => w.prompts.length === 2, "second turn");
  assert.match(
    w.prompts[1] ?? "",
    /Changes \(- before, \+ now\):\nIssue brief:\n\+ \n\+ --- Later note ---\n\+ \n\+ Note two\n/,
  );
  await turnDone(2);
  // Editing and then deleting a counted note each diff.
  await w.comment([brief, "Note one, edited", "Note two"]);
  await w.message("Again.");
  await w.until(() => w.prompts.length === 3, "third turn");
  assert.match(
    w.prompts[2] ?? "",
    /Issue brief:\n- Note one\n\+ Note one, edited\n/,
  );
  await turnDone(3);
  await w.comment([brief, "Note two"]);
  await w.message("Once more.");
  await w.until(() => w.prompts.length === 4, "fourth turn");
  assert.match(
    w.prompts[3] ?? "",
    /Issue brief:\n- Note one, edited\n- \n- --- Later note ---\n- \n/,
  );
  await turnDone(4);
  // No change since: no diff.
  await w.message("Last.");
  await w.until(() => w.prompts.length === 5, "fifth turn");
  assert.doesNotMatch(w.prompts[4] ?? "", /Changes \(/);
});

test("a specialist's prompt never carries the issue brief", async (t) => {
  const w = await liveTextWorld();
  t.after(() => w.close());
  await w.comment(["## Agent Brief\nSecret plan for the lead"]);
  w.unpause();
  await w.service.provisionTask(w.taskId);
  await w.until(() => w.prompts.length === 1, "lead turn");
  assert.match(w.prompts[0] ?? "", /Secret plan for the lead/);
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
  w.end("turn-1");
  await w.until(() => w.prompts.length === 2, "specialist turn");
  assert.match(w.prompts[1] ?? "", /^Specialist brief/);
  assert.doesNotMatch(w.prompts[1] ?? "", /Secret plan|Issue brief/);
});
