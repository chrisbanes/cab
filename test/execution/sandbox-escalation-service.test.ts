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
import type { SandboxReviewIdentity } from "../../src/core/sandbox-level.js";
import type {
  SandboxEscalationEvent,
  SandboxReviewEvent,
} from "../../src/standalone/codex.js";
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
  private reviewListener?: (event: SandboxReviewEvent) => void;
  /** Denials that can still be overruled, as Codex keeps them for the running turn. */
  readonly denials = new Map<string, SandboxReviewIdentity>();
  readonly overrules: SandboxReviewIdentity[] = [];
  overruleAnswer = true;
  onSandboxReview(listener: (event: SandboxReviewEvent) => void) {
    this.reviewListener = listener;
  }
  async overruleSandboxDenial(identity: SandboxReviewIdentity) {
    if (!this.denials.delete(identity.reviewId)) return false;
    this.overrules.push(identity);
    return this.overruleAnswer;
  }
  emitReview(event: SandboxReviewEvent) {
    if (!this.reviewListener) throw new Error("No review listener");
    if (event.kind === "review" && event.overrulable)
      this.denials.set(event.identity.reviewId, event.identity);
    this.reviewListener(event);
  }
  /** As Codex does at a turn's end, its denials can no longer be overruled. */
  endDenials(turn: string) {
    for (const identity of [...this.denials.values()])
      if (identity.turnId === turn) {
        this.denials.delete(identity.reviewId);
        this.emitReview({
          kind: "overruleEnded",
          identity,
          reason: "Turn ended",
        });
      }
  }
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
    this.endDenials(turn);
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

async function escalationTask(
  t: TestContext,
  expiryMs?: number,
  level: "escalate-approval" | "escalate-auto-review" = "escalate-approval",
) {
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
    sandbox: level,
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
  assert.equal(f.service.sandboxLevelFor(work.workId), level);
  assert.equal(
    runtime.policies.at(-1)?.sandboxEscalation,
    level === "escalate-auto-review" ? "auto-review" : "approval",
  );
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
  let reviews = 0;
  const reviewIdentity = (
    overrides: Partial<SandboxReviewIdentity> = {},
  ): SandboxReviewIdentity => ({
    runtimeGeneration: runtime.generation,
    threadId: work.threadId!,
    turnId: work.turnId!,
    reviewId: `review-${++reviews}`,
    targetItemId: `reviewed-item-${reviews}`,
    ...overrides,
  });
  /** Waits for the service to apply every reviewer event emitted so far. */
  const settled = () =>
    (f.service as unknown as { sandboxReviewQueue: Promise<void> })
      .sandboxReviewQueue;
  /** A started review, then its completion with `status`; resolves once both are applied. */
  const review = async (
    status: "approved" | "denied" | "timedOut" | "aborted",
    {
      identity: at = reviewIdentity(),
      cwd = worktree,
      command = "node chromium.mjs reviewed",
    }: {
      identity?: SandboxReviewIdentity;
      cwd?: string;
      command?: string;
    } = {},
  ) => {
    const base = { kind: "review" as const, identity: at, command, cwd };
    runtime.emitReview({
      ...base,
      status: "inProgress",
      riskLevel: null,
      rationale: null,
      overrulable: false,
    });
    runtime.emitReview({
      ...base,
      status,
      riskLevel: status === "approved" ? "low" : "high",
      rationale: `The reviewer ${status} it`,
      overrulable: status === "denied",
    });
    await settled();
    return at;
  };
  const reviewRecord = (at: SandboxReviewIdentity) =>
    storeOf(f.service).sandboxReview(at);
  return {
    reviewIdentity,
    review,
    settled,
    reviewRecord,
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

const autoReviewTask = (t: TestContext, expiryMs?: number) =>
  escalationTask(t, expiryMs, "escalate-auto-review");
const knownRisk = (service: StandaloneService, workId: string) =>
  (
    service as unknown as {
      started(): { supervisor: { hasKnownRisk(workId: string): boolean } };
    }
  )
    .started()
    .supervisor.hasKnownRisk(workId);

test("a reviewer approval is recorded with its risk, rationale, exit code and duration, and creates no Inbox item", async (t) => {
  const s = await autoReviewTask(t);
  const approved = await s.review("approved");
  const record = s.reviewRecord(approved);
  assert.deepEqual(
    {
      decider: record?.decider,
      decision: record?.decision,
      status: record?.status,
      riskLevel: record?.riskLevel,
      rationale: record?.rationale,
      command: record?.command,
      cwd: record?.cwd,
      workspace: record?.workspace,
      overrule: record?.overrule,
    },
    {
      decider: "reviewer",
      decision: "accept",
      status: "approved",
      riskLevel: "low",
      rationale: "The reviewer approved it",
      command: "node chromium.mjs reviewed",
      cwd: s.shownCwd,
      workspace: {
        head: worktreeGit(s.worktree, "rev-parse", "HEAD"),
        branch: null,
        dirty: true,
      },
      overrule: null,
    },
  );
  assert.deepEqual(await s.approvals(), []);
  const { reviewId: _reviewId, ...target } = approved;
  s.runtime.emitReview({
    kind: "itemCompleted",
    target,
    exitCode: 0,
    durationMs: 516,
    // A leaky event must still store no output.
    ...({ aggregatedOutput: "OUTPUT_SENTINEL" } as object),
  } as SandboxReviewEvent);
  await s.settled();
  const completed = s.reviewRecord(approved);
  assert.equal(completed?.exitCode, 0);
  assert.equal(completed?.durationMs, 516);
  assert.equal(completed?.durationSource, "runtime");
  // Without a runtime duration, the service measures it from the approval.
  const second = await s.review("approved");
  const { reviewId: _second, ...secondTarget } = second;
  s.runtime.emitReview({
    kind: "itemCompleted",
    target: secondTarget,
    exitCode: 2,
    durationMs: null,
  });
  await s.settled();
  assert.equal(s.reviewRecord(second)?.durationSource, "service");
  assert.equal(s.reviewRecord(second)?.exitCode, 2);
  s.f.seedPersistedState((db) => {
    assert.doesNotMatch(
      JSON.stringify(db.prepare("SELECT * FROM sandbox_reviews").all()),
      /OUTPUT_SENTINEL/,
    );
  });
});

test("a review bound on arrival is recorded with its command result even when the turn completes before the write", async (t) => {
  const s = await autoReviewTask(t);
  // Hold the review queue, as a slow workspace Git read or an earlier write would.
  let release!: () => void;
  const queue = s.f.service as unknown as { sandboxReviewQueue: Promise<void> };
  queue.sandboxReviewQueue = new Promise<void>((done) => {
    release = done;
  });
  const at = s.reviewIdentity();
  const base = {
    kind: "review" as const,
    identity: at,
    command: "node chromium.mjs reviewed",
    cwd: s.worktree,
    overrulable: false,
  };
  s.runtime.emitReview({
    ...base,
    status: "inProgress",
    riskLevel: null,
    rationale: null,
  });
  s.runtime.emitReview({
    ...base,
    status: "approved",
    riskLevel: "low",
    rationale: "The reviewer approved it",
  });
  const { reviewId: _reviewId, ...target } = at;
  s.runtime.emitReview({
    kind: "itemCompleted",
    target,
    exitCode: 0,
    durationMs: 42,
  });
  s.runtime.complete(s.runtime.turns);
  await waitFor(
    () =>
      s.f.service.list().find((w) => w.workId === s.work.workId)?.state !==
      "running",
  );
  release();
  await s.settled();
  const record = s.reviewRecord(at);
  assert.equal(record?.workId, s.work.workId);
  assert.equal(record?.taskId, s.seeded.taskId);
  assert.equal(record?.decision, "accept");
  assert.equal(record?.exitCode, 0);
  assert.equal(record?.durationMs, 42);
});

test("a timed-out or aborted review is recorded as a decline, and a request that still reaches cab follows the escalate-approval path", async (t) => {
  const s = await autoReviewTask(t, 50);
  for (const status of ["timedOut", "aborted"] as const) {
    const at = await s.review(status);
    assert.equal(s.reviewRecord(at)?.status, status);
    assert.equal(s.reviewRecord(at)?.decision, "decline");
    assert.equal(s.reviewRecord(at)?.overrule, null);
  }
  assert.deepEqual(await s.approvals(), []);
  const { identity, approval } = await s.escalate();
  assert.equal(approval.action, "sandbox.escalate");
  await waitFor(() => s.runtime.replies.length === 1);
  assert.deepEqual(s.runtime.replies, [{ identity, decision: "decline" }]);
  assert.equal(s.record(approval.interactionId)?.decider, "expiry");
});

test("a review that does not bind to the exact admitted escalate-auto-review turn records nothing; one of another generation notes an anomaly", async (t) => {
  const s = await autoReviewTask(t);
  const foreignTurn = await s.review("approved", {
    identity: s.reviewIdentity({ turnId: "foreign-turn" }),
  });
  assert.equal(s.reviewRecord(foreignTurn), undefined);
  assert.equal(knownRisk(s.f.service, s.work.workId), false);
  const otherGeneration = await s.review("denied", {
    identity: s.reviewIdentity({ runtimeGeneration: randomUUID() }),
  });
  assert.equal(s.reviewRecord(otherGeneration), undefined);
  assert.equal(knownRisk(s.f.service, s.work.workId), true);
  assert.deepEqual(await s.approvals(), []);
  assert.deepEqual(s.runtime.overrules, []);
});

test("a review of a turn admitted at escalate-approval is not recorded", async (t) => {
  const s = await escalationTask(t);
  const at = await s.review("approved");
  assert.equal(s.reviewRecord(at), undefined);
  assert.equal(knownRisk(s.f.service, s.work.workId), true);
});

test("a reviewer denial offers an advisory overrule; approve overrules it once and the retry is a separate review", async (t) => {
  const s = await autoReviewTask(t);
  const denied = await s.review("denied");
  const record = s.reviewRecord(denied);
  assert.equal(record?.decision, "decline");
  const [approval] = await s.approvals();
  assert.ok(approval);
  assert.equal(record?.overrule?.interactionId, approval.interactionId);
  assert.equal(approval.action, "sandbox.overrule");
  assert.equal(approval.approvable, true);
  assert.deepEqual(approval.material, {
    command: "node chromium.mjs reviewed",
    cwd: s.shownCwd,
    workspace: {
      head: worktreeGit(s.worktree, "rev-parse", "HEAD"),
      branch: null,
      dirty: true,
    },
    riskLevel: "high",
    rationale: "The reviewer denied it",
  });
  const inbox = (await s.api.readInbox()).data.items.find(
    (i: { id: string }) => i.id === approval.interactionId,
  ) as { headline?: string } | undefined;
  assert.equal(inbox?.headline, "Overrule a reviewer denial");
  // An open overrule holds nothing: the turn keeps running without a pending callback.
  const callbacks = (
    s.f.service as unknown as { callbacks: Map<string, Set<unknown>> }
  ).callbacks;
  assert.equal(callbacks.has(s.work.workId), false);
  const key = randomUUID();
  await s.decide(approval, "approved", key);
  assert.deepEqual(s.runtime.overrules, [denied]);
  await s.decide(approval, "approved", key);
  // Even with the runtime ready to send again, the claimed overrule is never sent twice.
  s.runtime.denials.set(denied.reviewId, denied);
  (
    s.f.service as unknown as { overruleRuntimes: Map<string, unknown> }
  ).overruleRuntimes.set(approval.interactionId, s.runtime);
  await s.f.service.settleSandboxOverrule(approval.interactionId);
  assert.equal(s.runtime.overrules.length, 1);
  assert.deepEqual(s.reviewRecord(denied)?.overrule, {
    interactionId: approval.interactionId,
    decider: "operator",
    decision: "accept",
    decidedAt: s.reviewRecord(denied)?.overrule?.decidedAt,
    delivered: true,
  });
  // The decision event is history: it is never delivered to the agent.
  assert.deepEqual(
    storeOf(s.f.service)
      .pendingEvents(s.seeded.assignmentId)
      .filter((e) => e.interactionId === approval.interactionId),
    [],
  );
  // The retry is reviewed again, as its own review.
  const retry = await s.review("approved");
  assert.deepEqual(
    storeOf(s.f.service)
      .sandboxReviews(s.seeded.taskId)
      .map((r) => [r.identity.reviewId, r.status, r.overrule !== null]),
    [
      [denied.reviewId, "denied", true],
      [retry.reviewId, "approved", false],
    ],
  );
});

test("a declined overrule keeps the denial; a rejected overrule records it was not delivered", async (t) => {
  const s = await autoReviewTask(t);
  const kept = await s.review("denied");
  const [first] = await s.approvals();
  await s.decide(first!, "denied");
  assert.deepEqual(s.runtime.overrules, []);
  assert.equal(s.reviewRecord(kept)?.overrule?.decision, "decline");
  assert.equal(s.reviewRecord(kept)?.overrule?.delivered, null);
  s.runtime.overruleAnswer = false;
  const rejected = await s.review("denied");
  const second = (await s.approvals()).find(
    (a) =>
      a.interactionId === s.reviewRecord(rejected)?.overrule?.interactionId,
  );
  await s.decide(second!, "approved");
  assert.equal(s.runtime.overrules.length, 1);
  assert.equal(s.reviewRecord(rejected)?.overrule?.delivered, false);
  // A runtime of another generation is never asked to overrule.
  s.runtime.overruleAnswer = true;
  const other = await s.review("denied");
  const third = (await s.approvals()).find(
    (a) => a.interactionId === s.reviewRecord(other)?.overrule?.interactionId,
  );
  s.runtime.currentUserInputGeneration = () => randomUUID();
  await s.decide(third!, "approved");
  assert.equal(s.runtime.overrules.length, 1);
  assert.equal(s.reviewRecord(other)?.overrule?.delivered, false);
});

test("a denial whose turn ends before it is recorded offers no overrule, and a long command is cut and marked", async (t) => {
  const s = await autoReviewTask(t);
  const at = s.reviewIdentity();
  const base = {
    kind: "review" as const,
    identity: at,
    command: "node chromium.mjs reviewed",
    cwd: s.worktree,
    riskLevel: "high" as const,
    rationale: "denied",
  };
  s.runtime.emitReview({ ...base, status: "inProgress", overrulable: false });
  s.runtime.emitReview({ ...base, status: "denied", overrulable: true });
  s.runtime.endDenials(s.work.turnId!);
  await s.settled();
  assert.equal(s.reviewRecord(at)?.status, "denied");
  assert.equal(s.reviewRecord(at)?.overrule, null);
  assert.deepEqual(await s.approvals(), []);
  const long = await s.review("denied", { command: "x".repeat(5000) });
  assert.equal(s.reviewRecord(long)?.command.length, 4096);
  assert.equal(s.reviewRecord(long)?.truncated, true);
  const [approval] = await s.approvals();
  assert.ok(approval);
  assert.equal((approval.material as { truncated?: boolean }).truncated, true);
});

test("an overrule is withdrawn when its turn ends or is stopped, and a later decision is refused", async (t) => {
  const s = await autoReviewTask(t);
  const ended = await s.review("denied");
  s.runtime.endDenials(s.work.turnId!);
  await s.settled();
  const [obsolete] = await s.approvals();
  assert.equal(obsolete?.approvable, false);
  assert.equal(
    obsolete?.lifecycle?.resolution,
    "Obsolete: the turn ended before the overrule was decided",
  );
  assert.equal(s.reviewRecord(ended)?.overrule?.decider, "obsolete");
  await assert.rejects(
    s.decide(obsolete!, "approved"),
    (error) => error instanceof OperatorApiError && error.status === 403,
  );
  const stopped = await s.review("denied");
  await s.api.execute({
    type: "task.stop",
    key: randomUUID(),
    taskId: s.seeded.taskId,
  } as never);
  await waitFor(
    () => s.reviewRecord(stopped)?.overrule?.decider === "obsolete",
  );
  assert.deepEqual(s.runtime.overrules, []);
});

test("a denial of a command outside the task workspace offers no overrule, and an agent cannot request one", async (t) => {
  const s = await autoReviewTask(t);
  const outside = await s.review("denied", { cwd: "/private/var/empty" });
  assert.equal(s.reviewRecord(outside)?.cwd, "/private/var/empty");
  assert.equal(s.reviewRecord(outside)?.overrule, null);
  const agent = await s.f.runtime.callTool({
    threadId: s.work.threadId!,
    turnId: s.work.turnId!,
    callId: "agent-overrule",
    tool: "cab_request_approval",
    arguments: { action: "sandbox.overrule", material: { command: "x" } },
  });
  assert.equal(agent.success, false);
  assert.match(agent.text, /reserved/);
  assert.deepEqual(await s.approvals(), []);
});

test("a stop withdraws an open overrule, and a start withdraws one a crash left open", async (t) => {
  const s = await autoReviewTask(t);
  const open = await s.review("denied");
  const interactionId = s.reviewRecord(open)!.overrule!.interactionId;
  await s.f.service.stop();
  const data = join(s.f.directory, "data");
  const db = new DatabaseSync(join(data, "standalone.sqlite"));
  try {
    assert.equal(
      db
        .prepare(
          "SELECT overruleDecider FROM sandbox_reviews WHERE interactionId = ?",
        )
        .get(interactionId)?.overruleDecider,
      "obsolete",
    );
    // A crash before the stop could withdraw it.
    db.prepare(
      "UPDATE sandbox_reviews SET overruleDecider = NULL, overruleDecidedAt = NULL WHERE interactionId = ?",
    ).run(interactionId);
    db.prepare(
      "UPDATE inbox_lifecycle SET status = 'actionable', obsolete = 0, resolution = NULL, resolvedAt = NULL WHERE id = ?",
    ).run(interactionId);
    db.prepare(
      "UPDATE coordination_operator_attention SET status = 'open', resolvedAt = NULL WHERE interactionId = ?",
    ).run(interactionId);
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
    const withdrawn = storeOf(restarted).sandboxReviewByOverrule(interactionId);
    assert.equal(withdrawn?.overrule?.decider, "obsolete");
    assert.equal(restarted.inboxLifecycle().get(interactionId)?.obsolete, 1);
  } finally {
    await restarted.stop();
  }
});
