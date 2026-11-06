import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeObservedSettings,
  RuntimeTurnSettings,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { writeSkillPlugin } from "../fixtures/skill-plugin.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
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
  reportResults = false;
  failTurns = false;
  private tool:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tool = listener;
  }
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
  readonly resumes: unknown[][] = [];
  async resumeThread(...args: unknown[]) {
    this.resumes.push(args);
  }
  async startTurn(...args: unknown[]) {
    this.turns.push(args);
    return `turn-${this.turns.length}`;
  }
  async interruptTurn() {}
  async waitForTurn(threadId: string, turnId: string) {
    if (this.reportResults) {
      const result = await this.tool?.({
        threadId,
        turnId,
        callId: randomUUID(),
        tool: "cab_report_result",
        arguments: { summary: "fixture result" },
      });
      assert.equal(
        result?.success,
        true,
        result?.text ?? "Missing report callback",
      );
    }
    return this.failTurns ? ("failed" as const) : ("completed" as const);
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

test("a follow-up turn of a Codex profile without settings still resumes with its workspace, so the runtime can scope its skills", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-codex-resume-"));
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
  const projectId = randomUUID();
  const taskId = randomUUID();
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Plain lead",
    instructions: "lead",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "project.create",
    projectId,
    name: "Resume",
    leadProfileId: lead,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Resume",
    outcome: "Codex resume",
    ready: false,
  });
  await service.provisionTask(taskId);
  execute({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const describe = () =>
    service.list().map((i) => [i.workId, i.state, i.reason]);
  await waitUntil(
    () => service.list().some((i) => i.state === "completed"),
    describe,
  );
  const binding = service.recoveryForTask(taskId)[0]?.binding;
  assert.ok(binding);
  await service.coordinationView().postOperatorMessage({
    key: randomUUID(),
    taskId,
    recipientAssignmentId: binding.assignmentId,
    expectedAssignmentVersion: binding.assignmentVersion,
    message: "Continue",
  });
  await waitUntil(() => runtime.resumes.length > 0, describe);
  const [threadId, , settings, workspace] = runtime.resumes[0] ?? [];
  assert.equal(threadId, "thread-1");
  assert.equal(settings, undefined);
  assert.equal(typeof workspace, "string");
});

for (const pluginCount of [0, 1, 16])
  test(`global Codex selections load before thread setup, retry missing sources and refresh bound revisions with ${pluginCount} plugins`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cab-global-service-"));
    const home = join(root, "home");
    const chosen = join(home, ".agents/skills/chosen");
    const other = join(home, ".agents/skills/other");
    for (const [dir, name] of [
      [chosen, "chosen"],
      [other, "other"],
    ]) {
      mkdirSync(dir!, { recursive: true });
      writeFileSync(join(dir!, "SKILL.md"), `---\nname: ${name}\n---\nv1`);
    }
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const runtime = new SettingsRuntime();
    runtime.reportResults = true;
    const service = new StandaloneService(
      join(root, "data"),
      () => runtime,
      undefined,
      {
        power: { enabled: false },
        routingClient: null,
        retry: { skillPluginMs: 30 },
      },
    );
    t.after(async () => {
      await service.stop().catch(() => {});
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    });
    await service.start();
    const execute = (command: object) =>
      service
        .domain()
        .execute({ key: randomUUID(), actor: "operator", ...command } as never);
    const lead = randomUUID(),
      projectId = randomUUID(),
      taskId = randomUUID();
    const plugins = Array.from({ length: pluginCount }, (_, i) => ({
      path: writeSkillPlugin(join(root, `plugin-${i}`), ["p"], `plugin-${i}`),
      skills: ["p"],
    }));
    execute({
      type: "profile.create",
      profileId: lead,
      name: "Global lead",
      instructions: "lead",
      capabilities: "code",
      skills: { plugins, global: ["chosen"] },
    });
    execute({
      type: "project.create",
      projectId,
      name: "Global project",
      leadProfileId: lead,
    });
    execute({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "task.create",
      projectId,
      taskId,
      title: "Global task",
      outcome: "work",
      ready: false,
    });
    await service.provisionTask(taskId);
    renameSync(chosen, join(root, "uninstalled"));
    execute({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    const describe = () => service.turnRequests();
    await waitUntil(
      () =>
        service
          .turnRequests()
          .some((r) => /Global skill chosen/.test(r.reason ?? "")),
      describe,
    );
    assert.equal(runtime.turns.length, 0);
    assert.equal(runtime.threads.length, 0);
    assert.equal(existsSync(join(root, "data/global-skill-cache")), false);
    renameSync(join(root, "uninstalled"), chosen);
    await waitUntil(
      () =>
        runtime.turns.length >= 1 &&
        service.list().every((i) => i.state === "completed"),
      describe,
    );
    const first = service.list()[0]!;
    const settings = runtime.threads[0]?.[2] as RuntimeTurnSettings;
    assert.deepEqual(runtime.turns[0]?.[3], settings);
    assert.equal(settings.skills?.plugins.length, pluginCount + 1);
    const adapter = settings.skills!.plugins.at(-1)!;
    assert.deepEqual(adapter.skills, ["chosen"]);
    assert.equal(adapter.name, "cab-global-skills");
    assert.equal(existsSync(join(adapter.path, "skills/other")), false);
    const record = service.turnSkillPlugins(first.workId);
    assert.equal(record.length, pluginCount + 1);
    assert.equal(
      (await new OperatorApi(service).readExecution(first.workId)).data
        .skillPlugins.length,
      pluginCount + 1,
    );
    assert.equal(JSON.stringify(record).includes(root), false);
    const earlier = new Set(service.list().map((i) => i.workId));
    const turnsBefore = runtime.turns.length;
    writeFileSync(join(chosen, "SKILL.md"), "---\nname: chosen\n---\nv2");
    const binding = service.recoveryForTask(taskId)[0]!.binding;
    assert.ok(binding);
    await service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId,
      recipientAssignmentId: binding.assignmentId,
      expectedAssignmentVersion: Number(
        service.domain().assignment(binding.assignmentId).version,
      ),
      message: "Continue",
    });
    await waitUntil(
      () =>
        runtime.turns.length > turnsBefore &&
        service.list().every((i) => i.state === "completed"),
      describe,
    );
    const next = runtime.resumes.at(-1)?.[2] as RuntimeTurnSettings;
    assert.deepEqual(runtime.turns.at(-1)?.[3], next);
    const refreshed = next.skills!.plugins.at(-1)!;
    assert.deepEqual(refreshed.skills, ["chosen"]);
    assert.notEqual(refreshed.path, adapter.path);
    assert.match(
      readFileSync(join(refreshed.path, "skills/chosen/SKILL.md"), "utf8"),
      /v2/,
    );
    assert.match(
      readFileSync(join(adapter.path, "skills/chosen/SKILL.md"), "utf8"),
      /v1/,
    );
    const followUp = service.list().find((i) => !earlier.has(i.workId))!;
    assert.notEqual(
      service.turnSkillPlugins(followUp.workId).at(-1)?.digest,
      record.at(-1)?.digest,
    );
    execute({
      type: "profile.configure",
      profileId: lead,
      expectedVersion: 1,
      skills: { plugins, global: ["other"] },
    });
    assert.deepEqual(service.turnSkillPlugins(first.workId).at(-1)?.skills, [
      "chosen",
    ]);
    const anotherTask = randomUUID();
    execute({
      type: "task.create",
      projectId,
      taskId: anotherTask,
      title: "New revision",
      outcome: "work",
      ready: false,
    });
    await service.provisionTask(anotherTask);
    execute({
      type: "task.configure",
      projectId,
      taskId: anotherTask,
      expectedVersion: 1,
      ready: true,
    });
    await waitUntil(
      () =>
        runtime.threads.length === 2 &&
        service.list().every((i) => i.state === "completed"),
      describe,
    );
    const otherSettings = runtime.threads[1]?.[2] as RuntimeTurnSettings;
    assert.deepEqual(otherSettings.skills?.plugins.at(-1)?.skills, ["other"]);
    assert.equal(
      existsSync(
        join(otherSettings.skills!.plugins.at(-1)!.path, "skills/chosen"),
      ),
      false,
    );
    const independent = randomUUID(),
      independentProject = randomUUID(),
      independentTask = randomUUID();
    execute({
      type: "profile.create",
      profileId: independent,
      name: "Independent global lead",
      instructions: "lead",
      capabilities: "code",
      skills: { plugins: [], global: ["chosen"] },
    });
    execute({
      type: "project.create",
      projectId: independentProject,
      name: "Independent globals",
      leadProfileId: independent,
    });
    execute({
      type: "project.configure",
      projectId: independentProject,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "task.create",
      projectId: independentProject,
      taskId: independentTask,
      title: "Independent profile",
      outcome: "work",
      ready: false,
    });
    await service.provisionTask(independentTask);
    execute({
      type: "task.configure",
      projectId: independentProject,
      taskId: independentTask,
      expectedVersion: 1,
      ready: true,
    });
    await waitUntil(
      () =>
        runtime.threads.length === 3 &&
        service.list().every((i) => i.state === "completed"),
      describe,
    );
    const independentSettings = runtime.threads[2]?.[2] as RuntimeTurnSettings;
    assert.equal(independentSettings.skills?.plugins.length, 1);
    assert.deepEqual(independentSettings.skills?.plugins[0]?.skills, [
      "chosen",
    ]);
    assert.equal(
      existsSync(
        join(independentSettings.skills!.plugins[0]!.path, "skills/other"),
      ),
      false,
    );
    if (pluginCount === 0) {
      runtime.failTurns = true;
      const heldTask = randomUUID();
      execute({
        type: "task.create",
        projectId: independentProject,
        taskId: heldTask,
        title: "Unresolved global consumer",
        outcome: "work",
        ready: false,
      });
      await service.provisionTask(heldTask);
      execute({
        type: "task.configure",
        projectId: independentProject,
        taskId: heldTask,
        expectedVersion: 1,
        ready: true,
      });
      await waitUntil(
        () => service.list().some((i) => i.state === "held"),
        describe,
      );
      const held = service.list().find((i) => i.state === "held")!;
      assert.deepEqual(service.turnSkillPlugins(held.workId).at(-1)?.skills, [
        "chosen",
      ]);
      assert.equal(existsSync(refreshed.path), true);
    }
    await service.stop();
    assert.equal(existsSync(adapter.path), true);
    assert.equal(existsSync(refreshed.path), true);
  });
