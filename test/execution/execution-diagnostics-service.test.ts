import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeConversationEvent,
  RuntimeDiagnosticEvent,
  RuntimeObservedSettings,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { tmpdir } from "../fixtures/temp.js";
import { until } from "../fixtures/until.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** A scripted runtime without diagnostic members: each turn waits for `complete`. */
class BareRuntime implements Runtime {
  conversation?: (event: RuntimeConversationEvent) => void;
  tool?: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
  unexpected?: (request: UnexpectedRequest) => void;
  prompts: string[] = [];
  onStart?: (threadId: string, turnId: string, prompt: string) => void;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private threads = 0;
  private turns = 0;
  async start() {}
  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("failed");
  }
  async startThread() {
    return `thread-${++this.threads}`;
  }
  async resumeThread() {}
  async startTurn(threadId: string, _workspace: string, prompt: string) {
    const turnId = `turn-${++this.turns}`;
    this.prompts.push(prompt);
    this.outcomes.set(turnId, deferred());
    this.onStart?.(threadId, turnId, prompt);
    return turnId;
  }
  async interruptTurn() {}
  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }
  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void) {
    this.unexpected = listener;
  }
  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversation = listener;
  }
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tool = listener;
  }
  complete(turnId: string, outcome: "completed" | "failed" = "completed") {
    this.outcomes.get(turnId)?.resolve(outcome);
  }
  get turnCount() {
    return this.turns;
  }
}

class DiagnosticsRuntime extends BareRuntime {
  diagnostic?: (event: RuntimeDiagnosticEvent) => void;
  settings?: RuntimeObservedSettings;
  onDiagnosticEvent(listener: (event: RuntimeDiagnosticEvent) => void) {
    this.diagnostic = listener;
  }
  observedSettings() {
    return this.settings;
  }
  emit(event: RuntimeDiagnosticEvent) {
    this.diagnostic?.(event);
  }
}

const ids = {
  profile: "20000000-0000-4000-8000-0000000000a1",
  project: "10000000-0000-4000-8000-0000000000a1",
  task: "30000000-0000-4000-8000-0000000000a1",
  assignment: "40000000-0000-4000-8000-0000000000a1",
};

async function fixture(
  runtime: BareRuntime,
  options: {
    dataDir?: string;
    brief?: string;
    diagnostics?: ConstructorParameters<typeof StandaloneService>[3];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cab-diagnostics-"));
  const dataDir = options.dataDir ?? join(root, "data");
  const service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    conversationHistoryExclusions: () => ["FIXTURE_SECRET_CANARY"],
    ...options.diagnostics,
  });
  await service.start();
  const run = (body: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...body } as never);
  run({
    type: "profile.create",
    profileId: ids.profile,
    name: "Diagnostics profile",
    instructions:
      "PROFILE_INSTRUCTION_TEXT keeps FIXTURE_SECRET_CANARY private",
    capabilities: "test",
  });
  run({
    type: "project.create",
    projectId: ids.project,
    name: "Diagnostics project",
    leadProfileId: ids.profile,
  });
  run({
    type: "project.configure",
    projectId: ids.project,
    expectedVersion: 1,
    paused: false,
    instructions: "PROJECT_INSTRUCTION_TEXT token=abc123",
  });
  run({
    type: "task.create",
    projectId: ids.project,
    taskId: ids.task,
    title: "Diagnostics task",
    outcome: "Run one diagnostic turn.",
  });
  run({
    type: "assignment.create",
    projectId: ids.project,
    taskId: ids.task,
    assignmentId: ids.assignment,
    profileId: ids.profile,
    brief: options.brief ?? "Run one diagnostic turn.",
    resultDestination: "lead:task",
    requesterAssignmentId: null,
  });
  await service.provisionTask(ids.task);
  return {
    root,
    service,
    dataDir,
    workId: `assignment:${ids.assignment}:initial`,
    run,
    store() {
      const store = service.executionDiagnostics();
      assert.ok(store);
      return store;
    },
    db() {
      return (service as unknown as { db: DatabaseSync }).db;
    },
    intent() {
      const intent = service.list().find((item) => item.workId === this.workId);
      return { state: intent?.state, reason: intent?.reason ?? null };
    },
    activate() {
      run({
        type: "task.configure",
        projectId: ids.project,
        taskId: ids.task,
        expectedVersion: 1,
        ready: true,
      });
    },
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const BASELINE_PROMPT =
  'Run one diagnostic turn.\n\nAssignment role: project assignee. The project lead remains accountable for coordinating this task and reviewing its results before completion. Report your result and durable next action through cab.\n\nCaptured review references (JSON): {"sourceId":"S","sourceRevision":1,"criteriaOmittedCount":0,"criteria":[]}\n\nProject instructions:\nPROJECT_INSTRUCTION_TEXT token=abc123\n\nProfile instructions:\nPROFILE_INSTRUCTION_TEXT keeps FIXTURE_SECRET_CANARY private';

test("the submitted assignment prompt matches the first-turn layout", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    // Only the source id varies.
    assert.equal(
      runtime.prompts[0]?.replace(
        /"sourceId":"[0-9a-f-]{36}"/,
        '"sourceId":"S"',
      ),
      BASELINE_PROMPT,
    );
    runtime.complete("turn-1");
  } finally {
    await f.close();
  }
});

const PROFILE_TEXT =
  "PROFILE_INSTRUCTION_TEXT keeps FIXTURE_SECRET_CANARY private";

async function finishTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: BareRuntime,
  turnId: string,
  outcome: "completed" | "failed" = "completed",
) {
  runtime.complete(turnId, outcome);
  await until(
    () => f.store().execution(f.workId)?.finishedAt != null,
    "capture finished",
  );
}

const names = (f: Awaited<ReturnType<typeof fixture>>, kind?: string) =>
  f
    .store()
    .events(f.workId)
    .items.filter((i) => !kind || i.kind === kind)
    .map((i) => i.name);

test("inputs are recorded before submission and equal the submitted bytes", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime, {
    brief: `Run one diagnostic turn. Echo: ${PROFILE_TEXT}`,
  });
  try {
    let atStart: string[] = [];
    runtime.onStart = () => {
      atStart = f
        .store()
        .inputs(f.workId)
        .map((i) => i.name);
    };
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    assert.deepEqual(atStart, [
      "request",
      "role",
      "review-references",
      "project-instructions",
      "profile-instructions",
      "submitted",
    ]);
    const inputs = new Map(
      f
        .store()
        .inputs(f.workId)
        .map((i) => [i.name, i.payload as Record<string, unknown>]),
    );
    const prompt = runtime.prompts[0] ?? "";
    assert.deepEqual(inputs.get("submitted"), {
      bytes: Buffer.byteLength(prompt),
      sha256: createHash("sha256").update(prompt).digest("hex"),
    });
    const project = String(inputs.get("project-instructions")?.text);
    const profile = String(inputs.get("profile-instructions")?.text);
    assert.equal(inputs.get("project-instructions")?.revision, 2);
    assert.equal(inputs.get("profile-instructions")?.revision, 1);
    // Own instruction text stays readable; credentials and patterns do not.
    assert.match(project, /PROJECT_INSTRUCTION_TEXT token=\[redacted\]/);
    assert.match(
      profile,
      /PROFILE_INSTRUCTION_TEXT keeps \[redacted\] private/,
    );
    const request = String(inputs.get("request")?.text);
    assert.doesNotMatch(request, /PROFILE_INSTRUCTION_TEXT/);
    assert.match(request, /Echo: \[redacted\]/);
    await finishTurn(f, runtime, "turn-1");
    assert.deepEqual(f.intent(), { state: "completed", reason: null });
    // An instruction holding a credential pattern stays redacted outside the inputs view.
    const api = new OperatorApi(f.service, []);
    const events = JSON.stringify(
      await api.readExecutionEvents(f.workId, new URLSearchParams()),
    );
    assert.doesNotMatch(
      events,
      /PROJECT_INSTRUCTION_TEXT|PROFILE_INSTRUCTION_TEXT/,
    );
    const view = JSON.stringify(
      await api.readExecutionInputs(f.workId, new URLSearchParams()),
    );
    assert.match(view, /PROJECT_INSTRUCTION_TEXT token=\[redacted\]/);
  } finally {
    await f.close();
  }
});

test("a resumed turn records unchanged instructions as not sent and submits only what it carries", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    await finishTurn(f, runtime, "turn-1");
    // The turn reported no result, so its repair turn resumes the same thread.
    await until(() => runtime.prompts.length === 2, "second turn start");
    const prompt = runtime.prompts[1] ?? "";
    const next = f.service
      .list()
      .find((item) => item.workId !== f.workId)?.workId;
    assert.ok(next?.includes(":repair:"));
    if (!next) return;
    assert.doesNotMatch(
      prompt,
      /PROJECT_INSTRUCTION_TEXT|PROFILE_INSTRUCTION_TEXT/,
    );
    const inputs = new Map(
      f
        .store()
        .inputs(next)
        .map((i) => [i.name, i.payload as Record<string, unknown>]),
    );
    assert.deepEqual(inputs.get("project-instructions"), {
      sent: false,
      revision: 2,
    });
    assert.deepEqual(inputs.get("profile-instructions"), {
      sent: false,
      revision: 1,
    });
    assert.deepEqual(inputs.get("submitted"), {
      bytes: Buffer.byteLength(prompt),
      sha256: createHash("sha256").update(prompt).digest("hex"),
    });
    runtime.complete("turn-2");
  } finally {
    await f.close();
  }
});

test("events bind to the exact turn, buffer until bound and count late arrivals", async () => {
  const runtime = new DiagnosticsRuntime();
  runtime.settings = {
    model: "gpt-test",
    modelProvider: "openai",
    reasoningEffort: null,
    serviceTier: null,
  };
  const f = await fixture(runtime);
  try {
    runtime.onStart = (threadId, turnId) => {
      runtime.emit({
        kind: "item",
        phase: "started",
        threadId,
        turnId,
        itemId: "cmd-1",
        itemType: "commandExecution",
        command: `cat ${PROFILE_TEXT}`,
        cwd: "/tmp",
      });
      runtime.emit({
        kind: "item",
        phase: "started",
        threadId,
        turnId: "other-turn",
        itemId: "wrong",
        itemType: "commandExecution",
      });
    };
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    await runtime.tool?.({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "not_a_coordination_tool",
      arguments: { note: "token=zzz" },
    });
    runtime.emit({
      kind: "turn",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    await finishTurn(f, runtime, "turn-1");
    runtime.emit({
      kind: "turn",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    const execution = f.store().execution(f.workId);
    assert.ok(execution);
    assert.equal(execution.taskId, ids.task);
    assert.equal(execution.projectId, ids.project);
    assert.equal(execution.assignmentId, ids.assignment);
    assert.equal(execution.threadId, "thread-1");
    assert.equal(execution.turnId, "turn-1");
    assert.equal(execution.instructionsRevision, 2);
    assert.equal(execution.profileRevision, 1);
    assert.equal(execution.harness, "codex");
    assert.equal(execution.mode, "enhanced");
    assert.equal(execution.eventSource, "supported");
    assert.deepEqual(
      execution.gaps.map((g) => [g.code, g.count]),
      [["late-event", 1]],
    );
    const items = f.store().events(f.workId).items;
    const command = items.find((i) => i.itemId === "cmd-1");
    assert.equal(command?.kind, "runtime");
    assert.doesNotMatch(
      JSON.stringify(command?.payload),
      /PROFILE_INSTRUCTION/,
    );
    assert.equal(
      items.some((i) => i.itemId === "wrong"),
      false,
    );
    const tool = items.find((i) => i.kind === "tool");
    assert.ok(tool);
    assert.equal(tool.name, "not_a_coordination_tool");
    const toolPayload = tool.payload as {
      arguments: unknown;
      success: boolean;
    };
    assert.deepEqual(toolPayload.arguments, { note: "token=[redacted]" });
    assert.equal(toolPayload.success, false);
    const settings = items.find((i) => i.kind === "setting")?.payload as {
      entries: { name: string; value: unknown; source: string }[];
    };
    const sources = Object.fromEntries(
      settings.entries.map((e) => [e.name, [e.value, e.source]]),
    );
    assert.deepEqual(sources.harness, ["codex", "service-admitted"]);
    assert.deepEqual(sources.sandbox, ["workspaceWrite", "service-admitted"]);
    assert.deepEqual(sources.model, ["gpt-test", "runtime-reported"]);
    assert.deepEqual(names(f, "service"), [
      "thread-bound",
      "input-captured",
      "turn-bound",
      "terminal-observed",
      "execution-settled",
    ]);
  } finally {
    await f.close();
  }
});

test("early-event overflow and an unsupported runtime are explicit", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    runtime.onStart = (threadId, turnId) => {
      for (let i = 0; i < 300; i++)
        runtime.emit({
          kind: "item",
          phase: "started",
          threadId,
          turnId,
          itemId: `r-${i}`,
          itemType: "reasoning",
        });
    };
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    await finishTurn(f, runtime, "turn-1");
    const execution = f.store().execution(f.workId);
    assert.deepEqual(
      execution?.gaps.map((g) => g.code),
      ["early-buffer-limit"],
    );
    assert.equal(names(f, "runtime").length, 0);
  } finally {
    await f.close();
  }
  const bare = new BareRuntime();
  const g = await fixture(bare);
  try {
    g.activate();
    await until(() => bare.prompts.length === 1, "turn start");
    await finishTurn(g, bare, "turn-1");
    const execution = g.store().execution(g.workId);
    assert.equal(execution?.eventSource, "unsupported");
    const settings = g
      .store()
      .events(g.workId)
      .items.find((i) => i.kind === "setting")?.payload as {
      entries: { name: string; source: string }[];
    };
    assert.equal(
      settings.entries.find((e) => e.name === "model")?.source,
      "unknown",
    );
  } finally {
    await g.close();
  }
});

test("baseline capture records only the execution and its gap", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    f.run({
      type: "project.configure",
      projectId: ids.project,
      expectedVersion: 2,
      diagnosticCapture: "baseline",
    });
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    assert.equal(runtime.diagnostic !== undefined, true);
    runtime.emit({
      kind: "turn",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    runtime.complete("turn-1");
    await until(() => f.intent().state === "completed", "completed");
    const execution = f.store().execution(f.workId);
    assert.equal(execution?.mode, "baseline");
    assert.deepEqual(
      execution?.gaps.map((g) => g.code),
      ["capture-baseline"],
    );
    assert.equal(f.store().events(f.workId).items.length, 0);
    // Restoring enhanced changes later executions only and erases nothing.
    f.run({
      type: "project.configure",
      projectId: ids.project,
      expectedVersion: 3,
      diagnosticCapture: "enhanced",
    });
    assert.equal(f.store().execution(f.workId)?.mode, "baseline");
  } finally {
    await f.close();
  }
});

test("a failing diagnostic store never changes the execution outcome", async () => {
  const control = new DiagnosticsRuntime();
  const c = await fixture(control);
  let controlTool: unknown;
  try {
    c.activate();
    await until(() => control.prompts.length === 1, "turn start");
    controlTool = await control.tool?.({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "not_a_coordination_tool",
      arguments: {},
    });
    await finishTurn(c, control, "turn-1");
  } finally {
    await c.close();
  }
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    for (const table of ["diagnostic_items", "diagnostic_executions"])
      f.db().exec(
        `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'diagnostic fault'); END`,
      );
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    const tool = await runtime.tool?.({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "not_a_coordination_tool",
      arguments: {},
    });
    assert.deepEqual(tool, controlTool);
    runtime.complete("turn-1");
    await until(() => f.intent().state === "completed", "completed");
    assert.deepEqual(f.intent(), { state: "completed", reason: null });
    const normal = (p?: string) => p?.replace(/"sourceId":"[0-9a-f-]{36}"/, "");
    assert.equal(normal(runtime.prompts[0]), normal(control.prompts[0]));
    assert.ok((f.store().health().unrecorded ?? 0) > 0);
  } finally {
    await f.close();
  }
});

test("restart marks unfinished capture interrupted and the timer prunes expired rows", async () => {
  let now = Date.now();
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime, {
    diagnostics: {
      diagnostics: {
        pruneIntervalMs: 10,
        now: () => now,
        limits: { ageMs: 1000 },
      },
    },
  });
  try {
    f.activate();
    await until(() => runtime.prompts.length === 1, "turn start");
    assert.ok(f.store().inputs(f.workId).length > 0);
    now += 2000;
    await until(
      () => f.store().inputs(f.workId).length === 0,
      "expired rows pruned",
    );
    assert.equal(f.intent().state, "running");
    const gaps = f
      .store()
      .execution(f.workId)
      ?.gaps.map((g) => g.code);
    assert.deepEqual(gaps, ["expired"]);
    await f.service.stop();
    // A crash leaves the row unfinished; a clean stop finishes it.
    const db = new DatabaseSync(join(f.dataDir, "standalone.sqlite"));
    db.prepare("UPDATE diagnostic_executions SET finishedAt = NULL").run();
    db.close();
    await f.service.start();
    assert.ok(
      f
        .store()
        .execution(f.workId)
        ?.gaps.some((g) => g.code === "capture-interrupted"),
    );
  } finally {
    await f.close();
  }
});

test("an unexpected request is recorded while its hold is unchanged", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    f.activate();
    await until(() => f.intent().state === "running", "running");
    runtime.unexpected?.({
      method: "item/tool/requestUserInput",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    assert.equal(f.intent().state, "held");
    assert.match(
      String(f.intent().reason),
      /Unexpected runtime request denied/,
    );
    const item = f
      .store()
      .events(f.workId)
      .items.find((i) => i.name === "unexpected-request");
    assert.deepEqual(item?.payload, { method: "item/tool/requestUserInput" });
    assert.equal(item?.severity, "warn");
    runtime.complete("turn-1");
  } finally {
    await f.close();
  }
});
