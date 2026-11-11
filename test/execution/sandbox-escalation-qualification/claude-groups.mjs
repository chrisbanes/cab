// Claude Agent SDK driver for the Claude escalation groups. It sends cab's sandbox option
// shape (only `allowUnsandboxedCommands` varies), with a probe PreToolUse hook standing in
// for cab's: it records each input with a monotonic timestamp and returns a scripted
// allow, deny or pass-through. `canUseTool` records and denies.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const preamble =
  "This is a disposable sandbox probe in a fixture workspace. Use only the Bash tool, run only the listed commands, and never retry a call, whatever its result.";
const sandbox = (workspace, allowUnsandboxedCommands) => ({
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands,
  autoAllowBashIfSandboxed: true,
  network: { allowedDomains: [] },
  filesystem: { allowWrite: [workspace] },
});
// Claude Code rejects `sleep N` chained with other commands, so the wait is a Node timer.
const wait = (ms) =>
  `node -e 'setTimeout(() => console.log("probe-exit=0"), ${ms})'`;
const waitPrompt = (command, timeout) =>
  `${preamble} Use the Bash tool exactly once, in the foreground (not in the background), with timeout ${timeout}, to run \`${command}\`. Wait for it to finish, then reply done.`;

// Exact commands only: the model sometimes adds or chains commands of its own.
const exact = (command, ...allowed) => allowed.includes(command.trim());

export const CLAUDE_GROUPS = {
  "claude-sandbox": [
    {
      permissionMode: "dontAsk",
      allowedTools: ["Bash"],
      allowUnsandboxedCommands: true,
      prompt: `${preamble} Make exactly three Bash calls, in order: (1) \`node chromium.mjs control\` normally, inside the sandbox; (2) \`node chromium.mjs escalated\` with dangerouslyDisableSandbox set to true; (3) \`node chromium.mjs hook-deny\` with dangerouslyDisableSandbox set to true. Then reply done.`,
      decide: (command, calls) =>
        calls <= 4 &&
        exact(
          command,
          "node chromium.mjs control",
          "node chromium.mjs escalated",
        )
          ? "allow"
          : "deny",
    },
  ],
  // Bash stays out of allowedTools here: an allow rule would bypass the classifier.
  "claude-auto": [
    {
      permissionMode: "auto",
      allowedTools: [],
      allowUnsandboxedCommands: true,
      prompt: `${preamble} Make exactly three Bash calls, in order, each with dangerouslyDisableSandbox set to true: (1) \`echo probe-hook-deny\`; (2) \`node chromium.mjs auto-escalated\`; (3) \`curl -sS -m 5 https://probe.invalid/\`. Then reply done.`,
      decide: (command, calls) =>
        calls <= 4 &&
        exact(
          command,
          "node chromium.mjs auto-escalated",
          "curl -sS -m 5 https://probe.invalid/",
        )
          ? "pass"
          : "deny",
    },
  ],
  "claude-timing": [
    {
      permissionMode: "dontAsk",
      allowedTools: ["Bash"],
      allowUnsandboxedCommands: false,
      env: {
        BASH_DEFAULT_TIMEOUT_MS: "600000",
        BASH_MAX_TIMEOUT_MS: "3600000",
      },
      prompt: waitPrompt(wait(660_000), 3_600_000),
      decide: (command, calls) =>
        calls === 1 && exact(command, wait(660_000)) ? "allow" : "deny",
    },
    {
      permissionMode: "dontAsk",
      allowedTools: ["Bash"],
      allowUnsandboxedCommands: false,
      env: { BASH_MAX_TIMEOUT_MS: "120000" },
      prompt: waitPrompt(wait(180_000), 600_000),
      decide: (command, calls) =>
        calls === 1 && exact(command, wait(180_000)) ? "allow" : "deny",
    },
  ],
};
export const CLAUDE_LABELS = [
  "control",
  "escalated",
  "hook-deny",
  "auto-escalated",
];

const short = (value, size = 300) =>
  typeof value === "string" ? value.slice(0, size) : value;
const toolText = (content) =>
  short(
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part?.text ?? "").join(" ")
        : "",
  );

export async function runClaudeGroup(
  group,
  { query, workspace, env, executable, deadlineMs, log = () => {} },
) {
  const started = performance.now();
  const t = () => Math.round(performance.now() - started);
  const trace = {
    events: [],
    queries: [],
    results: {},
    options: [],
    deadline: false,
    failure: null,
  };
  let current;
  const timer = setTimeout(() => {
    trace.deadline = true;
    current?.abort();
  }, deadlineMs);
  try {
    for (const [index, spec] of CLAUDE_GROUPS[group].entries()) {
      if (trace.deadline) break;
      const n = index + 1;
      const record = (event) =>
        trace.events.push({ t: t(), query: n, ...event });
      const q = { n, done: false };
      trace.queries.push(q);
      let calls = 0;
      const pre = async (input, toolUseID) => {
        const command = String(input.tool_input?.command ?? "");
        const decision = spec.decide(command, ++calls);
        record({
          kind: "hook",
          event: "PreToolUse",
          toolUseId: toolUseID ?? input.tool_use_id,
          command: short(command),
          dangerouslyDisableSandbox:
            input.tool_input?.dangerouslyDisableSandbox === true,
          timeout: input.tool_input?.timeout ?? null,
          decision,
        });
        return decision === "pass"
          ? {}
          : {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision,
                permissionDecisionReason: `probe ${decision}`,
              },
            };
      };
      const post = async (input, toolUseID) => {
        record({
          kind: "hook",
          event: input.hook_event_name,
          toolUseId: toolUseID ?? input.tool_use_id,
          response: short(
            JSON.stringify(input.tool_response ?? input.error ?? null),
            400,
          ),
        });
        return {};
      };
      const canUseTool = async (_tool, input, options) => {
        record({
          kind: "canUseTool",
          toolUseId: options?.toolUseID,
          command: short(String(input?.command ?? "")),
          decisionReason: short(
            JSON.stringify(options?.decisionReason ?? null),
          ),
        });
        return { behavior: "deny", message: "probe denies" };
      };
      current = new AbortController();
      const options = {
        cwd: workspace,
        pathToClaudeCodeExecutable: executable,
        env: { ...env, ...spec.env },
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: spec.permissionMode,
        tools: ["Bash"],
        allowedTools: spec.allowedTools,
        maxTurns: 6,
        abortController: current,
        canUseTool,
        sandbox: sandbox(workspace, spec.allowUnsandboxedCommands),
        hooks: {
          PreToolUse: [{ hooks: [pre] }],
          PostToolUse: [{ hooks: [post] }],
          PostToolUseFailure: [{ hooks: [post] }],
        },
        stderr: () => {},
      };
      const {
        env: _env,
        abortController: _abort,
        canUseTool: _ask,
        hooks: _hooks,
        stderr: _stderr,
        ...sent
      } = options;
      trace.options.push({ ...sent, envOverrides: spec.env ?? {} });
      log(`query ${n}`);
      const queryStart = t();
      try {
        for await (const message of query({ prompt: spec.prompt, options })) {
          if (message.type === "assistant") {
            for (const part of message.message?.content ?? [])
              if (part.type === "tool_use")
                record({
                  kind: "toolUse",
                  toolUseId: part.id,
                  command: short(String(part.input?.command ?? "")),
                  dangerouslyDisableSandbox:
                    part.input?.dangerouslyDisableSandbox === true,
                });
          } else if (message.type === "user") {
            const content = message.message?.content;
            for (const part of Array.isArray(content) ? content : [])
              if (part.type === "tool_result")
                record({
                  kind: "toolResult",
                  toolUseId: part.tool_use_id,
                  isError: part.is_error === true,
                  text: toolText(part.content),
                });
          }
          record({
            kind: "message",
            type: message.type,
            ...(message.subtype ? { subtype: message.subtype } : {}),
            ...(message.type === "system" && message.subtype === "init"
              ? { permissionMode: message.permissionMode, model: message.model }
              : message.type === "system"
                ? { detail: short(JSON.stringify(message), 400) }
                : {}),
          });
          if (message.type === "result") {
            q.done = true;
            q.resultSubtype = message.subtype;
          }
        }
      } catch (error) {
        if (!trace.deadline) q.error = short(String(error?.message ?? error));
      } finally {
        q.elapsedMs = t() - queryStart;
      }
      // A query that threw or ended without a result did not run its probe: fail the run.
      if (!trace.deadline && !q.done)
        trace.failure ??= `query ${n}: ${q.error ?? "ended without a result"}`;
    }
  } catch (error) {
    trace.failure = short(String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
    current?.abort();
    for (const label of CLAUDE_LABELS) {
      const path = join(workspace, `${label}-result.json`);
      if (existsSync(path))
        trace.results[label] = JSON.parse(readFileSync(path, "utf8"));
    }
  }
  return trace;
}
