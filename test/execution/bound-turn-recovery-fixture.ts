import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startCliService, loginCli } from "../fixtures/operator-cli.js";
import {
  NoTurnRuntime,
  reconcileAsBefore,
} from "../fixtures/recovery-generations.js";
import { until } from "../fixtures/until.js";
import type { TerminationVerification } from "../../src/standalone/recovery-types.js";
import { PROCESS_STILL_PRESENT } from "../../src/standalone/termination.js";
import type { BoundTurnRecoveryCommand } from "../../src/standalone/pre-turn-recovery.js";
import type { HeldTurnReleaseOptions } from "../../src/standalone/held-turn-release.js";

/** A genuinely submitted, bound fake turn whose observation is lost. No model or OS process. */
export class BoundRuntime extends NoTurnRuntime {
  override rejectStart = false;
  complete = false;
  approval = false;
  seedConversation = false;
  beforeObservationLost:
    | ((threadId: string, turnId: string) => void)
    | undefined;
  readonly resumed: string[] = [];
  override async resumeThread(threadId?: string) {
    this.resumed.push(threadId ?? "");
  }
  override async waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed"> {
    if (this.seedConversation && this.turnInvocations.length === 1) {
      const result = await this.listener?.({
        threadId,
        turnId,
        callId: "seed-wait",
        tool: "cab_ask_question",
        arguments: { question: "Seed completed conversation" },
      });
      assert.equal(result?.success, true);
      return "completed";
    }
    if (this.approval)
      await this.listener?.({
        threadId,
        turnId,
        callId: "bound-approval",
        tool: "cab_request_approval",
        arguments: {
          action: "publish",
          target: "offline artifact",
          material: { digest: "retained-exact-material" },
        },
      });
    if (!this.complete) {
      this.beforeObservationLost?.(threadId, turnId);
      throw new Error("Bound runtime observation lost");
    }
    return super.waitForTurn(threadId, turnId);
  }
}
export async function boundWorld(
  t: { after(fn: () => unknown): void },
  harness: "codex" | "claude" = "codex",
  excluded: string[] = [],
  approval = false,
  seedConversation = false,
  options: {
    runtime?: BoundRuntime;
    /** A runtime of the other harness, started beside the bound one. */
    foreign?: BoundRuntime;
    mode?: "verified" | "unknown";
    heldTurnRelease?: HeldTurnReleaseOptions;
  } = {},
) {
  const runtime = options.runtime ?? new BoundRuntime();
  runtime.approval = approval;
  runtime.seedConversation = seedConversation;
  let mode:
    | "verified"
    | "live"
    | "unknown"
    | "conflict"
    | "other-identity"
    | "hang" = options.mode ?? "verified";
  let gate: Promise<void> | undefined;
  let checks = 0;
  // Without release options each lost turn is held as an earlier build left it: an
  // unfinished callback keeps release off it until `reconcile` records that build's receipt.
  const callbacks = new Map<string, () => void>();
  if (!options.heldTurnRelease)
    runtime.beforeObservationLost = (threadId, turnId) => {
      const intent = s.f.service
        .list()
        .find((i) => i.threadId === threadId && i.turnId === turnId);
      assert.ok(intent);
      s.f.service.registerExecutionCallback(
        intent.workId,
        new Promise<void>((resolve) => callbacks.set(intent.workId, resolve)),
      );
    };
  const verifier = {
    async verify(
      identity: typeof runtime.identity,
    ): Promise<TerminationVerification> {
      checks++;
      if (gate) await gate;
      if (mode === "hang") return new Promise(() => {});
      if (mode === "unknown")
        return { kind: "unknown", reason: "No process proof" };
      if (mode === "live")
        return { kind: "conflict", reason: PROCESS_STILL_PRESENT };
      if (mode === "conflict")
        return { kind: "conflict", reason: "PID reused or boot changed" };
      return {
        kind: "verified",
        processIdentity:
          mode === "other-identity"
            ? { ...identity, processId: "another-process" }
            : identity,
        verifiedAt: "2026-10-03T10:05:00.000Z",
        method: "mac-pid-absent-same-boot",
      };
    },
  };
  const s = await startCliService(t, {
    // The service passes the harness; only a foreign runtime makes it matter.
    runtimeFactory: ((_context: unknown, h: string) =>
      h === harness
        ? runtime
        : (options.foreign ?? runtime)) as () => BoundRuntime,
    controlPaths: excluded,
    service: {
      runtimeHarnesses: options.foreign
        ? [harness, harness === "codex" ? "claude" : "codex"]
        : [harness],
      power: { enabled: false },
      routingClient: null,
      terminationVerifier: verifier,
      ...(options.heldTurnRelease && {
        heldTurnRelease: options.heldTurnRelease,
      }),
    },
  });
  t.after(() => {
    for (const end of callbacks.values()) end();
  });
  const command = (body: Record<string, unknown>) =>
    s.f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  command({
    type: "profile.create",
    profileId,
    name: "Bound recovery",
    instructions: "offline",
    capabilities: "coordination",
    runtime:
      harness === "claude"
        ? { harness, model: "opus", reasoningEffort: "high" }
        : { harness },
  });
  command({
    type: "project.create",
    projectId,
    name: "Bound recovery",
    leadProfileId: profileId,
  });
  command({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: true,
  });
  command({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  command({
    type: "task.create",
    projectId,
    taskId,
    title: "Bound",
    outcome: "Recover explicitly",
    ready: true,
  });
  await s.f.service.provisionTask(taskId);
  const assignmentId = String(s.f.service.domain().assignments(taskId)[0]?.id);
  assert.notEqual(assignmentId, "undefined");
  if (!seedConversation) {
    await s.f.service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId,
      recipientAssignmentId: assignmentId,
      expectedAssignmentVersion: 1,
      message: "Retained inbox work",
    });
  }
  command({
    type: "project.configure",
    projectId,
    expectedVersion: Number(s.f.service.domain().project(projectId).version),
    paused: false,
  });
  if (seedConversation) {
    await until(
      () =>
        s.f.service.coordinationView().readTask(taskId).questions.length ===
          1 && s.f.service.list().every((i) => i.state !== "running"),
      "completed seed conversation",
    );
    const question = s.f.service.coordinationView().readTask(taskId)
      .questions[0];
    assert.ok(question);
    await s.f.service.coordinationView().answerQuestion({
      key: randomUUID(),
      taskId,
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: "Continue the existing conversation",
    });
  }
  await until(
    () =>
      s.f.service.list().some((i) => i.state === "held" && i.turnId !== null),
    "bound held turn",
  );
  const record = s.f.service
    .recoveryForTask(taskId)
    .find((r) => r.intent.state === "held" && r.intent.turnId);
  assert.ok(
    record?.intent.threadId &&
      record.intent.turnId &&
      record.generation.workRevision,
  );
  const g = {
    assignmentId,
    projectId,
    taskId,
    workId: record.workId,
    threadId: record.intent.threadId,
    turnId: record.intent.turnId,
    workRevision: record.generation.workRevision,
    requestSequence: record.generation.requestSequence,
    // Claude records none; the receipt helper still needs one.
    processIdentity: record.processIdentity ?? runtime.identity,
  };
  const recovery = (key: string = randomUUID()): BoundTurnRecoveryCommand => ({
    key,
    assignmentId,
    receipt: {
      kind: "bound-turn",
      workId: g.workId,
      workRevision: g.workRevision,
      requestSequence: g.requestSequence,
      threadId: g.threadId,
      turnId: g.turnId,
      processIdentity: g.processIdentity,
      termination: { kind: "process-exit" },
      effects: "settled",
      workspace: "preserved",
    },
  });
  return {
    s,
    g,
    runtime,
    command,
    recovery,
    /** Records the earlier build's receipt for a held turn, then ends its callback. */
    async reconcile(command: BoundTurnRecoveryCommand = recovery()) {
      const result = await reconcileAsBefore(s.f.service, command);
      callbacks.get(command.receipt.workId)?.();
      callbacks.delete(command.receipt.workId);
      await new Promise((resolve) => setImmediate(resolve));
      return result;
    },
    checks: () => checks,
    setMode: (next: typeof mode) => {
      mode = next;
    },
    setGate: (next: Promise<void> | undefined) => {
      gate = next;
    },
    async cli() {
      return loginCli(t, s);
    },
  };
}
