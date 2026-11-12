import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { type TestContext, test } from "node:test";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Runtime, RuntimeTurnPolicy } from "../../src/standalone/codex.js";
import type { SandboxLevel } from "../../src/core/sandbox-level.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { ExecutionState } from "../../src/standalone/state.js";
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
  const setListening = (enabled: boolean) => {
    f.domain.execute({
      type: "project.configure",
      actor: "operator",
      key: crypto.randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.project(projectId).version),
      localListening: enabled,
    });
  };
  const setSandbox = (level: SandboxLevel) => {
    f.domain.execute({
      type: "project.configure",
      actor: "operator",
      key: crypto.randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.project(projectId).version),
      sandbox: level,
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
  return { f, setNetwork, setListening, setSandbox, ready, admit };
}

test("reasoning opt-in is snapshotted at admission for either task harness and survives restart", () => {
  const { f, ready, admit } = admissionFixture();
  try {
    f.db.exec(
      "UPDATE scheduler_capacity_limits SET globalLimit = 20 WHERE singleton = 1",
    );
    const configure = (fields: object) =>
      f.domain.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: Number(f.domain.project(projectId).version),
        ...fields,
      });
    const earlier = ready(taskA);
    const queued = ready(taskB, "claude");
    assert.equal(f.state.reasoningSummaries(queued.id), null);
    assert.equal(admit(earlier), true);
    configure({ reasoningSummaries: true });
    assert.equal(admit(queued), true);
    assert.equal(f.state.reasoningSummaries(earlier.id), false);
    assert.equal(f.state.reasoningSummaries(queued.id), true);
    const codex = ready(taskA);
    assert.equal(admit(codex), true);
    assert.equal(f.state.reasoningSummaries(codex.id), true);
    configure({ diagnosticCapture: "baseline" });
    const later = ready(taskB, "claude");
    assert.equal(admit(later), true);
    assert.equal(f.state.reasoningSummaries(later.id), false);
    configure({ diagnosticCapture: "enhanced", reasoningSummaries: true });
    const draft = f.state.create(
      "drafting:reasoning",
      "draft",
      "/tmp/reasoning-draft",
    );
    assert.equal(admit(draft), true);
    assert.equal(f.state.reasoningSummaries(draft.id), false);
    configure({ reasoningSummaries: false });
    f.reopen();
    assert.equal(f.state.reasoningSummaries(queued.id), true);
    assert.equal(f.domain.reasoningSummaries(projectId), false);
  } finally {
    f.close();
  }
});

test("reasoning table migration preserves projects and historical turns and is repeatable", () => {
  const { f } = admissionFixture();
  try {
    const project = f.domain.project(projectId);
    const historical = f.state.byWorkId("work-child-a");
    f.db.exec(
      "DROP TABLE execution_intent_reasoning_summaries; DROP TABLE project_reasoning_summaries",
    );
    f.reopen();
    assert.deepEqual(f.domain.project(projectId), project);
    assert.deepEqual(f.state.byWorkId("work-child-a"), historical);
    assert.equal(f.domain.reasoningSummaries(projectId), false);
    assert.equal(f.state.reasoningSummaries(String(historical?.id)), null);
    f.domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.project(projectId).version),
      reasoningSummaries: true,
    });
    f.reopen();
    assert.equal(f.domain.reasoningSummaries(projectId), true);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.close();
  }
});

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

test("a Claude task turn records the project's local listening setting at its own admission", () => {
  const { f, setListening, ready, admit } = admissionFixture();
  try {
    const before = ready(taskA, "claude");
    const earlier = ready(taskB, "claude");
    assert.equal(f.state.localListening(before.id), null);

    // Enabled after `before` was created but before it is admitted: the
    // setting at admission wins, and an already admitted turn keeps its value.
    assert.equal(admit(earlier), true);
    setListening(true);
    assert.equal(admit(before), true);
    assert.equal(f.state.localListening(earlier.id), false);
    assert.equal(f.state.localListening(before.id), true);
    assert.equal(f.state.commandNetworkAccess(before.id), false);

    // Disabling leaves the admitted turn on and the next one off.
    setListening(false);
    const after = ready(taskA, "claude");
    assert.equal(admit(after), true);
    assert.equal(f.state.localListening(after.id), false);
    assert.equal(f.state.localListening(before.id), true);
  } finally {
    f.close();
  }
});

test("only Claude task turns can be admitted with local listening", () => {
  const { f, setNetwork, setListening, ready, admit } = admissionFixture();
  try {
    setNetwork(true);
    setListening(true);
    const codex = ready(taskA);
    assert.equal(admit(codex), true);
    assert.equal(f.state.localListening(codex.id), false);
    assert.equal(f.state.commandNetworkAccess(codex.id), true);

    // A request without a task binding, such as a drafting run, stays off.
    const drafting = f.state.create(
      "drafting:run-1",
      "draft",
      "/tmp/net-draft",
    );
    assert.equal(f.state.begin(drafting.id, { projectId }), true);
    assert.equal(f.state.localListening(drafting.id), false);

    // No admission, no record.
    const waiting = ready(taskB, "claude");
    assert.equal(f.state.localListening(waiting.id), null);
    const heldEarly = ready(taskB, "claude");
    assert.equal(
      f.state.hold(heldEarly.id, "Storage failure before submission"),
      true,
    );
    assert.equal(f.state.localListening(heldEarly.id), null);
    const running = f.state.byWorkId("work-child-a");
    assert.equal(running?.state, "running");
    assert.equal(f.state.localListening(String(running?.id)), null);

    // A draft turn never gets local listening, even on a Claude task binding.
    new SchedulerStore(f.db);
    const state = new ExecutionState(f.db);
    const draft = ready(taskB, "claude");
    f.db
      .prepare(
        "INSERT INTO turn_requests (requestKey, workId, kind, prompt, state, draftTurn) VALUES (?, ?, 'assignment', 'Draft', 'active', 1)",
      )
      .run(randomUUID(), draft.workId);
    assert.equal(state.begin(draft.id, { projectId }), true);
    assert.equal(state.localListening(draft.id), false);
    assert.equal(state.commandNetworkAccess(draft.id), false);
  } finally {
    f.close();
  }
});

test("a task turn of either harness records the project's sandbox level at its own admission", () => {
  const { f, setSandbox, ready, admit } = admissionFixture();
  try {
    const before = ready(taskA, "claude");
    const earlier = ready(taskB, "codex");
    assert.equal(f.state.sandboxLevel(before.id), null);

    assert.equal(admit(earlier), true);
    setSandbox("unsandboxed");
    assert.equal(admit(before), true);
    assert.equal(f.state.sandboxLevel(earlier.id), "strict");
    assert.equal(f.state.sandboxLevel(before.id), "unsandboxed");
    assert.equal(f.state.localListening(before.id), false);
    assert.equal(f.state.commandNetworkAccess(before.id), false);

    // A running turn keeps its value; the next admission gets the new one.
    setSandbox("strict");
    const after = ready(taskA, "codex");
    assert.equal(admit(after), true);
    assert.equal(f.state.sandboxLevel(after.id), "strict");
    assert.equal(f.state.sandboxLevel(before.id), "unsandboxed");
    setSandbox("unsandboxed");
    const codex = ready(taskB, "codex");
    assert.equal(admit(codex), true);
    assert.equal(f.state.sandboxLevel(codex.id), "unsandboxed");
    assert.equal(f.state.sandboxLevel(after.id), "strict");
  } finally {
    f.close();
  }
});

test("a drafting run, a draft turn and an unadmitted turn never record the unsandboxed level", () => {
  const { f, setSandbox, ready, admit } = admissionFixture();
  try {
    setSandbox("unsandboxed");
    const drafting = f.state.create(
      "drafting:run-1",
      "draft",
      "/tmp/net-draft",
    );
    assert.equal(f.state.begin(drafting.id, { projectId }), true);
    assert.equal(f.state.sandboxLevel(drafting.id), "strict");
    assert.equal(
      f.state.applicableSandboxLevel(drafting.id, projectId),
      "strict",
    );

    const waiting = ready(taskB, "claude");
    assert.equal(f.state.sandboxLevel(waiting.id), null);
    assert.equal(
      f.state.applicableSandboxLevel(waiting.id, projectId),
      "unsandboxed",
    );

    new SchedulerStore(f.db);
    const state = new ExecutionState(f.db);
    const draft = ready(taskB, "claude");
    f.db
      .prepare(
        "INSERT INTO turn_requests (requestKey, workId, kind, prompt, state, draftTurn) VALUES (?, ?, 'assignment', 'Draft', 'active', 1)",
      )
      .run(randomUUID(), draft.workId);
    assert.equal(state.applicableSandboxLevel(draft.id, projectId), "strict");
    assert.equal(state.begin(draft.id, { projectId }), true);
    assert.equal(state.sandboxLevel(draft.id), "strict");
    setSandbox("strict");
    assert.equal(
      f.state.applicableSandboxLevel(waiting.id, projectId),
      "strict",
    );
    assert.equal(admit(waiting), true);
  } finally {
    f.close();
  }
});

for (const level of ["escalate-approval", "escalate-auto-review"] as const)
  test(`a task turn is admitted at the ${level} level when its harness has the seam; the rest record strict`, () => {
    const { f, setSandbox, ready, admit } = admissionFixture();
    try {
      f.db.exec(
        "UPDATE scheduler_capacity_limits SET globalLimit = 20 WHERE singleton = 1",
      );
      const earlier = ready(taskA, "codex");
      assert.equal(admit(earlier), true);
      setSandbox(level);
      const codex = ready(taskA, "codex");
      const claude = ready(taskB, "claude");
      assert.equal(f.state.applicableSandboxLevel(codex.id, projectId), level);
      assert.equal(admit(codex), true);
      assert.equal(admit(claude), true);
      assert.equal(f.state.sandboxLevel(codex.id), level);
      // Claude Code has the escalate-approval seam; auto-review stays Codex only.
      assert.equal(
        f.state.sandboxLevel(claude.id),
        level === "escalate-approval" ? level : "strict",
      );
      // A running turn keeps its level; only later admissions see a change.
      assert.equal(f.state.sandboxLevel(earlier.id), "strict");
      const drafting = f.state.create(
        `drafting:${level}`,
        "draft",
        `/tmp/net-${level}`,
      );
      assert.equal(f.state.begin(drafting.id, { projectId }), true);
      assert.equal(f.state.sandboxLevel(drafting.id), "strict");
      new SchedulerStore(f.db);
      const state = new ExecutionState(f.db);
      const draft = ready(taskB, "codex");
      f.db
        .prepare(
          "INSERT INTO turn_requests (requestKey, workId, kind, prompt, state, draftTurn) VALUES (?, ?, 'assignment', 'Draft', 'active', 1)",
        )
        .run(randomUUID(), draft.workId);
      assert.equal(state.begin(draft.id, { projectId }), true);
      assert.equal(state.sandboxLevel(draft.id), "strict");
      const unbound = state.create(
        `${level}-unbound`,
        "work",
        "/tmp/net-unbound",
      );
      assert.equal(state.begin(unbound.id, { projectId }), true);
      assert.equal(state.sandboxLevel(unbound.id), "strict");
      setSandbox("strict");
      assert.equal(state.sandboxLevel(codex.id), level);
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

test("the live local listening run and probe refuse to start without their flags", () => {
  for (const [script, refusal] of [
    [
      "test/execution/local-listening-qualification/live-local-listening.mjs",
      /Refusing live execution/,
    ],
    [
      "test/execution/local-listening-qualification/sandbox-listen-probe.mjs",
      /Refusing live sandbox probes/,
    ],
  ] as const) {
    const run = spawnSync(process.execPath, [script, "--live"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, refusal);
    assert.equal(run.stdout, "");
  }
});

/** A Codex runtime that records each `startTurn` call and can hold a thread start. */
class RecordingRuntime implements Runtime {
  turns: {
    workspace: unknown;
    arity: number;
    policy: RuntimeTurnPolicy | undefined;
  }[] = [];
  preflights: {
    workspace: string;
    skipSandbox?: boolean;
    sandboxEscalation?: "approval" | "auto-review";
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
  async preflightTurn(input: {
    workspace: string;
    skipSandbox?: boolean;
    sandboxEscalation?: "approval" | "auto-review";
  }) {
    this.preflights.push(input);
    return undefined;
  }
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

/** A service on a `RecordingRuntime` for both harnesses, with helpers to run one task turn. */
async function recordingService(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cab-network-admission-"));
  const runtime = new RecordingRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const d = service.domain();
  const exec = (body: Record<string, unknown>) =>
    d.execute({ key: randomUUID(), actor: "operator", ...body } as never);
  /** An unpaused project whose lead runs on `harness`. */
  const project = (harness: ExecutionHarness = "codex") => {
    const profileId = randomUUID();
    const projectId = randomUUID();
    exec({
      type: "profile.create",
      profileId,
      name: "Lead",
      instructions: "Lead the work.",
      capabilities: "shell",
      ...(harness === "claude"
        ? { runtime: { harness, model: "opus", reasoningEffort: "high" } }
        : {}),
    });
    exec({
      type: "project.create",
      projectId,
      name: `Network admission ${harness}`,
      leadProfileId: profileId,
    });
    exec({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    return projectId;
  };
  const configure = (projectId: string, settings: Record<string, unknown>) =>
    exec({
      type: "project.configure",
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      ...settings,
    });
  const seen = new Set<string>();
  const start = async (projectId: string, title: string) => {
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
  return { service, runtime, project, configure, start, turnOf, finished };
}

test("a turn admitted after enabling runs with network access and one admitted before keeps it off", async (t) => {
  const { service, runtime, project, configure, start, turnOf, finished } =
    await recordingService(t);
  const projectId = project();
  const setNetwork = (enabled: boolean) =>
    configure(projectId, { commandNetworkAccess: enabled });

  // (a) Default: today's three-argument call and a recorded off.
  await start(projectId, "default");
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
  await start(projectId, "before");
  await entered;
  runtime.gate = undefined;
  setNetwork(true);
  release();
  const before = await finished();
  assert.deepEqual(turnOf(before), { arity: 3, policy: undefined });
  assert.equal(service.commandNetworkAccessFor(before.workId), false);

  // (b) A turn admitted after enabling carries the policy as the fifth argument.
  await start(projectId, "after");
  const after = await finished();
  assert.deepEqual(turnOf(after), {
    arity: 5,
    policy: { networkAccess: true },
  });
  assert.equal(service.commandNetworkAccessFor(after.workId), true);

  // (d) Disabling again affects only later admissions.
  setNetwork(false);
  await start(projectId, "disabled");
  const disabled = await finished();
  assert.deepEqual(turnOf(disabled), { arity: 3, policy: undefined });
  assert.equal(service.commandNetworkAccessFor(disabled.workId), false);
  assert.equal(service.commandNetworkAccessFor(after.workId), true);
  assert.equal(service.commandNetworkAccessFor("unknown-work"), null);
});

test("each harness receives the expected sandbox policy for every combination of local listening and command network access", async (t) => {
  const { service, project, configure, start, turnOf, finished } =
    await recordingService(t);
  for (const harness of ["codex", "claude"] as const) {
    const projectId = project(harness);
    for (const network of [false, true])
      for (const listening of [false, true]) {
        configure(projectId, {
          commandNetworkAccess: network,
          localListening: listening,
        });
        await start(projectId, `${harness} ${network} ${listening}`);
        const intent = await finished();
        const expected =
          harness === "codex"
            ? network
              ? { networkAccess: true }
              : undefined
            : listening
              ? { networkAccess: false, localListening: true }
              : undefined;
        assert.deepEqual(
          turnOf(intent)?.policy,
          expected,
          `${harness} network=${network} listening=${listening}`,
        );
        assert.equal(
          service.localListeningFor(intent.workId),
          harness === "claude" && listening,
        );
      }
  }
});

test("a task turn of either harness runs with skipSandbox only when admitted at the unsandboxed level", async (t) => {
  const { service, project, configure, start, turnOf, finished } =
    await recordingService(t);
  for (const harness of ["codex", "claude"] as const) {
    const projectId = project(harness);
    for (const on of [false, true]) {
      configure(projectId, { sandbox: on ? "unsandboxed" : "strict" });
      await start(projectId, `${harness} ${on}`);
      const intent = await finished();
      assert.deepEqual(
        turnOf(intent)?.policy,
        on ? { networkAccess: false, skipSandbox: true } : undefined,
        `${harness} skip=${on}`,
      );
      assert.equal(
        service.sandboxLevelFor(intent.workId),
        on ? "unsandboxed" : "strict",
      );
    }
  }
  assert.equal(service.sandboxLevelFor("unknown-work"), null);
});

for (const [level, sandboxEscalation] of [
  ["escalate-approval", "approval"],
  ["escalate-auto-review", "auto-review"],
] as const)
  test(`a task turn runs with the escalation policy when admitted at ${level}, in each harness with the seam`, async (t) => {
    const { service, project, configure, start, turnOf, finished } =
      await recordingService(t);
    for (const harness of ["codex", "claude"] as const) {
      const projectId = project(harness);
      configure(projectId, { sandbox: level });
      await start(projectId, `${harness} escalate`);
      const intent = await finished();
      const admitted = harness === "codex" || level === "escalate-approval";
      assert.deepEqual(
        turnOf(intent)?.policy,
        admitted ? { networkAccess: false, sandboxEscalation } : undefined,
        harness,
      );
      assert.equal(
        service.sandboxLevelFor(intent.workId),
        admitted ? level : "strict",
      );
    }
  });

test("the service hints skipSandbox to preflight only for a task turn of an unsandboxed project", async (t) => {
  const { service, runtime, project, configure, start, finished } =
    await recordingService(t);
  const projectId = project("claude");
  const hinted = (intent: { workspace: string }) =>
    runtime.preflights.filter((input) => input.workspace === intent.workspace);
  for (const on of [false, true]) {
    configure(projectId, { sandbox: on ? "unsandboxed" : "strict" });
    await start(projectId, `task ${on}`);
    const intent = await finished();
    const inputs = hinted(intent);
    assert.ok(inputs.length > 0);
    for (const input of inputs)
      assert.deepEqual(
        "skipSandbox" in input ? input.skipSandbox : "absent",
        on ? true : "absent",
      );
  }

  // A draft turn in the same project, still unsandboxed, gets no hint.
  const taskId = randomUUID();
  const d = service.domain();
  d.execute({
    key: randomUUID(),
    actor: "operator",
    type: "task.create",
    projectId,
    taskId,
    title: "draft",
    outcome: "Probe",
    ready: false,
  } as never);
  await service.startDraftTurn({
    key: randomUUID(),
    taskId,
    expectedVersion: Number(d.task(taskId).version),
    message: "Refine this",
  });
  const draftPreflights = () => {
    const draft = service.list().find((i) => i.workId.includes(":draft:"));
    return runtime.preflights.filter(
      (input) => draft && input.workspace === draft.workspace,
    );
  };
  const deadline = Date.now() + 15_000;
  while (draftPreflights().length === 0) {
    assert.ok(Date.now() < deadline, "the draft turn was preflighted");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const input of draftPreflights())
    assert.equal("skipSandbox" in input, false);
});

test("the service hints sandboxEscalation to preflight only for a task turn admitted at an escalate level", async (t) => {
  const { runtime, project, configure, start, finished } =
    await recordingService(t);
  const projectId = project("claude");
  for (const [level, hint] of [
    ["strict", "absent"],
    ["escalate-approval", "approval"],
    // Claude Code is admitted strict at auto-review, so its preflight asks for nothing.
    ["escalate-auto-review", "absent"],
  ] as const) {
    configure(projectId, { sandbox: level });
    await start(projectId, `task ${level}`);
    const intent = await finished();
    const inputs = runtime.preflights.filter(
      (input) => input.workspace === intent.workspace,
    );
    assert.ok(inputs.length > 0);
    for (const input of inputs) {
      assert.equal(
        "sandboxEscalation" in input ? input.sandboxEscalation : "absent",
        hint,
        level,
      );
      assert.equal("skipSandbox" in input, false);
    }
  }
});
