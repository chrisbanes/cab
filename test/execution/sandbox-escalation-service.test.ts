import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { CoordinationStore } from "../../src/core/coordination.js";
import { DomainConflictError } from "../../src/core/domain-errors.js";
import {
  type NativeInputEndpointIdentity,
  nativeEndpointKey,
} from "../../src/core/structured-questions.js";
import type { SandboxEscalationEvent } from "../../src/standalone/codex.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  fixtureRepository,
  linkRepositories,
  waitFor,
  worktreeGit,
} from "../fixtures/native-result.js";
import { loginCli, serveCli } from "../fixtures/operator-cli.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

/** The fixture runtime as a Codex runtime that holds escalations and records each reply. */
class EscalationRuntime extends OperatorFixtureRuntime {
  readonly harness = "codex" as const;
  readonly generation = randomUUID();
  readonly replies: Array<{
    identity: NativeInputEndpointIdentity;
    decision: "accept" | "decline";
  }> = [];
  private listener?: (event: SandboxEscalationEvent) => boolean;
  private readonly pending = new Map<string, NativeInputEndpointIdentity>();
  currentUserInputGeneration() {
    return this.generation;
  }
  processIdentity() {
    return {
      processId: "escalation-runtime",
      processStartedAt: "2026-11-12T00:00:00.000Z",
      bootId: "escalation-boot",
    };
  }
  onSandboxEscalation(listener: (event: SandboxEscalationEvent) => boolean) {
    this.listener = listener;
  }
  async replySandboxEscalation(
    identity: NativeInputEndpointIdentity,
    decision: "accept" | "decline",
  ) {
    if (!this.pending.delete(nativeEndpointKey(identity))) return false;
    this.replies.push({ identity, decision });
    return true;
  }
  /** As Codex does, an interrupt ends the turn's unanswered escalations. */
  override async interruptTurn(thread: string, turn: string) {
    for (const identity of [...this.pending.values()])
      if (identity.threadId === thread && identity.turnId === turn)
        this.end(identity);
  }
  request(
    identity: NativeInputEndpointIdentity,
    cwd: string,
    command = "node chromium.mjs escalated",
    reason = "needs host Chromium",
  ) {
    this.pending.set(nativeEndpointKey(identity), identity);
    const taken = this.emit({
      kind: "requested",
      identity,
      command,
      cwd,
      reason,
    });
    if (!taken) this.pending.delete(nativeEndpointKey(identity));
    return taken;
  }
  end(identity: NativeInputEndpointIdentity) {
    this.pending.delete(nativeEndpointKey(identity));
    this.emit({ kind: "ended", identity, reason: "Turn ended" });
  }
  emit(event: SandboxEscalationEvent) {
    if (!this.listener) throw new Error("No escalation listener");
    return this.listener(event);
  }
}

/** The started service's coordination store; tests read escalation evidence through it. */
const storeOf = (service: StandaloneService) =>
  (service as unknown as { acquired: { coordination: CoordinationStore } })
    .acquired.coordination;

type Approval = {
  interactionId: string;
  revision: number;
  status: string;
  action: string | null;
  target: string | null;
  material: unknown;
  approvable: boolean;
  lifecycle?: { status: string; resolution: string | null };
};

async function escalationTask(t: TestContext, expiryMs?: number) {
  const runtime = new EscalationRuntime();
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    () => runtime,
    expiryMs === undefined ? {} : { sandboxEscalationExpiryMs: expiryMs },
  );
  t.after(() => f.close());
  const seeded = await seedReviewTask(
    f,
    "Escalation project",
    "Run Chromium",
    "Run the browser check",
    [{ repositoryId: "R1", path: fixtureRepository() }],
  );
  linkRepositories(f, seeded.projectId, ["R1"]);
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    expectedVersion: Number(domain.project(seeded.projectId).version),
    paused: false,
    sandbox: "escalate-approval",
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(domain.task(seeded.taskId).version),
    ready: true,
  });
  await waitFor(() => f.service.list().some((w) => w.state === "running"));
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  assert.equal(f.service.sandboxLevelFor(work.workId), "escalate-approval");
  assert.equal(runtime.policies.at(-1)?.sandboxEscalation, "approval");
  const workspace = await f.service.taskWorkspace(seeded.taskId);
  if (workspace?.state !== "ready") throw new Error("Workspace missing");
  const worktree = workspace.repositories[0]!.workspacePath;
  // The material names the working directory relative to the task workspace.
  const shownCwd = relative(workspace.path, worktree) || ".";
  writeFileSync(join(worktree, "uncommitted.txt"), "dirty");
  const api = new OperatorApi(f.service, [f.directory]);
  let item = 0;
  const identity = (
    overrides: Partial<NativeInputEndpointIdentity> = {},
  ): NativeInputEndpointIdentity => ({
    requestId: ++item,
    runtimeGeneration: runtime.generation,
    threadId: work.threadId!,
    turnId: work.turnId!,
    itemId: `item-${item}`,
    ...overrides,
  });
  const approvals = async () =>
    (await api.readTask(seeded.taskId)).data.approvals as Approval[];
  /** Raises an escalation and waits for its Inbox approval. */
  const escalate = async (
    at = identity(),
    command?: string,
    reason?: string,
  ) => {
    const known = new Set((await approvals()).map((a) => a.interactionId));
    assert.equal(runtime.request(at, worktree, command, reason), true);
    // Approvals of the same second sort by id, so the new one is found by id, not position.
    const fresh = () =>
      f.service
        .coordinationView()
        .readTask(seeded.taskId)
        .approvals.find((a) => !known.has(a.interactionId));
    await waitFor(() => fresh() !== undefined);
    const approval = (await approvals()).find(
      (a) => a.interactionId === fresh()!.interactionId,
    )!;
    return { identity: at, approval };
  };
  const decide = (
    approval: Approval,
    decision: "approved" | "denied",
    key: string = randomUUID(),
  ) =>
    api.execute({
      type: "approval.decide",
      key,
      taskId: seeded.taskId,
      interactionId: approval.interactionId,
      expectedRevision: approval.revision,
      decision,
      action: approval.action!,
      material: approval.material,
    } as never);
  const record = (interactionId: string) =>
    storeOf(f.service).sandboxEscalation(interactionId);
  return {
    f,
    runtime,
    seeded,
    work,
    worktree,
    shownCwd,
    api,
    identity,
    approvals,
    escalate,
    decide,
    record,
  };
}

test("an escalation becomes an Inbox approval; approve answers accept once and records its exit code and duration", async (t) => {
  const s = await escalationTask(t);
  const { identity, approval } = await s.escalate();
  assert.equal(approval.action, "sandbox.escalate");
  assert.equal(approval.target, null);
  assert.equal(approval.approvable, true);
  assert.deepEqual(approval.material, {
    command: "node chromium.mjs escalated",
    cwd: s.shownCwd,
    reason: "needs host Chromium",
    workspace: {
      head: worktreeGit(s.worktree, "rev-parse", "HEAD"),
      // The task worktree is detached.
      branch: null,
      dirty: true,
    },
  });
  const inbox = (await s.api.readInbox()).data.items.find(
    (i: { id: string }) => i.id === approval.interactionId,
  ) as { headline?: string } | undefined;
  assert.equal(inbox?.headline, "Run a command outside the sandbox");
  // While it waits, the turn keeps running, and its pending callback keeps its slot and writer.
  const waiting = s.f.service.list().find((w) => w.workId === s.work.workId);
  assert.equal(waiting?.state, "running");
  const callbacks = (
    s.f.service as unknown as { callbacks: Map<string, Set<unknown>> }
  ).callbacks;
  assert.equal(callbacks.get(s.work.workId)?.size, 1);
  assert.deepEqual(s.runtime.replies, []);

  const key = randomUUID();
  await s.decide(approval, "approved", key);
  assert.deepEqual(s.runtime.replies, [{ identity, decision: "accept" }]);
  await waitFor(() => !callbacks.has(s.work.workId));
  // A replayed decision sends nothing more.
  await s.decide(approval, "approved", key);
  assert.equal(s.runtime.replies.length, 1);
  assert.doesNotMatch(
    JSON.stringify(s.runtime.replies),
    /acceptForSession|mendment/,
  );
  // The decision event is history: it is never delivered to the agent.
  assert.deepEqual(
    storeOf(s.f.service)
      .pendingEvents(s.seeded.assignmentId)
      .filter((e) => e.interactionId === approval.interactionId),
    [],
  );
  s.runtime.emit({
    kind: "completed",
    identity,
    exitCode: 3,
    durationMs: 1234,
    // A leaky event must still store no output.
    ...({ aggregatedOutput: "OUTPUT_SENTINEL" } as object),
  } as SandboxEscalationEvent);
  const evidence = s.record(approval.interactionId);
  assert.deepEqual(
    {
      decider: evidence?.decider,
      decision: evidence?.decision,
      delivered: evidence?.delivered,
      exitCode: evidence?.exitCode,
      durationMs: evidence?.durationMs,
      durationSource: evidence?.durationSource,
    },
    {
      decider: "operator",
      decision: "accept",
      delivered: true,
      exitCode: 3,
      durationMs: 1234,
      durationSource: "runtime",
    },
  );
  assert.ok(evidence?.completedAt);
  // Without a runtime duration, the service measures it from the decision.
  const second = await s.escalate();
  await s.decide(second.approval, "approved");
  s.runtime.emit({
    kind: "completed",
    identity: second.identity,
    exitCode: 0,
    durationMs: null,
  });
  const measured = s.record(second.approval.interactionId);
  assert.equal(measured?.durationSource, "service");
  assert.equal(typeof measured?.durationMs, "number");
  s.f.seedPersistedState((db) => {
    const rows = JSON.stringify([
      db.prepare("SELECT * FROM sandbox_escalations").all(),
      db.prepare("SELECT * FROM coordination_interactions").all(),
      db.prepare("SELECT * FROM coordination_inbox_events").all(),
      db.prepare("SELECT * FROM inbox_lifecycle").all(),
    ]);
    assert.doesNotMatch(rows, /OUTPUT_SENTINEL/);
  });
});

test("decline answers decline and records no exit code; an escalation without an exact admitted turn is refused", async (t) => {
  const s = await escalationTask(t);
  const { identity, approval } = await s.escalate();
  await s.decide(approval, "denied");
  assert.deepEqual(s.runtime.replies, [{ identity, decision: "decline" }]);
  s.runtime.emit({
    kind: "completed",
    identity,
    exitCode: 1,
    durationMs: 5,
  });
  const evidence = s.record(approval.interactionId);
  assert.equal(evidence?.decision, "decline");
  assert.equal(evidence?.exitCode, null);
  assert.equal(evidence?.durationMs, null);
  // Another turn, another generation, or an agent's own approval request are all refused.
  assert.equal(
    s.runtime.request(s.identity({ turnId: "foreign-turn" }), s.worktree),
    false,
  );
  assert.equal(
    s.runtime.request(
      s.identity({ runtimeGeneration: randomUUID() }),
      s.worktree,
    ),
    false,
  );
  assert.equal((await s.approvals()).length, 1);
  const agent = await s.f.runtime.callTool({
    threadId: s.work.threadId!,
    turnId: s.work.turnId!,
    callId: "agent-escalation",
    tool: "cab_request_approval",
    arguments: {
      action: "sandbox.escalate",
      material: { command: "rm -rf /" },
    },
  });
  assert.equal(agent.success, false);
  assert.match(agent.text, /reserved/);
  assert.equal((await s.approvals()).length, 1);
  // A sandbox.escalate approval never authorizes a delivery action.
  assert.equal(
    storeOf(s.f.service).authorizationFor({
      assignmentId: s.seeded.assignmentId,
      interactionId: approval.interactionId,
      expectedRevision: approval.revision + 1,
      action: "pr.create",
      material: approval.material,
    }),
    false,
  );
});

test("an unanswered escalation is declined after the expiry, and a later decision conflicts", async (t) => {
  const s = await escalationTask(t, 50);
  const { identity, approval } = await s.escalate();
  await waitFor(() => s.runtime.replies.length === 1);
  assert.deepEqual(s.runtime.replies, [{ identity, decision: "decline" }]);
  const [expired] = await s.approvals();
  assert.equal(expired?.status, "denied");
  assert.equal(
    expired?.lifecycle?.resolution,
    "Expired: declined after 15 minutes without an answer",
  );
  assert.equal(s.record(approval.interactionId)?.decider, "expiry");
  await assert.rejects(
    s.decide(approval, "approved"),
    (error) => error instanceof OperatorApiError && error.status === 409,
  );
  assert.equal(s.runtime.replies.length, 1);
});

test("an operator decision and the expiry racing record one decision and send one reply", async (t) => {
  const s = await escalationTask(t);
  const store = storeOf(s.f.service);
  // Expiry first: the decision then conflicts.
  const first = await s.escalate();
  assert.equal(
    store.resolveSandboxEscalation(first.approval.interactionId, "expired")
      .decider,
    "expiry",
  );
  await assert.rejects(
    s.decide(first.approval, "approved"),
    (error) => error instanceof OperatorApiError && error.status === 409,
  );
  // The decision first: a late expiry leaves it unchanged.
  const second = await s.escalate();
  await s.decide(second.approval, "approved");
  assert.equal(
    store.resolveSandboxEscalation(second.approval.interactionId, "expired")
      .decider,
    "operator",
  );
  // Concurrent deliveries claim the one reply once.
  await Promise.all([
    s.f.service.settleSandboxEscalation(first.approval.interactionId),
    s.f.service.settleSandboxEscalation(first.approval.interactionId),
  ]);
  assert.deepEqual(
    s.runtime.replies.map((r) => [r.identity.itemId, r.decision]),
    [
      [second.identity.itemId, "accept"],
      [first.identity.itemId, "decline"],
    ],
  );
  assert.throws(
    () =>
      store.decideApproval({
        actor: "operator",
        key: randomUUID(),
        interactionId: first.approval.interactionId,
        expectedRevision: first.approval.revision,
        decision: "approved",
        action: "sandbox.escalate",
        material: first.approval.material,
      }),
    DomainConflictError,
  );
});

test("an escalation whose turn ends or is stopped resolves obsolete with no reply", async (t) => {
  const s = await escalationTask(t);
  const ended = await s.escalate();
  s.runtime.end(ended.identity);
  const [obsolete] = await s.approvals();
  assert.equal(obsolete?.approvable, false);
  assert.equal(
    obsolete?.lifecycle?.resolution,
    "Obsolete: the request ended before it was answered",
  );
  assert.equal(s.record(ended.approval.interactionId)?.decider, "obsolete");
  // An obsolete escalation is no longer approvable.
  await assert.rejects(
    s.decide(ended.approval, "approved"),
    (error) => error instanceof OperatorApiError && error.status === 403,
  );

  const stopped = await s.escalate();
  await s.api.execute({
    type: "task.stop",
    key: randomUUID(),
    taskId: s.seeded.taskId,
  } as never);
  await waitFor(
    () => s.record(stopped.approval.interactionId)?.decider === "obsolete",
  );
  assert.deepEqual(s.runtime.replies, []);
});

test("a stop withdraws a held escalation, and a start withdraws one a crash left pending", async (t) => {
  const s = await escalationTask(t);
  const pending = await s.escalate();
  const approved = await s.escalate();
  await s.decide(approved.approval, "approved");
  await s.f.service.stop();
  // A crash before either settled: one undecided, one decided but its reply never claimed.
  const data = join(s.f.directory, "data");
  const db = new DatabaseSync(join(data, "standalone.sqlite"));
  try {
    assert.equal(
      db
        .prepare(
          "SELECT decider FROM sandbox_escalations WHERE interactionId = ?",
        )
        .get(pending.approval.interactionId)?.decider,
      "obsolete",
    );
    db.prepare(
      "UPDATE sandbox_escalations SET decider = NULL, decision = NULL, decidedAt = NULL WHERE interactionId = ?",
    ).run(pending.approval.interactionId);
    db.prepare(
      "UPDATE inbox_lifecycle SET status = 'actionable', obsolete = 0, resolution = NULL, resolvedAt = NULL WHERE id = ?",
    ).run(pending.approval.interactionId);
    db.prepare(
      "UPDATE coordination_operator_attention SET status = 'open', resolvedAt = NULL WHERE interactionId = ?",
    ).run(pending.approval.interactionId);
    db.prepare(
      "UPDATE sandbox_escalations SET delivered = NULL WHERE interactionId = ?",
    ).run(approved.approval.interactionId);
  } finally {
    db.close();
  }
  const restarted = new StandaloneService(
    data,
    () => new EscalationRuntime(),
    undefined,
    { power: { enabled: false } },
  );
  await restarted.start();
  try {
    const store = storeOf(restarted);
    const withdrawn = store.sandboxEscalation(pending.approval.interactionId);
    assert.equal(withdrawn?.decider, "obsolete");
    assert.equal(withdrawn?.decision, null);
    assert.equal(
      restarted.inboxLifecycle().get(pending.approval.interactionId)?.obsolete,
      1,
    );
    const undelivered = store.sandboxEscalation(
      approved.approval.interactionId,
    );
    assert.equal(undelivered?.decision, "accept");
    assert.equal(undelivered?.delivered, false);
    assert.equal(undelivered?.exitCode, null);
  } finally {
    await restarted.stop();
  }
});

test("a long command is cut to fit the approval limit and the cut is shown, whatever the reason holds", async (t) => {
  const s = await escalationTask(t);
  // Control characters escape to six bytes each, so the reason alone could exceed the limit.
  const { approval } = await s.escalate(
    undefined,
    `node ${"x".repeat(20_000)}`,
    "\u0001".repeat(5_000),
  );
  const material = approval.material as {
    command: string;
    reason: string;
    truncated?: boolean;
  };
  assert.equal(material.truncated, true);
  assert.ok(material.command.startsWith("node x"));
  assert.ok(material.command.length < 20_000);
  assert.equal(material.reason.length, 512);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(material)).byteLength <= 8192,
  );
  assert.equal(approval.approvable, true);
  // The task read carries the cut marker for the task UI and the CLI.
  const [escalation] =
    (await s.api.readTask(s.seeded.taskId)).data.sandboxEscalations ?? [];
  assert.equal(escalation?.truncated, true);
});

test("the task read and cab task get show each escalation's command, decision, exit code and duration", async (t) => {
  const s = await escalationTask(t);
  const approved = await s.escalate();
  await s.decide(approved.approval, "approved");
  s.runtime.emit({
    kind: "completed",
    identity: approved.identity,
    exitCode: 3,
    durationMs: 1234,
  });
  const declined = await s.escalate();
  await s.decide(declined.approval, "denied");
  // The lead profile's private instructions in a command withhold its material.
  const withheld = await s.escalate(
    undefined,
    "echo PRIVATE REVIEW INSTRUCTIONS",
  );
  const read = (await s.api.readTask(s.seeded.taskId)).data.sandboxEscalations;
  // Times are asserted present or absent, then compared without their values.
  assert.deepEqual(
    read?.map((e) => [
      e.requestedAt > 0,
      e.decidedAt !== null,
      e.completedAt !== null,
    ]),
    // Approved and completed; declined with no completion; pending.
    [
      [true, true, true],
      [true, true, false],
      [true, false, false],
    ],
  );
  assert.deepEqual(
    read?.map((e) => ({ ...e, requestedAt: 0, decidedAt: 0, completedAt: 0 })),
    [
      {
        interactionId: approved.approval.interactionId,
        command: "node chromium.mjs escalated",
        truncated: false,
        cwd: s.shownCwd,
        workspace: {
          head: worktreeGit(s.worktree, "rev-parse", "HEAD"),
          branch: null,
          dirty: true,
        },
        decider: "operator",
        decision: "accept",
        outcome: "approved",
        exitCode: 3,
        durationMs: 1234,
        durationSource: "runtime",
        requestedAt: 0,
        decidedAt: 0,
        completedAt: 0,
      },
      {
        interactionId: declined.approval.interactionId,
        command: "node chromium.mjs escalated",
        truncated: false,
        cwd: s.shownCwd,
        workspace: {
          head: worktreeGit(s.worktree, "rev-parse", "HEAD"),
          branch: null,
          dirty: true,
        },
        decider: "operator",
        decision: "decline",
        outcome: "declined",
        exitCode: null,
        durationMs: null,
        durationSource: null,
        requestedAt: 0,
        decidedAt: 0,
        completedAt: 0,
      },
      {
        interactionId: withheld.approval.interactionId,
        command: null,
        truncated: false,
        cwd: null,
        workspace: null,
        decider: null,
        decision: null,
        outcome: "pending",
        exitCode: null,
        durationMs: null,
        durationSource: null,
        requestedAt: 0,
        decidedAt: 0,
        completedAt: 0,
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE REVIEW INSTRUCTIONS/);

  const served = await serveCli(t, s.f);
  const { h } = await loginCli(t, served);
  const r = await h.run(["task", "get", s.seeded.taskId, "--connection", "ro"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(
    r.out.includes(
      `Escalation ${approved.approval.interactionId}: node chromium.mjs escalated in ${s.shownCwd} · HEAD ${worktreeGit(s.worktree, "rev-parse", "HEAD").slice(0, 12)} · detached · uncommitted changes · Approved by the operator · exit code 3 · 1.2 s`,
    ),
    r.out,
  );
  assert.ok(
    r.out.includes(
      `Escalation ${declined.approval.interactionId}: node chromium.mjs escalated in ${s.shownCwd} · HEAD ${worktreeGit(s.worktree, "rev-parse", "HEAD").slice(0, 12)} · detached · uncommitted changes · Declined by the operator`,
    ),
  );
  assert.ok(
    r.out.includes(
      `Escalation ${withheld.approval.interactionId}: Command unavailable in an unavailable directory · Workspace state unknown · Waiting for an operator answer`,
    ),
  );
  assert.doesNotMatch(r.out, /PRIVATE REVIEW INSTRUCTIONS/);
});
