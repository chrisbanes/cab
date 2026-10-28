import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { startedOf } from "./service-internals.js";
import { tmpdir } from "./temp.js";

type ToolListener = (call: RuntimeToolCall) => Promise<RuntimeToolResult>;

export class JourneyRuntime implements Runtime {
  turns = 0;
  starts = 0;
  prompts: string[] = [];
  workspaces: string[] = [];
  handleTurn: ((threadId: string, turnId: string) => Promise<void>) | undefined;
  private listener: ToolListener | undefined;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async startThread(): Promise<string> {
    this.starts++;
    return `thread-${this.starts}`;
  }

  async resumeThread(): Promise<void> {}

  async startTurn(
    _threadId: string,
    workspace: string,
    prompt: string,
  ): Promise<string> {
    this.turns++;
    this.workspaces.push(workspace);
    this.prompts.push(prompt);
    return `turn-${this.turns}`;
  }

  async interruptTurn(): Promise<void> {}

  async waitForTurn(threadId: string, turnId: string) {
    await this.handleTurn?.(threadId, turnId);
    return "completed" as const;
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void): void {}

  onToolCall(listener: ToolListener): void {
    this.listener = listener;
  }

  async callTool(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    assert.ok(this.listener, "service registers the runtime tool callback");
    return this.listener(call);
  }
}

export function command(
  service: StandaloneService,
  body: Record<string, unknown>,
) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body } as never);
}

export async function waitUntil(
  predicate: () => boolean,
  description: string,
  diagnostics: () => unknown = () => undefined,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(
        `${description} timed out; ${JSON.stringify(diagnostics())}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function db(service: StandaloneService) {
  return (service as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

export async function refusedInitial(initialBatch = false) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-refused-initial-"));
  const projectId = randomUUID(),
    taskId = randomUUID(),
    profileId = randomUUID();
  const runtime = new JourneyRuntime();
  const makeService = () =>
    new StandaloneService(join(root, "data"), () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      supervisor: { observationMs: 5 },
    });
  const service = makeService();
  await service.start();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "PRESERVED_PROFILE",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "PRESERVED_PROJECT",
    paused: true,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Old title",
    outcome: "OLD_OUTCOME",
    ready: true,
  });
  await service.provisionTask(taskId);
  const assignment = service.domain().assignments(taskId)[0];
  assert.ok(assignment);
  const workId = `assignment:${assignment.id}:initial`;
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: Number(service.domain().task(taskId).version),
    title: "CURRENT_TITLE",
    outcome: "CURRENT_OUTCOME",
  });
  await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
  const old = service.turnRequests().find((r) => r.workId === workId);
  assert.ok(old);
  assert.equal(old.state, "held");
  assert.match(old.reason ?? "", /task-revision-changed/);
  assert.equal(runtime.turns, 0);
  if (initialBatch) {
    const coordination = startedOf(service).coordination;
    coordination.postOperatorMessage({
      actor: "operator",
      key: randomUUID(),
      taskId,
      recipientAssignmentId: String(assignment.id),
      expectedAssignmentVersion: Number(assignment.version),
      message: "HELD_INITIAL_BATCH",
    });
    assert.ok(
      coordination.bindDeliveryBatch(
        String(assignment.id),
        workId,
        Number(assignment.version),
      ),
    );
  }
  return {
    root,
    projectId,
    taskId,
    profileId,
    assignmentId: String(assignment.id),
    workId,
    old,
    runtime,
    service,
    makeService,
  };
}

export function unpause(
  f: Awaited<ReturnType<typeof refusedInitial>>,
  service = f.service,
) {
  command(service, {
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(service.domain().project(f.projectId).version),
    paused: false,
  });
}
