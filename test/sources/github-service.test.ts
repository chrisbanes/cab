import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { DeliveryStore } from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { GitHubSourceStore } from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { GitHubSynchronizer } from "../../src/standalone/github-sync.js";
import { StandaloneService } from "../../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import type {
  GitHubSourceReader,
  IssueSnapshot,
} from "../../src/standalone/github-source.js";

const issue: IssueSnapshot = {
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

test("startup invalidates prior clear source/dependency evidence before the first scheduler wake", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-github-startup-")));
  const data = join(root, "data");
  const projectId = randomUUID();
  const profileId = randomUUID();
  const localId = randomUUID();
  let readsFail = false;
  const startedWorkspaces: string[] = [];
  const reader: GitHubSourceReader = {
    async readSelection() {
      return readsFail
        ? { complete: false, issues: [], reason: "http-403" }
        : { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return readsFail
        ? { complete: false, blockers: [], reason: "http-403" }
        : { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: readsFail ? "unknown" : "open" };
    },
  };
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn(_thread, workspace) {
      startedWorkspaces.push(workspace);
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed";
    },
  });
  const options = {
    issueTrackers: {
      readerFactories: { github: () => reader },
      intervalMs: 60_000,
    },
    power: { enabled: false },
  };
  let service = new StandaloneService(data, runtime, undefined, options);
  try {
    await service.start();
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
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local",
      outcome: "Independent local work",
      ready: true,
    });
    await service.refreshGitHub();
    const imported = service.githubSources().issue("I_1");
    const taskId = String(imported?.taskId);
    assert.equal(domain.task(taskId).importedBlockers, "clear");
    const importedWorkspace = await service.provisionTask(taskId);
    await service.provisionTask(localId);
    await service.stop();
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    new Store(db).ensureHost("standalone-codex");
    const offline = new DomainStore(db);
    offline.migrate();
    offline.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    db.close();
    readsFail = true;
    service = new StandaloneService(data, runtime, undefined, options);
    await service.start();
    assert.ok(
      service.domain().admission(taskId).reasons.includes("source-unknown"),
    );
    assert.ok(
      service
        .domain()
        .admission(taskId)
        .reasons.includes("imported-blockers-unknown"),
    );
    assert.equal(service.domain().admission(localId).eligible, true);
    assert.equal(startedWorkspaces.includes(importedWorkspace.path), false);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runnable imported assignment starts on complete evidence, then a failed refresh holds later admission without cancelling its turn", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-active-hold-")),
  );
  const projectId = randomUUID();
  const profileId = randomUUID();
  const workerId = randomUUID();
  const assignmentId = randomUUID();
  let failed = false;
  let changed = false;
  let turns = 0;
  let toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  let release!: () => void;
  const heldTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader: GitHubSourceReader = {
    async readSelection() {
      return failed
        ? { complete: false, issues: [], reason: "http-403" }
        : {
            complete: true,
            issues: [changed ? { ...issue, title: "Imported revised" } : issue],
            reason: null,
          };
    },
    async readBlockers() {
      return failed
        ? { complete: false, blockers: [], reason: "http-403" }
        : { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: failed ? "unknown" : "open" };
    },
  };
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
    async startTurn() {
      turns++;
      return `turn-${turns}`;
    },
    async interruptTurn() {
      throw new Error("source hold must not cancel admitted turn");
    },
    async waitForTurn() {
      await heldTurn;
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
  try {
    await service.start();
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
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: workerId,
      name: "Worker",
      instructions: "Worker",
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
    assert.equal(domain.admission(taskId).eligible, true);
    await service.provisionTask(taskId);
    domain.execute({
      type: "assignment.create",
      actor: "agent",
      key: randomUUID(),
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Complete imported work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    await service.refreshGitHub();
    for (let i = 0; i < 100 && turns === 0; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(turns, 1);
    changed = true;
    await service.refreshGitHub();
    assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
    assert.ok(toolCall);
    const beforeDelegation = domain.assignments(taskId).length;
    const rejected = await toolCall({
      threadId: "thread",
      turnId: "turn-1",
      callId: "delegate-after-source-hold",
      tool: "cab_delegate",
      arguments: { profileId: workerId, brief: "Must remain held" },
    });
    assert.equal(rejected.success, false);
    assert.equal(domain.assignments(taskId).length, beforeDelegation);
    const noticeDb = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    try {
      const count = () =>
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_inbox_events WHERE taskId = ? AND eventType = 'source-hold'",
              )
              .get(taskId) as { count: number }
          ).count,
        );
      assert.equal(count(), 2);
      await service.refreshGitHub();
      assert.equal(count(), 2);
      const ordinaryEventId = randomUUID();
      const boundAssignmentId = String(
        (
          noticeDb
            .prepare(
              "SELECT assignmentId FROM task_execution_bindings WHERE workId = (SELECT workId FROM execution_intents WHERE threadId = 'thread' AND turnId = 'turn-1')",
            )
            .get() as { assignmentId: string }
        ).assignmentId,
      );
      noticeDb
        .prepare(
          "INSERT INTO coordination_inbox_events (eventId, taskId, recipientAssignmentId, eventType, payload) VALUES (?, ?, ?, 'operator-message', '{}')",
        )
        .run(ordinaryEventId, taskId, boundAssignmentId);
      assert.equal(
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_inbox_events WHERE eventId = ? AND recipientAssignmentId = ? AND eventType = 'operator-message'",
              )
              .get(ordinaryEventId, boundAssignmentId) as { count: number }
          ).count,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_delivery_events WHERE eventId = ?",
              )
              .get(ordinaryEventId) as { count: number }
          ).count,
        ),
        0,
      );
      const ordinaryBlocked = await toolCall({
        threadId: "thread",
        turnId: "turn-1",
        callId: "report-with-ordinary-inbox",
        tool: "cab_report_result",
        arguments: { summary: "Finished admitted work" },
      });
      assert.equal(ordinaryBlocked.success, false);
      assert.match(ordinaryBlocked.text, /inbox events remain undelivered/);
      noticeDb
        .prepare("DELETE FROM coordination_inbox_events WHERE eventId = ?")
        .run(ordinaryEventId);
      const report = await toolCall({
        threadId: "thread",
        turnId: "turn-1",
        callId: "report-after-source-hold",
        tool: "cab_report_result",
        arguments: { summary: "Finished admitted work" },
      });
      assert.equal(report.success, true, report.text);
      assert.equal(
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_results WHERE taskId = ? AND assignmentId = ?",
              )
              .get(taskId, boundAssignmentId) as { count: number }
          ).count,
        ),
        1,
      );
      assert.equal(count(), 2);
    } finally {
      noticeDb.close();
    }
    failed = true;
    await service.refreshGitHub();
    assert.ok(domain.admission(taskId).reasons.includes("source-unknown"));
    assert.ok(
      domain.admission(taskId).reasons.includes("imported-blockers-unknown"),
    );
    assert.equal(turns, 1);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held canonical lead receives one source-hold notice without changing assignment state", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-held-lead-")),
  );
  const projectId = randomUUID();
  const profileId = randomUUID();
  let title = "Original";
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [{ ...issue, title }], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
  };
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      throw new Error("Paused fixture must not start");
    },
    async interruptTurn() {},
    async waitForTurn() {
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
  try {
    await service.start();
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
      expectedVersion: 2,
      selectionId: "repo",
    });
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    const leadId = String(domain.ensureLeadAssignment(taskId)?.id);
    const db = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    try {
      db.prepare(
        "UPDATE domain_assignments SET state = 'held' WHERE id = ?",
      ).run(leadId);
      title = "Revised";
      await service.refreshGitHub();
      assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
      const count = () =>
        Number(
          (
            db
              .prepare(
                "SELECT count(*) AS count FROM coordination_inbox_events WHERE recipientAssignmentId = ? AND eventType = 'source-hold'",
              )
              .get(leadId) as { count: number }
          ).count,
        );
      assert.equal(count(), 1);
      await service.refreshGitHub();
      assert.equal(count(), 1);
      assert.equal(domain.assignment(leadId).state, "held");
    } finally {
      db.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unassigned routing-enabled source hold does not invent a lead assignment", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-routing-hold-")),
  );
  const projectId = randomUUID();
  const leadId = randomUUID();
  const workerId = randomUUID();
  let body = issue.body;
  let routingCalls = 0;
  let releaseFirst!: (value: {
    choice: string;
    model: string;
    confidence: number;
    probabilities: Record<string, number>;
    usage: { inputTokens: number; outputTokens: number };
  }) => void;
  const firstRoute = new Promise<{
    choice: string;
    model: string;
    confidence: number;
    probabilities: Record<string, number>;
    usage: { inputTokens: number; outputTokens: number };
  }>((resolve) => {
    releaseFirst = resolve;
  });
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [{ ...issue, body }], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
  };
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
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
      routingClient: {
        async choose(request) {
          routingCalls++;
          const choice = workerId;
          const response = {
            choice,
            model: request.requestedModel,
            confidence: 1,
            probabilities: Object.fromEntries(
              request.choices.map((candidate) => [
                candidate,
                candidate === choice ? 1 : 0,
              ]),
            ),
            usage: { inputTokens: 0, outputTokens: 0 },
          };
          return routingCalls === 1 ? firstRoute : response;
        },
      },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    for (const [profileId, name] of [
      [leadId, "Lead"],
      [workerId, "Worker"],
    ] as const)
      domain.execute({
        type: "profile.create",
        actor: "operator",
        key: randomUUID(),
        profileId,
        name,
        instructions: name,
        capabilities: "work",
      });
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: leadId,
    });
    domain.execute({
      type: "routing.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Choose the worker",
      credentialRef: "env:TEST_ROUTER",
      candidateProfileIds: [workerId],
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
    body = "Revised work";
    await service.refreshGitHub();
    assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
    assert.equal(domain.assignments(taskId).length, 0);
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    await service.provisionTask(taskId);
    assert.equal(domain.assignments(taskId).length, 0);
    const reviewDb = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    const digest = String(
      (
        reviewDb
          .prepare(
            "SELECT observedDigest FROM source_reviews WHERE externalId = 'I_1'",
          )
          .get() as { observedDigest: string }
      ).observedDigest,
    );
    reviewDb.close();
    domain.execute({
      type: "source.review",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      observedDigest: digest,
      decision: "accept-revised-scope",
    });
    for (let i = 0; i < 100 && routingCalls === 0; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(routingCalls, 1);
    body = "Revised again";
    service.githubSources().reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, body }],
      reason: null,
    });
    releaseFirst({
      choice: workerId,
      model: "jev-1.13.0",
      confidence: 1,
      probabilities: { [workerId]: 1, lead_review: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    for (let i = 0; i < 100; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(domain.assignments(taskId).length, 0);
    assert.ok(
      domain.admission(taskId).reasons.includes("source-review-required"),
    );
    const secondDb = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    const secondDigest = String(
      (
        secondDb
          .prepare(
            "SELECT observedDigest FROM source_reviews WHERE externalId = 'I_1'",
          )
          .get() as { observedDigest: string }
      ).observedDigest,
    );
    secondDb.close();
    domain.execute({
      type: "source.review",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      observedDigest: secondDigest,
      decision: "accept-revised-scope",
    });
    await service.refreshGitHub();
    assert.equal(routingCalls, 2);
    assert.deepEqual(
      domain.assignments(taskId).map((assignment) => assignment.profileId),
      [workerId],
    );
  } finally {
    releaseFirst({
      choice: workerId,
      model: "jev-1.13.0",
      confidence: 1,
      probabilities: { [workerId]: 1, lead_review: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit and timer refresh converge, and stop settles an in-flight read before closing storage", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-github-poll-")));
  const projectId = randomUUID();
  const leadId = randomUUID();
  let reads = 0;
  let stall = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader: GitHubSourceReader = {
    async readSelection() {
      reads++;
      if (stall) await blocked;
      return { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
  };
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
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
        intervalMs: 1000,
      },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    domain.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: leadId,
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
      leadProfileId: leadId,
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
    assert.equal(reads, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 1150));
    assert.ok(reads >= 2);
    stall = true;
    const first = service.refreshGitHub();
    const second = service.refreshGitHub();
    for (let i = 0; i < 100 && reads < 3; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const beforeStop = reads;
    const stopping = service.stop();
    assert.equal(reads, beforeStop);
    release();
    await Promise.all([first, second, stopping]);
    assert.equal(reads, beforeStop);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

const idleRuntime = (): Runtime => ({
  async start() {},
  async stop() {},
  onUnexpectedRequest() {},
  async startThread() {
    return "thread";
  },
  async resumeThread() {},
  async startTurn() {
    return "turn";
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
});

function addGitHubProject(
  domain: DomainStore,
  selection: object = {
    id: "repo",
    kind: "repository",
    repositoryId: "R_1",
    owner: "org",
    name: "repo",
  },
): string {
  const projectId = randomUUID();
  const profileId = randomUUID();
  const execute = (command: object) =>
    domain.execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  execute({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  execute({
    type: "project.create",
    projectId,
    name: `Alpha ${projectId.slice(0, 8)}`,
    leadProfileId: profileId,
  });
  execute({
    type: "github.configure",
    projectId,
    expectedVersion: 1,
    credentialRef: "env:TEST_GITHUB",
    selections: [selection],
    readiness: {
      mode: "any",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  execute({
    type: "github.activate",
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  return projectId;
}

test("blocker reads skip closed issues unless their still-open imported task owns the delivery closure", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  try {
    const projectId = addGitHubProject(domain);
    const owned = { ...issue, nodeId: "I_owned", number: 11 };
    const stale = {
      ...issue,
      nodeId: "I_stale",
      number: 12,
      state: "closed" as const,
    };
    const live = { ...issue, nodeId: "I_live", number: 13 };
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [owned],
      reason: null,
    });
    sources.reconcileBlockers("I_owned", {
      complete: true,
      blockers: [],
      reason: null,
    });
    const taskId = String(sources.issue("I_owned")?.taskId);
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "issue.close", repositoryId: "R_1", mode: "allow" }],
      requiredChecks: [],
    });
    const delivery = new DeliveryStore(db);
    const operationId = randomUUID();
    delivery.prepareAction(
      {
        operationId,
        action: {
          kind: "issue.close",
          target: { repositoryId: "R_1", nodeId: "I_owned", number: 11 },
          reviewedResultIds: [],
        },
      },
      {
        projectId,
        taskId,
        taskVersion: Number(domain.task(taskId).version),
        assignmentId: randomUUID(),
        assignmentVersion: 1,
        workId: "w",
        workRevision: 1,
        conversationRevision: 1,
      },
      false,
    );
    delivery.beginAttempt(operationId, { state: "open" });
    delivery.recordObservation(operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_owned", issueClosed: true },
    });
    const closedOwned = { ...owned, state: "closed" as const };
    sources.recordDeliveryClosure(
      projectId,
      domain.githubConfiguration(projectId).version,
      closedOwned,
      operationId,
      null,
      null,
    );
    assert.equal(domain.hasOwnDeliveryClosure(taskId), true);

    const blockerReads: string[] = [];
    const reader: GitHubSourceReader = {
      async readSelection() {
        return {
          complete: true,
          issues: [closedOwned, stale, live],
          reason: null,
        };
      },
      async readBlockers(reference) {
        blockerReads.push(reference.nodeId);
        return { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        return { status: "open" };
      },
    };
    const synchronizer = new GitHubSynchronizer(domain, sources, () => reader);
    await synchronizer.refresh();
    assert.deepEqual(blockerReads.sort(), ["I_live", "I_owned"]);

    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      state: "done",
    });
    blockerReads.length = 0;
    await synchronizer.refresh();
    assert.deepEqual(blockerReads, ["I_live"]);
  } finally {
    db.close();
  }
});

test("a rate-limited read pauses manual refreshes until the reset without implying dependency clearance", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-rate-limit-")),
  );
  const calls: string[] = [];
  let limited = false;
  const reader: GitHubSourceReader = {
    async readSelection() {
      calls.push("selection");
      return limited
        ? {
            complete: false,
            issues: [],
            reason: "rate-limited",
            resumeAt: Date.now() + 60_000,
          }
        : { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      calls.push("blockers");
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      calls.push("status");
      return { status: "open" };
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    idleRuntime,
    undefined,
    {
      issueTrackers: {
        readerFactories: { github: () => reader },
        intervalMs: 3_600_000,
      },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    const projectId = addGitHubProject(domain);
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    assert.equal(domain.task(taskId).importedBlockers, "clear");
    assert.deepEqual(calls, ["selection", "blockers"]);

    limited = true;
    await service.refreshGitHub();
    const readsAtLimit = calls.length;
    for (let i = 0; i < 2; i++) {
      await service.refreshGitHub();
      const sync = service.githubSources().syncState(projectId, "repo");
      assert.equal(sync?.complete, 0);
      assert.equal(sync?.reason, "rate-limited");
      assert.equal(domain.task(taskId).importedBlockers, "unknown");
    }
    assert.equal(calls.length, readsAtLimit);

    limited = false;
    mock.timers.tick(60_000);
    await service.refreshGitHub();
    assert.deepEqual(calls.slice(readsAtLimit), ["selection", "blockers"]);
    assert.equal(
      service.githubSources().syncState(projectId, "repo")?.complete,
      1,
    );
    assert.equal(domain.task(taskId).importedBlockers, "clear");
  } finally {
    mock.timers.reset();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rate-limit pause records a closed blocker as unknown so its local dependent stays blocked", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  try {
    const projectId = addGitHubProject(domain);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    const blockerTask = String(sources.issue("I_1")?.taskId);
    const localId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local dependent",
      outcome: "Wait for the issue",
      ready: true,
    });
    domain.execute({
      type: "dependency.add",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      blockerTaskId: blockerTask,
      expectedVersion: Number(domain.task(localId).version),
    });
    sources.recordIssueStatus("I_1", { status: "closed" });
    assert.ok(!domain.admission(localId).reasons.includes("local-dependency"));

    let reads = 0;
    const reader: GitHubSourceReader = {
      async readSelection() {
        reads++;
        return {
          complete: false,
          issues: [],
          reason: "rate-limited",
          resumeAt: Date.now() + 3_600_000,
        };
      },
      async readBlockers() {
        reads++;
        return { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        reads++;
        return { status: "closed" };
      },
    };
    const synchronizer = new GitHubSynchronizer(domain, sources, () => reader);
    for (let pass = 0; pass < 2; pass++) {
      await synchronizer.refresh();
      const status = db
        .prepare(
          "SELECT status, reason FROM external_item_status WHERE externalId = ?",
        )
        .get("I_1");
      assert.deepEqual(
        { ...status },
        { status: "unknown", reason: "rate-limited" },
      );
      assert.ok(domain.admission(localId).reasons.includes("local-dependency"));
    }
    assert.equal(reads, 1, "the paused second pass makes no reader call");
  } finally {
    db.close();
  }
});

test("a rate limit mid-selection leaves the unread issues' imported blockers unknown, not clear", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  try {
    addGitHubProject(domain);
    const issues = [1, 2, 3].map((number) => ({
      ...issue,
      nodeId: `I_${number}`,
      number,
    }));
    let limited = false;
    const blockerReads: string[] = [];
    const reader: GitHubSourceReader = {
      async readSelection() {
        return { complete: true, issues, reason: null };
      },
      async readBlockers(reference) {
        blockerReads.push(reference.nodeId);
        return limited
          ? {
              complete: false,
              blockers: [],
              reason: "rate-limited",
              resumeAt: Date.now() + 3_600_000,
            }
          : { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        return { status: "open" };
      },
    };
    const synchronizer = new GitHubSynchronizer(domain, sources, () => reader);
    const blockersOf = () =>
      issues.map((entry) =>
        String(
          domain.task(String(sources.issue(entry.nodeId)?.taskId))
            .importedBlockers,
        ),
      );
    await synchronizer.refresh();
    assert.deepEqual(blockersOf(), ["clear", "clear", "clear"]);

    limited = true;
    blockerReads.length = 0;
    await synchronizer.refresh();
    assert.deepEqual(
      blockerReads,
      ["I_1"],
      "only the first read reaches GitHub",
    );
    assert.deepEqual(blockersOf(), ["unknown", "unknown", "unknown"]);
  } finally {
    db.close();
  }
});

test("timer refreshes also wait out a rate limit", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-rate-limit-timer-")),
  );
  let reads = 0;
  const reader: GitHubSourceReader = {
    async readSelection() {
      reads++;
      return {
        complete: false,
        issues: [],
        reason: "rate-limited",
        resumeAt: Date.now() + 3_600_000,
      };
    },
    async readBlockers() {
      reads++;
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      reads++;
      return { status: "open" };
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    idleRuntime,
    undefined,
    {
      issueTrackers: {
        readerFactories: { github: () => reader },
        intervalMs: 1000,
      },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const projectId = addGitHubProject(service.domain());
    const reconcile = mock.method(
      service.githubSources(),
      "reconcileSelection",
    );
    await service.refreshGitHub();
    assert.equal(reads, 1);
    assert.equal(reconcile.mock.callCount(), 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 1150));
    assert.ok(reconcile.mock.callCount() >= 2, "the timer pass ran");
    assert.equal(reads, 1);
    const sync = service.githubSources().syncState(projectId, "repo");
    assert.equal(sync?.complete, 0);
    assert.equal(sync?.reason, "rate-limited");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub refresh defaults to five minutes", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-default-interval-")),
  );
  const delays: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const spy = mock.method(globalThis, "setInterval", ((
    ...args: Parameters<typeof setInterval>
  ) => {
    delays.push(args[1]);
    return realSetInterval(...args);
  }) as typeof setInterval);
  const service = new StandaloneService(
    join(root, "data"),
    idleRuntime,
    undefined,
    { power: { enabled: false } },
  );
  try {
    await service.start();
    assert.ok(delays.includes(300_000), `intervals: ${delays.join(",")}`);
    assert.ok(!delays.includes(60_000));
  } finally {
    spy.mock.restore();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

import { CredentialGitHubSourceReader } from "../../src/standalone/github-source-credential.js";

test("synchronizer scopes concrete reader pauses across refreshes and projects but env rotation recovers", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  addGitHubProject(domain);
  addGitHubProject(domain);
  const environment = { TEST_GITHUB: "token-A" };
  const calls: string[] = [];
  const sync = new GitHubSynchronizer(
    domain,
    sources,
    (ref) =>
      new CredentialGitHubSourceReader(ref, {
        environment,
        reader: (token) => ({
          async readSelection() {
            calls.push(token);
            return token === "token-A"
              ? {
                  complete: false,
                  issues: [],
                  reason: "rate-limited",
                  resumeAt: Date.now() + 60_000,
                }
              : { complete: true, issues: [], reason: null };
          },
          async readBlockers() {
            return { complete: true, blockers: [], reason: null };
          },
          async readIssueStatus() {
            return { status: "open" };
          },
        }),
      }),
  );
  try {
    await sync.refresh();
    await sync.refresh();
    assert.deepEqual(
      calls,
      ["token-A"],
      "scope survives newly constructed readers across projects/refreshes",
    );
    environment.TEST_GITHUB = "token-B";
    await sync.refresh();
    assert.deepEqual(calls, ["token-A", "token-B", "token-B"]);
    for (const project of domain.projects())
      assert.equal(sources.syncState(String(project.id), "repo")?.complete, 1);
    environment.TEST_GITHUB = "";
    await sync.refresh();
    for (const project of domain.projects())
      assert.equal(
        sources.syncState(String(project.id), "repo")?.reason,
        "missing-credential",
      );
  } finally {
    await sync.stop();
    db.close();
  }
});

async function closedIssueService(closedIssues: "skip" | "done") {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-closure-mode-")),
  );
  const projectId = randomUUID();
  const profileId = randomUUID();
  const reader = { state: "open" as "open" | "closed", interrupted: 0 };
  let release!: () => void;
  const heldTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  const service = new StandaloneService(
    join(root, "data"),
    (): Runtime => ({
      async start() {},
      async stop() {},
      onUnexpectedRequest() {},
      async startThread() {
        return "thread";
      },
      async resumeThread() {},
      async startTurn() {
        turns++;
        return `turn-${turns}`;
      },
      async interruptTurn() {
        reader.interrupted++;
      },
      async waitForTurn() {
        await heldTurn;
        return "completed";
      },
    }),
    undefined,
    {
      issueTrackers: {
        readerFactories: {
          github: (): GitHubSourceReader => ({
            async readSelection() {
              return {
                complete: true,
                issues: [{ ...issue, state: reader.state }],
                reason: null,
              };
            },
            async readBlockers() {
              return { complete: true, blockers: [], reason: null };
            },
            async readIssueStatus() {
              return { status: reader.state };
            },
          }),
        },
        intervalMs: 60_000,
      },
      power: { enabled: false },
    },
  );
  await service.start();
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
    paused: false,
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
    closedIssues,
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
  await service.provisionTask(taskId);
  domain.execute({
    type: "assignment.create",
    actor: "agent",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId: randomUUID(),
    profileId,
    brief: "Complete imported work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await service.refreshGitHub();
  for (let i = 0; i < 100 && turns === 0; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(turns, 1);
  const db = new DatabaseSync(join(root, "data", "standalone.sqlite"));
  const unfinished = () =>
    Number(
      (
        db
          .prepare(
            `SELECT count(*) AS count FROM task_execution_bindings b JOIN execution_intents e ON e.workId = b.workId
            WHERE b.taskId = ? AND e.state IN ('ready','capacity-waiting','held','submitting','running')
            AND NOT EXISTS (SELECT 1 FROM execution_request_refusals r WHERE r.workId = e.workId)`,
          )
          .get(taskId) as { count: number }
      ).count,
    );
  return {
    service,
    domain,
    taskId,
    reader,
    db,
    turns: () => turns,
    notices: () =>
      Number(
        (
          db
            .prepare(
              "SELECT count(*) AS count FROM coordination_inbox_events WHERE taskId = ? AND eventType = 'source-hold'",
            )
            .get(taskId) as { count: number }
        ).count,
      ),
    completion: () =>
      service.githubSources().providerCompletion(taskId) !== undefined,
    hold: () => service.githubSources().hold("I_1"),
    async finishTurn() {
      release();
      for (let i = 0; i < 200 && unfinished() > 0; i++)
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      assert.equal(unfinished(), 0);
    },
    async close() {
      release();
      db.close();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("done mode completes a closed imported task only after its running turn settles", async () => {
  const w = await closedIssueService("done");
  try {
    w.reader.state = "closed";
    await w.service.refreshGitHub();
    assert.equal(w.domain.task(w.taskId).state, "open");
    assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
    assert.ok(w.notices() > 0, "the lead is told to stop safely");
    assert.equal(w.reader.interrupted, 0);
    assert.equal(w.completion(), false);
    await w.finishTurn();
    await w.service.refreshGitHub();
    assert.equal(w.domain.task(w.taskId).state, "done");
    assert.equal(w.completion(), true);
    assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
    assert.equal(w.turns(), 1);
  } finally {
    await w.close();
  }
});

test("done mode leaves a stopped closed task open with its holds", async () => {
  const w = await closedIssueService("done");
  try {
    w.reader.state = "closed";
    await w.service.refreshGitHub();
    await w.finishTurn();
    await w.service.stopTask(w.taskId);
    await w.service.refreshGitHub();
    assert.equal(w.domain.task(w.taskId).state, "open");
    assert.equal(w.completion(), false);
    assert.equal(w.hold()?.reason, "closed");
  } finally {
    await w.close();
  }
});

test("skip mode never completes a closed imported task", async () => {
  const w = await closedIssueService("skip");
  try {
    w.reader.state = "closed";
    await w.service.refreshGitHub();
    await w.finishTurn();
    await w.service.refreshGitHub();
    assert.equal(w.domain.task(w.taskId).state, "open");
    assert.equal(w.completion(), false);
    assert.deepEqual([w.hold()?.active, w.hold()?.reason], [1, "closed"]);
  } finally {
    await w.close();
  }
});

/**
 * A service whose GitHub selection imports a Ready issue from linked R_1, a not-Ready one,
 * and a Ready one from R_2, which is selected but not linked for checkout.
 */
async function importedWorkspaceService(options: {
  paused: boolean;
  /** Further issues the selection lists, after the three above. */
  extra?: IssueSnapshot[];
  /** The first turn runs until released, holding the project's capacity. */
  blockFirstTurn?: boolean;
  /** Every other turn stays active until `close()`, so the test can observe it. */
  holdTurns?: boolean;
}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-imported-workspace-")),
  );
  const makeRepository = (name: string) => {
    const path = join(root, name);
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
  };
  const repository = makeRepository("source");
  const unready: IssueSnapshot = {
    ...issue,
    nodeId: "I_2",
    number: 2,
    title: "Not ready",
    labels: [],
  };
  const unlinked: IssueSnapshot = {
    ...issue,
    nodeId: "I_3",
    repositoryId: "R_2",
    repositoryName: "org/other",
    number: 3,
    title: "Unlinked repository",
  };
  const startedWorkspaces: string[] = [];
  let release = () => {};
  const firstTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseHeld = () => {};
  const heldTurns = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let waitedTurns = 0;
  let blockersFail = false;
  const service = new StandaloneService(
    join(root, "data"),
    () => ({
      async start() {},
      async stop() {},
      onUnexpectedRequest() {},
      async startThread() {
        return "thread";
      },
      async resumeThread() {},
      async startTurn(_thread, workspace) {
        startedWorkspaces.push(workspace);
        return "turn";
      },
      async interruptTurn() {},
      async waitForTurn() {
        waitedTurns += 1;
        if (options.blockFirstTurn && waitedTurns === 1) await firstTurn;
        else if (options.holdTurns) await heldTurns;
        return "completed" as const;
      },
    }),
    undefined,
    {
      issueTrackers: {
        readerFactories: {
          github: () => ({
            async readSelection() {
              return {
                complete: true,
                issues: [issue, unready, unlinked, ...(options.extra ?? [])],
                reason: null,
              };
            },
            async readBlockers() {
              return blockersFail
                ? { complete: false, blockers: [], reason: "http-403" }
                : { complete: true, blockers: [], reason: null };
            },
            async readIssueStatus() {
              return { status: "open" as const };
            },
          }),
        },
        intervalMs: 60_000,
      },
      power: { enabled: false },
    },
  );
  const projectId = randomUUID();
  const profileId = randomUUID();
  await service.start();
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
  const resume = () =>
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
      paused: false,
    });
  if (!options.paused) resume();
  // Both repositories are selected; only R_1 is linked for checkout at first.
  const link = async (
    repositories: { repositoryId: string; path: string; ref: string }[],
  ) => {
    await domain.configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: domain.repositoryLinks(projectId).version,
      repositories: repositories.map((r) => ({
        codeHost: "github",
        host: "github.com",
        ...r,
      })),
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(domain.githubConfiguration(projectId).version),
      credentialRef: "env:TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
        {
          id: "other",
          kind: "repository",
          repositoryId: "R_2",
          owner: "org",
          name: "other",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    for (const selectionId of ["repo", "other"])
      domain.execute({
        type: "github.activate",
        actor: "operator",
        key: randomUUID(),
        projectId,
        selectionId,
        expectedVersion: Number(domain.githubConfiguration(projectId).version),
      });
    await service.refreshGitHub();
  };
  await link([{ repositoryId: "R_1", path: repository, ref: "main" }]);
  const taskId = (nodeId: string) =>
    String(service.githubSources().issue(nodeId)?.taskId);
  const request = (nodeId: string) =>
    service.turnRequests().find((r) => r.taskId === taskId(nodeId));
  return {
    service,
    domain,
    projectId,
    repository,
    makeRepository,
    link,
    profileId,
    startedWorkspaces,
    release,
    failBlockers(fail: boolean) {
      blockersFail = fail;
    },
    resume,
    taskId,
    request,
    async settle(done: () => boolean) {
      // Provisioning runs git, so wait on the clock rather than on ticks.
      for (let i = 0; i < 100 && !done(); i++)
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    },
    async close() {
      releaseHeld();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an admitted imported task's turn provisions a workspace from its linked source repository", async () => {
  const f = await importedWorkspaceService({ paused: false });
  try {
    const waiting = (nodeId: string) => f.request(nodeId)?.reason ?? "";
    await f.settle(
      () => f.startedWorkspaces.length > 0 && /not linked/.test(waiting("I_3")),
    );
    const binding = await f.service.taskWorkspace(f.taskId("I_1"));
    assert.deepEqual(
      binding?.repositories.map((r) => [r.repositoryId, r.sourcePath]),
      [["R_1", f.repository]],
    );
    assert.deepEqual(f.startedWorkspaces, [
      realpathSync(String(binding?.path)),
    ]);
    // A not-Ready imported task has no queued turn and no checkout.
    assert.equal(f.request("I_2"), undefined);
    assert.equal(await f.service.taskWorkspace(f.taskId("I_2")), undefined);
    // A Ready task whose repository the project does not link waits without a checkout.
    assert.match(waiting("I_3"), /source repository is not linked/);
    assert.equal(await f.service.taskWorkspace(f.taskId("I_3")), undefined);
  } finally {
    await f.close();
  }
});

test("an imported task's initial turn is queued only once admissible", async () => {
  const f = await importedWorkspaceService({ paused: true, holdTurns: true });
  try {
    await f.settle(() => false);
    assert.equal(f.request("I_1"), undefined);
    f.resume();
    await f.service.refreshGitHub();
    await f.settle(() => f.startedWorkspaces.length > 0);
    assert.equal(f.request("I_1")?.state, "active");
  } finally {
    await f.close();
  }
});

test("a queued imported turn that never ran takes the current task, profile and instructions revisions when admitted", async () => {
  const f = await importedWorkspaceService({ paused: false, holdTurns: true });
  try {
    const waiting = () => f.request("I_3")?.reason ?? "";
    await f.settle(() => /not linked/.test(waiting()));
    const queued = f.request("I_3");
    assert.equal(queued?.state, "queued");
    // The lead profile changes before the turn has ever run: no explicit apply is needed.
    f.domain.execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId: f.profileId,
      expectedVersion: Number(f.domain.profile(f.profileId).version),
      instructions: "Edited lead",
    });
    // Linking R_2 revises the task through the source sync before the turn is admitted.
    const other = f.makeRepository("other");
    const before = Number(f.domain.task(f.taskId("I_3")).version);
    await f.link([
      { repositoryId: "R_1", path: f.repository, ref: "main" },
      { repositoryId: "R_2", path: other, ref: "main" },
    ]);
    await f.settle(() => f.request("I_3")?.state !== "queued");
    const request = f.request("I_3");
    assert.equal(request?.state, "active");
    assert.ok(Number(f.domain.task(f.taskId("I_3")).version) > before);
    assert.equal(
      request?.taskVersion,
      Number(f.domain.task(f.taskId("I_3")).version),
    );
    assert.equal(
      request?.profileRevision,
      Number(f.domain.profile(f.profileId).version),
    );
    assert.equal(
      f.service
        .turnRequests()
        .filter((r) => r.taskId === f.taskId("I_3") && r.state === "held")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a first turn waiting for capacity takes revisions changed by a profile edit and a source sync", async () => {
  const f = await importedWorkspaceService({
    paused: true,
    extra: [{ ...issue, nodeId: "I_4", number: 4, title: "Second ready" }],
    blockFirstTurn: true,
    holdTurns: true,
  });
  try {
    await f.service.configureCapacity({
      key: randomUUID(),
      globalLimit: 4,
      projectOverrides: { [f.projectId]: 1 },
    });
    f.resume();
    await f.service.refreshGitHub();
    // One Ready task runs; the other is bound to an execution waiting for capacity.
    await f.settle(
      () =>
        f.startedWorkspaces.length === 1 &&
        /Capacity waiting/.test(f.request("I_4")?.reason ?? ""),
    );
    const waiting = f.request("I_4");
    assert.match(String(waiting?.reason), /Capacity waiting/);
    f.domain.execute({
      type: "profile.configure",
      actor: "operator",
      key: randomUUID(),
      profileId: f.profileId,
      expectedVersion: Number(f.domain.profile(f.profileId).version),
      instructions: "Edited lead",
    });
    // A blocker read that fails then recovers revises the task, as each restart does.
    const before = Number(f.domain.task(f.taskId("I_4")).version);
    f.failBlockers(true);
    await f.service.refreshGitHub();
    f.failBlockers(false);
    await f.service.refreshGitHub();
    assert.ok(Number(f.domain.task(f.taskId("I_4")).version) > before);
    f.release();
    await f.settle(() => f.startedWorkspaces.length === 2);
    const request = f.request("I_4");
    assert.equal(request?.state, "active");
    assert.equal(
      request?.taskVersion,
      Number(f.domain.task(f.taskId("I_4")).version),
    );
    assert.equal(
      request?.profileRevision,
      Number(f.domain.profile(f.profileId).version),
    );
  } finally {
    f.release();
    await f.close();
  }
});

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), init);

/** A synchronizer over the real credential reader, with a project and its fetcher. */
function credentialSync(
  fetcher: (url: string, init?: RequestInit) => Response,
  selection?: object,
) {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  const projectId = addGitHubProject(domain, selection);
  const sync = new GitHubSynchronizer(
    domain,
    sources,
    (ref) =>
      new CredentialGitHubSourceReader(ref, {
        environment: { TEST_GITHUB: "token" },
        fetcher: async (input, init) => fetcher(String(input), init),
      }),
  );
  /** Imports `number` as a blocker of a new local task, outside any selection read. */
  const addLocalDependent = (nodeId: string, number: number) => {
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, nodeId, number }],
      reason: null,
    });
    const localId = randomUUID();
    const execute = (command: object) =>
      domain.execute({
        actor: "operator",
        key: randomUUID(),
        projectId,
        ...command,
      } as never);
    execute({
      type: "task.create",
      taskId: localId,
      title: `Dependent ${number}`,
      outcome: "Wait",
      ready: true,
    });
    execute({
      type: "dependency.add",
      taskId: localId,
      blockerTaskId: String(sources.issue(nodeId)?.taskId),
      expectedVersion: Number(domain.task(localId).version),
    });
    return localId;
  };
  return { db, domain, sources, sync, projectId, addLocalDependent };
}

const statusRow = (db: DatabaseSync, nodeId: string) => ({
  ...db
    .prepare(
      "SELECT status, reason FROM external_item_status WHERE externalId = ?",
    )
    .get(nodeId),
});

test("a GraphQL RATE_LIMITED answer pauses the source credential until the reset", async () => {
  const requests: string[] = [];
  const { db, sources, sync, projectId } = credentialSync(
    (url) => {
      requests.push(url);
      return json(
        { errors: [{ type: "RATE_LIMITED", message: "x" }], data: null },
        {
          headers: {
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
          },
        },
      );
    },
    { id: "repo", kind: "project", projectNodeId: "P_1", filter: "" },
  );
  try {
    await sync.refresh();
    assert.equal(sources.syncState(projectId, "repo")?.reason, "rate-limited");
    const fetched = requests.length;
    assert.ok(fetched > 0);
    await sync.refresh();
    assert.equal(requests.length, fetched, "the paused pass fetches nothing");
  } finally {
    await sync.stop();
    db.close();
  }
});

test("a blocker outside every selection read keeps its status after its repository is renamed", async () => {
  const { db, domain, sync, addLocalDependent } = credentialSync((url) => {
    if (url === "https://api.github.com/repos/org/repo")
      return new Response(null, {
        status: 301,
        headers: { location: "/repositories/1" },
      });
    if (url === "https://api.github.com/repositories/1")
      return json({ node_id: "R_1", full_name: "org/renamed" });
    if (url === "https://api.github.com/repos/org/renamed/issues/1")
      return json({
        node_id: "I_1",
        number: 1,
        title: "Imported",
        body: "Ship",
        state: "closed",
        repository_url: "https://api.github.com/repos/org/renamed",
        labels: [],
      });
    // The selection's own listing fails, so nothing refreshes the issue.
    return new Response("unavailable", { status: 503 });
  });
  try {
    const localId = addLocalDependent("I_1", 1);
    await sync.refresh();
    assert.deepEqual(statusRow(db, "I_1"), { status: "closed", reason: null });
    assert.ok(!domain.admission(localId).reasons.includes("local-dependency"));
  } finally {
    await sync.stop();
    db.close();
  }
});

test("one refresh pass looks a repository up once across selection and blocker reads, and the next pass again", async () => {
  let lookups = 0;
  const { db, sync, addLocalDependent } = credentialSync((url) => {
    if (url === "https://api.github.com/repos/org/repo") {
      lookups++;
      return json({ node_id: "R_1", full_name: "org/repo" });
    }
    const match = /\/issues\/(\d+)$/.exec(url);
    if (match)
      return json({
        node_id: `I_${match[1]}`,
        number: Number(match[1]),
        title: "Imported",
        body: "Ship",
        state: "open",
        repository_url: "https://api.github.com/repos/org/repo",
        labels: [],
      });
    return new Response("unavailable", { status: 503 });
  });
  try {
    for (const number of [1, 2, 3]) addLocalDependent(`I_${number}`, number);
    await sync.refresh();
    assert.equal(lookups, 1);
    await sync.refresh();
    assert.equal(lookups, 2);
  } finally {
    await sync.stop();
    db.close();
  }
});

test("the service builds preview and sync readers from the injected issue-tracker reader factory", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-reader-seam-")));
  const projectId = randomUUID();
  const references: string[] = [];
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    () => {
      throw new Error("no runtime");
    },
    undefined,
    {
      issueTrackers: {
        readerFactories: {
          github: (reference) => {
            references.push(reference);
            return reader;
          },
        },
        intervalMs: 60_000,
      },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
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
        conditions: [{ kind: "label", name: "ready" }],
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
    await service.gitHubSourceReader("env:PREVIEW").readSelection({
      id: "repo",
      kind: "repository",
      repositoryId: "R_1",
      owner: "org",
      name: "repo",
    });
    assert.deepEqual(references, ["env:PREVIEW"]);
    await service.refreshGitHub();
    assert.deepEqual(references, ["env:PREVIEW", "env:TEST_GITHUB"]);
    assert.ok(service.githubSources().issue("I_1"));
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
