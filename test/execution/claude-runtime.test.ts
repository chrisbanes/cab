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
import { dirname, join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeRuntime,
  claudeSdkVersion,
  claudeTemporaryBase,
  claudeToolShape,
  releaseClaudeTemporaryBase,
} from "../../src/standalone/claude.js";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";
import {
  type RuntimeConversationEvent,
  RuntimeNotEnabledError,
  type RuntimeToolCall,
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
    resolveExecutable?: () => Promise<string | null>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-claude-runtime-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const safetyFixture = runtimeSafetyFixture();
  const log: string[] = [];
  const recorded: unknown[] = [];
  const { sdk, sessions, queries, optionsSeen } = fakeSdk(
    options.scripts ?? [],
    log,
    {
      hangModels: options.hangModels ?? false,
    },
  );
  const runtime = new ClaudeRuntime({
    safety: {
      ...safetyFixture.safety,
      recordTurnProcess: (input) => {
        recorded.push(input);
        log.push("record");
        return options.record ? options.record() : true;
      },
    },
    claude: {
      configDirectory: join(root, "data", "claude", "config"),
      turnEnvironment:
        options.environment ??
        (() => ({
          env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "api-key-canary" },
          token: TOKEN,
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
  const turn = async (threadId: string, access?: "read-only") => {
    assert.equal(
      await settledPreflight(runtime, { workspace, settings }),
      undefined,
    );
    const turnId = await runtime.startTurn(
      threadId,
      workspace,
      "Do the work",
      settings,
      access ? { networkAccess: false, access } : undefined,
    );
    const generation = runtime.currentUserInputGeneration();
    assert.ok(generation);
    safetyFixture.bindTurn(threadId, turnId, generation);
    return turnId;
  };
  return {
    root,
    workspace,
    runtime,
    sessions,
    log,
    recorded,
    emitted,
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
    const server = sdk.createSdkMcpServer({ name: "ensemble", tools });
    assert.equal(server.name, "ensemble");
    const reported = coordinationTools.find(
      (tool) => tool.name === "ensemble_report_result",
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

test("a Claude turn runs one isolated query, releases its prompt only after the process is recorded, then resumes the session", async () => {
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
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.model, "haiku");
    assert.equal(options.effort, "low");
    assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.equal(options.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
    assert.equal(
      options.env?.CLAUDE_CONFIG_DIR,
      join(f.root, "data", "claude", "config"),
    );
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
    ]);
    assert.deepEqual(options.allowedTools, [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "mcp__ensemble__*",
    ]);
    assert.deepEqual(options.disallowedTools, [
      "AskUserQuestion",
      "WebFetch",
      "WebSearch",
      "Agent",
      "Task",
      "EnterPlanMode",
      "ExitPlanMode",
    ]);
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

test("the settings read and every turn run the PATH-resolved claude, resolved once per start", async () => {
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

test("each Claude result error maps to visible failure evidence", async () => {
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

test("interrupting a Claude turn aborts its query and ends it as interrupted", async () => {
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

test("losing the Claude process mid-tool reports an anomaly and never a terminal", async () => {
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

test("a malformed SDK message aborts the query and reports an anomaly", async () => {
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

test("an unverified Claude process exit reports an anomaly", async () => {
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

test("a Claude turn whose process cannot be recorded never receives its prompt", async () => {
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

test("coordination calls carry the hook's tool-use ID and uncorrelated calls are refused", async () => {
  const outcomes: unknown[] = [];
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        const args = { question: "Which?" };
        await session.hook(
          "mcp__ensemble__ensemble_ask_question",
          args,
          "toolu_9",
        );
        outcomes.push(await session.callTool("ensemble_ask_question", args));
        outcomes.push(
          await session.callTool("ensemble_ask_question", {
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
        name: "ensemble_ask_question",
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
        tool: "ensemble_ask_question",
        arguments: { question: "Which?" },
      },
    ]);
    assert.deepEqual(outcomes[0], {
      content: [{ type: "text", text: "ok:ensemble_ask_question" }],
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

test("the Claude token never appears in anything the runtime emits", async () => {
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

test("the PreToolUse hook records every call and denies calls outside policy", async () => {
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
    for (const index of [1, 2, 3, 4, 5, 6, 8]) {
      assert.equal(denied(index)?.permissionDecision, "deny");
      assert.ok(denied(index)?.permissionDecisionReason);
    }
    assert.deepEqual(
      f.runtime.toolLedger(threadId, turnId).map((entry) => entry.decision),
      [
        "allow",
        "deny",
        "deny",
        "deny",
        "deny",
        "deny",
        "deny",
        "allow",
        "deny",
      ],
    );
    assert.equal(
      f.runtime.toolLedger(threadId, turnId)[5]?.toolName,
      "WebFetch",
    );
  } finally {
    await f.cleanup();
  }
});

test("a read-only turn can write only the temporary base, in the sandbox and the hook", async () => {
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

test("preflight waits for a failed sandbox self-test, unsupported settings or a missing token before any query", async () => {
  let selfTest = false;
  let environment: ClaudeTurnEnvironment = { env: {}, token: TOKEN };
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

test("preflight refuses a sandbox temporary base that is not private", async () => {
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
      configDirectory: "/unused",
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
    /F6\.3/,
    /F6\.4/,
    /scrub/,
    /version the pinned SDK declares/,
  ])
    assert.match(limits, pattern);
});

test("a planted symlink in the sandbox temporary base is removed before the turn", async () => {
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

test("coordination arguments parsed by the advertised schema keep their hook correlation, and extra keys fail closed", async () => {
  const outcomes: Array<{ isError: boolean }> = [];
  const resultId = "70000000-0000-4000-8000-000000000001";
  const inputs: Array<[string, Record<string, unknown>]> = [
    ["ensemble_report_result", { summary: "Done" }],
    ["ensemble_request_completion", { reviewedResultIds: [resultId] }],
    ["ensemble_ask_question", { question: "Which?" }],
    ["ensemble_request_follow_up", { resultId, instructions: "Again" }],
  ];
  const f = fixture({
    scripts: [
      async function* (session) {
        yield init(sessionOf(session));
        for (const [index, [name, args]] of inputs.entries()) {
          await session.hook(
            `mcp__ensemble__${name}`,
            args,
            `toolu_ok_${index}`,
          );
          outcomes.push(
            (await session.callTool(name, args)) as { isError: boolean },
          );
        }
        const extra = { question: "Which?", unexpected: true };
        await session.hook(
          "mcp__ensemble__ensemble_ask_question",
          extra,
          "toolu_extra",
        );
        outcomes.push(
          (await session.callTool("ensemble_ask_question", extra)) as {
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

test("stopping the runtime ends a settings read that is still waiting", async () => {
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
