import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "node:child_process";
import type { ClaudeSdk } from "../../../src/standalone/claude.js";
import { record } from "./trace.js";

/** Model-free SDK transport; spawning still goes through ClaudeRuntime.spawnTurnProcess. */
export function signalSdk(file: string, executable: string): ClaudeSdk {
  return {
    createSdkMcpServer,
    tool,
    query: ({ prompt, options }) =>
      Object.assign(
        (async function* () {
          if (!options.mcpServers) {
            await new Promise<void>((resolve) =>
              options.abortController?.signal.addEventListener(
                "abort",
                () => resolve(),
                { once: true },
              ),
            );
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
          const first = await prompt[Symbol.asyncIterator]().next();
          if (first.done) throw new Error("No admitted prompt");
          child.stdin?.write(`${JSON.stringify({ method: "sdk-active" })}\n`);
          yield {
            type: "system",
            subtype: "init",
            session_id: options.sessionId ?? options.resume,
            claude_code_version: "2.1.296",
          };
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
