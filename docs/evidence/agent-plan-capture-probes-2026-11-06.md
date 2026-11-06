# Agent plan capture probes

Recorded 2026-11-06 for [#1512](https://github.com/chrisbanes/cab/issues/1512), proof T1 of
the approved plan (revision 1). Candidate `fa61e593598f9e2acb52ef5cc9b3122833f1e08c`, no
runtime code changed. Probe scripts were throwaway files under `/tmp`. No credential, token,
account data or model output text is recorded.

Versions: Node.js v26.13.0, Claude Code 2.1.318 (`@anthropic-ai/claude-agent-sdk` from the
checkout), codex-cli 0.166.0.

## Claude

One SDK `query()` from an empty Git workspace with the options `claude.ts` builds:
`settingSources: []`, `strictMcpConfig`, `managedSettings.disableAllHooks`,
`permissionMode: "dontAsk"`, cab's sandbox options, cab's `disallowedTools`, PreToolUse,
PostToolUse and PostToolUseFailure hooks, and `tools`/`allowedTools` set to cab's turn
tools plus `TodoWrite`. The environment followed `claudeTurnEnvironment` with a fresh
`CLAUDE_CONFIG_DIR`. The prompt asked for a three-step todo list kept with the todo tool.
The model was the CLI default, `claude-sonnet-5-5`.

- Attempt: `system/init` tools were `Task, Bash, Edit, Glob, Grep, Read, Write`. `TodoWrite`
  was absent, no hook fired, and the result was `success` after one model turn.
- Retry with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, the plan's only allowed adjustment: the
  same init tools, no hook and the same result.

Inspection of the installed CLI explains both results. `TodoWrite`'s `isEnabled()` is
`!WD() && _8()`. `WD()` is true unless `CLAUDE_CODE_ENABLE_TASKS` is false, so the task
tools (`TaskCreate` and related) replace `TodoWrite` by default. `_8()` is true for an
unknown model or one of a fixed list of older models (up to `claude-opus-4-7` and
`claude-sonnet-4-6`), and otherwise only when `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set. The
retry satisfied `_8()` but not `!WD()`. Enabling `TodoWrite` on current models would also
need `CLAUDE_CODE_ENABLE_TASKS` set to false; that was not tried, because it is outside the
plan's allowance.

**Verdict: fail.** Claude is not offered `TodoWrite` under cab's settings, even with the
allowed adjustment.

## Codex

One `codex app-server` run with cab's `-c` flags (`approval_policy=never`,
`sandbox_mode=workspace-write`, `cli_auth_credentials_store=file`,
`features.multi_agent=false`, `features.plugins=false`,
`features.skill_mcp_dependency_install=false` and the shell `HOME`), using the operator's
existing Codex home and default model. After `initialize` with `experimentalApi`, it sent
`thread/start` and `turn/start` with a prompt asking the agent to use `update_plan` for a
three-step plan and to run no commands or edit files.

- The turn completed. Notifications were `thread/started`, `turn/started`, 9
  `item/started` and 9 `item/completed` (user message, reasoning and agent message items
  only), `item/agentMessage/delta`, token-usage, rate-limit and moderation updates, and
  `turn/completed`.
- No `turn/plan/updated` was emitted, and no item related to `update_plan` appeared.

The installed binary contains the `update_plan` tool and its instructions, including
guidance to skip planning for trivial work. The probe's task was trivial, so this attempt
shows that the agent may decline to plan; it does not show that `update_plan` is
unavailable. The plan allows no Codex retry.

**Verdict: fail.** Codex emitted no `turn/plan/updated` in the one allowed attempt.

## Observed caps

No plan step was observed, so there is no longest step or largest step count to record.

## Revision 2 planning probes

Recorded 2026-11-06 while replanning, after the probes above. No model output, prompt
beyond its description, credential or account data is recorded.

Versions: Node.js v26.13.0, `@anthropic-ai/claude-agent-sdk` 0.3.316, Claude Code 2.1.318
(`claude` on `PATH`, which cab uses) and codex-cli 0.166.0.

### Claude with both gates

One attempt with the SDK-bundled CLI 2.1.316, then one retry with
`pathToClaudeCodeExecutable` set to the installed 2.1.318; both gave the same result.

- Setup: the options `claude.ts` builds (`settingSources: []`, `strictMcpConfig`,
  `managedSettings.disableAllHooks`, `permissionMode: "dontAsk"`, cab's sandbox and
  `disallowedTools`, PreToolUse, PostToolUse and PostToolUseFailure hooks and a deny-all
  `canUseTool`), with `tools`/`allowedTools` set to cab's turn tools plus `TodoWrite`. The
  environment followed `claudeTurnEnvironment` with a fresh `CLAUDE_CONFIG_DIR`, plus
  `CLAUDE_CODE_ENABLE_TASKS=0` and `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. The model was the
  default, `claude-sonnet-5-5`. The task was to read three files, write a summary file,
  read it back and track progress with the todo tool.
- `system/init` tools were `Task, Bash, Edit, Glob, Grep, Read, TodoWrite, Write`. The
  result was `success` after 10 turns.
- PostToolUse fired for `TodoWrite` four times, interleaved with Read and Write. The
  statuses went `[in_progress, pending, pending]` → `[completed, in_progress, pending]` →
  `[completed, completed, in_progress]` → `[completed, completed, completed]`.

**Verdict: pass.**

### Codex without the gate

One attempt with the operator's Codex home, cab's `-c` flags and a realistic task: read
three files, write `summary.md`, verify it, and keep and update a plan. The turn completed
with 7 `commandExecution` items, 1 `fileChange`, 5 `agentMessage` and 1 `reasoning`. No
`turn/plan/updated` was emitted.

**Verdict: fail.**

### Gate discovery

`codex app-server -c tools.update_plan=true --print-startup-config` fails with
`expected struct UpdatePlanToolConfig`, and `-c tools.update_plan={enabled=1}` fails with
`expected a boolean in tools.update_plan.enabled`. An unknown key is accepted silently.

### Codex with `-c tools.update_plan.enabled=true`

One attempt with the same task. It used an isolated `CODEX_HOME` holding only an
`auth.json` symlink to the operator login, an isolated `HOME` as cab uses, cab's `-c`
flags and `experimentalApi`. The account used a ChatGPT login and model `gpt-6.1-sol`.

- The turn completed, and four `turn/plan/updated` notifications arrived. Their params
  keys were `threadId, turnId, explanation, plan`, with `explanation` null each time. Each
  had 3 steps, the longest 59 characters.
- The statuses went `[inProgress, pending, pending]` → `[completed, inProgress, pending]`
  → `[completed, completed, inProgress]` → `[completed, completed, completed]`.
- No `update_plan` item type appeared.

**Verdict: pass.**

This run changed both the flag and the home, so the flag's effect is not isolated. cab
sets both.
