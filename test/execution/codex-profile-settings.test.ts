import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeObservedSettings,
  RuntimeTurnSettings,
} from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { tmpdir } from "../fixtures/temp.js";

/** A Codex-shaped fake: it reports supported models, can refuse in preflight and echoes settings. */
class SettingsRuntime implements Runtime {
  readonly harness = "codex" as const;
  readonly threads: unknown[][] = [];
  readonly turns: unknown[][] = [];
  readonly preflights: unknown[] = [];
  preflightReason: string | undefined;
  private readonly settingsByThread = new Map<string, RuntimeTurnSettings>();
  private count = 0;
  supportedSettings() {
    return {
      default: ["low", "high"],
      "m-default": ["low", "high"],
      "m-alt": ["medium"],
    };
  }
  async preflightTurn(input: unknown) {
    this.preflights.push(input);
    return this.preflightReason;
  }
  async start() {}
  async stop() {}
  async startThread(...args: unknown[]) {
    this.threads.push(args);
    const threadId = `thread-${++this.count}`;
    if (args[2])
      this.settingsByThread.set(threadId, args[2] as RuntimeTurnSettings);
    return threadId;
  }
  async resumeThread() {}
  async startTurn(...args: unknown[]) {
    this.turns.push(args);
    return `turn-${this.turns.length}`;
  }
  async interruptTurn() {}
  async waitForTurn() {
    return "completed" as const;
  }
  observedSettings(threadId: string): RuntimeObservedSettings {
    const settings = this.settingsByThread.get(threadId);
    return {
      model: settings?.model ?? "m-default",
      modelProvider: "fake",
      reasoningEffort: settings?.reasoningEffort ?? "low",
      serviceTier: null,
    };
  }
  onUnexpectedRequest() {}
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Codex turns carry the captured profile revision's settings, wait on a preflight reason and keep the unchanged call shapes without settings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-codex-settings-"));
  const runtime = new SettingsRuntime();
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
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
  await service.start();
  const lead = randomUUID();
  const worker = randomUUID();
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Plain lead",
    instructions: "lead",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "profile.create",
    profileId: worker,
    name: "Configured worker",
    instructions: "build",
    capabilities: "code",
    runtime: {
      harness: "codex",
      model: "m-alt",
      reasoningEffort: "medium",
    },
  });
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Settings",
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
  const taskId = randomUUID();
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Settings",
    outcome: "Codex settings",
    ready: false,
  });
  await service.provisionTask(taskId);
  const assign = (profileId: string) => {
    const assignmentId = randomUUID();
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Build",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    return `assignment:${assignmentId}:initial`;
  };
  const first = assign(worker);

  // (c) A preflight reason keeps the work waiting with that reason and starts nothing.
  const reason = "Codex runtime unavailable: model m-alt is not supported";
  runtime.preflightReason = reason;
  execute({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const describe = () => ({
    intents: service.list().map((i) => [i.workId, i.state, i.reason]),
    requests: service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
  });
  const request = (workId: string) =>
    service.turnRequests().find((r) => r.workId === workId);
  await waitUntil(() => request(first)?.reason === reason, describe);
  assert.equal(request(first)?.state, "queued");
  assert.equal(runtime.threads.length, 0);
  assert.equal(runtime.turns.length, 0);
  assert.deepEqual(runtime.preflights.at(-1), {
    workspace: service.list().find((i) => i.workId === first)?.workspace,
    settings: { model: "m-alt", reasoningEffort: "medium" },
  });

  runtime.preflightReason = undefined;
  await (
    service as unknown as { wakeScheduler(): Promise<void> }
  ).wakeScheduler();
  const done = (workId: string) =>
    service.list().find((i) => i.workId === workId)?.state === "completed";
  await waitUntil(() => done(first), describe);

  // (b) A reconfigured profile applies to the next assignment, not to the captured one.
  execute({
    type: "profile.configure",
    profileId: worker,
    expectedVersion: 1,
    runtime: { harness: "codex", model: "m-default", reasoningEffort: "high" },
  });
  const second = assign(worker);
  // (d) A profile without settings keeps today's call shapes.
  const plain = assign(lead);
  await waitUntil(() => done(second) && done(plain), describe);

  const threadOf = (workId: string) =>
    service.list().find((i) => i.workId === workId)?.threadId;
  const settingsOf = (workId: string) => ({
    thread: runtime.threads.find(
      (_, i) => `thread-${i + 1}` === threadOf(workId),
    ),
    turn: runtime.turns.find((args) => args[0] === threadOf(workId)),
  });
  assert.deepEqual(settingsOf(first).thread?.[2], {
    model: "m-alt",
    reasoningEffort: "medium",
  });
  assert.deepEqual(settingsOf(first).turn?.[3], {
    model: "m-alt",
    reasoningEffort: "medium",
  });
  assert.deepEqual(settingsOf(second).thread?.[2], {
    model: "m-default",
    reasoningEffort: "high",
  });
  assert.deepEqual(settingsOf(second).turn?.[3], {
    model: "m-default",
    reasoningEffort: "high",
  });
  assert.equal(settingsOf(plain).thread?.length, 2);
  assert.equal(settingsOf(plain).turn?.length, 3);

  // (a) Diagnostics name the configured and the runtime-reported values.
  const entries = (workId: string) => {
    const setting = service
      .executionDiagnostics()
      ?.events(workId)
      .items.find((i) => i.kind === "setting")?.payload as
      | { entries: { name: string; value: unknown; source: string }[] }
      | undefined;
    assert.ok(setting);
    return Object.fromEntries(
      setting.entries.map((e) => [e.name, [e.value, e.source]]),
    );
  };
  const reported = entries(first);
  assert.deepEqual(reported["profile.model"], ["m-alt", "service-admitted"]);
  assert.deepEqual(reported["profile.reasoningEffort"], [
    "medium",
    "service-admitted",
  ]);
  assert.deepEqual(reported.model, ["m-alt", "runtime-reported"]);
  assert.deepEqual(reported.reasoningEffort, ["medium", "runtime-reported"]);
  assert.equal("profile.model" in entries(plain), false);
});
