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

- The task Overview is the task's conversation. A compact Decisions and holds card
  stays pinned for open questions, approvals and result review requests, execution uncertainty or Stop,
  active source holds, interventions, wait reasons and operator-action recovery.
  Ordinary writer and capacity holds while a turn starts or runs stay on Execution,
  and waiting for capacity is named by the strip, never pinned. The task strip shows
  its state badge and at most one distinct reason, without repeating the next actor
  or readiness wording. The lead's conversation runs oldest to newest beneath it, and
  the reply composer is docked in view at the bottom of the conversation column.
  Untargeted first visits open at the newest entry; explicit links win, while return
  visits and updates keep the reading position, disclosures and drafts. On phones,
  Latest result and Task details follow the conversation.
  The subtitle uses the first meaningful outcome sentence, skipping headings, quotes
  and source metadata. The one-line strip carries one source identity chip, and shows
  the lead only when different from the project default. Operator next actions link
  to their decision. Refresh source, Focus mode and Improve with lead share one
  overflow menu; polling and New updates replace Refresh task.
  The brief, evidence and assignments move to the inspector. The History tab is
  removed; conversation links (`#history`, `?section=history`, `?assignment=`)
  open the Overview at the matching place in the conversation. Captured context lives
  on Execution; `?section=context`, `#context` and captured-record links reveal it there.
  Latest result keeps legacy `#review`; viewing-reference controls live on Review.
- The conversation interleaves records cab already keeps: captured assistant text,
  operator messages and follow-ups, questions and their answers, approvals, results,
  delegations and tool activity. Assistant text renders as sanitized Markdown with a
  raw-text view. Delegated assignments appear inline, where the lead delegated them,
  as collapsible sub-conversations that show the agent, harness, state and the brief's
  first sentence, with the full brief on request.
- A question or approval can be answered from the attention card or from its place in
  the conversation. Both show the same request state; neither creates a second
  request.
- A result review request is the exception to conversation-first reading: it opens a
  decision-focused panel in the attention card, and the same panel in the Inbox
  ([ADR-1035](1035-result-review-requests.md)). The panel carries the decision, the lead's
  recommendation, what changed, criteria, evidence and remaining uncertainty, so the
  operator does not reconstruct the decision from the conversation, which stays one link
  away.
- The service builds the conversation as one paged, per-task timeline read. It merges
  captured history, coordination records and curated tool activity, normalises
  timestamps to milliseconds, and gives each entry a stable ordering key. Records that
  only have second precision order by a fixed kind order within the same second. The
  read applies the existing visibility, redaction and omission rules.
- Tool activity reaches the browser only through a curated projection: the tool
  kind, a one-line summary (for a command, the command and exit status) and, on
  request, its bounded, redacted output. Runs of consecutive tool calls are grouped
  with a failure count. File changes open Changes: in a side pane at 1024px and wider, otherwise the tab. cab's own coordination
  tool calls appear as the records they produce, not as tool rows. Working
  directories, absolute workspace paths, raw payloads and service or severity rows still do not
  cross the operator UI boundary. [ADR-1025](1025-conversation-activity-plans-and-change-notifications.md)
  widens the projection with durations, repository-relative file paths and one
  allowlisted target per non-command tool, and adds agent plans and push change
  notices.
- The Claude harness records its tool use in the same diagnostic store, with the same
  redaction, size limits and retention as Codex command items, so a conversation
  reads the same whichever harness ran it.
- The conversation is not a complete transcript. Omitted items, tool activity past
  diagnostic retention and activity a harness does not capture appear as inline gap
  markers, with identifiers in the marker's detail. Tool activity remains diagnostic:
  an absent tool row is not evidence that no tool ran.
- The timeline's interaction is the shared task comment: one operator contribution
  with zero or more recipients chosen by assignment identity, shown once at the task
  root. Recording it starts nothing and text never wakes an agent; delivery uses the
  existing inbox, follow-up and admission rules. Contextual feedback, Local review
  and the draft turn keep their own single destinations (see the SPEC's shared task
  comments).

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
- `docs/SPEC.md`, `design/DESIGN.md`, `docs/acceptance.md`, the route crosswalks in
  `docs/design/ui02-foundation.md`, `ui06-configuration.md` and `ui08-foundation.md`,
  and the user flows describe the conversation view as built.
