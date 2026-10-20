import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import type {
  HookCallback,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ClaudeSdk } from "../../src/standalone/claude.js";

/** A scripted Claude Agent SDK that spawns a real child for abort, loss and exit. */
export interface FakeTool {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

/** What a scripted fake query can do; mirrors the C0-observed SDK behaviour. */
export interface Session {
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

export type Script = (session: Session) => AsyncGenerator<unknown>;

export const fakeModels = [
  {
    value: "default",
    displayName: "Default",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

export function fakeSdk(
  scripts: Script[],
  log: string[],
  options: { hangModels?: boolean } = {},
) {
  const supportedModels = () =>
    options.hangModels
      ? new Promise<never>(() => {})
      : Promise.resolve(fakeModels);
  const sessions: Session[] = [];
  const queries: string[] = [];
  const optionsSeen: Options[] = [];
  const sdk: ClaudeSdk = {
    query: ({ prompt, options }) => {
      optionsSeen.push(options);
      if (!options.mcpServers) {
        // The model-free settings read: no prompt is ever released.
        queries.push("settings");
        return Object.assign(
          (async function* () {
            const signal = options.abortController?.signal;
            await new Promise((done) =>
              signal?.aborted
                ? done(undefined)
                : signal?.addEventListener("abort", done),
            );
          })(),
          { supportedModels },
        );
      }
      queries.push("turn");
      return Object.assign(
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
        { supportedModels },
      );
    },
    createSdkMcpServer: ((options: { tools: FakeTool[] }) => ({
      type: "sdk",
      name: "ensemble",
      instance: { tools: options.tools },
    })) as never,
    // Like the MCP layer, arguments are parsed by the advertised object shape.
    tool: ((
      name: string,
      _description: string,
      shape: z.ZodRawShape,
      handler: FakeTool["handler"],
    ) => ({
      name,
      handler: (args: Record<string, unknown>, extra: unknown) =>
        handler(z.object(shape).parse(args), extra),
    })) as never,
  };
  return { sdk, sessions, queries, optionsSeen };
}

export const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  claude_code_version: "2.1.296",
});
export const result = (
  sessionId: string,
  fields: Record<string, unknown> = {},
) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: "done",
  ...fields,
});
export const sessionOf = (session: Session) =>
  String(session.options.sessionId ?? session.options.resume);
