import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeConversationEvent,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { StandaloneService } from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, label = "condition") {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/** A scripted runtime: each turn waits for `complete`, and `onStart` runs inside startTurn. */
class DiagnosticsRuntime implements Runtime {
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

const ids = {
  profile: "20000000-0000-4000-8000-0000000000a1",
  project: "10000000-0000-4000-8000-0000000000a1",
  task: "30000000-0000-4000-8000-0000000000a1",
  assignment: "40000000-0000-4000-8000-0000000000a1",
};

async function fixture(
  runtime: DiagnosticsRuntime,
  options: { dataDir?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-diagnostics-"));
  const dataDir = options.dataDir ?? join(root, "data");
  const service = new StandaloneService(dataDir, () => runtime, undefined, {
    power: { enabled: false },
    conversationHistoryExclusions: () => ["FIXTURE_SECRET_CANARY"],
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
    brief: "Run one diagnostic turn.",
    resultDestination: "lead:task",
    requesterAssignmentId: null,
  });
  await service.provisionTask(ids.task);
  return {
    root,
    service,
    workId: `assignment:${ids.assignment}:initial`,
    run,
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
  'Run one diagnostic turn.\n\nAssignment role: project assignee. The project lead remains accountable for coordinating this task and reviewing its results before completion. Report your result and durable next action through Ensemble.\n\nCaptured review references (JSON): {"sourceId":"S","sourceRevision":1,"criteriaOmittedCount":0,"criteria":[]}\n\nCaptured project instructions (revision 2):\nPROJECT_INSTRUCTION_TEXT token=abc123\n\nCaptured profile instructions (revision 1):\nPROFILE_INSTRUCTION_TEXT keeps FIXTURE_SECRET_CANARY private';

test("the submitted assignment prompt is unchanged", async () => {
  const runtime = new DiagnosticsRuntime();
  const f = await fixture(runtime);
  try {
    f.activate();
    await waitUntil(() => runtime.prompts.length === 1, "turn start");
    // Pinned before executionPrompt was split into parts; only the source id varies.
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
