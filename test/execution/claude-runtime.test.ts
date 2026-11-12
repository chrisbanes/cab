import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeRuntime,
  claudeSdkVersion,
  claudeTemporaryBase,
  claudeToolShape,
  claudeTurnEnvironment,
  releaseClaudeTemporaryBase,
} from "../../src/standalone/claude.js";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";
import {
  type RuntimeConversationEvent,
  type RuntimeDiagnosticEvent,
  RuntimeNotEnabledError,
  type RuntimeToolCall,
  type RuntimeTurnSettings,
  type SandboxEscalationEvent,
  type SandboxReviewEvent,
  type UnexpectedRequest,
} from "../../src/standalone/codex.js";
import type { ClaudeTurnEnvironment } from "../../src/standalone/service.js";
import {
  closeRuntimeSafetyFixtures,
  runtimeSafetyFixture,
} from "../fixtures/runtime-safety.js";
import {
  fakeSdk,
  init,
  result,
  type Script,
  sessionOf,
} from "../fixtures/claude-sdk.js";
import { tmpdir } from "../fixtures/temp.js";
import { slashTmpDenied } from "../fixtures/host-access.js";

test.after(closeRuntimeSafetyFixtures);

/** Preflight probes run in the background; poll until a final answer. */
async function settledPreflight(
  runtime: ClaudeRuntime,
  input: Parameters<ClaudeRuntime["preflightTurn"]>[0],
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const reason = await runtime.preflightTurn(input);
    if (!/checking the sandbox|reading supported models/.test(reason ?? ""))
      return reason;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Preflight did not settle");
}

const TOKEN = "claude-runtime-token-canary-3319";
const fixtureClaude = "/fixture/bin/claude";

function fixture(
  options: {
    scripts?: Script[];
    record?: () => boolean;
    environment?: () => ClaudeTurnEnvironment;
    verified?: boolean;
    selfTest?: () => boolean;
    hangModels?: boolean;
    mcpSources?: string[];
    apiProvider?: string;
    apiKeySource?: string | null;
    resolveExecutable?: () => Promise<string | null>;
    diagnostic?: "collect" | "throw" | "none";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cab-claude-runtime-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const safetyFixture = runtimeSafetyFixture();
  let origin: string | undefined;
  const log: string[] = [];
  const recorded: unknown[] = [];
  const { sdk, sessions, queries, optionsSeen } = fakeSdk(
    options.scripts ?? [],
    log,
    {
      hangModels: options.hangModels ?? false,
      ...(options.mcpSources ? { mcpSources: options.mcpSources } : {}),
      ...(options.apiProvider ? { apiProvider: options.apiProvider } : {}),
      ...(options.apiKeySource !== undefined
        ? { apiKeySource: options.apiKeySource }
        : {}),
    },
  );
  const runtime = new ClaudeRuntime({
    safety: {
      ...safetyFixture.safety,
      threadQualification: (id) => {
        const q = safetyFixture.safety.threadQualification(id);
        return q && origin !== undefined ? { ...q, codexHome: origin } : q;
      },
      recordTurnProcess: (input) => {
        recorded.push(input);
        log.push("record");
        return options.record ? options.record() : true;
      },
    },
    claude: {
      turnEnvironment:
        options.environment ??
        (() => ({
          env: {
            PATH: process.env.PATH,
            HOME: "/native/home",
            CLAUDE_CONFIG_DIR: "/native/config",
            ANTHROPIC_API_KEY: "api-key-canary",
            CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
          },
        })),
    },
    sdk,
    resolveExecutable: options.resolveExecutable ?? (async () => fixtureClaude),
    captureProcessIdentity: async (pid) =>
      pid
        ? {
            processId: String(pid),
            processStartedAt: "Sat Oct 11 10:00:00 2026",
            bootId: "claude-runtime-boot",
          }
        : null,
    terminationVerifier: {
      verify: async (identity) =>
        options.verified === false
          ? { kind: "unknown", reason: "unverifiable" }
          : {
              kind: "verified",
              processIdentity: identity,
              verifiedAt: new Date().toISOString(),
              method: "mac-pid-absent-same-boot",
            },
    },
    exitTimeoutMs: 2000,
    sandboxSelfTest: async () => (options.selfTest ? options.selfTest() : true),
    probeRetryMs: 20,
  });
  const emitted: unknown[] = [];
  const anomalies: Array<{
    threadId?: string;
    turnId?: string;
    reason: string;
  }> = [];
  const unexpected: UnexpectedRequest[] = [];
  const toolCalls: RuntimeToolCall[] = [];
  const diagnostics: RuntimeDiagnosticEvent[] = [];
  if (options.diagnostic !== "none")
    runtime.onDiagnosticEvent((event) => {
      if (options.diagnostic === "throw") throw new Error("listener failed");
      diagnostics.push(event);
    });
  runtime.onConversationEvent((event: RuntimeConversationEvent) =>
    emitted.push(event),
  );
  runtime.onTerminalAnomaly((anomaly) => anomalies.push(anomaly));
  runtime.onUnexpectedRequest((request) => unexpected.push(request));
  runtime.onToolCall(async (call) => {
    toolCalls.push(call);
    return { text: `ok:${call.tool}`, success: true };
  });
  /** Starts a turn and binds it the way the service does. */
  const settings = { model: "haiku", reasoningEffort: "low" };
  const turn = async (
    threadId: string,
    access?: "read-only",
    skills?: RuntimeTurnSettings["skills"],
    gitWritableRoots?: string[],
    localListening?: boolean,
    skipSandbox?: boolean,
    sandboxEscalation?: "approval" | "auto-review",
  ) => {
    const turnSettings = skills ? { ...settings, skills } : settings;
    assert.equal(
      await settledPreflight(runtime, {
        workspace,
        settings: turnSettings,
        ...(sandboxEscalation ? { sandboxEscalation } : {}),
      }),
      undefined,
    );
    const turnId = await runtime.startTurn(
      threadId,
      workspace,
      "Do the work",
      turnSettings,
      access ||
        gitWritableRoots ||
        localListening ||
        skipSandbox ||
        sandboxEscalation
        ? {
            networkAccess: false,
            ...(access ? { access } : {}),
            ...(gitWritableRoots ? { gitWritableRoots } : {}),
            ...(localListening ? { localListening } : {}),
            ...(skipSandbox ? { skipSandbox } : {}),
            ...(sandboxEscalation ? { sandboxEscalation } : {}),
          }
        : undefined,
    );
    const generation = runtime.currentUserInputGeneration();
    assert.ok(generation);
    safetyFixture.bindTurn(threadId, turnId, generation);
    return turnId;
  };
  return {
    setOrigin: (value: string) => {
      origin = value;
    },
    root,
    workspace,
    runtime,
    sessions,
    log,
    recorded,
    emitted,
    diagnostics,
    anomalies,
    unexpected,
    toolCalls,
    turn,
    queries,
    optionsSeen,
    cleanup: async () => {
      await releaseClaudeTemporaryBase(workspace);
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the pinned SDK is the qualified version", () => {
  const entry = createRequire(import.meta.url).resolve(
    "@anthropic-ai/claude-agent-sdk",
  );
  const manifest = JSON.parse(
    readFileSync(join(dirname(entry), "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(manifest.version, claudeSdkVersion);
});

test("every coordination tool converts to a real SDK MCP tool without defaults", async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  process.on("warning", onWarning);
  try {
    const tools = coordinationTools.map((definition) =>
      sdk.tool(
        definition.name,
        definition.description,
        claudeToolShape(definition.inputSchema),
        async () => ({ content: [] }),
      ),
    );
    const server = sdk.createSdkMcpServer({ name: "cab", tools });
    assert.equal(server.name, "cab");
    const reported = coordinationTools.find(
      (tool) => tool.name === "cab_report_result",
    );
    assert.ok(reported);
    // Defaults would make handler arguments differ from the hooked input.
    assert.deepEqual(
      z.object(claudeToolShape(reported.inputSchema)).parse({ summary: "S" }),
      { summary: "S" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("a Claude turn runs one native query, releases its prompt only after the process is recorded, then resumes the session", {
  skip: slashTmpDenied(),
}, async () => {
  const scripts: Script[] = [
    async function* (session) {
      yield init(sessionOf(session));
      yield {
        type: "assistant",
        uuid: "a-1",
        message: { content: [{ type: "text", text: "Hello" }] },
      };
      yield result(sessionOf(session));
    },
    async function* (session) {
      yield init(sessionOf(session));
      yield result(sessionOf(session));
    },
  ];
  const f = fixture({ scripts });
  try {
    writeFileSync(join(f.workspace, "AGENTS.md"), "ROOT-AGENTS-NONCE");
    mkdirSync(join(f.workspace, "repo-1"));
    writeFileSync(
      join(f.workspace, "repo-1", "CLAUDE.md"),
      "REPO-CLAUDE-NONCE",
    );
    mkdirSync(join(f.workspace, "repo-2"));
    writeFileSync(join(f.root, "outside.md"), "SYMLINK-NONCE");
    symlinkSync(
      join(f.root, "outside.md"),
      join(f.workspace, "repo-2", "AGENTS.md"),
    );
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const first = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, first), "completed");
    assert.deepEqual(f.log.slice(0, 2), ["record", "prompt"]);
    const options = f.sessions[0]?.options;
    assert.ok(options);
    assert.equal(options.sessionId, threadId);
    assert.equal(options.resume, undefined);
    assert.equal(options.cwd, f.workspace);
    assert.equal(options.settingSources, undefined);
    assert.equal(options.strictMcpConfig, undefined);
    assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.model, "haiku");
    assert.equal(options.effort, "low");
    assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(options.env?.HOME, "/native/home");
    assert.equal(options.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
    // Claude Code offers TodoWrite only behind these gates.
    assert.equal(options.env?.CLAUDE_CODE_ENABLE_TASKS, "0");
    assert.equal(options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, "/native/config");
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
    const base = claudeTemporaryBase(f.workspace);
    assert.equal(options.env?.CLAUDE_CODE_TMPDIR, base);
    assert.ok(Buffer.byteLength(`${base}/claude-4294967294`) <= 44);
    assert.deepEqual(options.tools, [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "Agent",
      "TodoWrite",
      "Skill",
    ]);
    assert.deepEqual(options.allowedTools, [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "Agent",
      "TodoWrite",
      "Skill",
      "mcp__cab__*",
    ]);
    assert.deepEqual(options.disallowedTools, [
      "AskUserQuestion",
      "WebFetch",
      "WebSearch",
      "EnterPlanMode",
      "ExitPlanMode",
    ]);
    // Native configuration supplies extensions.
    assert.equal(options.managedSettings, undefined);
    assert.equal(options.plugins, undefined);
    assert.equal(options.skills, undefined);
    assert.deepEqual(options.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [] },
      filesystem: { allowWrite: [f.workspace, base] },
    });
    const prompt = options.systemPrompt as { append: string };
    assert.match(prompt.append, /ROOT-AGENTS-NONCE/);
    assert.match(prompt.append, /REPO-CLAUDE-NONCE/);
    assert.doesNotMatch(prompt.append, /SYMLINK-NONCE/);
    assert.deepEqual(f.sessions[0]?.prompt?.message, {
      role: "user",
      content: "Do the work",
    });
    assert.deepEqual(
      f.emitted.map((event) => (event as { kind: string }).kind),
      ["started", "completed"],
    );
    assert.deepEqual(f.recorded[0], {
      threadId,
      processIdentity: {
        processId: String(f.sessions[0]?.child.pid),
        processStartedAt: "Sat Oct 11 10:00:00 2026",
        bootId: "claude-runtime-boot",
      },
    });
    assert.equal(f.runtime.processIdentity(), null);

    await f.runtime.resumeThread(threadId, []);
    const second = await f.turn(threadId);
    assert.notEqual(second, first);
    assert.equal(await f.runtime.waitForTurn(threadId, second), "completed");
    assert.equal(f.sessions[1]?.options.resume, threadId);
    assert.equal(f.sessions[1]?.options.sessionId, undefined);
  } finally {
    await f.cleanup();
  }
});

test("the settings read and every turn run the PATH-resolved claude, resolved once per start", {
  skip: slashTmpDenied(),
}, async () => {
  let resolved = 0;
  const script: Script = async function* (session) {
    yield init(sessionOf(session));
    yield result(sessionOf(session));
  };
  const f = fixture({
    scripts: [script, script],
    resolveExecutable: async () => {
      resolved++;
      return fixtureClaude;
    },
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const first = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, first), "completed");
    await f.runtime.resumeThread(threadId, []);
    const second = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, second), "completed");
    assert.equal(resolved, 1);
    assert.deepEqual(f.queries, ["settings", "turn", "turn"]);
    assert.deepEqual(
      f.optionsSeen.map((options) => options.pathToClaudeCodeExecutable),
      [fixtureClaude, fixtureClaude, fixtureClaude],
    );
  } finally {
    await f.cleanup();
  }
});

test("a missing claude rejects start before any query and leaves the runtime stopped", async () => {
  const f = fixture({ resolveExecutable: async () => null });
  try {
    // Not a failure: the service treats this harness as not enabled for the run.
    await assert.rejects(
      f.runtime.start(),
      (error) =>
        error instanceof RuntimeNotEnabledError &&
        error.message === "Claude executable is not on the service PATH",
    );
    await assert.rejects(
      f.runtime.startThread(f.workspace, []),
      /Runtime stopped/,
    );
    assert.deepEqual(f.queries, []);
    assert.equal(existsSync(join(f.root, "data", "claude")), false);
  } finally {
    await f.cleanup();
  }
});

test("each Claude result error maps to visible failure evidence", {
  skip: slashTmpDenied(),
}, async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [
      { subtype: "error_during_execution", is_error: true },
      "unknown",
      "error_during_execution",
    ],
    [
      { subtype: "error_max_turns", is_error: true },
      "permanent",
      "error_max_turns",
    ],
    [
      { subtype: "error_max_budget_usd", is_error: true },
      "permanent",
      "error_max_budget_usd",
    ],
    [
      { subtype: "error_max_structured_output_retries", is_error: true },
      "permanent",
      "error_max_structured_output_retries",
    ],
    [
      {
        is_error: true,
        terminal_reason: "api_error",
        result: "Not logged in · Please run /login",
      },
      "permanent",
      "unauthorized",
    ],
    [
      { is_error: true, terminal_reason: "api_error", result: "Overloaded" },
      "unknown",
      "api_error",
    ],
  ];
  const f = fixture({
    scripts: cases.map(
      ([fields]) =>
        async function* (session) {
          yield init(sessionOf(session));
          yield result(sessionOf(session), fields);
          // The SDK throws after yielding an error result (C0).
          throw new Error(`Claude Code returned an error result: ${TOKEN}`);
        },
    ),
  });
  try {
    await f.runtime.start();
    for (const [, classification, reasonCode] of cases) {
      const threadId = await f.runtime.startThread(f.workspace, []);
      const turnId = await f.turn(threadId);
      assert.equal(await f.runtime.waitForTurn(threadId, turnId), "failed");
      assert.deepEqual(f.runtime.failureEvidence(threadId, turnId), {
        threadId,
        turnId,
        status: "failed",
        classification,
        reasonCode,
        source: "harness",
        harnessRetries: null,
      });
    }
    assert.deepEqual(f.anomalies, []);
  } finally {
    await f.cleanup();
  }
});

test("interrupting a Claude turn aborts its query and ends it as interrupted", {
  skip: slashTmpDenied(),
}, async () => {
  let reached!: () => void;
  const streaming = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        reached();
        await new Promise(() => {});
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    await streaming;
    await f.runtime.interruptTurn(threadId, turnId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "failed");
    const child = f.sessions[0]?.child;
    assert.equal(child?.signalCode, "SIGTERM");
    assert.equal(
      f.runtime.failureEvidence(threadId, turnId)?.reasonCode,
      "interrupted",
    );
    assert.deepEqual(f.anomalies, []);
  } finally {
    await f.cleanup();
  }
});

test("a subagent's prose is not the lead's conversation", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        yield {
          type: "assistant",
          uuid: "a-sub",
          parent_tool_use_id: "toolu_agent",
          message: { content: [{ type: "text", text: "from the subagent" }] },
        };
        yield {
          type: "assistant",
          uuid: "a-lead",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "from the lead" }] },
        };
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    const texts = f.emitted.flatMap((event) => {
      const e = event as { kind: string; text?: string };
      return e.kind === "completed" ? [e.text] : [];
    });
    assert.deepEqual(texts, ["from the lead"]);
  } finally {
    await f.cleanup();
  }
});

test("every SDK message of a turn, presented or not, is activity of that turn", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        // A partial stream event is not presented as conversation, but it is activity.
        yield {
          type: "stream_event",
          uuid: "partial",
          parent_tool_use_id: null,
          event: { type: "content_block_delta" },
        };
        yield result(sessionOf(session));
      },
    ],
  });
  const activity: { threadId: string; turnId: string }[] = [];
  f.runtime.onTurnActivity((turn) => activity.push(turn));
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    await f.runtime.waitForTurn(threadId, turnId).catch(() => undefined);
    assert.ok(activity.length >= 2, JSON.stringify(activity));
    assert.ok(
      activity.every((a) => a.threadId === threadId && a.turnId === turnId),
    );
  } finally {
    await f.cleanup();
  }
});

test("losing the Claude process mid-tool reports an anomaly and never a terminal", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        yield {
          type: "assistant",
          uuid: "a-tool",
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
          },
        };
        session.child.kill("SIGKILL");
        await session.waitForExit();
        throw new Error("Claude Code process terminated by signal SIGKILL");
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    await assert.rejects(f.runtime.waitForTurn(threadId, turnId));
    assert.deepEqual(f.anomalies, [
      { threadId, turnId, reason: "Claude process ended without a result" },
    ]);
    assert.equal(f.runtime.failureEvidence(threadId, turnId), undefined);
  } finally {
    await f.cleanup();
  }
});

test("a malformed SDK message aborts the query and reports an anomaly", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    scripts: [
      async function* () {
        yield { type: "system", subtype: "init" };
        await new Promise(() => {});
      },
      async function* (session) {
        yield init(sessionOf(session));
        yield { ...result(sessionOf(session)), subtype: 7 };
      },
    ],
  });
  try {
    await f.runtime.start();
    for (let index = 0; index < 2; index++) {
      const threadId = await f.runtime.startThread(f.workspace, []);
      const turnId = await f.turn(threadId);
      await assert.rejects(f.runtime.waitForTurn(threadId, turnId));
      assert.deepEqual(f.anomalies[index], {
        threadId,
        turnId,
        reason: "Claude SDK message failed validation",
      });
    }
    assert.ok(f.sessions[0]?.options.abortController?.signal.aborted);
  } finally {
    await f.cleanup();
  }
});

test("an unverified Claude process exit reports an anomaly", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    verified: false,
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    await assert.rejects(f.runtime.waitForTurn(threadId, turnId));
    assert.equal(
      f.anomalies[0]?.reason,
      "Claude process exit was not verified",
    );
  } finally {
    await f.cleanup();
  }
});

test("a Claude turn whose process cannot be recorded never receives its prompt", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    record: () => false,
    scripts: [
      async function* () {
        yield { type: "never" };
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    assert.equal(
      await settledPreflight(f.runtime, { workspace: f.workspace }),
      undefined,
    );
    await assert.rejects(
      f.runtime.startTurn(threadId, f.workspace, "Do the work"),
      /Claude turn could not start/,
    );
    assert.deepEqual(f.log, ["record"]);
    assert.equal(f.sessions.length, 0);
    assert.deepEqual(f.anomalies, []);
  } finally {
    await f.cleanup();
  }
});

test("an unavailable token prevents the turn without revealing it", async () => {
  const f = fixture({
    environment: () => ({
      unavailable:
        "Claude runtime unavailable: subscription token is unavailable",
    }),
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    await assert.rejects(
      f.runtime.startTurn(threadId, f.workspace, "Do the work"),
      /^Error: Claude runtime unavailable: subscription token is unavailable$/,
    );
    assert.equal(f.sessions.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("coordination calls carry the hook's tool-use ID and uncorrelated calls are refused", {
  skip: slashTmpDenied(),
}, async () => {
  const outcomes: unknown[] = [];
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        const args = { question: "Which?" };
        await session.hook("mcp__cab__cab_ask_question", args, "toolu_9");
        outcomes.push(await session.callTool("cab_ask_question", args));
        outcomes.push(
          await session.callTool("cab_ask_question", {
            question: "Other",
          }),
        );
        const denied = await (
          session.options.canUseTool as NonNullable<Options["canUseTool"]>
        )("WebFetch", {}, { signal: new AbortController().signal } as never);
        outcomes.push(denied);
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, [
      {
        type: "function",
        name: "cab_ask_question",
        description: "Ask",
        inputSchema: {
          type: "object",
          properties: { question: { type: "string" } },
          required: ["question"],
        },
      },
    ]);
    const turnId = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.deepEqual(f.toolCalls, [
      {
        threadId,
        turnId,
        callId: "toolu_9",
        tool: "cab_ask_question",
        arguments: { question: "Which?" },
      },
    ]);
    assert.deepEqual(outcomes[0], {
      content: [{ type: "text", text: "ok:cab_ask_question" }],
      isError: false,
    });
    assert.equal((outcomes[1] as { isError: boolean }).isError, true);
    assert.equal((outcomes[2] as { behavior: string }).behavior, "deny");
    assert.deepEqual(f.unexpected, [
      { method: "claude/canUseTool:WebFetch", threadId, turnId },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("the Claude token never appears in anything the runtime emits", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        yield result(sessionOf(session), {
          is_error: true,
          terminal_reason: "api_error",
          result: `Not logged in ${TOKEN}`,
          errors: [TOKEN],
        });
        throw new Error(`Claude Code returned an error result: ${TOKEN}`);
      },
      async function* () {
        yield { type: "result", subtype: 1, detail: TOKEN };
      },
    ],
  });
  const seen: unknown[] = [];
  try {
    await f.runtime.start();
    for (let index = 0; index < 2; index++) {
      const threadId = await f.runtime.startThread(f.workspace, []);
      const turnId = await f.turn(threadId);
      await f.runtime.waitForTurn(threadId, turnId).then(
        (status) => seen.push(status),
        (error: Error) => seen.push(error.message, String(error.stack)),
      );
      seen.push(f.runtime.failureEvidence(threadId, turnId));
    }
    const serialized = JSON.stringify([
      seen,
      f.emitted,
      f.anomalies,
      f.unexpected,
      f.toolCalls,
    ]);
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(f.anomalies.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("the PreToolUse hook allows calls inside policy and denies the rest", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  let outside = "";
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        const workspace = String(session.options.cwd);
        const calls: Array<[string, unknown]> = [
          ["Write", { file_path: join(workspace, "inside.txt"), content: "x" }],
          ["Write", { file_path: join(outside, "x.txt"), content: "x" }],
          ["Edit", { file_path: join(workspace, "..", "escape.txt") }],
          ["Edit", { file_path: `${workspace}/sub/../inside.txt` }],
          ["Write", { file_path: join(workspace, "link", "x.txt") }],
          ["WebFetch", { url: "https://example.com" }],
          ["Bash", { command: "ls", dangerouslyDisableSandbox: true }],
          ["Bash", { command: "ls" }],
          ["mcp__other__x", {}],
        ];
        for (const [index, [name, input]] of calls.entries())
          decisions.push(await session.hook(name, input, `toolu_${index}`));
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.workspace, "link"));
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    const denied = (index: number) =>
      (
        decisions[index] as {
          hookSpecificOutput?: {
            permissionDecision: string;
            permissionDecisionReason: string;
          };
        }
      ).hookSpecificOutput;
    assert.deepEqual(decisions[0], {});
    assert.deepEqual(decisions[7], {});
    assert.equal(denied(8)?.permissionDecision, "allow");
    for (const index of [1, 2, 3, 4, 5, 6]) {
      assert.equal(denied(index)?.permissionDecision, "deny");
      assert.ok(denied(index)?.permissionDecisionReason);
    }
  } finally {
    await f.cleanup();
  }
});

test("a task turn's Git roots are writable to sandboxed commands but not to file-editing tools", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  let gitRoot = "";
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        decisions.push(
          await session.hook(
            "Edit",
            { file_path: join(gitRoot, "config") },
            "toolu_0",
          ),
        );
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    gitRoot = join(f.root, "repositories", "managed", "worktrees", "repo-1");
    const roots = [
      join(f.root, "repositories", "managed", "objects"),
      join(f.root, "repositories", "managed", "reftable"),
      gitRoot,
    ];
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId, undefined, undefined, roots);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.deepEqual(f.sessions[0]?.options.sandbox?.filesystem, {
      allowWrite: [f.workspace, claudeTemporaryBase(f.workspace), ...roots],
    });
    assert.equal(
      (decisions[0] as { hookSpecificOutput?: { permissionDecision: string } })
        .hookSpecificOutput?.permissionDecision,
      "deny",
    );
  } finally {
    await f.cleanup();
  }
});

test("a task turn with local listening can bind loopback ports and keeps network denied", {
  skip: slashTmpDenied(),
}, async () => {
  const turnScript = async function* (
    session: Parameters<typeof sessionOf>[0],
  ) {
    yield init(sessionOf(session));
    yield result(sessionOf(session));
  };
  const f = fixture({ scripts: [turnScript, turnScript, turnScript] });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    for (const [access, listening] of [
      [undefined, true],
      [undefined, undefined],
      ["read-only", true],
    ] as const) {
      const turnId = await f.turn(
        threadId,
        access,
        undefined,
        undefined,
        listening,
      );
      assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    }
    const network = (index: number) =>
      f.sessions[index]?.options.sandbox?.network;
    assert.deepEqual(network(0), {
      allowedDomains: [],
      allowLocalBinding: true,
    });
    assert.deepEqual(network(1), { allowedDomains: [] });
    // A read-only (draft) turn never listens, whatever the policy carries.
    assert.deepEqual(network(2), { allowedDomains: [] });
  } finally {
    await f.cleanup();
  }
});

test("a skip-sandbox task turn disables only the sandbox and keeps the tool policy and hook roots", {
  skip: slashTmpDenied(),
}, async () => {
  let outside = "";
  const decisions: unknown[] = [];
  const turnScript = async function* (
    session: Parameters<typeof sessionOf>[0],
  ) {
    yield init(sessionOf(session));
    decisions.push(
      await session.hook(
        "Write",
        { file_path: join(outside, "x.txt"), content: "x" },
        "toolu_out",
      ),
    );
    yield result(sessionOf(session));
  };
  const f = fixture({ scripts: [turnScript, turnScript, turnScript] });
  try {
    outside = join(f.root, "outside");
    mkdirSync(outside);
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    for (const [access, skip] of [
      [undefined, undefined],
      [undefined, true],
      ["read-only", true],
    ] as const) {
      const turnId = await f.turn(
        threadId,
        access,
        undefined,
        undefined,
        undefined,
        skip,
      );
      assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    }
    const [normal, skipped, draft] = f.sessions.map((s) => s.options);
    assert.ok(normal && skipped && draft);
    assert.deepEqual(skipped.sandbox, { enabled: false });
    for (const key of [
      "permissionMode",
      "tools",
      "allowedTools",
      "disallowedTools",
      "cwd",
    ] as const)
      assert.deepEqual(skipped[key], normal[key]);
    assert.deepEqual(
      Object.keys(skipped.hooks ?? {}),
      Object.keys(normal.hooks ?? {}),
    );
    assert.deepEqual(Object.keys(skipped.mcpServers ?? {}), ["cab"]);
    assert.equal(normal.sandbox?.enabled, true);
    assert.equal(normal.sandbox?.failIfUnavailable, true);
    // A read-only (draft) turn stays sandboxed whatever the policy carries.
    assert.deepEqual(draft.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [] },
      filesystem: { allowWrite: [claudeTemporaryBase(f.workspace)] },
    });
    // The hook still confines Write outside the roots in every turn.
    assert.equal(decisions.length, 3);
    for (const decision of decisions)
      assert.equal(
        (
          decision as {
            hookSpecificOutput?: { permissionDecision: string };
          }
        ).hookSpecificOutput?.permissionDecision,
        "deny",
      );
  } finally {
    await f.cleanup();
  }
});

test("preflight with the skip-sandbox hint ignores the self-test and leaves a passed probe unconsumed", {
  skip: slashTmpDenied(),
}, async () => {
  let runs = 0;
  let passing = false;
  const f = fixture({
    selfTest: () => {
      runs++;
      return passing;
    },
  });
  try {
    await f.runtime.start();
    const hinted = () =>
      settledPreflight(f.runtime, {
        workspace: f.workspace,
        skipSandbox: true,
      });
    // The failing self-test is never consulted.
    assert.equal(await hinted(), undefined);
    assert.equal(runs, 0);
    passing = true;
    // Without the hint it still waits, then a passed probe is left for the next turn.
    assert.match(
      String(await f.runtime.preflightTurn({ workspace: f.workspace })),
      /checking the sandbox/,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runs, 1);
    assert.equal(await hinted(), undefined);
    assert.equal(
      await settledPreflight(f.runtime, { workspace: f.workspace }),
      undefined,
    );
    assert.equal(runs, 1);
    // That unhinted admission consumed it: the next one probes again.
    assert.match(
      String(await f.runtime.preflightTurn({ workspace: f.workspace })),
      /checking the sandbox/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a read-only turn can write only the temporary base, in the sandbox and the hook", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        const workspace = String(session.options.cwd);
        const base = claudeTemporaryBase(workspace);
        const calls: Array<[string, unknown]> = [
          ["Write", { file_path: join(workspace, "inside.txt"), content: "x" }],
          ["Edit", { file_path: join(workspace, "inside.txt") }],
          ["Write", { file_path: join(base, "scratch.txt"), content: "x" }],
          ["Read", { file_path: join(workspace, "inside.txt") }],
        ];
        for (const [index, [name, input]] of calls.entries())
          decisions.push(await session.hook(name, input, `toolu_${index}`));
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId, "read-only");
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    const base = claudeTemporaryBase(f.workspace);
    assert.deepEqual(f.sessions[0]?.options.sandbox?.filesystem, {
      allowWrite: [base],
    });
    const verdict = (index: number) =>
      (
        decisions[index] as {
          hookSpecificOutput?: { permissionDecision: string };
        }
      ).hookSpecificOutput?.permissionDecision;
    assert.equal(verdict(0), "deny");
    assert.equal(verdict(1), "deny");
    assert.equal(verdict(2), undefined);
    assert.equal(verdict(3), undefined);
  } finally {
    await f.cleanup();
  }
});

test("preflight waits for a failed sandbox self-test, unsupported settings or a missing token before any query", {
  skip: slashTmpDenied(),
}, async () => {
  let selfTest = false;
  let environment: ClaudeTurnEnvironment = { env: {} };
  const f = fixture({
    selfTest: () => selfTest,
    environment: () => environment,
  });
  try {
    await f.runtime.start();
    assert.equal(f.runtime.supportedSettings(), undefined);
    const preflight = (settings?: {
      model: string | null;
      reasoningEffort: string | null;
    }) =>
      settledPreflight(f.runtime, {
        workspace: f.workspace,
        ...(settings ? { settings } : {}),
      });
    assert.match(
      String(await preflight()),
      /^Claude runtime unavailable: sandbox/,
    );
    assert.deepEqual(f.queries, []);
    selfTest = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await preflight(), undefined);
    assert.deepEqual(f.queries, ["settings"]);
    assert.deepEqual(f.runtime.supportedSettings()?.haiku, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.equal(
      await preflight({ model: "opus", reasoningEffort: null }),
      "Claude runtime unavailable: model opus is not supported",
    );
    assert.equal(
      await preflight({ model: "haiku", reasoningEffort: "extreme" }),
      "Claude runtime unavailable: effort extreme is not supported for haiku",
    );
    assert.deepEqual(f.queries, ["settings"]);
    environment = {
      unavailable:
        "Claude runtime unavailable: subscription token is not configured",
    };
    assert.equal(
      await preflight(),
      "Claude runtime unavailable: subscription token is not configured",
    );
  } finally {
    await f.cleanup();
  }
});

test("preflight refuses a sandbox temporary base that is not private", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture();
  const base = claudeTemporaryBase(f.workspace);
  try {
    mkdirSync(base, { mode: 0o755 });
    chmodSync(base, 0o755);
    await f.runtime.start();
    assert.equal(
      await settledPreflight(f.runtime, { workspace: f.workspace }),
      "Claude runtime unavailable: per-task sandbox temporary directory is not private",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("the effective policy discloses hook confinement, the redirected temporary root and untested surfaces", () => {
  const runtime = new ClaudeRuntime({
    safety: runtimeSafetyFixture().safety,
    claude: {
      turnEnvironment: () => ({ unavailable: "unused" }),
    },
  });
  const policy = runtime.effectivePolicy("/work/task");
  assert.deepEqual(policy.writableRoots, [
    "/work/task",
    claudeTemporaryBase("/work/task"),
  ]);
  assert.deepEqual(policy.sharedWriteRoots, []);
  assert.equal(policy.network, "denied");
  assert.equal(policy.fileToolConfinement, "hook");
  const limits = policy.limits.join("\n");
  for (const pattern of [
    /PreToolUse hook/,
    /exit 126/,
    /F5\.5/,
    /F6\.4/,
    /classifier also decides a call the operator approved/,
    /scrub/,
    /version the pinned SDK declares/,
    /TodoWrite/,
  ])
    assert.match(limits, pattern);
});

test("a planted symlink in the sandbox temporary base is removed before the turn", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture();
  const base = claudeTemporaryBase(f.workspace);
  const uid = process.getuid?.() ?? 0;
  try {
    mkdirSync(base, { mode: 0o700 });
    chmodSync(base, 0o700);
    const target = join(f.root, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(base, `claude-${uid}`));
    symlinkSync(target, join(base, "cc-socks"));
    await f.runtime.start();
    assert.equal(
      await settledPreflight(f.runtime, { workspace: f.workspace }),
      undefined,
    );
    for (const name of [`claude-${uid}`, "cc-socks"])
      assert.throws(() => lstatSync(join(base, name)), /ENOENT/);
    assert.ok(lstatSync(target).isDirectory());
  } finally {
    await f.cleanup();
  }
});

test("coordination arguments parsed by the advertised schema keep their hook correlation, and extra keys fail closed", {
  skip: slashTmpDenied(),
}, async () => {
  const outcomes: Array<{ isError: boolean }> = [];
  const resultId = "70000000-0000-4000-8000-000000000001";
  const inputs: Array<[string, Record<string, unknown>]> = [
    ["cab_report_result", { summary: "Done" }],
    ["cab_request_completion", { reviewedResultIds: [resultId] }],
    ["cab_ask_question", { question: "Which?" }],
    ["cab_request_follow_up", { resultId, instructions: "Again" }],
  ];
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        for (const [index, [name, args]] of inputs.entries()) {
          await session.hook(`mcp__cab__${name}`, args, `toolu_ok_${index}`);
          outcomes.push(
            (await session.callTool(name, args)) as { isError: boolean },
          );
        }
        const extra = { question: "Which?", unexpected: true };
        await session.hook("mcp__cab__cab_ask_question", extra, "toolu_extra");
        outcomes.push(
          (await session.callTool("cab_ask_question", extra)) as {
            isError: boolean;
          },
        );
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(
      f.workspace,
      coordinationTools,
    );
    const turnId = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.deepEqual(
      outcomes.map((outcome) => outcome.isError),
      [false, false, false, false, true],
    );
    assert.deepEqual(
      f.toolCalls.map((call) => [call.callId, call.tool, call.arguments]),
      inputs.map(([name, args], index) => [`toolu_ok_${index}`, name, args]),
    );
  } finally {
    await f.cleanup();
  }
});

test("stopping the runtime ends a settings read that is still waiting", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({ hangModels: true });
  const reading = "Claude runtime unavailable: reading supported models";
  const untilReading = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        (await f.runtime.preflightTurn({ workspace: f.workspace })) === reading
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Settings read never started");
  };
  try {
    await f.runtime.start();
    await untilReading();
    assert.deepEqual(f.queries, ["settings"]);
    const started = Date.now();
    await f.runtime.stop();
    assert.ok(Date.now() - started < 2000);
    await f.runtime.start();
    await untilReading();
    // A fresh generation starts a new read instead of waiting on the stopped one.
    assert.deepEqual(f.queries, ["settings", "settings"]);
  } finally {
    await f.cleanup();
  }
});

/** Runs one scripted turn and returns what the fixture recorded. */
async function diagnosticTurn(
  calls: (session: Parameters<Script>[0]) => Promise<unknown>,
  diagnostic: "collect" | "throw" | "none" = "collect",
  access?: "read-only",
) {
  const f = fixture({
    diagnostic,
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        await calls(session);
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId, access);
    const outcome = await f.runtime.waitForTurn(threadId, turnId);
    return { outcome, diagnostics: f.diagnostics, threadId, turnId };
  } finally {
    await f.cleanup();
  }
}

test("a Bash tool use is recorded as a command item with exit status and bounded output", {
  skip: slashTmpDenied(),
}, async () => {
  const command = "echo hi";
  const run = await diagnosticTurn(async (session) => {
    await session.hook("Bash", { command }, "toolu_ok");
    await session.postHook("Bash", { command }, "toolu_ok", {
      response: { stdout: "ok\n", stderr: "", interrupted: false },
    });
    await session.hook("Bash", { command }, "toolu_err");
    await session.postHook("Bash", { command }, "toolu_err", {
      response: { stdout: "o", stderr: "e", interrupted: false },
    });
    for (const [id, outcome] of [
      ["toolu_f2", { error: "Exit code 2\nboom" }],
      ["toolu_f_plain", { error: "no prefix" }],
      ["toolu_f_int", { error: "Exit code 130\nx", isInterrupt: true }],
    ] as const) {
      await session.hook("Bash", { command }, id);
      await session.postHook("Bash", { command }, id, outcome);
    }
    await session.hook("Bash", { command }, "toolu_interp");
    await session.postHook("Bash", { command }, "toolu_interp", {
      response: {
        stdout: "",
        stderr: "",
        interrupted: false,
        returnCodeInterpretation: "No matches found",
      },
    });
    await session.hook("Bash", { command }, "toolu_bg");
    await session.postHook("Bash", { command }, "toolu_bg", {
      response: {
        stdout: "",
        stderr: "",
        interrupted: false,
        backgroundTaskId: "bg1",
      },
    });
    await session.hook("Bash", { command }, "toolu_bad");
    await session.postHook("Bash", { command }, "toolu_bad", {
      response: "not an object",
    });
  });
  assert.equal(run.outcome, "completed");
  const { threadId, turnId } = run;
  const item = (id: string, phase: "started" | "completed") =>
    run.diagnostics.find(
      (event) =>
        event.kind === "item" && event.itemId === id && event.phase === phase,
    );
  assert.deepEqual(item("toolu_ok", "started"), {
    kind: "item",
    phase: "started",
    threadId,
    turnId,
    itemId: "toolu_ok",
    itemType: "commandExecution",
    status: "inProgress",
    command,
  });
  assert.deepEqual(item("toolu_ok", "completed"), {
    kind: "item",
    phase: "completed",
    threadId,
    turnId,
    itemId: "toolu_ok",
    itemType: "commandExecution",
    status: "completed",
    command,
    exitCode: 0,
    aggregatedOutput: "ok\n",
  });
  const completed = (id: string) =>
    item(id, "completed") as Extract<RuntimeDiagnosticEvent, { kind: "item" }>;
  assert.equal(completed("toolu_err").aggregatedOutput, "o\ne");
  assert.deepEqual(
    [
      completed("toolu_f2").status,
      completed("toolu_f2").exitCode,
      completed("toolu_f2").aggregatedOutput,
    ],
    ["failed", 2, "boom"],
  );
  assert.equal(completed("toolu_f_plain").exitCode, null);
  assert.equal(completed("toolu_f_plain").aggregatedOutput, "no prefix");
  assert.equal(completed("toolu_f_int").exitCode, null);
  assert.deepEqual(
    [completed("toolu_interp").status, completed("toolu_interp").exitCode],
    ["completed", null],
  );
  assert.equal(completed("toolu_bg").exitCode, null);
  assert.equal(completed("toolu_bad").exitCode, null);
  assert.equal("aggregatedOutput" in completed("toolu_bad"), false);
});

test("oversized Claude commands and output are replaced whole, as for Codex", {
  skip: slashTmpDenied(),
}, async () => {
  const command = "x".repeat(5 * 1024);
  const run = await diagnosticTurn(async (session) => {
    await session.hook("Bash", { command }, "toolu_big");
    await session.postHook("Bash", { command }, "toolu_big", {
      response: {
        stdout: "y".repeat(49 * 1024),
        stderr: "",
        interrupted: false,
      },
    });
  });
  const [started, completed] = run.diagnostics as Array<
    Extract<RuntimeDiagnosticEvent, { kind: "item" }>
  >;
  assert.deepEqual(started?.command, { omitted: "size-limit", bytes: 5120 });
  assert.deepEqual(completed?.aggregatedOutput, {
    omitted: "size-limit",
    bytes: 49 * 1024,
  });
});

test("file changes and allowlisted tools record a relative path or target, never content or input", {
  skip: slashTmpDenied(),
}, async () => {
  const script = async (session: Parameters<Script>[0]) => {
    const path = join(String(session.options.cwd), "secret-name.txt");
    await session.hook("Write", { file_path: path, content: "BODY" }, "w1");
    await session.postHook(
      "Write",
      { file_path: path, content: "BODY" },
      "w1",
      {
        response: { filePath: path, content: "BODY" },
      },
    );
    await session.hook("Read", { file_path: path }, "r1");
    await session.postHook("Read", { file_path: path }, "r1", {
      response: { file: { content: "BODY" } },
    });
    await session.hook("Grep", { pattern: "needle", path }, "g1");
    await session.hook("Glob", { pattern: "**/*.ts" }, "g2");
    await session.hook(
      "Agent",
      { subagent_type: "explore", prompt: "P" },
      "a1",
    );
    await session.hook("mcp__kb__search", { q: "Q" }, "m1");
    await session.hook("Skill", { skill: "s" }, "s1");
    await session.hook("mcp__cab__cab_report_result", {}, "c1");
  };
  for (const access of [undefined, "read-only"] as const) {
    const run = await diagnosticTurn(script, "collect", access);
    const items = run.diagnostics.flatMap((event) =>
      event.kind === "item" ? [event] : [],
    );
    if (access === "read-only") {
      // The Write is declined here, so it records more rows; each still has the relative path.
      const writes = items.filter((e) => e.itemType === "fileChange");
      assert.ok(writes.length > 0);
      for (const event of writes)
        assert.deepEqual(event.paths, ["secret-name.txt"]);
    } else
      assert.deepEqual(
        items.map((event) => [
          event.itemType,
          event.phase,
          event.tool,
          event.target,
          event.paths,
        ]),
        [
          [
            "fileChange",
            "started",
            undefined,
            "secret-name.txt",
            ["secret-name.txt"],
          ],
          [
            "fileChange",
            "completed",
            undefined,
            "secret-name.txt",
            ["secret-name.txt"],
          ],
          ["toolCall", "started", "Read", "secret-name.txt", undefined],
          ["toolCall", "completed", "Read", "secret-name.txt", undefined],
          ["toolCall", "started", "Grep", "needle", undefined],
          ["toolCall", "started", "Glob", "**/*.ts", undefined],
          ["toolCall", "started", "Agent", "explore", undefined],
          ["toolCall", "started", "mcp__kb__search", "kb/search", undefined],
          ["toolCall", "started", "Skill", undefined, undefined],
        ],
      );
    const text = JSON.stringify(run.diagnostics);
    assert.equal(/BODY|file_path|cwd|"P"/.test(text), false);
    assert.equal(text.includes(String(tmpdir())), false);
  }
});

test("cab tools emit nothing and refused calls are recorded as declined", {
  skip: slashTmpDenied(),
}, async () => {
  const run = await diagnosticTurn(async (session) => {
    await session.hook("mcp__cab__cab_report_result", {}, "c1");
    await session.postHook("mcp__cab__cab_report_result", {}, "c1", {
      response: {},
    });
    await session.hook("Write", { file_path: "/etc/x", content: "x" }, "w1");
    await session.hook(
      "Bash",
      { command: "ls", dangerouslyDisableSandbox: true },
      "b1",
    );
  });
  assert.deepEqual(
    run.diagnostics.map((event) =>
      event.kind === "item"
        ? [event.itemId, event.itemType, event.phase, event.status]
        : event,
    ),
    [
      ["w1", "fileChange", "started", "inProgress"],
      ["w1", "fileChange", "completed", "declined"],
      ["b1", "commandExecution", "started", "inProgress"],
      ["b1", "commandExecution", "completed", "declined"],
    ],
  );
  const write = run.diagnostics.find(
    (event) => event.kind === "item" && event.itemId === "w1",
  );
  assert.deepEqual(write?.kind === "item" && write.paths, [
    "outside workspace",
  ]);
  assert.equal(JSON.stringify(run.diagnostics).includes("/etc/x"), false);
});

test("a failing diagnostic listener changes no hook result or turn outcome", {
  skip: slashTmpDenied(),
}, async () => {
  const script = async (session: Parameters<Script>[0]) => {
    const cwd = String(session.options.cwd);
    const results: unknown[] = [];
    for (const [name, input] of [
      ["Bash", { command: "ls" }],
      ["Write", { file_path: "/etc/x" }],
      ["Bash", { command: "ls", dangerouslyDisableSandbox: true }],
      ["Write", { file_path: join(cwd, "ok.txt"), content: "x" }],
    ] as const) {
      results.push(await session.hook(name, input, `t_${results.length}`));
      results.push(
        await session.postHook(name, input, `t_${results.length}`, {
          response: { stdout: "", stderr: "", interrupted: false },
        }),
      );
      results.push(
        await session.postHook(name, input, `t_${results.length}`, {
          error: "Exit code 1\nx",
        }),
      );
    }
    return results;
  };
  const seen: Record<string, unknown[]> = {};
  for (const mode of ["none", "throw"] as const) {
    const outcome = await diagnosticTurn(async (session) => {
      seen[mode] = (await script(session)) as unknown[];
    }, mode);
    assert.equal(outcome.outcome, "completed");
  }
  assert.deepEqual(seen.throw, seen.none);
  assert.ok(
    (seen.none ?? []).some((entry) => JSON.stringify(entry).includes("deny")),
  );
});

/** The probe plugin: a skill, plus a hook and an MCP server that must never run. */
async function pluginFixture(root: string) {
  const { writePluginFixture } = (await import(
    pathToFileURL(
      join(
        process.cwd(),
        "test/execution/skill-plugin-qualification/fixture.mjs",
      ),
    ).href
  )) as {
    writePluginFixture: (
      root: string,
      options: { dir?: string; nonce: string },
    ) => { dir: string };
  };
  return writePluginFixture(root, { nonce: "unit" });
}

test("native extensions keep built-in tool controls for lead and subagents", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  let outside = "";
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        const workspace = String(session.options.cwd);
        const subagent = { id: "agent-1", type: "general-purpose" };
        const calls: Array<[string, unknown]> = [
          ["Skill", { skill: "probe-skill" }],
          ["Agent", { description: "d", prompt: "p" }],
          ["Write", { file_path: join(outside, "x.txt"), content: "x" }],
          ["Bash", { command: "ls", dangerouslyDisableSandbox: true }],
          ["Write", { file_path: join(workspace, "ok.txt"), content: "x" }],
          ["Task", { description: "d" }],
          ["WebFetch", { url: "https://example.com" }],
          ["Agent", { description: "d", prompt: "p", isolation: "worktree" }],
          ["Agent", { description: "d", prompt: "p", model: "opus" }],
        ];
        for (const [index, [name, input]] of calls.entries()) {
          decisions.push(await session.hook(name, input, `main_${index}`));
          decisions.push(
            await session.hook(name, input, `sub_${index}`, subagent),
          );
        }
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    outside = join(f.root, "outside");
    mkdirSync(outside);
    const plugin = await pluginFixture(f.root);
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId, undefined, {
      plugins: [{ path: plugin.dir, skills: ["probe-skill"] }],
    });
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    const options = f.sessions[0]?.options;
    assert.equal(options?.plugins, undefined);
    assert.equal(options?.skills, undefined);
    assert.ok(Array.isArray(options?.tools) && options.tools.includes("Skill"));
    assert.equal(options?.managedSettings, undefined);
    assert.equal(options?.strictMcpConfig, undefined);
    assert.equal(options?.settingSources, undefined);
    assert.deepEqual(Object.keys(options?.mcpServers ?? {}), ["cab"]);
    assert.deepEqual(Object.keys(options?.hooks ?? {}).sort(), [
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
    ]);
    const verdict = (index: number) =>
      (
        decisions[index] as {
          hookSpecificOutput?: { permissionDecision: string };
        }
      ).hookSpecificOutput?.permissionDecision;
    // Each call is decided identically for the main agent (even) and a subagent (odd).
    const expected = [
      undefined,
      undefined,
      "deny",
      "deny",
      undefined,
      "deny",
      "deny",
      "deny",
      "deny",
    ];
    for (const [call, want] of expected.entries()) {
      assert.equal(verdict(call * 2), want, `main ${call}`);
      assert.equal(verdict(call * 2 + 1), want, `subagent ${call}`);
    }
  } finally {
    await f.cleanup();
  }
});

test("legacy profile selections do not override native skill discovery", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId, undefined, {
      plugins: [
        { path: "/plugins/a", skills: ["review"], name: "plugin-a" },
        { path: "/plugins/b", skills: ["test"], name: "plugin-b" },
      ],
    });
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.equal(f.sessions[0]?.options.skills, undefined);
  } finally {
    await f.cleanup();
  }
});

test("native skills are admitted without a cab selection", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        decisions.push(await session.hook("Skill", { skill: "x" }, "t1"));
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.equal(
      (
        decisions[0] as {
          hookSpecificOutput?: { permissionDecision: string };
        }
      ).hookSpecificOutput?.permissionDecision,
      undefined,
    );
    assert.deepEqual(f.sessions[0]?.options.tools, [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "Agent",
      "TodoWrite",
      "Skill",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a subagent's tool calls are recorded with their attribution, and a denied call as declined", {
  skip: slashTmpDenied(),
}, async () => {
  const run = await diagnosticTurn(async (session) => {
    const subagent = { id: "agent-7", type: "general-purpose" };
    await session.hook("Agent", { description: "d", prompt: "p" }, "a1");
    await session.hook("Bash", { command: "ls" }, "b1", subagent);
    await session.postHook(
      "Bash",
      { command: "ls" },
      "b1",
      { response: { stdout: "x", stderr: "", interrupted: false } },
      subagent,
    );
    await session.hook("Write", { file_path: "/etc/x", content: "x" }, "w1", {
      id: "agent-7",
    });
  });
  const items = run.diagnostics.filter(
    (event): event is Extract<RuntimeDiagnosticEvent, { kind: "item" }> =>
      event.kind === "item",
  );
  assert.deepEqual(
    items.map((e) => [e.itemId, e.phase, e.status, e.subagent]),
    [
      ["a1", "started", "inProgress", undefined],
      [
        "b1",
        "started",
        "inProgress",
        { id: "agent-7", type: "general-purpose" },
      ],
      [
        "b1",
        "completed",
        "completed",
        { id: "agent-7", type: "general-purpose" },
      ],
      ["w1", "started", "inProgress", { id: "agent-7" }],
      ["w1", "completed", "declined", { id: "agent-7" }],
    ],
  );
});

test("the TodoWrite gates override the service environment", () => {
  const env = claudeTurnEnvironment(
    { CLAUDE_CODE_ENABLE_TASKS: "1", CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" },
    "/tmp/base",
  );
  assert.equal(env.CLAUDE_CODE_ENABLE_TASKS, "0");
  assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
});

test("the lead's TodoWrite calls feed plan events and never tool rows", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  const todos = (...statuses: string[]) => ({
    todos: statuses.map((status, index) => ({
      content: `Step ${index + 1}`,
      status,
      activeForm: "ACTIVE_FORM_CANARY",
    })),
  });
  const f = fixture({
    diagnostic: "collect",
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        const calls: [unknown, string, { id: string }?][] = [
          [todos("in_progress", "pending"), "t1"],
          [todos("completed", "in_progress"), "t2"],
          [todos("completed", "completed"), "t3", { id: "agent-7" }],
          [todos("done"), "t4"],
        ];
        for (const [input, id, agent] of calls) {
          decisions.push(await session.hook("TodoWrite", input, id, agent));
          decisions.push(
            await session.postHook(
              "TodoWrite",
              input,
              id,
              { response: {} },
              agent,
            ),
          );
        }
        yield result(sessionOf(session));
      },
    ],
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.deepEqual(decisions, Array(8).fill({}));
    assert.deepEqual(
      f.emitted.filter((event) => (event as { kind: string }).kind === "plan"),
      [
        {
          threadId,
          turnId,
          kind: "plan",
          plan: {
            steps: [
              { text: "Step 1", status: "in-progress" },
              { text: "Step 2", status: "pending" },
            ],
            omittedStepCount: 0,
            done: 0,
            total: 2,
          },
        },
        {
          threadId,
          turnId,
          kind: "plan",
          plan: {
            steps: [
              { text: "Step 1", status: "done" },
              { text: "Step 2", status: "in-progress" },
            ],
            omittedStepCount: 0,
            done: 1,
            total: 2,
          },
        },
      ],
    );
    assert.equal(
      f.diagnostics.filter(
        (event) => (event as { kind: string }).kind === "item",
      ).length,
      0,
    );
    assert.doesNotMatch(JSON.stringify(f.emitted), /ACTIVE_FORM_CANARY/);
  } finally {
    await f.cleanup();
  }
});

test("settings probe cleanup awaits its existing SIGKILL fallback", {
  skip: slashTmpDenied(),
  timeout: 10000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-claude-probe-exit-"));
  const safety = runtimeSafetyFixture();
  const { sdk } = fakeSdk([], []);
  let probe: import("node:child_process").ChildProcess | undefined;
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let exited = false;
  sdk.query = ({ options }) =>
    Object.assign(
      (async function* () {
        probe = options.spawnClaudeCodeProcess?.({
          command: process.execPath,
          args: [
            "-e",
            'process.on("SIGTERM",()=>{});setInterval(()=>{},60000);process.stdout.write("ready")',
          ],
          env: {},
          signal: new AbortController().signal,
        }) as unknown as import("node:child_process").ChildProcess;
        probe.stdout?.once("data", () => ready());
        probe.once("exit", () => {
          exited = true;
        });
        await new Promise<void>((resolve) =>
          options.abortController?.signal.addEventListener(
            "abort",
            () => resolve(),
            { once: true },
          ),
        );
      })(),
      {
        supportedModels: () => new Promise<never>(() => {}),
        mcpServerStatus: async () => [
          { name: "cab", status: "connected", source: "sdk" },
        ],
        accountInfo: async () => ({
          apiProvider: "firstParty",
          subscriptionType: "max",
          apiKeySource: "none",
        }),
      },
    );
  const runtime = new ClaudeRuntime({
    safety: safety.safety,
    sdk,
    claude: {
      turnEnvironment: () => ({ env: {} }),
    },
    resolveExecutable: async () => process.execPath,
    sandboxSelfTest: async () => true,
    exitTimeoutMs: 10,
  });
  try {
    await runtime.start();
    for (let attempt = 0; attempt < 100 && !probe; attempt++) {
      await runtime.preflightTurn({ workspace: root });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await reached;
    await runtime.stop();
    assert.equal(exited, true);
    assert.equal(probe?.signalCode, "SIGKILL");
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const sources of [[], ["project"], ["sdk", "project"], ["sdk", "sdk"]])
  test(`ambiguous or missing cab MCP provenance refuses the prompt: ${sources.join(",")}`, {
    skip: slashTmpDenied(),
  }, async () => {
    const f = fixture({
      mcpSources: sources,
      scripts: [
        async function* (session) {
          yield init(sessionOf(session));
          yield result(sessionOf(session));
        },
      ],
    });
    try {
      await f.runtime.start();
      const id = await f.runtime.startThread(f.workspace, []);
      await assert.rejects(f.turn(id), /Claude turn could not start/);
      assert.ok(!f.log.includes("prompt"));
    } finally {
      await f.cleanup();
    }
  });

test("Claude refuses legacy and unknown configuration origins before a resume query", async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    await assert.rejects(
      f.runtime.resumeThread("personal-session", []),
      /previous harness setup/,
    );
    const id = await f.runtime.startThread(f.workspace, []);
    f.setOrigin("cab");
    await assert.rejects(
      f.runtime.resumeThread(id, []),
      /previous harness setup/,
    );
    assert.equal(f.sessions.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("API-backed Claude metadata cannot release a model prompt", async () => {
  const f = fixture({ apiProvider: "bedrock" });
  try {
    await f.runtime.start();
    assert.equal(await f.runtime.verifyNativeLogin(), false);
    assert.deepEqual(f.queries, ["settings"]);
    assert.equal(f.sessions.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("native subscription metadata may omit the optional API-key source and refuses known API billing sources", async () => {
  for (const [apiKeySource, expected] of [
    [null, true],
    ["oauth", true],
    ["ANTHROPIC_API_KEY", false],
    ["apiKeyHelper", false],
  ] as const) {
    const f = fixture({ apiKeySource });
    try {
      await f.runtime.start();
      assert.equal(await f.runtime.verifyNativeLogin(), expected);
      assert.equal(f.sessions.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

type Decision = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
const decisionOf = (value: unknown) =>
  (value as Decision).hookSpecificOutput?.permissionDecision ?? "pass";
const reasonOf = (value: unknown) =>
  (value as Decision).hookSpecificOutput?.permissionDecisionReason;
const flagged = (command: string, description?: string) => ({
  command,
  dangerouslyDisableSandbox: true,
  ...(description ? { description } : {}),
});
/** Waits for a condition the runtime reaches asynchronously. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition not reached");
}

test("an escalate-approval task turn runs in auto mode with Bash held by the hook; other turns keep their options", {
  skip: slashTmpDenied(),
}, async () => {
  const script: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    yield result(sessionOf(session));
  };
  const f = fixture({ scripts: [script, script, script, script] });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const run = async (
      access?: "read-only",
      skip?: boolean,
      escalate?: "approval",
    ) => {
      const turnId = await f.turn(
        threadId,
        access,
        undefined,
        undefined,
        undefined,
        skip,
        escalate,
      );
      assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    };
    await run();
    await run(undefined, undefined, "approval");
    await run("read-only", undefined, "approval");
    await run(undefined, true);
    const [strict, escalated, readOnly, unsandboxed] = f.sessions.map(
      (s) => s.options,
    );
    assert.ok(strict && escalated && readOnly && unsandboxed);
    assert.equal(escalated.permissionMode, "auto");
    assert.deepEqual(
      escalated.allowedTools,
      strict.allowedTools?.filter((name) => name !== "Bash"),
    );
    assert.ok(strict.allowedTools?.includes("Bash"));
    assert.deepEqual(escalated.tools, strict.tools);
    assert.equal(escalated.sandbox?.allowUnsandboxedCommands, true);
    assert.equal(escalated.sandbox?.autoAllowBashIfSandboxed, true);
    const { hooks: _hooks, ...matcher } =
      escalated.hooks?.PreToolUse?.[0] ?? {};
    assert.deepEqual(matcher, { timeout: 960, onFailure: "block" });
    assert.equal(escalated.env?.BASH_MAX_TIMEOUT_MS, "3600000");
    // A read-only turn ignores the escalation and keeps today's exact options.
    for (const options of [strict, readOnly]) {
      assert.equal(options.permissionMode, "dontAsk");
      assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
      assert.deepEqual(Object.keys(options.hooks?.PreToolUse?.[0] ?? {}), [
        "hooks",
      ]);
      assert.equal(options.env?.BASH_MAX_TIMEOUT_MS, undefined);
    }
    assert.deepEqual(readOnly.allowedTools, strict.allowedTools);
    // An unsandboxed turn gains only the request ceiling.
    assert.equal(unsandboxed.permissionMode, "dontAsk");
    assert.deepEqual(unsandboxed.allowedTools, strict.allowedTools);
    assert.equal(unsandboxed.env?.BASH_MAX_TIMEOUT_MS, "3600000");
  } finally {
    await f.cleanup();
  }
});

test("a held escalation is answered once: accept allows the call and records its exit code, decline refuses it", {
  skip: slashTmpDenied(),
}, async () => {
  const events: SandboxEscalationEvent[] = [];
  const decisions: unknown[] = [];
  let f!: ReturnType<typeof fixture>;
  const requested = (n: number) =>
    events.filter((e) => e.kind === "requested").length >= n;
  const script: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    const accepted = session.hook(
      "Bash",
      flagged("node chromium.mjs", "needs host Chromium"),
      "toolu_accept",
    );
    await until(() => requested(1));
    const [first] = events;
    assert.ok(first?.kind === "requested");
    assert.equal(
      await f.runtime.replySandboxEscalation(first.identity, "accept"),
      true,
    );
    // A second answer, or one for another generation, is never written.
    assert.equal(
      await f.runtime.replySandboxEscalation(first.identity, "decline"),
      false,
    );
    decisions.push(await accepted);
    await session.postHook(
      "Bash",
      flagged("node chromium.mjs"),
      "toolu_accept",
      {
        response: { stdout: "ok", stderr: "", interrupted: false },
      },
    );
    const declined = session.hook("Bash", flagged("echo hi"), "toolu_decline");
    await until(() => requested(2));
    const second = events.findLast((e) => e.kind === "requested");
    assert.ok(second?.kind === "requested");
    assert.equal(
      await f.runtime.replySandboxEscalation(
        { ...second.identity, runtimeGeneration: "another" },
        "accept",
      ),
      false,
    );
    assert.equal(
      await f.runtime.replySandboxEscalation(second.identity, "decline"),
      true,
    );
    decisions.push(await declined);
    yield result(sessionOf(session));
  };
  f = fixture({ scripts: [script] });
  f.runtime.onSandboxEscalation((event) => {
    events.push(event);
    return true;
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(
      threadId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "approval",
    );
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    const generation = f.runtime.currentUserInputGeneration();
    const identity = (id: string) => ({
      requestId: id,
      runtimeGeneration: generation,
      threadId,
      turnId,
      itemId: id,
    });
    assert.deepEqual(events, [
      {
        kind: "requested",
        identity: identity("toolu_accept"),
        command: "node chromium.mjs",
        cwd: f.workspace,
        reason: "needs host Chromium",
      },
      {
        kind: "completed",
        identity: identity("toolu_accept"),
        exitCode: 0,
        durationMs: null,
      },
      {
        kind: "requested",
        identity: identity("toolu_decline"),
        command: "echo hi",
        cwd: f.workspace,
        reason: null,
      },
      {
        kind: "completed",
        identity: identity("toolu_decline"),
        exitCode: null,
        durationMs: null,
      },
    ]);
    assert.deepEqual(decisions.map(decisionOf), ["allow", "deny"]);
    assert.match(String(reasonOf(decisions[1])), /declined/);
    assert.deepEqual(f.unexpected, []);
  } finally {
    await f.cleanup();
  }
});

test("a flagged call is refused without an owner, before auto mode is confirmed, on a strict turn and when its turn stops", {
  skip: slashTmpDenied(),
}, async () => {
  const events: SandboxEscalationEvent[] = [];
  let owned = false;
  const decisions: unknown[] = [];
  let held: Promise<unknown> | undefined;
  const refusing: Script = async function* (session) {
    // Before init confirms auto, nothing is sent to the operator.
    decisions.push(
      await session.hook("Bash", flagged("echo early"), "toolu_early"),
    );
    yield init(sessionOf(session), "auto");
    // A listener that does not take the request leaves it refused.
    decisions.push(
      await session.hook("Bash", flagged("echo unowned"), "toolu_unowned"),
    );
    yield result(sessionOf(session));
  };
  const strict: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    decisions.push(
      await session.hook("Bash", flagged("echo strict"), "toolu_strict"),
    );
    // The CLI reads the string "true" as the flag too, so the hook refuses it.
    decisions.push(
      await session.hook(
        "Bash",
        { command: "echo string", dangerouslyDisableSandbox: "true" },
        "toolu_string",
      ),
    );
    yield result(sessionOf(session));
  };
  const stopped: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    held = session.hook("Bash", flagged("echo held"), "toolu_held");
    await new Promise(() => {});
  };
  const f = fixture({ scripts: [refusing, strict, stopped] });
  f.runtime.onSandboxEscalation((event) => {
    events.push(event);
    return owned;
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const escalate = (id: string) =>
      f.turn(
        id,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "approval",
      );
    const first = await escalate(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, first), "completed");
    const second = await f.turn(threadId);
    assert.equal(await f.runtime.waitForTurn(threadId, second), "completed");
    assert.deepEqual(decisions.map(decisionOf), [
      "deny",
      "deny",
      "deny",
      "deny",
    ]);
    assert.equal(
      reasonOf(decisions[3]),
      "Commands never run outside the sandbox",
    );
    assert.match(String(reasonOf(decisions[0])), /not confirmed auto/);
    assert.equal(
      reasonOf(decisions[2]),
      "Commands never run outside the sandbox",
    );
    // Only the unowned request reached the listener.
    assert.deepEqual(
      events.map((e) => e.kind === "requested" && e.command),
      ["echo unowned"],
    );
    owned = true;
    const third = await escalate(threadId);
    await until(() => held !== undefined && events.length === 2);
    await f.runtime.interruptTurn(threadId, third);
    assert.equal(decisionOf(await held), "deny");
    assert.equal(await f.runtime.waitForTurn(threadId, third), "failed");
    const ended = events.at(-1);
    // Nothing held can be answered after its turn stopped.
    assert.ok(ended?.kind === "ended");
    assert.equal(ended.reason, "Turn stopped");
    assert.equal(
      await f.runtime.replySandboxEscalation(ended.identity, "accept"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("an escalate turn whose start reports another permission mode fails with a named reason", {
  skip: slashTmpDenied(),
}, async () => {
  const script: Script = async function* (session) {
    yield init(sessionOf(session), "default");
    yield result(sessionOf(session));
  };
  const f = fixture({ scripts: [script] });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(
      threadId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "approval",
    );
    await assert.rejects(f.runtime.waitForTurn(threadId, turnId));
    assert.deepEqual(
      f.anomalies.map((a) => a.reason),
      ["Claude Code reported permission mode default, not auto"],
    );
  } finally {
    await f.cleanup();
  }
});

test("a hook cancelled while held refuses the call and ends the escalation; a failed command reports its exit code", {
  skip: slashTmpDenied(),
}, async () => {
  const events: SandboxEscalationEvent[] = [];
  const decisions: unknown[] = [];
  let f!: ReturnType<typeof fixture>;
  const script: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    const cancel = new AbortController();
    const held = session.hook(
      "Bash",
      flagged("echo cancelled"),
      "toolu_cancel",
      undefined,
      cancel.signal,
    );
    await until(() => events.length === 1);
    cancel.abort();
    decisions.push(await held);
    const failing = session.hook("Bash", flagged("exit 3"), "toolu_fail");
    await until(() => events.length === 3);
    const request = events[2];
    assert.ok(request?.kind === "requested");
    await f.runtime.replySandboxEscalation(request.identity, "accept");
    decisions.push(await failing);
    await session.postHook("Bash", flagged("exit 3"), "toolu_fail", {
      error: "Exit code 3\nboom",
    });
    yield result(sessionOf(session));
  };
  f = fixture({ scripts: [script] });
  f.runtime.onSandboxEscalation((event) => {
    events.push(event);
    return true;
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(
      threadId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "approval",
    );
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.deepEqual(decisions.map(decisionOf), ["deny", "allow"]);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["requested", "ended", "requested", "completed"],
    );
    const completed = events[3];
    assert.ok(completed?.kind === "completed");
    assert.equal(completed.exitCode, 3);
    assert.equal(completed.durationMs, null);
  } finally {
    await f.cleanup();
  }
});

test("preflight and start refuse an escalate-approval turn whose model has no auto mode, by the model's value", {
  skip: slashTmpDenied(),
}, async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    const preflight = (model: string) =>
      settledPreflight(f.runtime, {
        workspace: f.workspace,
        settings: { model, reasoningEffort: null },
        sandboxEscalation: "approval",
      });
    assert.equal(
      await preflight("default"),
      "Claude runtime unavailable: auto mode is not available for model default",
    );
    assert.equal(await preflight("haiku"), undefined);
    // Auto-review needs auto mode too, and is never downgraded.
    assert.equal(
      await settledPreflight(f.runtime, {
        workspace: f.workspace,
        settings: { model: "default", reasoningEffort: null },
        sandboxEscalation: "auto-review",
      }),
      "Claude runtime unavailable: auto mode is not available for model default",
    );
    // Without the hint, auto mode is not needed.
    assert.equal(
      await settledPreflight(f.runtime, {
        workspace: f.workspace,
        settings: { model: "default", reasoningEffort: null },
      }),
      undefined,
    );
    const threadId = await f.runtime.startThread(f.workspace, []);
    await assert.rejects(
      f.runtime.startTurn(
        threadId,
        f.workspace,
        "x",
        { model: "default", reasoningEffort: null },
        {
          networkAccess: false,
          sandboxEscalation: "approval",
        },
      ),
      /auto mode is not available for model default/,
    );
  } finally {
    await f.cleanup();
  }
});

test("canUseTool allows only an accepted escalation's own call, once; the turn's process identity binds only while it runs", {
  skip: slashTmpDenied(),
}, async () => {
  const events: SandboxEscalationEvent[] = [];
  const asked: unknown[] = [];
  let identityDuring: unknown;
  let f!: ReturnType<typeof fixture>;
  let threadId = "";
  const script: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    const held = session.hook("Bash", flagged("node chromium.mjs"), "toolu_ok");
    await until(() => events.length === 1);
    const request = events[0];
    assert.ok(request?.kind === "requested");
    identityDuring = f.runtime.turnProcessIdentity(
      threadId,
      request.identity.turnId,
    );
    await f.runtime.replySandboxEscalation(request.identity, "accept");
    await held;
    const input = flagged("node chromium.mjs");
    asked.push(await session.canUseTool("Bash", input, "toolu_ok"));
    asked.push(await session.canUseTool("Bash", input, "toolu_ok"));
    asked.push(await session.canUseTool("Bash", input, "toolu_other"));
    yield result(sessionOf(session));
  };
  f = fixture({ scripts: [script] });
  f.runtime.onSandboxEscalation((event) => {
    events.push(event);
    return true;
  });
  try {
    await f.runtime.start();
    threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(
      threadId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "approval",
    );
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    assert.deepEqual(asked, [
      { behavior: "allow", updatedInput: flagged("node chromium.mjs") },
      { behavior: "deny", message: "cab grants no permissions" },
      { behavior: "deny", message: "cab grants no permissions" },
    ]);
    assert.equal(f.unexpected.length, 2);
    assert.deepEqual(
      identityDuring,
      (f.recorded[0] as { processIdentity: unknown }).processIdentity,
    );
    assert.equal(f.runtime.turnProcessIdentity(threadId, turnId), null);
    assert.equal(f.runtime.turnProcessIdentity("other", turnId), null);
  } finally {
    await f.cleanup();
  }
});

test("an escalate-auto-review turn keeps the escalate options and passes only flagged Bash to the classifier", {
  skip: slashTmpDenied(),
}, async () => {
  const decisions: unknown[] = [];
  const script: Script = async function* (session) {
    decisions.push(
      await session.hook("Bash", flagged("echo early"), "toolu_early"),
    );
    yield init(sessionOf(session), "auto");
    decisions.push(
      await session.hook("Bash", flagged("node chromium.mjs"), "toolu_flag"),
    );
    decisions.push(
      await session.hook("WebFetch", { url: "https://x" }, "toolu_web"),
    );
    yield result(sessionOf(session));
  };
  const approval: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    yield result(sessionOf(session));
  };
  const f = fixture({ scripts: [script, approval] });
  const reviews: SandboxReviewEvent[] = [];
  f.runtime.onSandboxReview((event) => reviews.push(event));
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    for (const level of ["auto-review", "approval"] as const) {
      const turnId = await f.turn(
        threadId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        level,
      );
      assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    }
    const [reviewed, approved] = f.sessions.map((s) => s.options);
    for (const key of [
      "permissionMode",
      "allowedTools",
      "sandbox",
      "env",
    ] as const)
      assert.deepEqual(reviewed?.[key], approved?.[key], key);
    assert.deepEqual(
      Object.keys(reviewed?.hooks?.PreToolUse?.[0] ?? {}),
      Object.keys(approved?.hooks?.PreToolUse?.[0] ?? {}),
    );
    // Refused before auto mode is confirmed; then passed through; a tool outside the
    // policy is denied by the hook before any classifier, with no canUseTool.
    assert.deepEqual(decisions.map(decisionOf), ["deny", "pass", "deny"]);
    assert.match(String(reasonOf(decisions[0])), /not confirmed auto/);
    assert.deepEqual(f.unexpected, []);
    // A passed call that never ran records nothing.
    assert.deepEqual(reviews, []);
  } finally {
    await f.cleanup();
  }
});

test("classifier decisions on passed flagged calls are recorded as reviews; an undecided call goes to the operator once", {
  skip: slashTmpDenied(),
}, async () => {
  const reviews: SandboxReviewEvent[] = [];
  const escalations: SandboxEscalationEvent[] = [];
  const asked: unknown[] = [];
  let f!: ReturnType<typeof fixture>;
  const denied = (toolUseId: string, type: string, reason?: string) => ({
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: toolUseId,
    decision_reason_type: type,
    ...(reason ? { decision_reason: reason } : {}),
    message: "denied",
  });
  const script: Script = async function* (session) {
    yield init(sessionOf(session), "auto");
    // Approved: it runs with no permission ask.
    await session.hook("Bash", flagged("node chromium.mjs"), "toolu_ran");
    await session.postHook("Bash", flagged("node chromium.mjs"), "toolu_ran", {
      error: "Exit code 2\nboom",
    });
    // Denied by the classifier, with its reason; other reasons and unknown calls record nothing.
    await session.hook("Bash", flagged("curl x"), "toolu_denied");
    yield denied("toolu_denied", "classifier", "Looks like exfiltration");
    await session.hook("Bash", flagged("echo rule"), "toolu_rule");
    yield denied("toolu_rule", "rule");
    yield denied("toolu_unknown", "classifier");
    // Undecided: the classifier asks, and the operator answers once.
    await session.hook("Bash", flagged("node chromium.mjs ask"), "toolu_ask");
    const pending = session.canUseTool(
      "Bash",
      flagged("node chromium.mjs ask"),
      "toolu_ask",
    );
    await until(() => escalations.length === 1);
    const request = escalations[0];
    assert.ok(request?.kind === "requested");
    assert.equal(
      await f.runtime.replySandboxEscalation(request.identity, "accept"),
      true,
    );
    asked.push(await pending);
    await session.postHook(
      "Bash",
      flagged("node chromium.mjs ask"),
      "toolu_ask",
      { response: { stdout: "", stderr: "", interrupted: false } },
    );
    // Anything else the classifier asks about is still unexpected.
    asked.push(await session.canUseTool("Bash", flagged("ls"), "toolu_other"));
    yield result(sessionOf(session));
  };
  f = fixture({ scripts: [script] });
  f.runtime.onSandboxReview((event) => reviews.push(event));
  f.runtime.onSandboxEscalation((event) => {
    escalations.push(event);
    return true;
  });
  try {
    await f.runtime.start();
    const threadId = await f.runtime.startThread(f.workspace, []);
    const turnId = await f.turn(
      threadId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "auto-review",
    );
    assert.equal(await f.runtime.waitForTurn(threadId, turnId), "completed");
    const generation = f.runtime.currentUserInputGeneration();
    const target = (id: string) => ({
      runtimeGeneration: generation,
      threadId,
      turnId,
      targetItemId: id,
    });
    const review = (id: string, command: string) => ({
      kind: "review",
      identity: { ...target(id), reviewId: id },
      command,
      cwd: f.workspace,
      riskLevel: null,
      overrulable: false,
    });
    assert.deepEqual(reviews, [
      {
        ...review("toolu_ran", "node chromium.mjs"),
        status: "approved",
        rationale: null,
      },
      {
        kind: "itemCompleted",
        target: target("toolu_ran"),
        exitCode: 2,
        durationMs: null,
      },
      {
        ...review("toolu_denied", "curl x"),
        status: "denied",
        rationale: "Looks like exfiltration",
      },
    ]);
    // The undecided call is an operator escalation, not a review.
    assert.deepEqual(
      escalations.map((e) => e.kind),
      ["requested", "completed"],
    );
    assert.deepEqual(asked, [
      { behavior: "allow", updatedInput: flagged("node chromium.mjs ask") },
      { behavior: "deny", message: "cab grants no permissions" },
    ]);
    assert.equal(f.unexpected.length, 1);
  } finally {
    await f.cleanup();
  }
});
