import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeSdk } from "../../../src/standalone/claude.js";
import { record } from "./trace.js";

/**
 * Model-free SDK transport; spawning still goes through ClaudeRuntime.spawnTurnProcess.
 * With `sessions`, the CLI saves the prompt to its session file only after `saveDelayMs`
 * (an abort first prevents it) and `resume` of an unsaved session fails, as the real CLI does.
 */
export function signalSdk(
  file: string,
  executable: string,
  completing = false,
  sessions?: { saveDelayMs: number },
): ClaudeSdk {
  return {
    createSdkMcpServer: ((options: { tools: unknown[] }) => ({
      type: "sdk",
      name: "cab",
      instance: { tools: options.tools },
    })) as never,
    tool: ((
      name: string,
      _description: string,
      _shape: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => ({ name, handler })) as never,
    query: ({ prompt, options }) =>
      Object.assign(
        (async function* () {
          if (!options.mcpServers) {
            const probe = options.spawnClaudeCodeProcess?.({
              command: executable,
              args: [],
              signal: new AbortController().signal,
              env: {
                ...options.env,
                SIGNAL_TRACE: file,
                SIGNAL_PROBE: "settings",
              },
              ...(options.cwd ? { cwd: options.cwd } : {}),
            }) as unknown as ChildProcess;
            await new Promise<void>((resolve) => {
              probe.once("exit", () => resolve());
              options.abortController?.signal.addEventListener(
                "abort",
                () => probe.stdin?.end(),
                { once: true },
              );
            });
            return;
          }
          const child = options.spawnClaudeCodeProcess?.({
            command: executable,
            args: [],
            signal: new AbortController().signal,
            env: { ...options.env, SIGNAL_TRACE: file },
            ...(options.cwd ? { cwd: options.cwd } : {}),
          }) as unknown as ChildProcess;
          const exit = new Promise<void>((resolve) =>
            child.once("exit", () => {
              record(file, "sdk-exit-observed");
              resolve();
            }),
          );
          child.on("error", () => {});
          options.abortController?.signal.addEventListener(
            "abort",
            () => {
              record(file, "sdk-protocol-interrupt");
              child.kill("SIGTERM");
              record(file, "sdk-ack");
            },
            { once: true },
          );
          record(file, "conversation-open", {
            method: options.resume ? "thread/resume" : "thread/start",
            threadId: options.resume ?? options.sessionId,
          });
          const first = await prompt[Symbol.asyncIterator]().next();
          if (first.done) throw new Error("No admitted prompt");
          if (sessions) {
            const config = options.env?.CLAUDE_CONFIG_DIR;
            const id = options.resume ?? options.sessionId;
            if (!config || !id) throw new Error("Session fixture needs config");
            const projects = join(config, "projects");
            if (
              options.resume &&
              !(
                existsSync(projects) &&
                readdirSync(projects).some((d) =>
                  existsSync(join(projects, d, `${id}.jsonl`)),
                )
              )
            ) {
              record(file, "resume-missing", { session: id });
              child.kill("SIGTERM");
              throw new Error("No conversation found");
            }
            const save = setTimeout(() => {
              mkdirSync(join(projects, "fixture"), { recursive: true });
              appendFileSync(
                join(projects, "fixture", `${id}.jsonl`),
                `${JSON.stringify({ type: "user", sessionId: id })}\n`,
              );
              record(file, "session-saved", { session: id });
            }, sessions.saveDelayMs);
            options.abortController?.signal.addEventListener(
              "abort",
              () => clearTimeout(save),
              { once: true },
            );
            child.once("exit", () => clearTimeout(save));
          }
          child.stdin?.write(`${JSON.stringify({ method: "sdk-active" })}\n`);
          yield {
            type: "system",
            subtype: "init",
            session_id: options.sessionId ?? options.resume,
            claude_code_version: "2.1.296",
          };
          if (completing) {
            const args = { summary: "Offline successor settled" };
            const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
            await hook?.(
              {
                hook_event_name: "PreToolUse",
                tool_name: "mcp__cab__cab_report_result",
                tool_input: args,
                tool_use_id: "successor-result",
              } as never,
              "successor-result",
              { signal: new AbortController().signal },
            );
            const server = options.mcpServers?.cab as unknown as {
              instance: {
                tools: {
                  name: string;
                  handler: (args: unknown, extra: unknown) => Promise<unknown>;
                }[];
              };
            };
            const report = server.instance.tools.find(
              (tool) => tool.name === "cab_report_result",
            );
            if (!report) throw new Error("Result callback missing");
            record(file, "result-saved", await report.handler(args, {}));
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: options.sessionId ?? options.resume,
              result: "done",
            };
            child.stdin?.end();
          }
          await exit;
        })(),
        {
          supportedModels: async () => [
            {
              value: "opus",
              displayName: "Default",
              description: "",
              supportsEffort: true,
              supportedEffortLevels: ["high"],
            },
          ],
        },
      ),
  };
}
