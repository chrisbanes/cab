---
status: accepted
---

# Widen the conversation's tool projection, capture agent plans and push change notifications

[ADR-1022](1022-task-conversation-view.md) limits tool activity in the task conversation
to a curated projection: the tool kind, a one-line summary and bounded output on request.
File changes appear only as a count and rows carry no duration. Plans are absent: Claude is
not offered `TodoWrite`, and Codex `turn/plan/updated` events never reach the diagnostic
store. The task view polls every 15 seconds and has no push channel. This decision widens
all three and fixes the new boundary. The tool projection, plan capture and change
notices are implemented.

## Decision

- **Tool rows show duration, paths and one target.**
  - Each tool row records an end time, so rows and command groups can show a duration.
  - File changes carry repository-relative paths. Absolute workspace paths and working
    directories stay excluded.
  - A non-command tool may show one target, from a per-tool allowlist only: Read, Write
    and Edit show the repository-relative path; Grep and Glob the pattern; web search the
    query; MCP tools the server and tool name; Agent the subagent type.
  - A target is capped at 128 characters and passes through the existing projection
    redaction. A path outside the workspace shows as "outside workspace". Unknown tools
    stay name-only. cab's own `cab_*` and `mcp__cab__` coordination tools stay excluded.
  - Tool observation is still never claimed complete: an absent tool row is not evidence
    that no tool ran.
- **A curated plan record per assignment.** A plan is an ordered list of steps, each with
  text and a status of pending, in progress or done. Codex `turn/plan/updated` events and
  Claude `TodoWrite` calls feed it. The latest snapshot is authoritative, and the timeline
  marks when the plan changed. Step text is agent-authored, so it is redacted, and the
  number of steps and their length are capped; the caps are fixed with the record's
  implementation. A plan is the agent's working plan, not a requirement, and stays
  distinct from the task brief.
- **`TodoWrite` joins Claude's offered tools.** Claude's turn tools are a fixed list, and
  the PreToolUse hook refuses any other tool outside cab's coordination tools as outside
  cab's tool policy. `TodoWrite` reads and writes no file, runs no command and reaches no
  network; its only effect is the agent's own in-turn task list. Every call still passes
  the same PreToolUse hook and diagnostic capture, and its payload reaches cab only through
  the redacted, capped plan record. The tool list and the hook allowance change together.
  `EnterPlanMode` and `ExitPlanMode` stay disallowed: they gate approval flow and do not
  display a plan.
- **An authenticated server-sent events stream per task carries change notifications
  only.** A notice says that the task's read or timeline changed and carries no task
  content. The browser refetches through the existing reads, which stay the one
  authoritative path, consistent with ADR-1022's rejection of merging in the browser.
  Polling remains the fallback when the stream drops. The stream is
  `GET /api/operator/tasks/:taskId/stream`, a session-only route: it reuses the cookie
  session, Host check and task visibility of the reads, refuses a foreign `Origin`, and
  sends only `read`, `timeline` and `heartbeat` events with `data: {}`. Notices come from
  committed writes observed at the shared database facade and attributed to the task by
  the ids they bind; a parameterless write that changed rows and names no watched id
  notifies every watched task. A write keyed only by another identifier, such as a
  delivery operation, a runtime question or another task, is not attributed. A heartbeat
  every 15 seconds keeps the session current and ends the stream when it is not; sign-out,
  shutdown and the task leaving the readable set also end it. The browser reconnects with
  jittered back-off from 1 to 30 seconds and polls every 15 seconds while the stream is
  not healthy, and every 60 seconds while it is, so an unattributed change still appears
  within a minute.
- **Reasoning stays uncollected.** A separate ADR decides on it.

## Considered options

- A denylist for targets rather than an allowlist. Rejected: any new tool would leak its
  input by default.
- Keeping absolute or workspace paths for file changes. Rejected: they cross the boundary
  ADR-1022 set.
- Carrying row, plan or timeline content over the stream. Rejected: it creates a second
  authoritative path and brings back the browser merging ADR-1022 rejected.
- Polling only. Kept as the fallback; it alone leaves the view up to 15 seconds stale.
- Streaming text deltas and inline expandable output. Not pursued.
- Collecting reasoning. Left to a separate ADR.
- Copying code from panel libraries. Not pursued; only ideas inform the design.

## Consequences

- Diagnostic capture keeps end time, repository-relative path and allowlisted target
  fields within the existing redaction, size, retention and storage limits. These fields
  extend what ADR-1022 let cross the operator UI boundary; working directories and raw
  payloads still do not.
- Plans become a new record kept per assignment, with their own caps.
- The stream adds a long-lived authenticated connection and a second signalling path, but
  no second content path.
- `docs/SPEC.md`, ADR-1022, `docs/design/operator-cli.md` and `docs/development.md`
  describe the contract. `cab logs` and the
  CLI diagnostic views are not widened by this decision.
