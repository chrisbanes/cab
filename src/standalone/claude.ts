import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  SDKUserMessage,
  SpawnOptions,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type FailureEvidence,
  parseFailureEvidence,
  type Runtime,
  type RuntimeConversationEvent,
  type RuntimeToolCall,
  type RuntimeToolDefinition,
  type RuntimeToolResult,
  type RuntimeTurnSettings,
  type UnexpectedRequest,
} from "./codex.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
  RuntimeProcessIdentity,
  TerminationVerifier,
} from "./recovery-types.js";
import type {
  RuntimeSafetyPort,
  RuntimeTerminalFailureEvidence,
  RuntimeTerminalStatus,
} from "./runtime-retention.js";
import type { ClaudeTurnEnvironment } from "./service.js";
import {
  captureProcessIdentity,
  MacProcessTerminationVerifier,
} from "./termination.js";

/** The SDK surface the runtime uses; tests inject a fake. */
export interface ClaudeSdk {
  query(params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }): AsyncIterable<unknown>;
  createSdkMcpServer: typeof createSdkMcpServer;
  tool: typeof tool;
}

export interface ClaudeRuntimeOptions {
  safety: RuntimeSafetyPort;
  claude: {
    configDirectory: string;
    turnEnvironment: () => ClaudeTurnEnvironment;
  };
  sdk?: ClaudeSdk;
  captureProcessIdentity?: (
    pid: number | undefined,
  ) => Promise<RuntimeProcessIdentity | null>;
  terminationVerifier?: TerminationVerifier;
  /** How long a settled query's CLI may take to exit before SIGTERM. */
  exitTimeoutMs?: number;
}

/** The C0-qualified SDK; its bundled CLI reported these values (F7.6). */
export const claudeSdkVersion = "0.3.296";
// ponytail: static until the model-free supportedModels() read is qualified (#825 T1 F9.0).
const supportedModels = ["default", "sonnet", "opus", "haiku", "fable"];
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

const mcpServerName = "ensemble";
const mcpToolPrefix = `mcp__${mcpServerName}__`;
const builtInTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
const disallowedTools = [
  "AskUserQuestion",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "EnterPlanMode",
  "ExitPlanMode",
];
const maxPendingToolUses = 256;
const maxRetainedSettledTurns = 64;
const instructionFiles = ["AGENTS.md", "CLAUDE.md"];
const maxInstructionFileBytes = 32 * 1024;
const maxInstructionBytes = 128 * 1024;

const initSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().min(1),
  claude_code_version: z.string().optional(),
});
const assistantSchema = z.object({
  type: z.literal("assistant"),
  uuid: z.string().min(1).max(128),
  message: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.string() }),
      ]),
    ),
  }),
});
const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().min(1),
  is_error: z.boolean(),
  session_id: z.string().min(1),
  terminal_reason: z.string().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
type ClaudeResult = z.infer<typeof resultSchema>;
const hookInputSchema = z.object({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  tool_use_id: z.string().min(1),
});

/** Maps a validated result to failure evidence; null means a completed turn. */
export function claudeResultFailure(
  result: ClaudeResult,
): RuntimeTerminalFailureEvidence | null {
  const evidence = (
    classification: RuntimeTerminalFailureEvidence["classification"],
    reasonCode: string,
  ): RuntimeTerminalFailureEvidence => ({
    classification,
    reasonCode,
    source: "harness",
    harnessRetries: null,
  });
  if (result.subtype === "success") {
    if (!result.is_error) return null;
    if (result.terminal_reason !== "api_error")
      return evidence("unknown", "unknown");
    const text = [result.result ?? "", ...(result.errors ?? [])].join("\n");
    return /not logged in|\b401\b|invalid.{0,20}(token|api key)|authentication/i.test(
      text,
    )
      ? evidence("permanent", "unauthorized")
      : evidence("unknown", "api_error");
  }
  if (result.subtype === "error_during_execution")
    return evidence("unknown", "error_during_execution");
  if (
    result.subtype === "error_max_turns" ||
    result.subtype === "error_max_budget_usd" ||
    result.subtype === "error_max_structured_output_retries"
  )
    return evidence("permanent", result.subtype);
  return evidence("unknown", "unknown");
}

/** The Claude subprocess environment: one token variable, isolated config, scrubbed children. */
export function claudeTurnEnvironment(
  base: NodeJS.ProcessEnv,
  token: string,
  configDirectory: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined) env[key] = value;
  // API-key billing is deferred; only the subscription token authenticates.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CLAUDE_CONFIG_DIR = configDirectory;
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  return env;
}

async function readBounded(path: string, limit: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
    const text = buffer.subarray(0, Math.min(bytesRead, limit)).toString();
    return bytesRead > limit ? `${text}\n[truncated]` : text;
  } finally {
    await file.close();
  }
}

/** Repository instructions as text, never through Claude setting sources. */
export async function claudeRepositoryInstructions(
  workspace: string,
): Promise<string> {
  const directories = [""];
  try {
    for (const entry of (await readdir(workspace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("repo-"))
      .map((entry) => entry.name)
      .sort())
      directories.push(entry);
  } catch {
    return "";
  }
  const sections: string[] = [];
  let remaining = maxInstructionBytes;
  for (const directory of directories)
    for (const name of instructionFiles) {
      if (remaining <= 0) break;
      const relative = directory ? `${directory}/${name}` : name;
      const path = join(workspace, relative);
      try {
        if (!(await lstat(path)).isFile()) continue;
        const text = await readBounded(
          path,
          Math.min(maxInstructionFileBytes, remaining),
        );
        remaining -= Buffer.byteLength(text);
        sections.push(`## Repository instructions: ${relative}\n\n${text}`);
      } catch {
        // Absent or unreadable files add no instructions.
      }
    }
  return sections.join("\n\n");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const inputDigest = (name: string, input: unknown) =>
  createHash("sha256")
    .update(canonical([name, input]))
    .digest("hex");

/** Removes JSON Schema defaults so handler arguments equal the model's input. */
function withoutDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDefaults);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "default")
      .map(([key, entry]) => [key, withoutDefaults(entry)]),
  );
}

/** The SDK takes an object shape; a union is advertised as optional fields. */
export function claudeToolShape(
  inputSchema: Record<string, unknown>,
): z.ZodRawShape {
  const schema = withoutDefaults(inputSchema) as Record<string, unknown>;
  const parsed = z.fromJSONSchema(schema as never);
  if (parsed instanceof z.ZodObject) return parsed.shape;
  // ponytail: union fields are all optional here; dispatch validates the exact branch.
  const shape: Record<string, z.ZodType> = {};
  for (const branch of z
    .array(z.record(z.string(), z.unknown()))
    .parse(schema.anyOf ?? []))
    for (const [key, field] of Object.entries(
      (z.fromJSONSchema(branch as never) as z.ZodObject).shape,
    ))
      shape[key] = (field as z.ZodType).optional();
  return shape;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

interface TurnOutcome {
  status: RuntimeTerminalStatus;
  failure?: RuntimeTerminalFailureEvidence;
}

interface ClaudeTurn {
  threadId: string;
  turnId: string;
  abort: AbortController;
  child?: ChildProcess;
  exited?: Promise<void>;
  identity?: RuntimeProcessIdentity;
  released: boolean;
  interrupted: boolean;
  malformed: boolean;
  result?: ClaudeResult;
  pendingToolUses: Map<string, string[]>;
  pendingCount: number;
  release: (released: boolean) => void;
  started: ReturnType<typeof deferred<void>>;
  settled: ReturnType<typeof deferred<TurnOutcome>>;
  done: boolean;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** One `query()` and `claude` subprocess per Ensemble turn; the session ID is the thread ID. */
export class ClaudeRuntime implements Runtime {
  readonly harness = "claude" as const;
  private generation: string | undefined;
  private sdk: ClaudeSdk | undefined;
  private readonly freshThreads = new Set<string>();
  private readonly threadTools = new Map<
    string,
    readonly RuntimeToolDefinition[]
  >();
  private readonly turns = new Map<string, ClaudeTurn>();
  private unexpected?: (request: UnexpectedRequest) => void;
  private toolCall?: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
  private anomaly?: (anomaly: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  private conversation?: (event: RuntimeConversationEvent) => void;

  constructor(private readonly options: ClaudeRuntimeOptions) {}

  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void): void {
    this.unexpected = listener;
  }
  onToolCall(
    listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ): void {
    this.toolCall = listener;
  }
  onTerminalAnomaly(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ): void {
    this.anomaly = listener;
  }
  onConversationEvent(
    listener: (event: RuntimeConversationEvent) => void,
  ): void {
    this.conversation = listener;
  }

  /** Terminal evidence is bound to this per-start generation. */
  currentUserInputGeneration(): string | undefined {
    return this.generation;
  }

  supportedSettings(): { models: string[]; efforts: string[] } {
    return { models: [...supportedModels], efforts: [...effortSchema.options] };
  }

  async start(): Promise<void> {
    if (this.generation) throw new Error("Runtime already started");
    await mkdir(this.options.claude.configDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(this.options.claude.configDirectory, 0o700);
    this.sdk =
      this.options.sdk ??
      ((await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk);
    this.generation = randomUUID();
  }

  async stop(): Promise<void> {
    if (!this.generation) return;
    this.generation = undefined;
    const pending = [...this.turns.values()].filter((turn) => !turn.done);
    for (const turn of pending) turn.abort.abort();
    await Promise.allSettled(pending.map((turn) => turn.settled.promise));
    this.turns.clear();
    this.freshThreads.clear();
    this.threadTools.clear();
  }

  async startThread(
    _workspace: string,
    tools: readonly RuntimeToolDefinition[] = [],
  ): Promise<string> {
    if (!this.generation) throw new Error("Runtime stopped");
    const threadId = randomUUID();
    try {
      this.options.safety.registerThreadTools(
        threadId,
        createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
      );
    } catch {
      throw new Error("Runtime thread safety baseline unavailable");
    }
    this.freshThreads.add(threadId);
    this.threadTools.set(threadId, tools);
    return threadId;
  }

  async resumeThread(
    threadId: string,
    tools: readonly RuntimeToolDefinition[] = [],
  ): Promise<void> {
    if (!this.generation) throw new Error("Runtime stopped");
    this.threadTools.set(threadId, tools);
  }

  async startTurn(
    threadId: string,
    workspace: string,
    prompt: string,
    settings?: RuntimeTurnSettings,
  ): Promise<string> {
    const sdk = this.sdk;
    const generation = this.generation;
    if (!sdk || !generation) throw new Error("Runtime stopped");
    const environment = this.options.claude.turnEnvironment();
    if ("unavailable" in environment) throw new Error(environment.unavailable);
    const model = settings?.model ?? undefined;
    if (model !== undefined && !supportedModels.includes(model))
      throw new Error("Claude model is not supported");
    const effort =
      settings?.reasoningEffort == null
        ? undefined
        : effortSchema.parse(settings.reasoningEffort);
    const fresh = this.freshThreads.delete(threadId);
    const tools = this.threadTools.get(threadId) ?? [];
    this.threadTools.delete(threadId);
    const instructions = await claudeRepositoryInstructions(workspace);
    if (this.generation !== generation) throw new Error("Runtime stopped");

    let release!: (released: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const turn: ClaudeTurn = {
      threadId,
      turnId: randomUUID(),
      abort: new AbortController(),
      released: false,
      interrupted: false,
      malformed: false,
      pendingToolUses: new Map(),
      pendingCount: 0,
      release: (released) => {
        turn.released = released;
        release(released);
      },
      started: deferred<void>(),
      settled: deferred<TurnOutcome>(),
      done: false,
    };
    // The CLI receives no prompt until its process identity is durably recorded.
    async function* gatedPrompt(): AsyncGenerator<SDKUserMessage> {
      if (!(await gate)) return;
      yield {
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
      };
    }
    const hook: HookCallback = async (input) => this.preToolUse(turn, input);
    const canUseTool: CanUseTool = async (toolName) => {
      this.unexpected?.({
        method: `claude/canUseTool:${toolName}`,
        threadId,
        turnId: turn.turnId,
      });
      return { behavior: "deny", message: "Ensemble grants no permissions" };
    };
    const options: Options = {
      cwd: workspace,
      env: claudeTurnEnvironment(
        environment.env,
        environment.token,
        this.options.claude.configDirectory,
      ),
      ...(fresh ? { sessionId: threadId } : { resume: threadId }),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      tools: [...builtInTools],
      allowedTools: [...builtInTools, `${mcpToolPrefix}*`],
      disallowedTools: [...disallowedTools],
      mcpServers: {
        [mcpServerName]: sdk.createSdkMcpServer({
          name: mcpServerName,
          tools: tools.map((definition) =>
            sdk.tool(
              definition.name,
              definition.description,
              claudeToolShape(definition.inputSchema),
              async (args) => this.handleTool(turn, definition.name, args),
            ),
          ),
        }),
      },
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      canUseTool,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: instructions,
      },
      abortController: turn.abort,
      spawnClaudeCodeProcess: (spawnOptions) =>
        this.spawnTurnProcess(turn, spawnOptions),
      // Diagnostics may contain sensitive data; drain without retaining them.
      stderr: () => {},
    };
    let stream: AsyncIterable<unknown>;
    try {
      stream = sdk.query({ prompt: gatedPrompt(), options });
    } catch {
      turn.release(false);
      throw new Error("Claude turn could not start");
    }
    this.retain(turn);
    void this.consume(turn, stream, generation);
    try {
      await turn.started.promise;
    } catch {
      turn.abort.abort();
      await turn.settled.promise.catch(() => {});
      throw new Error("Claude turn could not start");
    }
    return turn.turnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.threadId !== threadId || turn.done) return;
    turn.interrupted = true;
    turn.abort.abort();
  }

  async waitForTurn(
    threadId: string,
    turnId: string,
  ): Promise<"completed" | "failed"> {
    const generation = this.generation;
    if (!generation) throw new Error("Runtime stopped");
    const turn = this.turns.get(turnId);
    if (!turn || turn.threadId !== threadId)
      throw new Error("Runtime terminal evidence unavailable");
    const outcome = await turn.settled.promise;
    this.turns.delete(turnId);
    try {
      // Binds evidence recorded before the service bound this turn.
      this.options.safety.recordTerminal({
        threadId,
        turnId,
        status: outcome.status,
        runtimeGeneration: generation,
        ...(outcome.failure ? { failure: outcome.failure } : {}),
      });
      const evidence = this.options.safety.terminalForWait(
        threadId,
        turnId,
        generation,
      );
      if (
        !evidence ||
        evidence.workId === null ||
        evidence.conflicted ||
        evidence.firstStatus === null
      )
        throw new Error("Runtime terminal evidence is uncertain");
      return evidence.firstStatus;
    } catch {
      this.anomaly?.({
        threadId,
        turnId,
        reason: "Terminal evidence could not be verified for the bound turn",
      });
      throw new Error("Runtime terminal evidence unavailable");
    }
  }

  processIdentity(): null {
    // Each turn has its own CLI; recordTurnProcess binds it before the prompt.
    return null;
  }

  async inspectExecution(
    _identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    return {
      kind: "unknown",
      reason: "Claude Code cannot prove exact historical execution state",
    };
  }

  failureEvidence(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined {
    const generation = this.generation;
    if (!threadId || !turnId || !generation) return undefined;
    try {
      const evidence = this.options.safety.terminal(
        threadId,
        turnId,
        generation,
      );
      if (
        evidence?.firstStatus !== "failed" ||
        evidence.conflicted ||
        !evidence.workId ||
        !evidence.failure
      )
        return undefined;
      return parseFailureEvidence({
        threadId,
        turnId,
        status: "failed",
        ...evidence.failure,
      });
    } catch {
      return undefined;
    }
  }

  /** Keeps unwaited settled turns bounded; unsettled turns are never evicted. */
  private retain(turn: ClaudeTurn): void {
    this.turns.set(turn.turnId, turn);
    const settled = [...this.turns.values()].filter((item) => item.done);
    for (const oldest of settled.slice(0, -maxRetainedSettledTurns))
      this.turns.delete(oldest.turnId);
  }

  private spawnTurnProcess(turn: ClaudeTurn, options: SpawnOptions) {
    const child = spawn(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      // The SDK's forwarded signal terminates the CLI on abort (C0 F2).
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    turn.child = child;
    turn.exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    const capture =
      this.options.captureProcessIdentity ?? captureProcessIdentity;
    void capture(child.pid)
      .catch(() => null)
      .then((identity) => this.admitProcess(turn, identity));
    return child as ChildProcess & {
      stdin: NonNullable<ChildProcess["stdin"]>;
      stdout: NonNullable<ChildProcess["stdout"]>;
    };
  }

  private admitProcess(
    turn: ClaudeTurn,
    identity: RuntimeProcessIdentity | null,
  ): void {
    if (turn.released || turn.done) return;
    let recorded = false;
    if (identity && !turn.abort.signal.aborted)
      try {
        recorded =
          this.options.safety.recordTurnProcess?.({
            threadId: turn.threadId,
            processIdentity: identity,
          }) ?? false;
      } catch {
        recorded = false;
      }
    if (!recorded || !identity) {
      turn.release(false);
      turn.started.reject(new Error("Claude turn process was not recorded"));
      return;
    }
    turn.identity = identity;
    turn.release(true);
    turn.started.resolve();
  }

  private async consume(
    turn: ClaudeTurn,
    stream: AsyncIterable<unknown>,
    generation: string,
  ): Promise<void> {
    try {
      for await (const message of stream)
        if (!this.accept(turn, message)) {
          turn.malformed = true;
          turn.abort.abort();
          break;
        }
    } catch {
      // An error result throws after it is yielded; outcome is decided below.
    }
    const exitVerified = await this.verifyExit(turn);
    turn.done = true;
    if (!turn.released) {
      turn.release(false);
      turn.started.reject(new Error("Claude turn ended before its prompt"));
      turn.settled.reject(new Error("Claude turn did not start"));
      this.turns.delete(turn.turnId);
      return;
    }
    const fail = (reason: string) => {
      this.anomaly?.({ threadId: turn.threadId, turnId: turn.turnId, reason });
      turn.settled.reject(new Error("Runtime terminal evidence unavailable"));
    };
    if (turn.malformed) return fail("Claude SDK message failed validation");
    if (!exitVerified) return fail("Claude process exit was not verified");
    let outcome: TurnOutcome;
    if (turn.result) {
      const failure = claudeResultFailure(turn.result);
      outcome = failure
        ? { status: "failed", failure }
        : { status: "completed" };
    } else if (turn.interrupted)
      outcome = {
        status: "failed",
        failure: {
          classification: "permanent",
          reasonCode: "interrupted",
          source: "harness",
          harnessRetries: null,
        },
      };
    else return fail("Claude process ended without a result");
    if (this.generation === generation)
      try {
        this.options.safety.recordTerminal({
          threadId: turn.threadId,
          turnId: turn.turnId,
          status: outcome.status,
          runtimeGeneration: generation,
          ...(outcome.failure ? { failure: outcome.failure } : {}),
        });
      } catch {
        // waitForTurn records again once the service has bound the turn.
      }
    turn.settled.resolve(outcome);
  }

  /** False for a malformed known message; other message types are ignored. */
  private accept(turn: ClaudeTurn, message: unknown): boolean {
    const head = z
      .object({ type: z.string(), subtype: z.unknown().optional() })
      .safeParse(message);
    if (!head.success) return false;
    if (head.data.type === "system" && head.data.subtype === "init") {
      const init = initSchema.safeParse(message);
      return init.success && init.data.session_id === turn.threadId;
    }
    if (head.data.type === "assistant") {
      const assistant = assistantSchema.safeParse(message);
      if (!assistant.success) return false;
      assistant.data.message.content.forEach((block, index) => {
        if (!("text" in block) || typeof block.text !== "string") return;
        const item = {
          threadId: turn.threadId,
          turnId: turn.turnId,
          itemId: `${assistant.data.uuid}:${index}`,
        };
        this.conversation?.({ ...item, kind: "started" });
        this.conversation?.({ ...item, kind: "completed", text: block.text });
      });
      return true;
    }
    if (head.data.type === "result") {
      const result = resultSchema.safeParse(message);
      if (
        !result.success ||
        turn.result ||
        result.data.session_id !== turn.threadId
      )
        return false;
      turn.result = result.data;
    }
    return true;
  }

  /** Exit is verified by the recorded identity, never assumed from stream end. */
  private async verifyExit(turn: ClaudeTurn): Promise<boolean> {
    const child = turn.child;
    if (!child) return true;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const wait = (ms: number) =>
      Promise.race([turn.exited ?? Promise.resolve(), sleep(ms)]);
    if (!exited()) await wait(this.options.exitTimeoutMs ?? 10_000);
    if (!exited()) {
      child.kill("SIGTERM");
      await wait(3000);
    }
    if (!exited()) return child.pid === undefined;
    if (!turn.identity) return true;
    try {
      const verification = await (
        this.options.terminationVerifier ?? new MacProcessTerminationVerifier()
      ).verify(turn.identity);
      return verification.kind === "verified";
    } catch {
      return false;
    }
  }

  private async preToolUse(turn: ClaudeTurn, raw: unknown) {
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
    const input = hookInputSchema.safeParse(raw);
    if (!input.success) return deny("Ensemble could not read this tool call");
    const { tool_name: name, tool_input: toolInput } = input.data;
    if (name.startsWith(mcpToolPrefix)) {
      if (turn.pendingCount >= maxPendingToolUses)
        return deny("Too many pending Ensemble tool calls");
      const key = inputDigest(name.slice(mcpToolPrefix.length), toolInput);
      const queue = turn.pendingToolUses.get(key) ?? [];
      queue.push(input.data.tool_use_id);
      turn.pendingToolUses.set(key, queue);
      turn.pendingCount++;
    }
    return {};
  }

  private async handleTool(
    turn: ClaudeTurn,
    name: string,
    args: Record<string, unknown>,
  ) {
    const error = (text: string) => ({
      content: [{ type: "text" as const, text }],
      isError: true,
    });
    const key = inputDigest(name, args);
    const queue = turn.pendingToolUses.get(key);
    const callId = queue?.shift();
    if (queue?.length === 0) turn.pendingToolUses.delete(key);
    if (!callId)
      return error("Coordination call is not correlated with a tool use");
    turn.pendingCount--;
    if (!this.toolCall || turn.done)
      return error("Coordination call is not bound to current task work");
    try {
      const result = await this.toolCall({
        threadId: turn.threadId,
        turnId: turn.turnId,
        callId,
        tool: name,
        arguments: args,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.success,
      };
    } catch {
      return error("Coordination call failed");
    }
  }
}
