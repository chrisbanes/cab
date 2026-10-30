---
status: accepted
---

# Present a task as one conversation with curated tool activity

Task detail treated conversations as supporting history, disclosed underneath the
overview. In practice the History tab showed each captured assistant item as a
separate disclosure titled by date, assignment and lifecycle, with omissions as
identifier-heavy rows. Operator messages, questions, results and tool activity sat
elsewhere or, for tool activity, only in `cab logs`. Following what an agent did and
why meant reassembling it across tabs, so the task view was hard to read.

## Decision

- The task Overview is the task's conversation. A compact attention card listing
  what is waiting on the operator stays pinned at the top, the lead's conversation
  runs oldest to newest beneath it, and the reply composer is docked at the bottom.
  The brief, evidence and assignments move to the inspector. The History tab is
  removed; links that opened it (`#history`, `?section=context`, `?assignment=`)
  open the Overview at the matching place in the conversation.
- The conversation interleaves records cab already keeps: captured assistant text,
  operator messages and follow-ups, questions and their answers, approvals, results,
  delegations and tool activity. Assistant text renders as sanitized Markdown with a
  raw-text view. Delegated assignments appear inline, where the lead delegated them,
  as collapsible sub-conversations that keep their assignment, profile and harness.
- A question or approval can be answered from the attention card or from its place in
  the conversation. Both show the same request state; neither creates a second
  request.
- The service builds the conversation as one paged, per-task timeline read. It merges
  captured history, coordination records and curated tool activity, normalises
  timestamps to milliseconds, and gives each entry a stable ordering key. Records that
  only have second precision order by a fixed kind order within the same second. The
  read applies the existing visibility, redaction and omission rules.
- Tool activity reaches the browser only through a curated projection: the tool
  kind, a one-line summary (for a command, the command and exit status) and, on
  request, its bounded, redacted output. Runs of consecutive tool calls are grouped
  with a failure count. File changes are a count that opens the Changes tab. cab's
  own coordination tool calls appear as the records they produce, not as tool rows.
  Working directories, workspace paths, raw payloads and service or severity rows
  still do not cross the operator UI boundary.
- The Claude harness records its tool use in the same diagnostic store, with the same
  redaction, size limits and retention as Codex command items, so a conversation
  reads the same whichever harness ran it.
- The conversation is not a complete transcript. Omitted items, tool activity past
  diagnostic retention and activity a harness does not capture appear as inline gap
  markers, with identifiers in the marker's detail. Tool activity remains diagnostic:
  an absent tool row is not evidence that no tool ran.
- Interaction does not change. A reply still goes to one assignment with its
  destination shown first. Mentions that wake other agents remain the separate
  proposal in [#842](https://github.com/chrisbanes/cab/issues/842), which can build on
  this timeline.

## Considered options

- Keep per-item disclosures and render their text as Markdown. Rejected: it keeps
  each item readable but leaves the story split across tabs and out of order.
- An attention rail beside a conversation grouped by turn, and a compact timeline
  beside a reading pane. Both were prototyped; the single conversation column read
  best and kept the next decision in view.
- One flat stream of every assignment, or a separate conversation per assignment.
  Rejected: the flat stream loses who delegated what, and separate conversations
  hide the delegation in the lead's story.
- Merging the reads in the browser. Rejected: it cannot page or follow live updates
  consistently, and it spreads the redaction and omission rules across the client.
- Reading `/executions/:workId/events` from the browser. Rejected: it carries raw
  diagnostic payloads and paths across the boundary.
- Summary counts only for tool activity. Rejected: a failed command is often the
  reason for what the agent did next.

## Consequences

- Diagnostic retention now limits what the conversation shows; older turns keep
  their text and show a gap where tool activity expired.
- Claude tool capture adds diagnostic rows within the existing per-execution and
  installation limits.
- `cab logs` and the CLI history commands are unchanged; the CLI remains the full
  diagnostic view.
- `docs/SPEC.md`, `design/DESIGN.md` and `docs/acceptance.md` describe the target. The
  route crosswalks in `docs/design/ui02-foundation.md`, `ui06-configuration.md` and
  `ui08-foundation.md`, and the user flows, describe the built History tab until the
  conversation view ships and they are revised with it.
