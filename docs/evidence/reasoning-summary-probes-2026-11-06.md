# Reasoning summary probes

Recorded 2026-11-06 for [#1514](https://github.com/chrisbanes/cab/issues/1514), proof T1 of
the approved plan (revision 1). Base `d84460fb6a60d0a5a6e9bd32a3389701d2f87dd0`; no runtime
code changed. Probe scripts were throwaway files under `/tmp`. No credential, account data,
session, thread or turn id, thinking signature, or model output, summary or reasoning text is
recorded; only structure, counts, lengths, usage and timings.

Versions: Node.js v26.13.0, `@anthropic-ai/claude-agent-sdk` 0.3.316 from the checkout,
Claude Code 2.1.318 (`claude` on `PATH`, passed as `pathToClaudeCodeExecutable`) and
codex-cli 0.166.0.

## Setup

Each run used a fresh Git workspace under `/tmp` with three short files: two describing
alternative caching approaches and one listing constraints. The prompt was the same for
every run: read the three files, choose an approach, write `decision.md` with a
one-paragraph justification, and run no other commands. Each run was one `query()` or one
`turn/start`, with a 10-minute timeout. No run timed out.

- **Claude.** The options `startTurn` builds: `settingSources: []`, `strictMcpConfig`,
  `managedSettings.disableAllHooks`, `permissionMode: "dontAsk"`, cab's sandbox options and
  `disallowedTools`, `tools`/`allowedTools` set to cab's turn tools, pass-through PreToolUse,
  PostToolUse and PostToolUseFailure hooks, a deny-all `canUseTool`, and the
  `claudeTurnEnvironment` variables with a fresh `CLAUDE_CONFIG_DIR`. cab's MCP tools and
  repository instructions were omitted. Subscription auth. Model was the CLI default,
  `claude-sonnet-5-5`; effort was unset (the CLI default) except where noted.
  - **C-N:** these options unchanged.
  - **C-R:** plus `thinking: {type: "adaptive", display: "summarized"}`. The installed SDK
    passes this to the CLI as `--thinking=adaptive --thinking-display summarized`.
  - **C-R retry:** C-R plus `effort: "high"`, the plan's one allowed retry.
- **Codex.** `codex app-server` with cab's `-c` flags (`approval_policy=never`,
  `sandbox_mode=workspace-write`, `tools.update_plan.enabled=true`,
  `cli_auth_credentials_store=file`, `features.multi_agent=false`, `features.plugins=false`,
  `features.skill_mcp_dependency_install=false` and the shell `HOME`), an isolated
  `CODEX_HOME` holding only an `auth.json` symlink to the operator login, and an isolated
  `HOME`. After `initialize` with `experimentalApi`, a fresh thread per condition with cab's
  `thread/start` params and a `turn/start` with cab's `executionPolicy` `sandboxPolicy`. cab's
  dynamic tools were omitted. ChatGPT auth. Model was the default, `gpt-6.1-sol`; effort was
  unset, and the model catalogue (`model/list`, no model turn) gives its default effort as
  `low`.
  - **X-N:** no `summary`.
  - **X-R:** `summary: "auto"`.
  - **X-R retry:** `summary: "detailed"`, the plan's one allowed retry.

Six model turns were used, the plan's maximum. No harness failure occurred.

## Claude

| Run       | Result  | SDK turns | Wall ms | `duration_ms` / `duration_api_ms` | Output tokens | Thinking tokens | Cost (USD, list) |
| --------- | ------- | --------: | ------: | --------------------------------: | ------------: | --------------: | ---------------: |
| C-N       | success |         5 |   21042 |                     19919 / 20444 |           782 |               0 |           0.0669 |
| C-R       | success |         5 |   14049 |                     13133 / 13628 |           765 |               0 |           0.0373 |
| C-R retry | success |         5 |   12442 |                     11678 / 12125 |           799 |               0 |           0.0376 |

Thinking tokens are `usage.output_tokens_details.thinking_tokens` and
`modelUsage["claude-sonnet-5-5"].thinkingTokens`; both were 0 in every run. Each run also
made one `claude-haiku-5-5` call of 1228 input and 18 output tokens.

Shape, identical in all three runs:

- Frames: `system/init` 1, `rate_limit_event` 1, `assistant` 5, `user` 4, `result/success` 1.
- Assistant blocks in order: `tool_use` ×4 (Read, Read, Read, Write), then `text`.
- `thinking` blocks: 0. `redacted_thinking` blocks: 0. `system`/`thinking_tokens` frames: 0.
  No assistant frame had a `parent_tool_use_id`.
- Summary characters per turn: 0; largest summary: 0.

Usability: no summary text existed to judge. Requesting summarised adaptive thinking, with
default or high effort, did not make the model think on this task.

**Verdict: not usable: none emitted.**

## Codex

| Run       | Result    | Wall ms | Total input / cached | Total output | Reasoning output | Last turn input / output |
| --------- | --------- | ------: | -------------------: | -----------: | ---------------: | -----------------------: |
| X-N       | completed |   14384 |        42731 / 38528 |          258 |                0 |               14446 / 39 |
| X-R       | completed |   12913 |        42702 / 28160 |          225 |                0 |               14427 / 23 |
| X-R retry | completed |   14482 |        42765 / 28160 |          268 |                0 |               14464 / 40 |

Usage is the last `thread/tokenUsage/updated` `total` and `last` breakdown;
`reasoningOutputTokens` was 0 in both in every run, and `cacheWriteInputTokens` was 0.

Shape, the same in all three runs:

- Completed items: `userMessage` 1, `agentMessage` 2, `commandExecution` 1, `fileChange` 1.
  The agent read the files with one command despite the prompt.
- `reasoning` items: 0, so no `summary` or `content` parts to count.
- `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded` and
  `item/reasoning/textDelta` notifications: 0.
- Summary characters per turn: 0; largest summary: 0.
- No server requests arrived.

Usability: no summary text existed to judge. The model did no reasoning at its default `low`
effort, with or without a summary request.

**Verdict: not usable: none emitted.**

The [agent plan capture probes](agent-plan-capture-probes-2026-11-06.md) recorded Codex
`reasoning` items on other tasks with cab's `-c` flags and no summary request, using the
operator's Codex home rather than an isolated one; their `summary` and `content` fields were
not measured.

## Cost comparison

One sample per condition, indicative only. With no reasoning in any run, requesting summaries
changed neither runtime's output: Claude's output tokens were 782 not requested against 765
and 799 requested, and Codex's 258 against 225 and 268. The wall-clock and cost differences
come from prompt caching (Claude's not-requested run wrote 14083 cache tokens against about
6540 in the others) and run-to-run variation, not from the request.

## Observed caps

No summary was emitted, so there is no largest per-turn total from which to set the per-turn
cap.

## Round one result

Neither runtime produced a provider-designated summary in the allowed runs, because neither
model reasoned on this task at its default settings. The evidence does not show that
summaries are unavailable when a model does reason, and it does not show raw reasoning
without summaries.

**Round one result: proposed.** The maintainer then authorized a second round on a task that
needs reasoning ([decision](https://github.com/chrisbanes/cab/issues/1514#issuecomment-6683602179)).

## Round two

Recorded 2026-11-06 on base `003266d11b8a81c0b7ce849f2cd3b0690ccc60fd`, with the same
versions, setup and recording rules as round one, except as stated here.

- **Task.** Each run used a fresh Git workspace under `/tmp` holding a small Node.js module
  split across five source files, with one failing `node:test` test. The failure had two
  interacting causes in different files. The prompt asked the agent to run the test, diagnose
  the root cause across the source files, fix the source rather than the test, and write
  `diagnosis.md` explaining the root cause and the chosen fix.
- **Effort.** Claude ran with `effort: "high"` in both conditions. Codex ran with `medium`,
  set as cab sets a configured effort: `config.model_reasoning_effort` on `thread/start` and
  `effort` on `turn/start`.
- **Conditions.** C-N and X-N as in round one; C-R and X-R requested summaries as in round
  one (`display: "summarized"`, `summary: "auto"`). Each requested run produced summary text,
  so no retry was allowed or used.

Four model turns were used, within the grant of six. No harness failure occurred and no run
timed out. In every run the agent fixed both causes and the test passed afterwards.

### Claude

| Run | Result  | SDK turns | Wall ms | `duration_ms` / `duration_api_ms` | Output tokens | Thinking tokens | Cost (USD, list) |
| --- | ------- | --------: | ------: | --------------------------------: | ------------: | --------------: | ---------------: |
| C-N | success |         4 |   22050 |                     21090 / 21131 |          1617 |             337 |           0.0533 |
| C-R | success |         5 |   20416 |                     19637 / 19569 |          1912 |             285 |           0.0598 |

Thinking tokens are `usage.output_tokens_details.thinking_tokens`, which equalled
`modelUsage["claude-sonnet-5-5"].thinkingTokens`. Each run also made one `claude-haiku-5-5`
call of 1237 input and 24 output tokens with no thinking.

- **C-N.** Frames: `system/init` 1, `rate_limit_event` 1, `assistant` 6, `user` 3,
  `system/thinking_tokens` 17 (last `estimated_tokens` 220), `result/success` 1. Blocks in
  order: `tool_use` ×2, `thinking` ×2, `tool_use`, `text`. The first `thinking` block was
  empty and the second had 214 characters; both had a signature. Tools used: Bash ×3.
- **C-R.** Frames: `system/init` 1, `rate_limit_event` 1, `assistant` 7, `user` 4,
  `system/thinking_tokens` 51 (last `estimated_tokens` 320), `result/success` 1. Blocks in
  order: `tool_use` ×2, `thinking`, `text`, `tool_use` ×2, `text`. One `thinking` block of 593
  characters, with a signature. Tools used: Bash ×3, Write.
- Both runs: no `redacted_thinking` block, and every frame carrying a `thinking` block had
  `parent_tool_use_id` null.
- Per-turn summary totals: C-N 214 characters, C-R 593; the largest single block was the
  same as each total.

Without the option, the CLI still returned thinking text by its own default. cab does not
treat that turn as requested, so it would store none of it.

Usability (C-R): the summary, written in the first person, names both causes and explains
why the agent chose its fix location over the alternative it considered.

**Verdict: usable.**

### Codex

| Run | Result    | Wall ms | Total input / cached | Total output | Reasoning output | Last turn input / output |
| --- | --------- | ------: | -------------------: | -----------: | ---------------: | -----------------------: |
| X-N | completed |   34309 |        75214 / 65792 |         1019 |               14 |               16561 / 78 |
| X-R | completed |   28400 |        60658 / 36992 |          929 |               18 |               16453 / 81 |

`thread/start` reported effort `medium` in both runs.

- **X-N.** Completed items: `userMessage` 1, `agentMessage` 3, `commandExecution` 7,
  `reasoning` 1, `fileChange` 1. The `reasoning` item had 0 `summary` parts and 0 `content`
  parts. No reasoning notifications arrived.
- **X-R.** Completed items: `userMessage` 1, `agentMessage` 3, `commandExecution` 5,
  `reasoning` 1, `fileChange` 1. The `reasoning` item, on the turn's thread and turn, had 1
  `summary` part of 32 characters and 0 `content` parts. One `summaryPartAdded` and one
  `summaryTextDelta` arrived, on the same thread and turn, and the completed `summary` equalled
  the concatenated deltas. No `textDelta` (raw reasoning) arrived.
- Per-turn summary totals: X-N 0 characters, X-R 32.

Usability (X-R): the summary was only a short bold heading naming the area being fixed. It
did not explain the causes or why the agent chose its fix.

**Verdict: not usable: heading only.** The summary field works as documented, but at this
effort it carried no explanation.

### Round two cost comparison

One sample per condition, indicative only.

- **Claude.** Requested against not requested: 1912 against 1617 output tokens, 285 against
  337 thinking tokens, 0.0598 against 0.0533 USD, and 19637 against 21090 `duration_ms`. The
  request changed the thinking display, not whether the model thought, and the run-to-run
  differences in tool calls dominate.
- **Codex.** Requested against not requested: 929 against 1019 output tokens, 18 against 14
  reasoning output tokens, and 28400 against 34309 wall ms. The differences follow the number
  of commands run (5 against 7), not the request.

### Round two caps

The largest per-turn summary total observed was 593 characters (Claude, C-R). Codex's was 32.

## Gate result

Claude produced a usable provider-designated summary on the lead's turn when requested.
Codex produced a provider-designated summary, but it was not usable. Codex `content` (raw
reasoning) was empty in every run and was never counted.

**Gate result: accepted**
