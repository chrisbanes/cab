import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
  terminalFailureEvidence,
  type Runtime,
  type RuntimeConversationEvent,
  RuntimeNotEnabledError,
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
import { resolveOnPath } from "./executable-path.js";
import { isWithin } from "./workspace-inspection.js";

/** The SDK surface the runtime uses; tests inject a fake. */
export interface ClaudeSdk {
  query(params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }): AsyncIterable<unknown> & { supportedModels(): Promise<unknown> };
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
  /** Finds the `claude` to run; defaults to the service's own `PATH`. */
  resolveExecutable?: () => Promise<string | null>;
  captureProcessIdentity?: (
    pid: number | undefined,
  ) => Promise<RuntimeProcessIdentity | null>;
  terminationVerifier?: TerminationVerifier;
  /** How long a settled query's CLI may take to exit before SIGTERM. */
  exitTimeoutMs?: number;
  /** How soon a failed self-test or settings read is retried; defaults to 30 s. */
  probeRetryMs?: number;
  /** Model-free check that Seatbelt can start in the turn's spawn context. */
  sandboxSelfTest?: (input: {
    workspace: string;
    env: Record<string, string>;
  }) => Promise<boolean>;
}

/** The C0-qualified SDK. */
export const claudeSdkVersion = "0.3.296";
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const supportedModelsSchema = z
  .array(
    z.object({
      value: z.string().min(1).max(128),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(effortSchema).optional(),
    }),
  )
  .max(64);
const settingsReadTimeoutMs = 30_000;
/** A passed self-test admits a turn only this soon after it ran. */
const probeFreshMs = 30_000;
/** A failed probe or settings read is retried no sooner than this by default. */
const defaultProbeRetryMs = 30_000;
/** The CLI falls back to the shared `/tmp/claude-<uid>` above this (AF_UNIX, #825 T1). */
const maxSandboxTemporaryBytes = 44;

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
const maxLedgerEntries = 256;
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
  temporaryBase: string,
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
  // Moves the sandbox $TMPDIR to <base>/claude-<uid> (#825 T1 F9.1).
  env.CLAUDE_CODE_TMPDIR = temporaryBase;
  return env;
}

/** A short per-task base, so `<base>/claude-<uid>` fits an AF_UNIX socket path. */
export function claudeTemporaryBase(workspace: string): string {
  return `/tmp/ens-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`;
}

/** Creates or accepts only a private directory owned by this user; otherwise a reason. */
async function ensureTemporaryBase(base: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined)
    return "per-task sandbox temporary directory is unsupported on this host";
  if (Buffer.byteLength(`${base}/claude-${uid}`) > maxSandboxTemporaryBytes)
    return "per-task sandbox temporary directory path is too long";
  try {
    await mkdir(base, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      return "per-task sandbox temporary directory could not be created";
  }
  try {
    const stat = await lstat(base);
    if (
      !stat.isDirectory() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o700
    )
      return "per-task sandbox temporary directory is not private";
  } catch {
    return "per-task sandbox temporary directory could not be read";
  }
  // The sandboxed agent can write here; a planted symlink must not redirect the next turn.
  for (const name of [`claude-${uid}`, "cc-socks"]) {
    const path = join(base, name);
    const safe = async () => {
      try {
        const stat = await lstat(path);
        return (stat.isDirectory() || stat.isSocket()) && stat.uid === uid;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    };
    if (await safe()) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
    if (!(await safe()))
      return "per-task sandbox temporary directory holds an unsafe entry";
  }
  return undefined;
}

/** Removes a task's sandbox temporary base when it is still the private directory Ensemble made. */
export async function releaseClaudeTemporaryBase(
  workspace: string,
): Promise<void> {
  const base = claudeTemporaryBase(workspace);
  try {
    const stat = await lstat(base);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      return;
  } catch {
    return;
  }
  await rm(base, { recursive: true, force: true });
}

function defaultSandboxSelfTest(input: {
  workspace: string;
  env: Record<string, string>;
}): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return new Promise((done) =>
    execFile(
      "/usr/bin/sandbox-exec",
      ["-p", "(version 1)(allow default)", "/usr/bin/true"],
      { cwd: input.workspace, env: input.env, timeout: 5000 },
      (error) => done(!error),
    ),
  );
}

/** Resolves through the nearest existing ancestor, so symlinked parents are followed. */
async function resolvedPath(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;)
    try {
      return join(await realpath(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.push(basename(existing));
      existing = parent;
    }
}

async function withinRoots(
  path: string,
  roots: readonly string[],
): Promise<boolean> {
  const candidate = await resolvedPath(path);
  for (const root of roots)
    if (isWithin(await resolvedPath(root), candidate)) return true;
  return false;
}

/** Disclosed with the effective policy; see ADR-1008 and the C0/T1 evidence. */
export const claudePolicyLimits: readonly string[] = [
  "File-editing tools are confined by Ensemble's PreToolUse hook, not by the OS sandbox.",
  "A sandbox that stops working mid-turn shows only as failed commands (exit 126), not a failed turn.",
  "The sandbox self-test proves Seatbelt can start, not the exact profile Claude Code applies.",
  "Untested: inertness of model-written Claude configuration (C0 F5.5), whether Claude Code honours dangerouslyDisableSandbox (F6.3; Ensemble's hook denies it), and a missing sandbox-exec binary (F6.4).",
  "The subprocess environment scrub is qualified for sandboxed Bash only (#827): Bash saw neither the token variable nor its value, and could not read its parent's environment with ps. Other ways to read a parent process's environment are untested.",
  "After a service crash, a running Claude CLI process can outlive the service (#827); verify it has exited before recovering the turn.",
  "Only the Claude Code version the pinned SDK declares was qualified. The installed claude is not version-checked, and another version may enforce the sandbox, tool and permission controls differently.",
  "Whether processes started by sandboxed Bash keep the per-task temporary directory is untested.",
  "The sandboxed agent can write the per-task temporary directory; Ensemble checks only its top-level entries before each turn.",
  "The per-task temporary directory has a predictable name under /tmp; another local user who creates it first makes Claude work wait, but never shares it.",
  "If the sandboxed agent changes the per-task temporary directory's permissions, the task's Claude work waits as not private until the operator repairs or removes it.",
];

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
  roots: readonly string[];
  ledger: Array<{
    toolUseId: string;
    toolName: string;
    decision: "allow" | "deny";
  }>;
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
  /** The service-PATH `claude`, resolved once per start; the SDK never falls back to its bundled one. */
  private executable: string | undefined;
  private readonly freshThreads = new Set<string>();
  private readonly threadTools = new Map<
    string,
    readonly RuntimeToolDefinition[]
  >();
  private readonly turns = new Map<string, ClaudeTurn>();
  /** Model to supported efforts, read model-free from the installed CLI. */
  private supported: Map<string, readonly string[]> | undefined;
  private settingsReading = false;
  private settingsRun: Promise<void> | undefined;
  private settingsAbort: AbortController | undefined;
  private settingsFailedAt: number | undefined;
  private readonly sandboxProbes = new Map<
    string,
    { pending: boolean; passed?: boolean; at: number }
  >();
  private admissionChanged?: () => void;
  private get retryMs(): number {
    return this.options.probeRetryMs ?? defaultProbeRetryMs;
  }
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

  /** Undefined until a preflight has read them from the installed CLI. */
  supportedSettings(): Record<string, readonly string[]> | undefined {
    return this.supported && Object.fromEntries(this.supported);
  }

  effectivePolicy(workspace: string) {
    return {
      writableRoots: [workspace, claudeTemporaryBase(workspace)],
      sharedWriteRoots: [] as string[],
      network: "denied" as const,
      fileToolConfinement: "hook" as const,
      limits: [...claudePolicyLimits],
    };
  }

  /** Bounded per-turn record of tool names and decisions; never inputs. */
  toolLedger(threadId: string, turnId: string) {
    const turn = this.turns.get(turnId);
    return turn?.threadId === threadId ? [...turn.ledger] : [];
  }

  /** Removes a released task's sandbox temporary base. */
  onAdmissionChange(listener: () => void): void {
    this.admissionChanged = listener;
  }

  async preflightTurn(input: {
    workspace: string;
    settings?: RuntimeTurnSettings;
  }): Promise<string | undefined> {
    const unavailable = (reason: string) =>
      `Claude runtime unavailable: ${reason}`;
    if (!this.generation || !this.sdk) return unavailable("runtime stopped");
    const environment = this.options.claude.turnEnvironment();
    if ("unavailable" in environment) return environment.unavailable;
    const base = claudeTemporaryBase(input.workspace);
    const temporary = await ensureTemporaryBase(base);
    if (temporary) return unavailable(temporary);
    const env = claudeTurnEnvironment(
      environment.env,
      environment.token,
      this.options.claude.configDirectory,
      base,
    );
    // Probes run in the background so the serial scheduler never awaits them.
    const sandbox = this.sandboxStatus(input.workspace, env);
    if (sandbox) return unavailable(sandbox);
    const settings = this.settingsStatus(input.workspace, env);
    if (settings) return unavailable(settings);
    const problem = this.settingsProblem(input.settings);
    if (problem) return unavailable(problem);
    // A passed self-test admits exactly one turn.
    this.sandboxProbes.delete(input.workspace);
    return undefined;
  }

  /** Undefined once a fresh self-test for this workspace has passed. */
  private sandboxStatus(
    workspace: string,
    env: Record<string, string>,
  ): string | undefined {
    const now = Date.now();
    const probe = this.sandboxProbes.get(workspace);
    if (probe?.passed === true && now - probe.at <= probeFreshMs)
      return undefined;
    if (probe?.pending) return "checking the sandbox";
    if (probe?.passed === false && now - probe.at < this.retryMs)
      return "sandbox self-test failed";
    const generation = this.generation;
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...withoutToken } = env;
    this.sandboxProbes.set(workspace, { pending: true, at: now });
    void (this.options.sandboxSelfTest ?? defaultSandboxSelfTest)({
      workspace,
      env: withoutToken,
    })
      .catch(() => false)
      .then((passed) => {
        if (this.generation !== generation) return;
        this.sandboxProbes.set(workspace, {
          pending: false,
          passed,
          at: Date.now(),
        });
        this.notifyAdmission(passed ? 0 : this.retryMs);
      });
    return "checking the sandbox";
  }

  /** Undefined once supported settings are known; reads them model-free once. */
  private settingsStatus(
    workspace: string,
    env: Record<string, string>,
  ): string | undefined {
    if (this.supported) return undefined;
    if (this.settingsReading) return "reading supported models";
    if (
      this.settingsFailedAt !== undefined &&
      Date.now() - this.settingsFailedAt < this.retryMs
    )
      return "supported models could not be read";
    const generation = this.generation;
    this.settingsReading = true;
    this.settingsRun = this.readSettings(env, workspace).then(
      (supported) => {
        this.settingsReading = false;
        if (this.generation !== generation) return;
        this.supported = supported;
        this.notifyAdmission(0);
      },
      () => {
        this.settingsReading = false;
        if (this.generation !== generation) return;
        this.settingsFailedAt = Date.now();
        this.notifyAdmission(this.retryMs);
      },
    );
    return "reading supported models";
  }

  private notifyAdmission(afterMs: number): void {
    const generation = this.generation;
    setTimeout(() => {
      if (this.generation === generation) this.admissionChanged?.();
    }, afterMs).unref();
  }

  private settingsProblem(
    settings: RuntimeTurnSettings | undefined,
  ): string | undefined {
    if (!this.supported) return "supported models are unknown";
    const model = settings?.model ?? "default";
    const efforts = this.supported.get(model);
    if (!efforts) return `model ${model} is not supported`;
    const effort = settings?.reasoningEffort;
    if (effort != null && !efforts.includes(effort))
      return `effort ${effort} is not supported for ${model}`;
    return undefined;
  }

  /** A model-free query whose prompt never releases (#825 T1 F9.0). */
  private async readSettings(
    env: Record<string, string>,
    workspace: string,
  ): Promise<Map<string, readonly string[]>> {
    const { sdk, executable } = this;
    if (!sdk || !executable) throw new Error("Runtime stopped");
    const abort = new AbortController();
    this.settingsAbort = abort;
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    async function* never(): AsyncGenerator<SDKUserMessage> {
      await new Promise((done) =>
        abort.signal.addEventListener("abort", done, { once: true }),
      );
    }
    const query = sdk.query({
      prompt: never(),
      options: {
        cwd: workspace,
        env,
        pathToClaudeCodeExecutable: executable,
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        tools: [],
        abortController: abort,
        stderr: () => {},
        spawnClaudeCodeProcess: (options) => {
          const spawned = this.spawnChild(options);
          child = spawned.child;
          exited = spawned.exited;
          return spawned.child as never;
        },
      },
    });
    const drained = (async () => {
      try {
        for await (const _ of query);
      } catch {
        // Abort ends the model-free query.
      }
    })();
    try {
      let timer: NodeJS.Timeout | undefined;
      const models = await Promise.race([
        query.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out")),
            settingsReadTimeoutMs,
          ).unref();
          // stop() ends a read that is still waiting.
          abort.signal.addEventListener(
            "abort",
            () => reject(new Error("stopped")),
            { once: true },
          );
        }),
      ]).finally(() => clearTimeout(timer));
      return new Map(
        supportedModelsSchema
          .parse(models)
          .map((model) => [
            model.value,
            model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
          ]),
      );
    } finally {
      abort.abort();
      await drained;
      if (child && !(await this.awaitExit(child, exited)))
        child.kill("SIGKILL");
    }
  }

  async start(): Promise<void> {
    if (this.generation) throw new Error("Runtime already started");
    const executable = await (
      this.options.resolveExecutable ??
      (() => resolveOnPath("claude", process.env))
    )();
    if (executable === null)
      throw new RuntimeNotEnabledError(
        "Claude executable is not on the service PATH",
      );
    await mkdir(this.options.claude.configDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(this.options.claude.configDirectory, 0o700);
    this.sdk =
      this.options.sdk ??
      ((await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk);
    this.executable = executable;
    this.generation = randomUUID();
  }

  async stop(): Promise<void> {
    if (!this.generation) return;
    this.generation = undefined;
    this.executable = undefined;
    const pending = [...this.turns.values()].filter((turn) => !turn.done);
    for (const turn of pending) turn.abort.abort();
    this.settingsAbort?.abort();
    await Promise.allSettled([
      ...pending.map((turn) => turn.settled.promise),
      this.settingsRun,
    ]);
    this.settingsReading = false;
    this.settingsRun = undefined;
    this.settingsAbort = undefined;
    this.turns.clear();
    this.sandboxProbes.clear();
    this.supported = undefined;
    this.settingsFailedAt = undefined;
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
    const { sdk, executable } = this;
    const generation = this.generation;
    if (!sdk || !executable || !generation) throw new Error("Runtime stopped");
    const environment = this.options.claude.turnEnvironment();
    if ("unavailable" in environment) throw new Error(environment.unavailable);
    const problem = this.settingsProblem(settings);
    if (problem) throw new Error(`Claude runtime unavailable: ${problem}`);
    const model = settings?.model ?? undefined;
    const effort =
      settings?.reasoningEffort == null
        ? undefined
        : effortSchema.parse(settings.reasoningEffort);
    const base = claudeTemporaryBase(workspace);
    const temporary = await ensureTemporaryBase(base);
    if (temporary) throw new Error(`Claude runtime unavailable: ${temporary}`);
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
      roots: [workspace, base],
      ledger: [],
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
      pathToClaudeCodeExecutable: executable,
      env: claudeTurnEnvironment(
        environment.env,
        environment.token,
        this.options.claude.configDirectory,
        base,
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
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        network: { allowedDomains: [] },
        filesystem: { allowWrite: [workspace, base] },
      },
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
    // Settled turns stay readable (ledger) until retain() evicts them.
    const outcome = await turn.settled.promise;
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
    return terminalFailureEvidence(
      this.options.safety,
      threadId,
      turnId,
      this.generation,
    );
  }

  /** Keeps unwaited settled turns bounded; unsettled turns are never evicted. */
  private retain(turn: ClaudeTurn): void {
    this.turns.set(turn.turnId, turn);
    const settled = [...this.turns.values()].filter((item) => item.done);
    for (const oldest of settled.slice(0, -maxRetainedSettledTurns))
      this.turns.delete(oldest.turnId);
  }

  private spawnChild(options: SpawnOptions) {
    const child = spawn(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      // The SDK's forwarded signal terminates the CLI on abort (C0 F2).
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    return { child, exited };
  }

  /** True once the child has exited, after waiting and then SIGTERM. */
  private async awaitExit(
    child: ChildProcess,
    exitedEvent: Promise<void> | undefined,
  ): Promise<boolean> {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const wait = (ms: number) =>
      Promise.race([exitedEvent ?? Promise.resolve(), sleep(ms)]);
    if (!exited()) await wait(this.options.exitTimeoutMs ?? 10_000);
    if (!exited()) {
      child.kill("SIGTERM");
      await wait(3000);
    }
    return exited() || child.pid === undefined;
  }

  private spawnTurnProcess(turn: ClaudeTurn, options: SpawnOptions) {
    const { child, exited } = this.spawnChild(options);
    turn.child = child;
    turn.exited = exited;
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
    if (!(await this.awaitExit(child, turn.exited))) return false;
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

  /** Records every call and denies those outside Ensemble's policy. */
  private async preToolUse(turn: ClaudeTurn, raw: unknown) {
    const input = hookInputSchema.safeParse(raw);
    const record = (decision: "allow" | "deny") => {
      if (input.success && turn.ledger.length < maxLedgerEntries)
        turn.ledger.push({
          toolUseId: input.data.tool_use_id,
          toolName: input.data.tool_name.slice(0, 128),
          decision,
        });
    };
    const deny = (reason: string) => {
      record("deny");
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: reason,
        },
      };
    };
    if (!input.success) return deny("Ensemble could not read this tool call");
    const { tool_name: name, tool_input: toolInput } = input.data;
    const fields = z.record(z.string(), z.unknown()).safeParse(toolInput);
    if (!builtInTools.includes(name) && !name.startsWith(mcpToolPrefix))
      return deny(`${name} is outside Ensemble's tool policy`);
    if (name === "Write" || name === "Edit") {
      const path = fields.success ? fields.data.file_path : undefined;
      if (
        typeof path !== "string" ||
        path.split(/[\\/]/).includes("..") ||
        !(await withinRoots(resolve(turn.roots[0] ?? "/", path), turn.roots))
      )
        return deny("File edits are confined to the task's writable roots");
    }
    if (
      name === "Bash" &&
      (!fields.success || fields.data.dangerouslyDisableSandbox === true)
    )
      return deny("Commands never run outside the sandbox");
    if (name.startsWith(mcpToolPrefix)) {
      if (turn.pendingCount >= maxPendingToolUses)
        return deny("Too many pending Ensemble tool calls");
      const key = inputDigest(name.slice(mcpToolPrefix.length), toolInput);
      const queue = turn.pendingToolUses.get(key) ?? [];
      queue.push(input.data.tool_use_id);
      turn.pendingToolUses.set(key, queue);
      turn.pendingCount++;
    }
    record("allow");
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
