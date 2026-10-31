import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { DomainCommand } from "../../src/core/domain.js";
import type { NativeInputEndpointIdentity } from "../../src/core/structured-questions.js";
import { CodexRuntime } from "../../src/standalone/codex.js";
import type { RuntimeSpawnContext } from "../../src/standalone/service.js";
import { StandaloneService } from "../../src/standalone/service.js";
import type { RuntimeProcessIdentity } from "../../src/standalone/recovery-types.js";
import { startedOf } from "./service-internals.js";
import { until } from "./until.js";
export { until };

export const generation = "retention-generation";
const processIdentity: RuntimeProcessIdentity = {
  processId: "4242",
  processStartedAt: "retention-fixture-start",
  bootId: "retention-fixture-boot",
};
type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

export type RuntimeInternals = {
  child: ChildProcessWithoutNullStreams | undefined;
  nativeGeneration: string | undefined;
  nativeExecutable:
    | { codexVersion: string; executableHash: string }
    | undefined;
  threadSnapshots: Map<
    string,
    {
      tools?: readonly unknown[];
      settings?: Record<string, unknown>;
    }
  > & {
    settledStats(): {
      count: number;
      utf8Bytes: number;
      pinnedCount: number;
      pinnedUtf8Bytes: number;
    };
  };
  nativeTurns: Map<string, string>;
  nativeEndpoints: Map<string, unknown>;
  nativeEndpointsByTurn: Map<string, Set<string>>;
  nativeEndpointsByRpcId: Map<string, Set<string>>;
  invalidNativeTurns: Set<string>;
  nativeReadbacks: Map<string, unknown>;
  conversationTurns: Map<string, unknown>;
  pending: Map<string | number, unknown>;
  options: { safety: RuntimeSpawnContext["safety"] };
  receive(child: ChildProcessWithoutNullStreams, line: string): void;
  cancelUserInput(identity: NativeInputEndpointIdentity, reason: string): void;
  request(
    method: string,
    params: unknown,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown>;
};

export type ServiceInternals = {
  db: import("node:sqlite").DatabaseSync;
  nativeWaiters: Map<string, unknown>;
  callbacks: Map<string, Set<Promise<unknown>>>;
  active: Set<Promise<unknown>>;
  activeByWorkId: Map<string, Promise<unknown>>;
  backgroundRuns: Set<Promise<unknown>>;
  conversationCaptures: Map<string, unknown>;
};

export function fixture(root: string, currentGeneration = generation) {
  let runtime: CodexRuntime | undefined;
  let safety: RuntimeSpawnContext["safety"] | undefined;
  let service!: StandaloneService;
  let resumeModel = "fixture-model";
  let startedThreadCount = 0;
  let startedTurnCount = 0;
  let turnStartRequestCount = 0;
  let failTurnStart = false;
  const requestThreads = new Map<
    string,
    { threadId: string; identity: NativeInputEndpointIdentity }
  >();
  let writeIntentObservations = 0;
  let writeIntentViolations = 0;
  const stdin = new PassThrough();
  const child = {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: () => true,
  } as unknown as ChildProcessWithoutNullStreams;
  stdin.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === "function") as
      | ((error: Error | null) => void)
      | undefined;
    const message = JSON.parse(String(chunk)) as {
      id?: string | number;
      method?: string;
      result?: unknown;
      params?: { threadId?: string };
    };
    if (message.id !== undefined && runtime) {
      const requestKey = String(message.id);
      const request = requestThreads.get(requestKey);
      if (message.result !== undefined && request) {
        writeIntentObservations++;
        const row = startedOf(service).coordination.runtimeQuestionByEndpoint(
          request.identity,
        );
        if (!row?.replyIntentId || row.deliveryState !== "sending")
          writeIntentViolations++;
      }
      const params = {
        threadId: request?.threadId ?? "retention-thread",
        requestId: message.id,
      };
      requestThreads.delete(requestKey);
      const internals = runtime as unknown as RuntimeInternals;
      internals.receive(
        child,
        JSON.stringify({ method: "serverRequest/resolved", params }),
      );
    }
    queueMicrotask(() => callback?.(null));
    return true;
  }) as typeof stdin.write;

  service = new StandaloneService(
    join(root, "data"),
    (context: RuntimeSpawnContext) => {
      safety = context.safety;
      runtime = new CodexRuntime("retention-fixture", context);
      const internals = runtime as unknown as RuntimeInternals;
      runtime.start = async () => {
        internals.child = child;
        internals.nativeGeneration = currentGeneration;
        internals.nativeExecutable = {
          codexVersion: "codex-cli 0.159.0",
          executableHash: "c".repeat(64),
        };
      };
      runtime.stop = async () => {
        internals.child = undefined;
      };
      runtime.processIdentity = () => processIdentity;
      internals.request = async (method, params, beforeResolve) => {
        if (method === "turn/start") {
          turnStartRequestCount++;
          if (failTurnStart) throw new Error("Synthetic turn startup failure");
          return {
            turn: { id: `retention-started-turn-${startedTurnCount++}` },
          };
        }
        const paramsThreadId = (params as { threadId?: string }).threadId;
        const threadId =
          method === "thread/start"
            ? `retention-start-thread-${startedThreadCount++}`
            : (paramsThreadId ?? "retention-thread");
        const response = {
          thread: { id: threadId },
          approvalPolicy: "never",
          sandbox: { type: "workspaceWrite" },
          model: resumeModel,
          modelProvider: "fixture-provider",
          reasoningEffort: null,
          serviceTier: null,
          collaborationMode: {
            mode: "default",
            settings: {
              model: resumeModel,
              reasoning_effort: null,
              developer_instructions: null,
            },
          },
        };
        beforeResolve?.(response);
        return response;
      };
      return runtime;
    },
    undefined,
    { power: { enabled: false }, issueTrackers: { intervalMs: 60_000 } },
  );
  return {
    service,
    runtime: () => {
      assert.ok(runtime);
      return runtime;
    },
    child,
    associateRequest: (
      requestId: string | number,
      threadId: string,
      identity: NativeInputEndpointIdentity,
    ) => {
      requestThreads.set(String(requestId), { threadId, identity });
    },
    writeIntentEvidence: () => ({
      observations: writeIntentObservations,
      violations: writeIntentViolations,
    }),
    setResumeModel: (value: string) => {
      resumeModel = value;
    },
    setTurnStartFailure: (value: boolean) => {
      failTurnStart = value;
    },
    stageCounts: () => ({
      threadStarts: startedThreadCount,
      turnStartRequests: turnStartRequestCount,
      successfulTurnStarts: startedTurnCount,
    }),
    safety: () => {
      assert.ok(safety);
      return safety;
    },
    internals: () => ({
      ...(service as unknown as ServiceInternals),
      ...startedOf(service),
    }),
  };
}

export function createTask(service: StandaloneService) {
  const { domain } = startedOf(service);
  const run = (command: WithoutKey<DomainCommand>) =>
    domain.execute({
      ...command,
      key: randomUUID(),
    } as DomainCommand);
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  run({
    type: "profile.create",
    actor: "operator",
    profileId: leadProfileId,
    name: "Retention lead",
    instructions: "Coordinate",
    capabilities: "delegate",
  });
  run({
    type: "profile.create",
    actor: "operator",
    profileId: workerProfileId,
    name: "Retention worker",
    instructions: "Build",
    capabilities: "code",
  });
  run({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Runtime retention fixture",
    leadProfileId,
  });
  run({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Native question retention",
    outcome: "Exercise service callbacks",
    ready: true,
  });
  run({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  domain.ensureLeadAssignment(taskId);
  run({
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfileId],
  });
  run({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId: workerProfileId,
    brief: "Run native request retention fixture",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const assignment = domain.assignment(assignmentId);
  return {
    projectId,
    taskId,
    assignmentId,
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(assignment.instructionsRevision),
    profileRevision: Number(assignment.profileRevision),
  };
}

export function nativeRequest(
  threadId: string,
  turnId: string,
  itemId: string,
) {
  return {
    threadId,
    turnId,
    itemId,
    isBlocking: false,
    autoResolutionMs: null,
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Choose one",
        isOther: false,
        isSecret: false,
        options: [{ label: "A", description: "Option A" }],
      },
    ],
  };
}

export function createNativeWork(
  f: ReturnType<typeof fixture>,
  task: ReturnType<typeof createTask>,
  index: number,
  identity: Partial<{ threadId: string; turnId: string; workId: string }> = {},
) {
  const { state } = f.internals();
  const threadId = identity.threadId ?? `retention-native-thread-${index}`;
  const turnId = identity.turnId ?? `retention-native-turn-${index}`;
  const workId = identity.workId ?? `retention-native-work-${index}`;
  const intent = state.create(
    workId,
    "Synthetic native question retention turn",
    join("/tmp/runtime-retention-native", workId),
  );
  state.bindTask(workId, {
    taskId: task.taskId,
    assignmentId: task.assignmentId,
    assignmentVersion: task.assignmentVersion,
    instructionsRevision: task.instructionsRevision,
    profileRevision: task.profileRevision,
  });
  assert.equal(
    state.begin(intent.id, {
      projectId: task.projectId,
      requestSequence: index + 1,
      processIdentity,
    }),
    true,
  );
  assert.equal(state.bindThread(intent.id, threadId), true);
  assert.equal(state.bindTurn(intent.id, turnId, generation), true);
  const internals = f.runtime() as unknown as RuntimeInternals;
  internals.nativeTurns.set(threadId, turnId);
  internals.threadSnapshots.set(threadId, {
    settings: {
      model: "fixture-model",
      modelProvider: "fixture-provider",
      reasoningEffort: null,
      serviceTier: null,
    },
    tools: [],
  });
  f.safety().registerThreadTools(
    threadId,
    createHash("sha256").update("[]").digest("hex"),
  );
  return { intent, threadId, turnId, workId };
}

export function settledRuntimeCounts(f: ReturnType<typeof fixture>) {
  const runtime = f.runtime() as unknown as RuntimeInternals;
  const service = f.internals();
  const state = service.state as unknown as {
    nativePrebindings: Map<string, unknown>;
  };
  return {
    nativeEndpoints: runtime.nativeEndpoints.size,
    endpointsByTurn: runtime.nativeEndpointsByTurn.size,
    endpointsByRpcId: runtime.nativeEndpointsByRpcId.size,
    threadSnapshots: runtime.threadSnapshots.size,
    nativeTurns: runtime.nativeTurns.size,
    invalidNativeTurns: runtime.invalidNativeTurns.size,
    readbacks: runtime.nativeReadbacks.size,
    failureEvidenceCache: 0,
    conversationTurns: runtime.conversationTurns.size,
    pendingRpc: runtime.pending.size,
    nativeWaiters: service.nativeWaiters.size,
    callbackWorkItems: service.callbacks.size,
    callbacks: [...service.callbacks.values()].reduce(
      (sum, entries) => sum + entries.size,
      0,
    ),
    active: service.active.size,
    activeByWorkId: service.activeByWorkId.size,
    backgroundRuns: service.backgroundRuns.size,
    conversationCaptures: service.conversationCaptures.size,
    nativePrebindings: state.nativePrebindings.size,
  };
}

function retainedUtf8Bytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "boolean")
    return Buffer.byteLength(String(value), "utf8");
  if (value === null || value === undefined || typeof value === "function")
    return 0;
  if (value instanceof Map) {
    let bytes = 0;
    for (const [key, item] of value)
      bytes += retainedUtf8Bytes(key, seen) + retainedUtf8Bytes(item, seen);
    return bytes;
  }
  if (value instanceof Set) {
    let bytes = 0;
    for (const item of value) bytes += retainedUtf8Bytes(item, seen);
    return bytes;
  }
  if (Array.isArray(value))
    return value.reduce(
      (bytes, item) => bytes + retainedUtf8Bytes(item, seen),
      0,
    );
  if (typeof value === "object") {
    if (seen.has(value)) return 0;
    seen.add(value);
    let bytes = 0;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          "child",
          "resolve",
          "reject",
          "timer",
          "stdin",
          "stdout",
          "stderr",
        ].includes(key)
      )
        continue;
      bytes += Buffer.byteLength(key, "utf8") + retainedUtf8Bytes(item, seen);
    }
    return bytes;
  }
  return 0;
}

export function runtimeCollectionSizes(f: ReturnType<typeof fixture>) {
  const runtime = f.runtime() as unknown as RuntimeInternals;
  const service = f.internals();
  const state = service.state as unknown as {
    nativePrebindings: Map<string, unknown>;
  };
  const map = (value: Map<unknown, unknown>) => ({
    count: value.size,
    utf8Bytes: retainedUtf8Bytes(value),
  });
  const set = (value: Set<unknown>) => ({
    count: value.size,
    utf8Bytes: retainedUtf8Bytes(value),
  });
  return {
    terminalCache: { count: 0, utf8Bytes: 0 },
    settledNativePayloadCache: { count: 0, utf8Bytes: 0 },
    nativeEndpoints: map(runtime.nativeEndpoints),
    endpointsByTurn: map(runtime.nativeEndpointsByTurn),
    endpointsByRpcId: map(runtime.nativeEndpointsByRpcId),
    threadSnapshots: map(runtime.threadSnapshots),
    nativeTurns: map(runtime.nativeTurns),
    invalidNativeTurns: set(runtime.invalidNativeTurns),
    readbacks: map(runtime.nativeReadbacks),
    failureEvidenceCache: { count: 0, utf8Bytes: 0 },
    conversationTurns: map(runtime.conversationTurns),
    pendingRpc: map(runtime.pending),
    serviceNativeWaiters: map(service.nativeWaiters),
    serviceCallbacks: map(service.callbacks),
    serviceActive: set(service.active),
    serviceActiveByWorkId: map(service.activeByWorkId),
    serviceBackgroundRuns: set(service.backgroundRuns),
    serviceConversationCaptures: map(service.conversationCaptures),
    stateNativePrebindings: map(state.nativePrebindings),
  };
}

export function assertSettledRuntimeCounts(
  f: ReturnType<typeof fixture>,
): void {
  const counts = settledRuntimeCounts(f);
  for (const [name, count] of Object.entries(counts))
    assert.equal(count, 0, `${name} should retire after the turn settles`);
  const sizes = runtimeCollectionSizes(f);
  for (const [name, value] of Object.entries(sizes))
    assert.deepEqual(
      value,
      { count: 0, utf8Bytes: 0 },
      `${name} bytes should retire after settlement`,
    );
}

function summarizeTimings(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const at = (percentile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)
    ] ?? 0;
  return {
    iterations: sorted.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

export function timeIterations(count: number, action: (index: number) => void) {
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    const started = process.hrtime.bigint();
    action(index);
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  return summarizeTimings(samples);
}

export function seedTerminalRows(
  service: StandaloneService,
  count: number,
): void {
  const { db } = service as unknown as ServiceInternals;
  const insertIntent = db.prepare(`INSERT INTO execution_intents
    (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval)
    VALUES (?,?,? ,?,'completed',NULL,?,?,'chatgpt','workspaceWrite','never')`);
  const insertRecovery = db.prepare(`INSERT INTO execution_recovery_identities
    (workId,requestSequence,processId,processStartedAt,bootId,threadId,turnId,
      runtimeGeneration,terminalEvidenceObserved)
    VALUES (?,1,NULL,NULL,NULL,?,?,?,0)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const workId = `retention-work-${index}`;
      const turnId = `retention-turn-${index}`;
      const workspace =
        index < 2
          ? "/tmp/retention-conflict-workspace"
          : `/tmp/retention-${index}`;
      insertIntent.run(
        randomUUID(),
        workId,
        "synthetic retention turn",
        workspace,
        "retention-thread",
        turnId,
      );
      insertRecovery.run(workId, "retention-thread", turnId, generation);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function receiveTerminal(
  runtime: CodexRuntime,
  child: ChildProcessWithoutNullStreams,
  turnId: string,
  status: "completed" | "failed" = "completed",
  threadId = "retention-thread",
  errorCode?: string,
): void {
  (runtime as unknown as RuntimeInternals).receive(
    child,
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status,
          ...(status === "failed" && errorCode !== undefined
            ? { error: { codexErrorInfo: errorCode } }
            : {}),
        },
      },
    }),
  );
}
