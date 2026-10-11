# #822 Claude Agent SDK probes, 11 October 2026

This records the eight bounded probes of
[#822](https://github.com/chrisbanes/ensemble/issues/822) against the Claude Agent
SDK and its bundled Claude Code CLI, run in one disposable root outside the
repository. They settle the SDK behaviour that the Claude runtime (C3 #825) relies
on under [ADR-1008](../adr/1008-claude-code-execution-harness.md). Each probe is
split into facets. `[ADR]` facets test an ADR-1008 guarantee. `[I]` facets are
informational and cannot fail a probe. A probe is `failed` if an `[ADR]` facet
failed, otherwise `untested` if any facet is untested, otherwise `passed`.

## Summary

| # | Probe | Disposition | ADR-1008 guarantee | Result |
| --- | --- | --- | --- | --- |
| 1 | Session start, ID capture and resume | passed | Each turn is one `query()` resuming the assignment's session; the SDK session ID is the conversation identity | The init and result carry the same UUID; a new process resumes it and recalls the earlier turn; a host-minted `sessionId` works |
| 2 | Abort mid-turn and mid-tool | passed | Interrupt uses the query's abort path | Abort settles in about 2 s; the CLI exits by itself; the tool is killed; the transcript gets an error `tool_result`; the session resumes |
| 3 | Parent kill mid-turn and mid-tool, then resume | passed | A tool call cut off by a crash is not re-run; explicit recovery may resume the session | Resume does not re-run the cut-off tool, and the agent reports it as killed. The orphaned CLI keeps running after the parent dies |
| 4 | In-process SDK MCP server | passed | Coordination tools are served through an in-process SDK MCP server | Tools appear as `mcp__ensemble__<tool>`; invalid arguments never reach the handler; error and throw shapes reach the model as `is_error` results |
| 5 | `dontAsk`, allowlist and `PreToolUse` policy | untested | `dontAsk`, an explicit allowlist, a hook that sees and can deny every call, no `AskUserQuestion`, inert mode and config changes | Hook IDs equal assistant tool-use IDs; denials hold; `tools` is the allowlist; `AskUserQuestion` is absent. Inert config writes untested (F5.5) |
| 6 | Sandbox | failed | Workspace and explicit roots writable only, empty network allowlist, no unsandboxed retry, failure if unavailable | Network denied; outside writes denied except the sandbox's own `$TMPDIR` (F6.1 failed); an unusable `sandbox-exec` fails each command rather than the query (F6.4 failed); unsandboxed retry untested |
| 7 | Isolation and subscription token | passed | No setting sources, strict MCP config, dedicated config directory; operator `setup-token` authentication | The OAuth token alone completes turns (`apiKeySource: none`); no decoy hook, instruction, memory, plugin, skill, command, agent or MCP server loads; transcripts land in the dedicated directory |
| 8 | Subprocess PID and stream bounds | passed | Each turn has its own `claude` subprocess and process identity | `spawnClaudeCodeProcess` receives the CLI command; its PID and birth identity are captured, and exit is verified after every query |

## Returned to Chris

Two `[ADR]` facets contradict the ADR-1008 sentence "Shell commands run in Claude
Code's sandbox (Seatbelt on macOS): writes to the task workspace and explicit
writable roots only, an empty network allowlist, no unsandboxed retry, and failure
if the sandbox is unavailable." Neither ADR-1008 nor code was changed.

- **F6.1, writable roots.** Under the ADR sandbox options with
  `filesystem.allowWrite: [<workspace>]`, Claude Code replaced the subprocess
  `TMPDIR` (`<disposable-root>/tmp`) with `/tmp/claude-501` and allowed sandboxed
  Bash to write there (`echo x > "$TMPDIR/sbx-tmpdir.txt"` succeeded, and the file
  existed afterwards). That directory is per OS user, not per task, so it is an
  implicit writable root shared by every Claude session of that user. Writes to
  `<disposable-root>/outside`, a unique `/tmp` file and the decoy home were
  refused with `operation not permitted`. The harness deleted only the probe's
  file. Both attempts showed the same behaviour; attempt 1's check looked at the
  wrong directory and is not counted as a pass.
- **F6.4, unavailable sandbox.** With `failIfUnavailable: true` and the CLI
  started under an outer Seatbelt profile that denies exec of
  `/usr/bin/sandbox-exec`, the query emitted `init` and completed with
  `subtype: "success"`. The Bash call failed with
  `Exit code 126 env: /usr/bin/sandbox-exec: Operation not permitted`, and the
  target file was not written. No command ran unsandboxed, but the query did not
  fail with `error_during_execution`: the dependency check only runs at startup and
  did not detect this condition. Both attempts gave the same result. A missing
  `sandbox-exec` binary or an unsupported platform, which the SDK documents as
  failing the query, was not induced.

## Environment

| Input | Value |
| --- | --- |
| Run window | 2026-10-11 16:07Z – 16:27Z |
| Checkout | `111f46d744db3d8f15b562a5014ae12945d2c4c2` plus the uncommitted `test/claude-c0/**` scripts in this change (see Reproduction) |
| macOS | 27.0.1 |
| Node / npm | v24.21.0 / 11.19.0 (probe processes) |
| SDK | `@anthropic-ai/claude-agent-sdk` 0.3.296 (newest by `npm view` at run time), `zod` 4.6.5, installed only in `<disposable-root>/sdk`; no package declares an install lifecycle script |
| CLI used | The SDK's default-resolved executable `<disposable-root>/sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, Claude Code 2.1.296 |
| Installed CLI | `/opt/homebrew/bin/claude --version` → `2.1.296 (Claude Code)`; versions match, so the `pathToClaudeCodeExecutable` repeat was not needed |
| Model | `haiku` alias, resolved to `claude-haiku-5-5`; `effort: "low"` |
| Credential | `CLAUDE_CODE_OAUTH_TOKEN` present (minted by Chris, read from `~/.env` by that name only); no API key variable passed |
| Nested Seatbelt | `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` exits 0 from the harness context |
| Model-backed `query()` calls | 56 of the 60 cap |

Every query ran with an allowlist environment (`PATH`, `TMPDIR=<disposable-root>/tmp`,
`LANG`, `HOME=<disposable-root>/home`, `CLAUDE_CONFIG_DIR=<disposable-root>/config`
and, for live turns, the token), `cwd: <disposable-root>/workspace`,
`settingSources: []`, `strictMcpConfig: true`, `permissionMode: "dontAsk"`,
`tools: []` unless a probe says otherwise, a 120 s deadline with abort, and the
harness's `spawnClaudeCodeProcess` wrapper. The decoy home held user settings with
marker-writing `SessionStart`, `UserPromptSubmit` and `PreToolUse` hooks, a
`WebFetch` allow rule, `defaultMode: "acceptEdits"`, an `env` entry, a marketplace
plugin, a skill, a command, an agent, a user `CLAUDE.md`, a `.claude.json` MCP
server and an auto-memory file. The workspace held the same project-level decoys
plus `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` and `.mcp.json`. No probe read or
wrote the real home, `~/.claude`, the Ensemble data directory or database, an
operator project or the installed prototype.

## Reproduction

From the repository root on Node 24.21.0, after `npm ci && npm run build:service`:

```sh
C0_ROOT="$(node test/claude-c0/run.mjs --live init)"
node test/claude-c0/run.mjs --live p7 --root "$C0_ROOT"
node test/claude-c0/run.mjs --live p8 --root "$C0_ROOT"
node test/claude-c0/run.mjs --live p1 --root "$C0_ROOT"   # probes 1 and 2
node test/claude-c0/run.mjs --live p3 --root "$C0_ROOT"
node test/claude-c0/run.mjs --live p4 --root "$C0_ROOT"
node test/claude-c0/run.mjs --live p5 --root "$C0_ROOT"
node test/claude-c0/run.mjs --live p6 --root "$C0_ROOT"
node test/claude-c0/run.mjs summary --root "$C0_ROOT"
node test/claude-c0/run.mjs --live cleanup --root "$C0_ROOT"
```

Each live step exited 0. The driver refuses any other argument shape (exit 2). The
committed scripts differ from the executed ones only by Biome formatting, one
lint-suppression comment and the redaction of Claude Code's dash-separated
project-directory names, which was applied again when the traces were copied
here. Harness helpers added for later probes did not change earlier probes'
behaviour.

## Attempts and corrections

Each facet had at most 3 attempts. Each correction below fixed the harness or a
fixture; none changed a pass condition to accommodate an observation.

| Step | Attempts | Reason for each repeat |
| --- | --- | --- |
| p7 | 2 | F7.4's first check required zero plugins; the CLI always lists three `path: "builtin"` plugins. The check now requires built-ins only, as planned |
| p8 | 2 | Repeated to record the full large tool-result length (the first run recorded a 400-character excerpt) and per-run environment keys |
| p1 | 1 | — |
| p3 | 3 | Attempt 1: the orphaned CLI finished the 20 s tool before the 30 s window ended, so nothing was cut off. The tool now sleeps 60 s. Attempt 2: a stale state file from attempt 1 made F3.2 kill the new parent before it started. The state file is now removed before each spawn |
| p4 | 2 | A shadowed variable made F4.2 a harness error |
| p5 | 3 | F5.5 only; see probe 5 |
| p6 | 2 | F6.1 checked `<disposable-root>/tmp`, but the sandbox reports a different `TMPDIR`. F6.3's model retried without the flag. The retry prompt was made explicit, and a facet now needs `dangerouslyDisableSandbox: true` to have been sent |

## Probe 1: session start, ID capture and resume

Options: the base options with no tools. Each `query()` ran in its own subprocess.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F1.1 [ADR] Session ID capture | passed | `init.session_id` is a UUID equal to the result's `session_id` |
| F1.2 [ADR] Resume | passed | `query({ options: { resume } })` in a new process returned the same `session_id` in `init` and `result` and recalled the turn-1 nonce. No fork |
| F1.3 [I] Pre-assigned `sessionId` | passed | A harness-minted UUID was accepted, appeared in `init` and resumed with recall |
| F1.4 [I] Unknown session ID | passed | No `init`; the result is `error_during_execution`, `is_error: true`, `errors: ["No conversation found with session ID: <id>"]`; `query()` then throws `Claude Code returned an error result: …`; CLI exit 1 |

## Probe 2: abort mid-turn and mid-tool

Options: base options with `includePartialMessages: true` (mid-turn) or
`tools: ["Bash"]`, `allowedTools: ["Bash"]` (mid-tool), aborted through
`options.abortController`.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F2.1 [ADR] Abort mid-turn | passed | Aborted at the first partial message. The generator threw `Error: Claude Code process aborted by user` 2.0 s after `abort()`; no `result` message. The CLI exited with code 143 without a harness signal, and exit was verified. The transcript holds the user prompt and attachments and no assistant record |
| F2.2 [ADR] Abort mid-tool | passed | Aborted once the tool wrote `started`. Same throw after 2.0 s; CLI exit 143, verified. The `/bin/zsh` and `sleep` tool processes were gone when the query settled, and `finished` was not written within 15 s. The transcript holds `tool_use:Bash` followed by a synthesized error `tool_result` |
| F2.3 [I] Resume after abort | passed | The aborted session resumed with the same ID and completed (`success`) |

## Probe 3: parent crash mid-turn and mid-tool

`p3-parent.mjs` (a probe-owned `node` child) ran the query with
`tools: ["Bash"]`, `allowedTools: ["Bash"]` and `includePartialMessages: true`. The
driver killed it with SIGKILL after re-verifying its birth identity. It then
watched for 30 s, terminated any recorded survivor by verified identity
(SIGTERM), and resumed from a fresh process with the same tools.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F3.1 [ADR] Cut-off tool not re-run | passed | The tool (`echo started:<n> >> counter; sleep 60; echo finished:<n> >> counter`) was mid-sleep when the parent died. After the survivor CLI was terminated, a resume and one follow-up turn left exactly one `started:<n>` line and no `finished` line. `resume_reason` was absent |
| F3.2 [ADR] Mid-turn recovery | passed | After the parent was killed during streaming, a resume from a new process was accepted (same session) and completed with `success` |
| F3.3 [I] Orphans | passed | The CLI survives its parent's death. Mid-tool, the CLI and its `/bin/zsh` and `sleep` children were still alive after 30 s. On SIGTERM the CLI exited within 2.5 s and the tool died with it. Mid-turn, the orphaned CLI finished generating, appended the assistant text to the transcript and exited about 8 s after the kill. In attempt 1 the orphan also completed a 20 s tool and its turn 23 s after the kill |
| F3.4 [I] Appearance to the agent | passed | The transcript shows `tool_use:Bash` paired with a synthesized error `tool_result` (exit 137) written when the CLI was terminated. Asked what happened, the agent replied that the command "exited with code 137, which usually means the process was killed" and that it could not confirm what was written (class: knows-interrupted) |

Limit: the cut-off is caused by terminating the orphaned CLI after the window. A
crash that kills the CLI before the transcript records the `tool_use`, for example
a host power loss, was not exercised.

## Probe 4: in-process SDK MCP server

A fixture server named `ensemble`, built with `createSdkMcpServer` and `tool()`
(zod schemas), exposed `ensemble_echo` (`text: string`, `count: int`),
`ensemble_nested` (`questions[]` of `{id, question, kind?: "single" | "multi"}`),
`ensemble_error` (returns `isError: true`) and `ensemble_throw` (throws).
`allowedTools` named the four exact tools.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F4.1 [ADR] Serving and names | passed | `init.tools` lists `mcp__ensemble__ensemble_{echo,error,nested,throw}`; `init.mcp_servers` and `mcpServerStatus()` show `{name: "ensemble", status: "connected", source: "sdk"}`. With `allowedTools: ["mcp__ensemble__*"]` the handler ran with no permission denials |
| F4.2 [ADR] Argument validation | passed | The handler was never invoked with invalid data. Unquoted `"count": not-a-number` was rejected by the CLI (`<tool_use_error>InputValidationError: … could not be parsed as JSON`). A missing `text` was rejected by the MCP layer (`MCP error -32602: Input validation error: Invalid arguments for tool ensemble_echo: [ … "path": ["text"], "message": "Invalid input: expected string, received undefined" … ]`). Both reach the model as error `tool_result`s |
| F4.3 [I] Result and error shapes | passed | Success gives `echo:ok:1`, not an error. `isError: true` gives an error `tool_result` carrying the handler's text. A thrown handler gives an error `tool_result` with the exception message `fixture handler threw`. The transcript stores each pair as `tool_use` and `tool_result` (`:error` for the latter two) |
| F4.4 [I] Nested structured arguments | passed | Two questions arrived intact (deep-equal to the model's input). The advertised schema is draft-07 JSON Schema with the nested array of objects, `kind` as a string enum and `required: ["id", "question"]` |

## Probe 5: `dontAsk`, allowlist and `PreToolUse` policy

Policy: `permissionMode: "dontAsk"`,
`tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"]`, `allowedTools` set to
those six plus the four MCP tools, and
`disallowedTools: ["AskUserQuestion", "WebFetch", "WebSearch", "Agent", "Task", "EnterPlanMode", "ExitPlanMode"]`.
A `PreToolUse` callback hook with no matcher records every input and denies
`Write` or `Edit` outside `<disposable-root>/workspace`. A `canUseTool` counter
denies everything. The SDK warns (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) that
`canUseTool` is not invoked for bare `allowedTools` entries.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F5.1 [ADR] Hook sees every call | passed | The model made 7 calls (Read, Glob, Grep, Write, Bash, `mcp__ensemble__ensemble_echo`, Write). The hook's `tool_use_id` set equals the assistant `tool_use` ID set, and the callback's `toolUseID` argument equals `input.tool_use_id`. Hook input carries `permission_mode: "dontAsk"`, and MCP calls carry `mcp_server: {name: "ensemble", source: "sdk"}` |
| F5.2 [ADR] Denial holds; allow rules bypass `canUseTool` | passed | The control in-workspace write succeeded. The outside write was absent, and the model saw `PreToolUse:Write hook error: C0-POLICY-DENIED: …`. The turn continued to `success`. `canUseTool` was invoked 0 times |
| F5.3 [ADR] Allowlist expression | passed | Under the policy, `init.tools` is exactly the six built-ins plus four MCP tools. In a variant with `WebFetch` in `tools` but not in `allowedTools` or `disallowedTools`, the call reached the hook and was then denied by `dontAsk` (`Permission to use WebFetch has been denied because Claude Code is running in don't ask mode…`, listed in `permission_denials`). `canUseTool` was not invoked. `tools` therefore expresses the allowlist; `allowedTools` only pre-approves |
| F5.4 [ADR] `AskUserQuestion` disabled | passed | Absent from `init.tools`; the model made no call; `canUseTool` was not invoked; the query settled in 4.3 s with `success` |
| F5.5 [ADR] Mode and config changes are inert | untested | No `EnterPlanMode` or `ExitPlanMode` tool is available under the policy, and every hook input reported `dontAsk`. Attempt 1: the CLI itself refused the model's `Write` to `.claude/settings.json` and `.mcp.json` under `dontAsk` (two `permission_denied` system messages). The resumed turn kept `dontAsk`, had no `WebFetch` and only the `ensemble` server, and no rogue marker. Attempt 1's check expected the writes to land and recorded `untested`. In attempts 2 and 3 the model made no tool calls. Reason: the model never completed or had refused the config writes within the attempt cap |

## Probe 6: sandbox

The probe 5 policy plus
`sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, network: { allowedDomains: [] }, filesystem: { allowWrite: [<workspace>] } }`.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F6.0 [I] Positive control | passed | `echo inside > <workspace>/sbx-inside.txt` succeeded; the outside write failed with `operation not permitted` |
| F6.1 [ADR] Outside writes denied | failed | Refused: `<disposable-root>/outside`, `/tmp/ensemble-c0-<id>` and `<disposable-root>/home` (`operation not permitted`, files absent). Allowed: `"$TMPDIR/sbx-tmpdir.txt"`, where the sandbox reported `tmpdir=/tmp/claude-501`, not the configured `TMPDIR` |
| F6.2 [ADR] Network denied | passed | The harness's own request to its loopback listener succeeded (control). Sandboxed `curl` to the listener gave `curl-exit=7` with 0 hits. `curl https://example.com` gave `curl-exit=56` with `<sandbox_violations> deny network-outbound example.com:443` |
| F6.3 [ADR] No unsandboxed retry | untested | Attempt 1: the model retried the outside write without the flag, and it was refused again. Attempt 2: the model made no call. The model never sent `dangerouslyDisableSandbox: true`, so the hook never saw that field and whether the CLI honours it was not observed |
| F6.4 [ADR] Unavailable sandbox fails closed | failed | See Returned to Chris: the query succeeded, and the command failed with exit 126 without running |

## Probe 7: isolation and subscription token

| Facet | Disposition | Observation |
| --- | --- | --- |
| F7.1 [ADR] Subscription token authenticates | passed | With only `CLAUDE_CODE_OAUTH_TOKEN` and an empty dedicated `CLAUDE_CONFIG_DIR`, "Reply with exactly: OK" returned `success`, `is_error: false`, `apiKeySource: "none"`, model `claude-haiku-5-5`. Without the token, `init` is still emitted. The turn then fails with `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`, `Not logged in · Please run /login`, `query()` throws, and the CLI exits 1 |
| F7.2 [ADR] No user or project settings or hooks | passed | No decoy marker file in the model-free or live runs (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, MCP). `init.permissionMode` is `dontAsk` despite the decoy `acceptEdits`. `echo env=${DECOY_SETTINGS_ENV:-unset}` printed `env=unset`. The SDK's own `PreToolUse` hook saw the Bash call (control) |
| F7.3 [ADR] No CLAUDE.md, AGENTS.md or auto memory | passed | The `InstructionsLoaded` hook fired for no file. The model recalled the system-prompt control nonce and none of the five decoy nonces. No memory path appeared in the dedicated directory |
| F7.4 [ADR] No plugins, skills, commands, agents or connectors | passed | No `decoy` name in `plugins`, `skills`, `slash_commands`, `agents` or `mcp_servers`. `plugins` lists only `cc-plugin-agents-md`, `cc-plugin-telemetry` and `cc-plugin-plugin-authoring`, all `path: "builtin"`. `mcp_servers` is empty. `skills` lists the CLI's bundled skills (`deep-research`, `design`, `dataviz`, `verify`, `code-review` and others), and `agents` lists `claude`, `Explore`, `general-purpose`, `Plan` and `statusline-setup` |
| F7.5 [ADR] Dedicated config directory is used | passed | Session transcripts land in `<disposable-root>/config/projects/<dash-separated workspace path>/<session>.jsonl`. The CLI also writes `.claude.json`, `backups/`, `plugins/installed_plugins.json`, `policy-limits.json` and `remote-settings.json` there. Nothing was added under the decoy home |
| F7.6 [I] Models and effort | passed | `supportedModels()` answered at `init` without a model turn: `default` and `sonnet` (`claude-sonnet-5-5`), `fable` (`claude-fable-5-1`), `opus` (`claude-opus-5-5`) and `haiku` (`claude-haiku-5-5`), each `supportsEffort: true` with `low`, `medium`, `high`, `xhigh` and `max` |

## Probe 8: subprocess PID and stream bounds

| Facet | Disposition | Observation |
| --- | --- | --- |
| F8.1 [ADR] PID and identity | passed | `spawnClaudeCodeProcess` receives exactly `{args, command, cwd, env, signal}`. In all three runs the PID was a positive integer and `captureProcessIdentity` was non-null at `init`, and `ps -o command=` showed the given command (the CLI itself, no intermediary). The CLI shares the harness's process group. No idle children at `init` on live runs; the auth-failing run showed two `<defunct>` entries |
| F8.2 [ADR] Exit identity | passed | `MacProcessTerminationVerifier.verify` returned `verified` after every query without a harness signal (exit 1 for the auth failure, 0 otherwise) |
| F8.3 [I] Stream bounds | passed | Auth failure: stdout 23,292 bytes over 6 lines, largest line 18,336. One-turn success: 24,445 bytes, 7 lines, largest 18,592. A Bash command printing 1,100,000 bytes: 58,811 bytes, 9 lines, largest 33,232; the model received a 2,359-character tool result, because Claude Code truncates large tool output before it reaches the stream. stderr was 0 bytes on the wrapper tee and in the `stderr` callback in every run |
| F8.4 [I] Spawn contract | passed | Command `<disposable-root>/sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`; flags `--output-format <v> --verbose --input-format <v> --effort=low --model=haiku [--allowedTools=…] --tools=… --setting-sources= --strict-mcp-config --permission-mode=dontAsk`. Environment keys are the allowlist plus `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_SDK_READS_SESSION_STATE` added by the SDK |

## Untested surfaces

- F5.5: inertness of model-written `.claude/settings.json` and `.mcp.json` after
  the writes landed. Attempt 1 indicates the CLI refuses those writes under
  `dontAsk`.
- F6.3: whether the CLI honours a model-supplied `dangerouslyDisableSandbox: true`
  with `allowUnsandboxedCommands: false`.
- F6.4 with a missing `sandbox-exec` binary or an unsupported platform.
- Behaviour under the operator's real `HOME`, real `~/.claude` and keychain login.
  Probes used a decoy home only.
- A crash that kills the CLI together with its parent (P3 killed only the parent).
- Larger models and efforts other than `low`. All live turns used `haiku`.

## Observed names and shapes

- Query options used: `cwd`, `env` (replaces the environment), `settingSources: []`,
  `strictMcpConfig: true`, `permissionMode: "dontAsk"`, `tools`, `allowedTools`,
  `disallowedTools`, `mcpServers`, `hooks.PreToolUse` and
  `hooks.InstructionsLoaded`, `canUseTool`, `sandbox`, `resume`, `sessionId`,
  `abortController`, `includePartialMessages`, `systemPrompt`, `model`, `effort`,
  `spawnClaudeCodeProcess` and `stderr`.
- `SpawnOptions`: `{command, args, cwd, env, signal}`. `signal` is the SDK's
  forwarded signal, which aborts after a stdin-EOF grace period.
- Abort: `query()` throws `Error("Claude Code process aborted by user")`, emits no
  `result`, and the CLI exits 143.
- Errors: an error result makes `query()` throw
  `Claude Code returned an error result: <errors[0]>` after yielding the result
  message. Unknown `resume` gives `error_during_execution`. Missing auth gives
  `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`.
- `SDKSystemMessage` (`init`) fields used: `session_id`, `apiKeySource`,
  `permissionMode`, `model`, `tools`, `mcp_servers[] {name, status, source}`,
  `plugins[] {name, path, source}`, `skills`, `slash_commands`, `agents` and
  `claude_code_version`.
- `TerminalReason` includes `aborted_streaming`, `aborted_tools`, `api_error` and
  `completed`. Aborted queries produced no result, so no `aborted_*` reason was
  observed.
- `PreToolUseHookInput`: `tool_name`, `tool_input`, `tool_use_id`,
  `permission_mode` and `mcp_server {name, source}`. A deny with
  `permissionDecisionReason` reaches the model as
  `PreToolUse:<Tool> hook error: <reason>`.
- MCP tool names are `mcp__<server>__<tool>`. Validation errors come from the CLI
  (unparseable JSON) or as MCP `-32602` (schema).
- Transcript record types: `queue-operation`, `user`, `attachment`, `atis-latch`,
  `ai-title`, `assistant`, `last-prompt`, `cost-state` and `mode`.

## Traces

Each JSONL file is a redacted trace of one step: message types, never bodies;
query settlement with process exit and verification; every signal with its
identity check; and a final `facets` line holding the step's results. Redaction
happened at write time and again when the traces were copied here. The token,
any Anthropic key or bearer value, the disposable root, the checkout and the user
home appear only as placeholders.

| File | SHA-256 |
| --- | --- |
| `issue-822-claude-sdk-probes-p1-2026-10-11.jsonl` | `d07ad1b2e9b75010d869d7626ee1391af2f0599e31bcadb5d7b66382f42e0964` |
| `issue-822-claude-sdk-probes-p3-2026-10-11.jsonl` | `5816e61294fdcde9de448ebcc36f1e9f5c712bc37030a3fec4fe7f7266af8c3a` |
| `issue-822-claude-sdk-probes-p3-parent-tool-2026-10-11.jsonl` | `a014902ca34004b5d2a11daa6cd7b293861761f05999817bdf3d2be7541dba26` |
| `issue-822-claude-sdk-probes-p3-parent-turn-2026-10-11.jsonl` | `410c9b267924d1bfdd31ba9243062c00a62028f4056dc4ef502b1916b88df70c` |
| `issue-822-claude-sdk-probes-p4-2026-10-11.jsonl` | `4f0ed88204e7a56e978b219ba0edeead24ac4c694a27e9163267da12f3e22437` |
| `issue-822-claude-sdk-probes-p5-2026-10-11.jsonl` | `cccb310b60bd0339927af91ccc3174c15487c59ff3c37031d2a3a9823f067197` |
| `issue-822-claude-sdk-probes-p6-2026-10-11.jsonl` | `3d59dc8e3f6567bfceacdbefe2f4ffcae608ede9f5e9f9d7277f46d23cc431c9` |
| `issue-822-claude-sdk-probes-p7-2026-10-11.jsonl` | `f76fc4b03fa8c97b9d0294d9c7d122a9ee84df19b1887b1b8c2e139521288065` |
| `issue-822-claude-sdk-probes-p8-2026-10-11.jsonl` | `8d4f4f7398a5608c83831e5593eb17e53592d192c6845b0d5b34414bc66bad38` |

Cleanup verified every recorded process identity as exited and then removed only
the disposable root.
