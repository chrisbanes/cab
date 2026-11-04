import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { until } from "../fixtures/until.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class BrowserJourneyRuntime implements Runtime {
  turns = 0;
  threads = 0;
  prompts: string[] = [];
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("completed");
  }

  async startThread(
    _workspace: string,
    _tools?: readonly RuntimeToolDefinition[],
  ) {
    return `browser-thread-${++this.threads}`;
  }

  async resumeThread(
    _threadId: string,
    _tools?: readonly RuntimeToolDefinition[],
  ) {}

  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    const turnId = `browser-turn-${++this.turns}`;
    this.prompts.push(prompt);
    this.outcomes.set(turnId, deferred());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  callTool(call: RuntimeToolCall) {
    assert.ok(this.toolCall, "service registered the runtime tool listener");
    return this.toolCall(call);
  }

  complete(turnId: string) {
    this.outcomes.get(turnId)?.resolve("completed");
  }
}

test("project pause preserves captured instructions until explicit apply", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-project-revision-"));
  chmodSync(directory, 0o700);
  const runtime = new BrowserJourneyRuntime();
  const service = new StandaloneService(directory, () => runtime, undefined, {
    power: { enabled: false },
  });
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();
  const profileId = randomUUID(),
    projectId = randomUUID();
  service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Revision lead",
    instructions: "Coordinate bounded work",
    capabilities: "coordination",
  });
  service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Revision project",
    leadProfileId: profileId,
  });
  const api = new OperatorApi(service, [directory]);
  const capturedInstructions = "PROJECT_INSTRUCTIONS_REVISION_TWO";
  await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: capturedInstructions,
  });
  const taskId = randomUUID();
  await api.execute({
    type: "task.create",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Captured instruction task",
    outcome: "Remain held while the project is paused.",
    ready: true,
  });
  await service.provisionTask(taskId);

  await until(() => service.domain().assignments(taskId).length === 1);
  const assignment = service.domain().assignments(taskId)[0];
  assert.ok(assignment);
  assert.equal(Number(assignment.instructionsRevision), 2);
  assert.equal(service.domain().project(projectId).paused, 1);
  assert.equal(runtime.turns, 0, "a ready task remains held while paused");

  await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: service.domain().project(projectId).version,
    paused: false,
  });
  await until(() => runtime.turns === 1);
  assert.ok(runtime.prompts[0]?.includes(capturedInstructions));
  assert.equal(
    Number(
      service.domain().assignment(String(assignment.id)).instructionsRevision,
    ),
    2,
  );
  const activeWork = service
    .list()
    .find((item) => item.turnId === "browser-turn-1");
  assert.ok(activeWork?.threadId && activeWork.turnId);
  const question = await runtime.callTool({
    threadId: activeWork.threadId,
    turnId: activeWork.turnId,
    callId: "revision-test-question",
    tool: "cab_ask_question",
    arguments: { question: "Which captured revision should I use?" },
  });
  assert.equal(question.success, true, "the fixture records a durable wait");
  runtime.complete("browser-turn-1");
  await until(() =>
    service
      .list()
      .some(
        (item) =>
          item.turnId === "browser-turn-1" && item.state === "completed",
      ),
  );

  const changedInstructions = "PROJECT_INSTRUCTIONS_REVISION_THREE";
  const changedCommand = {
    type: "project.configure" as const,
    key: randomUUID(),
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    instructions: changedInstructions,
    paused: true,
  };
  await api.execute(changedCommand);
  assert.equal(
    Number(service.domain().project(projectId).instructionsRevision),
    3,
    "a real instruction change still creates a revision",
  );
  await api.execute(changedCommand);
  assert.equal(
    Number(service.domain().project(projectId).instructionsRevision),
    3,
    "replay must not create another project instruction revision",
  );

  // Operator input recorded while the project is paused stays durable but starts nothing.
  const pausedRead = (await api.readTask(taskId)).data;
  const pausedQuestion = pausedRead.questions[0];
  const pausedLead = pausedRead.assignments.find(
    (candidate) => candidate.assignmentId === String(assignment.id),
  );
  assert.ok(pausedQuestion && pausedLead);
  await api.execute({
    type: "question.answer",
    key: randomUUID(),
    taskId,
    interactionId: pausedQuestion.interactionId,
    expectedRevision: pausedQuestion.revision,
    answer: "Use the captured revision after an explicit apply.",
  });
  await api.execute({
    type: "message",
    key: randomUUID(),
    taskId,
    recipientAssignmentId: pausedLead.assignmentId,
    expectedAssignmentVersion: pausedLead.version,
    message: "Continue using the changed project instructions.",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtime.turns, 1, "paused work cannot start a follow-up turn");

  await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    paused: false,
  });
  assert.equal(
    Number(service.domain().project(projectId).instructionsRevision),
    3,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    runtime.turns,
    1,
    "a stale assignment does not silently adopt new instructions",
  );
  assert.equal(
    Number(
      service.domain().assignment(String(assignment.id)).instructionsRevision,
    ),
    2,
  );

  await api.execute({
    type: "assignment.apply",
    key: randomUUID(),
    projectId,
    assignmentId: String(assignment.id),
    expectedVersion: Number(
      service.domain().assignment(String(assignment.id)).version,
    ),
  });
  await until(() => runtime.turns === 2);
  assert.ok(runtime.prompts[1]?.includes(changedInstructions));
  assert.ok(!runtime.prompts[0]?.includes(changedInstructions));
  assert.equal(
    Number(
      service.domain().assignment(String(assignment.id)).instructionsRevision,
    ),
    3,
  );
});
