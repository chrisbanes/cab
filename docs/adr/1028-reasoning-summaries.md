---
status: proposed
---

# Opt-in reasoning summaries

cab collects no reasoning. Execution reads report `reasoning: "not-collected"`, Codex
diagnostics are metadata only, Claude `thinking` blocks are dropped, and cab requests
reasoning summaries from neither runtime. Operators reviewing or debugging an agent's work
cannot see why it chose an approach. Both runtimes can be asked for provider-produced
summaries of their reasoning. This decision lets a project opt in to collecting and showing
them. Its status is `proposed` because the
[probes](../evidence/reasoning-summary-probes-2026-11-06.md) observed no summary from either
runtime; see [What the evidence contradicts](#what-the-evidence-contradicts).

## Decision

Reasoning summaries help an operator understand an agent's decisions during review and
debugging. They are not a live progress feed or an audit trail.

- **Collection.** cab collects provider-produced reasoning summaries only: Codex reasoning
  summaries and Claude summarised thinking. It never collects raw reasoning, even where a
  provider exposes it. A runtime that offers only raw reasoning shows none.
- **Setting.** Reasoning summaries are a separate project setting, `reasoningSummaries`, off by
  default, beside diagnostic capture.
  - It is a versioned `project.configure` boolean. A revision setting it `true` is rejected
    unless the resulting `diagnosticCapture` is `enhanced`. A revision that switches capture to
    `baseline` sets it to `false` in the same revision, so it never re-enables silently.
  - Like local listening ([ADR-1027](1027-local-listening-for-test-fixtures.md)), it is
    recorded when a turn is admitted, so a change reaches only later turns.
- **Requesting.** A turn admitted with the setting on requests summaries from its runtime.
  A turn admitted with it off sends today's requests and stores no reasoning, whatever the
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
  are capped in characters, with a truncation marker when the cap applies. The cap is set
  from evidence, at or above the largest observed per-turn total and within the 64 KiB limit
  on stored conversation text.

## Runtimes

- **Claude Code.** Requested with the SDK option
  `thinking: {type: "adaptive", display: "summarized"}`. Summaries arrive as `thinking`
  content blocks in assistant frames; frames with a `parent_tool_use_id` belong to a subagent.
  `redacted_thinking` blocks are never stored. Thinking tokens are counted within output
  tokens. In the probes the model did not think on the task, with default or high effort, so
  no summary shape, size or cost was observed. A requested turn that stores no summary
  reports `unavailable`.
- **Codex.** Requested with `summary: "auto"` on `turn/start`. Summaries arrive in the
  `summary` array of a `reasoning` thread item, with `item/reasoning/summaryTextDelta` and
  `item/reasoning/summaryPartAdded` notifications. The item's `content` array and
  `item/reasoning/textDelta` carry raw reasoning and are never stored. The `summary` override
  persists for the thread's later turns, so a turn admitted with the setting off on a thread
  that earlier requested summaries sends `summary: "none"`. In the probes the default model
  did no reasoning at its default `low` effort, with `auto` or `detailed` summaries, so no
  summary shape, size or cost was observed. A requested turn that stores no summary reports
  `unavailable`.

## Considered options

- **Collecting raw reasoning.** Rejected: raw reasoning stays provider-private, and a
  runtime that offers only raw reasoning shows none.
- **Always-on collection.** Rejected: summaries add stored agent text, so a project opts in,
  and only while it already accepts `enhanced` capture.
- **Live reasoning streams.** Out of scope: the purpose is review and debugging, not progress.

## Consequences

- Projects that do not opt in are unchanged, and capture health reports `not-requested` for
  them.
- An opted-in project's operators can read why an agent chose an approach, on runtimes and
  turns that produce summaries.
- A turn may legitimately produce no summary when the model does not reason, so `unavailable`
  is an expected outcome, not a fault.
- Summaries add stored text under existing retention and redaction, bounded by the per-turn
  cap, and **Delete collected reasoning** gives the operator an irreversible way to remove
  them early.

## What the evidence contradicts

The decisions assume that requesting summaries from at least one runtime yields usable
summaries. In the [probes](../evidence/reasoning-summary-probes-2026-11-06.md), neither did:
on a small decision task, both runtimes reported zero thinking or reasoning tokens in all six
runs, so no summary, and no raw reasoning, was emitted. The probes therefore cannot confirm
the summary shape, typical size or cost, or set the per-turn cap. They do not show that
summaries are unavailable when a model does reason.
