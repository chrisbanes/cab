import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
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
import type {
  HookCallback,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeSdk,
  ClaudeRuntime,
  claudeSdkVersion,
  claudeToolShape,
} from "../src/standalone/claude.js";
import { coordinationTools } from "../src/standalone/coordination-tools.js";
import type {
  RuntimeConversationEvent,
  RuntimeToolCall,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import type { ClaudeTurnEnvironment } from "../src/standalone/service.js";
import {
  closeRuntimeSafetyFixtures,
  runtimeSafetyFixture,
} from "./fixtures/runtime-safety.js";
import { tmpdir } from "./temp.js";

test.after(closeRuntimeSafetyFixtures);

const TOKEN = "claude-runtime-token-canary-3319";

interface FakeTool {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

/** What a scripted fake query can do; mirrors the C0-observed SDK behaviour. */
interface Session {
  options: Options;
  child: ChildProcess;
  prompt: SDKUserMessage | undefined;
  hook(
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<unknown>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  waitForExit(): Promise<void>;
}

type Script = (session: Session) => AsyncGenerator<unknown>;

function fakeSdk(scripts: Script[], log: string[]) {
  const sessions: Session[] = [];
  const sdk: ClaudeSdk = {
    query: ({ prompt, options }) =>
      (async function* () {
        const script = scripts.shift();
        assert.ok(script, "unexpected query");
        const forwarded = new AbortController();
        const abort = options.abortController;
        const aborted = () =>
          new Promise<void>((resolve) => {
            if (abort?.signal.aborted) resolve();
            abort?.signal.addEventListener("abort", () => resolve());
          });
        void aborted().then(() => forwarded.abort());
        const child = options.spawnClaudeCodeProcess?.({
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
          ],
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: options.env ?? {},
          signal: forwarded.signal,
        }) as unknown as ChildProcess;
        const exit = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          child.once("exit", () => resolve());
        });
        const iterator = prompt[Symbol.asyncIterator]();
        const first = await Promise.race([
          iterator.next(),
          aborted().then(() => "aborted" as const),
        ]);
        if (first === "aborted")
          throw new Error("Claude Code process aborted by user");
        if (first.done) {
          child.stdin?.end();
          await exit;
          return;
        }
        log.push("prompt");
        const tools =
          (
            options.mcpServers?.ensemble as unknown as
              | undefined
              | {
                  instance: { tools: FakeTool[] };
                }
          )?.instance.tools ?? [];
        const session: Session = {
          options,
          child,
          prompt: first.value,
          hook: (toolName, toolInput, toolUseId) => {
            const hook = options.hooks?.PreToolUse?.[0]
              ?.hooks[0] as HookCallback;
            return hook(
              {
                hook_event_name: "PreToolUse",
                tool_name: toolName,
                tool_input: toolInput,
                tool_use_id: toolUseId,
              } as never,
              toolUseId,
              { signal: forwarded.signal },
            );
          },
          callTool: (name, args) => {
            const definition = tools.find((tool) => tool.name === name);
            assert.ok(definition);
            return definition.handler(args, {});
          },
          waitForExit: () => exit,
        };
        sessions.push(session);
        const messages = script(session);
        try {
          for (;;) {
            const next = await Promise.race([
              messages.next(),
              aborted().then(() => "aborted" as const),
            ]);
            if (next === "aborted") {
              await exit;
              throw new Error("Claude Code process aborted by user");
            }
            if (next.done) break;
            yield next.value;
          }
        } finally {
          // Like the CLI, the child exits once its stream is finished.
          child.stdin?.end();
          await exit;
        }
      })(),
    createSdkMcpServer: ((options: { tools: FakeTool[] }) => ({
      type: "sdk",
      name: "ensemble",
      instance: { tools: options.tools },
    })) as never,
    tool: ((
      name: string,
      _description: string,
      _shape: unknown,
      handler: FakeTool["handler"],
    ) => ({ name, handler })) as never,
  };
  return { sdk, sessions };
}

const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  claude_code_version: "2.1.296",
});
const result = (sessionId: string, fields: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: "done",
  ...fields,
});
const sessionOf = (session: Session) =>
  String(session.options.sessionId ?? session.options.resume);

function fixture(
  options: {
    scripts?: Script[];
    record?: () => boolean;
    environment?: () => ClaudeTurnEnvironment;
    verified?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-claude-runtime-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const safetyFixture = runtimeSafetyFixture();
  const log: string[] = [];
  const recorded: unknown[] = [];
  const { sdk, sessions } = fakeSdk(options.scripts ?? [], log);
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
  const turn = async (threadId: string) => {
    const turnId = await runtime.startTurn(threadId, workspace, "Do the work", {
      model: "haiku",
      reasoningEffort: "low",
    });
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
    cleanup: async () => {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the pinned SDK is the C0-qualified version", () => {
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
