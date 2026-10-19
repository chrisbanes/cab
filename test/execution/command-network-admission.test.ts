import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Runtime, RuntimeTurnPolicy } from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { coordinationFixture } from "../fixtures/coordination.js";
import { tmpdir } from "../fixtures/temp.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const workerProfile = "30000000-0000-4000-8000-000000000002";

function admissionFixture() {
  const f = coordinationFixture();
  f.db
    .prepare(
      "INSERT INTO scheduler_project_capacity_limits (projectId, projectLimit) VALUES (?, 20)",
    )
    .run(projectId);
  const setNetwork = (enabled: boolean) => {
    f.domain.execute({
      type: "project.configure",
      actor: "operator",
      key: crypto.randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.project(projectId).version),
      commandNetworkAccess: enabled,
    });
  };
  let sequence = 0;
  /** A ready intent bound to a fresh assignment on a harness. */
  const ready = (taskId: string, harness: ExecutionHarness = "codex") => {
    sequence += 1;
    const workId = `net-work-${sequence}`;
    const assignmentId = crypto.randomUUID();
    f.domain.execute({
      type: "assignment.create",
      actor: "agent",
      key: crypto.randomUUID(),
      projectId,
      taskId,
      assignmentId,
      profileId: workerProfile,
      brief: "Network test",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    const assignment = f.domain.assignment(assignmentId);
    const intent = f.state.create(workId, "work", `/tmp/net-${sequence}`);
    f.state.bindTask(
      workId,
      {
        taskId: String(assignment.taskId),
        assignmentId,
        assignmentVersion: Number(assignment.version),
        instructionsRevision: Number(assignment.instructionsRevision),
        profileRevision: Number(assignment.profileRevision),
      },
      harness,
    );
    return intent;
  };
  const admit = (intent: { id: string }) =>
    f.state.begin(intent.id, { projectId });
  return { f, setNetwork, ready, admit };
}

test("a turn records the project's command network setting at its own admission", () => {
  const { f, setNetwork, ready, admit } = admissionFixture();
  try {
    const before = ready(taskA);
    const earlier = ready(taskB);
    assert.equal(f.state.commandNetworkAccess(before.id), null);

    // Enabled after `before` was created but before it is admitted: the
    // setting at admission wins, and an already admitted turn keeps its value.
    assert.equal(admit(earlier), true);
    setNetwork(true);
    assert.equal(admit(before), true);
    assert.equal(f.state.commandNetworkAccess(earlier.id), false);
    assert.equal(f.state.commandNetworkAccess(before.id), true);

    // Disabling leaves the admitted turn on and the next one off.
    setNetwork(false);
    const after = ready(taskA);
    assert.equal(admit(after), true);
    assert.equal(f.state.commandNetworkAccess(after.id), false);
    assert.equal(f.state.commandNetworkAccess(before.id), true);
  } finally {
    f.close();
  }
});

test("only Codex task turns can be admitted with command network access", () => {
  const { f, setNetwork, ready, admit } = admissionFixture();
  try {
    setNetwork(true);
    const claude = ready(taskA, "claude");
    assert.equal(admit(claude), true);
    assert.equal(f.state.commandNetworkAccess(claude.id), false);

    // A request without a task binding, such as a drafting run, stays off.
    const drafting = f.state.create(
      "drafting:run-1",
      "draft",
      "/tmp/net-draft",
    );
    assert.equal(f.state.begin(drafting.id, { projectId }), true);
    assert.equal(f.state.commandNetworkAccess(drafting.id), false);

    // No admission, no record: a waiting turn, one held before it was ever
    // admitted, and one admitted before the setting existed all read null.
    const waiting = ready(taskB);
    assert.equal(f.state.commandNetworkAccess(waiting.id), null);
    const heldEarly = ready(taskB);
    assert.equal(
      f.state.hold(heldEarly.id, "Storage failure before submission"),
      true,
    );
    assert.equal(f.state.commandNetworkAccess(heldEarly.id), null);
    const running = f.state.byWorkId("work-child-a");
    assert.equal(running?.state, "running");
    assert.equal(f.state.commandNetworkAccess(String(running?.id)), null);
  } finally {
    f.close();
  }
});

test("the live network run refuses to start without --live --one-attempt", () => {
  const run = spawnSync(
    process.execPath,
    ["test/execution/network-access-qualification/live-network.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Refusing live Codex execution/);
  assert.equal(run.stdout, "");
});

/** A Codex runtime that records each `startTurn` call and can hold a thread start. */
class RecordingRuntime implements Runtime {
  turns: {
    workspace: unknown;
    arity: number;
    policy: RuntimeTurnPolicy | undefined;
  }[] = [];
  gate: Promise<void> | undefined;
  entered: (() => void) | undefined;
  private ids = 0;
  async start() {}
  async stop() {}
  async startThread() {
    this.entered?.();
    await this.gate;
    return `thread-${++this.ids}`;
  }
  async resumeThread() {}
  async startTurn(...call: unknown[]) {
    this.turns.push({
      workspace: call[1],
      arity: call.length,
      policy: call[4] as RuntimeTurnPolicy | undefined,
    });
    return `turn-${++this.ids}`;
  }
  async interruptTurn() {}
  async waitForTurn(): Promise<"completed"> {
    return "completed";
  }
  onUnexpectedRequest() {}
}

test("a turn admitted after enabling runs with network access and one admitted before keeps it off", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-network-admission-"));
  const runtime = new RecordingRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const d = service.domain();
  const exec = (body: Record<string, unknown>) =>
    d.execute({ key: randomUUID(), actor: "operator", ...body } as never);
  const profileId = randomUUID();
  const projectId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Lead the work.",
    capabilities: "shell",
  });
  exec({
    type: "project.create",
    projectId,
    name: "Network admission",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  const setNetwork = (enabled: boolean) =>
    exec({
      type: "project.configure",
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      commandNetworkAccess: enabled,
    });
  const seen = new Set<string>();
  const start = async (title: string) => {
    const taskId = randomUUID();
    exec({
      type: "task.create",
      projectId,
      taskId,
      title,
      outcome: "Probe",
      ready: false,
    });
    await service.provisionTask(taskId);
    exec({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
  };
  /** The first turn run in an intent's workspace; later repair turns are not counted. */
  const turnOf = (intent: { workspace: string }) => {
    const turn = runtime.turns.find((t) => t.workspace === intent.workspace);
    return turn && { arity: turn.arity, policy: turn.policy };
  };
  const finished = async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const intent = service
        .list()
        .find((i) => i.workId.endsWith(":initial") && !seen.has(i.id));
      if (intent?.state === "completed") {
        seen.add(intent.id);
        return intent;
      }
      assert.ok(Date.now() < deadline, "the turn completed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // (a) Default: today's three-argument call and a recorded off.
  await start("default");
  const first = await finished();
  assert.deepEqual(turnOf(first), { arity: 3, policy: undefined });
  assert.equal(service.commandNetworkAccessFor(first.workId), false);

  // (c) Admitted, then held in its thread start while the setting is enabled.
  let release!: () => void;
  runtime.gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    runtime.entered = resolve;
  });
  await start("before");
  await entered;
  runtime.gate = undefined;
  setNetwork(true);
  release();
  const before = await finished();
  assert.deepEqual(turnOf(before), { arity: 3, policy: undefined });
  assert.equal(service.commandNetworkAccessFor(before.workId), false);

  // (b) A turn admitted after enabling carries the policy as the fifth argument.
  await start("after");
  const after = await finished();
  assert.deepEqual(turnOf(after), {
    arity: 5,
    policy: { networkAccess: true },
  });
  assert.equal(service.commandNetworkAccessFor(after.workId), true);

  // (d) Disabling again affects only later admissions.
  setNetwork(false);
  await start("disabled");
  const disabled = await finished();
  assert.deepEqual(turnOf(disabled), { arity: 3, policy: undefined });
  assert.equal(service.commandNetworkAccessFor(disabled.workId), false);
  assert.equal(service.commandNetworkAccessFor(after.workId), true);
  assert.equal(service.commandNetworkAccessFor("unknown-work"), null);
});
