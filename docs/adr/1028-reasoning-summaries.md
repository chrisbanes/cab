---
status: accepted
---

# Opt-in reasoning summaries

cab collects no reasoning. Execution reads report `reasoning: "not-collected"`, Codex
diagnostics are metadata only, Claude `thinking` blocks are dropped, and cab requests
reasoning summaries from neither runtime. Operators reviewing or debugging an agent's work
cannot see why it chose an approach. Both runtimes can be asked for provider-produced
summaries of their reasoning. This decision lets a project opt in to collecting and showing
them. The [probes](../evidence/reasoning-summary-probes-2026-11-06.md) found usable summaries
from Claude Code but not from Codex. The project setting, admission snapshot and confirmed
delete command are implemented. Requesting, storing and displaying summaries remain
unimplemented: cab still collects no reasoning, so deletion currently has nothing to erase.

## Decision

Reasoning summaries help an operator understand an agent's decisions during review and
debugging. They are not a live progress feed or an audit trail.

- **Collection.** cab collects provider-produced reasoning summaries only, from runtimes
  whose summaries are usable (see [Runtimes](#runtimes)). It never collects raw reasoning,
  even where a provider exposes it. A runtime that offers only raw reasoning shows none.
- **Setting.** Reasoning summaries are a separate project setting, `reasoningSummaries`, off by
  default, beside diagnostic capture.
  - It is a versioned `project.configure` boolean. A revision setting it `true` is rejected
    unless the resulting `diagnosticCapture` is `enhanced`. A revision that switches capture to
    `baseline` sets it to `false` in the same revision, so it never re-enables silently.
  - Like local listening ([ADR-1027](1027-local-listening-for-test-fixtures.md)), it is
    recorded when a turn is admitted, so a change reaches only later turns.
- **Requesting.** A turn admitted with the setting on requests summaries from its runtime
  when that runtime produces usable summaries; today that is Claude Code only. A turn
  admitted with it off sends today's requests and stores no reasoning, whatever the
  runtime emits. Projects that have not opted in run exactly as today.
- **Lead turns only.** Summaries are stored for the lead's turn only, never for a subagent's
  frames.
- **Display.**
  - The web task conversation shows a turn's summaries in a collapsed "Reasoning summary"
    disclosure on the agent turn they belong to.
  - The CLI shows them in `logs` only with `--verbose`. The reasoning capture note keeps the
    existing `--verbose` and `coverage.notes` behaviour.
- **Capture health.** Each execution's capture health reports `reasoning` as:
  - `not-requested` when the setting was off or capture was `baseline` for the turn;
  - `collected` when at least one summary was stored;
  - `unavailable` otherwise: summaries were requested but none arrived, the runtime or model
    does not support them, or redaction was unavailable.
- **Opt-out.** Switching the setting off stops collection for new turns immediately. Existing
  summaries stay until normal retention unless the operator uses **Delete collected
  reasoning**, a confirmed, irreversible service command on the same setting that erases the
  project's stored summaries. Settings exposes it with a confirmation.
- **Protection.** Summaries are stored with the agent turn under the same retention and
  redaction as assistant text, including deleted-project redaction
  (`DeletedProjectRedactionStore`), and are removed with the project. Each turn's summaries
  are capped at 16,000 characters in total. A turn over the cap keeps the first 16,000
  characters and is marked truncated, and every display of it says so. The largest observed
  per-turn total was 593 characters, and 16,000 characters fit the 64 KiB limit on stored
  conversation text even at four UTF-8 bytes per character.

## Runtimes

- **Claude Code.** Requested with the SDK option
  `thinking: {type: "adaptive", display: "summarized"}`, which the SDK passes to the CLI as
  `--thinking=adaptive --thinking-display summarized`. Summaries arrive as `thinking` content
  blocks in assistant frames, each with a signature that is never stored. Frames with a
  `parent_tool_use_id` belong to a subagent, and `redacted_thinking` blocks are never stored.
  A turn may carry several blocks, some empty, interleaved with text and tool use. On a
  diagnosis task at `effort: "high"` the requested turn returned one 593-character summary
  that explained the agent's choice of fix. Thinking tokens are counted within output tokens.
  In one sample each, the requested turn used 1912 output tokens and 285 thinking tokens
  against 1617 and 337 not requested, and cost 0.0598 against 0.0533 USD list; the
  difference follows the tool calls each run made, not the request. The model
  may not think at all on a simple task, even when asked, and then the turn reports
  `unavailable`. The CLI also returns thinking text when not asked, so the off path must drop
  it.
- **Codex.** The App Server accepts `summary: "auto"` on `turn/start` and returns summaries in
  the `summary` array of a `reasoning` thread item, with `item/reasoning/summaryPartAdded` and
  `item/reasoning/summaryTextDelta` notifications; the item's `content` array and
  `item/reasoning/textDelta` carry raw reasoning. At `medium` effort the requested turn
  returned one 32-character heading that named what the agent was fixing but not why, which is
  not usable for review; it used 18 reasoning output tokens against 14 not requested. Codex
  shows none: cab sends Codex turns today's requests, stores no Codex reasoning, and reports
  `unavailable` for a Codex turn admitted with the setting on.
  Requesting Codex summaries later needs evidence of usable output and a revised decision; the
  `summary` override persists for a thread's later turns, so that decision must send
  `summary: "none"` on a turn admitted with the setting off.

## Considered options

- **Collecting raw reasoning.** Rejected: raw reasoning stays provider-private, and a
  runtime that offers only raw reasoning shows none.
- **Always-on collection.** Rejected: summaries add stored agent text, so a project opts in,
  and only while it already accepts `enhanced` capture.
- **Live reasoning streams.** Out of scope: the purpose is review and debugging, not progress.

## Consequences

- Projects that do not opt in are unchanged, and capture health reports `not-requested` for
  them.
- An opted-in project's operators can read why a Claude Code agent chose an approach, on turns
  where the model thinks. Codex turns show no summaries.
- A turn may legitimately produce no summary when the model does not reason, so `unavailable`
  is an expected outcome, not a fault.
- Summaries add stored text under existing retention and redaction, bounded by the per-turn
  cap, and **Delete collected reasoning** gives the operator an irreversible way to remove
  them early.
