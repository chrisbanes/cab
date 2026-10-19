---
status: accepted
---

# Run draft turns as a read-only mode of the lead assignment

An operator often needs to talk to a task's project lead before the task is Ready:
to clarify an imported issue, have the lead investigate the repositories, or let it
comment on or label the issue. Draft (unready) tasks otherwise run no turns. The
glossary defines **Draft turn**; delivery scope lives in
[#1193](https://github.com/chrisbanes/ensemble/issues/1193).

## Decision

- A draft turn is a turn of the task's **project lead assignment**, marked as a draft
  turn on its turn request (`draftTurn`). It is not a new request kind, so it reuses
  the lead's conversation, task workspace, capacity reservation, writer, Stop and
  pause holds, questions, receipts, history and recovery.
- The operator starts one with `task.draft-turn` (task page, CLI). One draft turn per
  task is queued, held or running at a time. The task must be open and not Ready, with a
  configured, unrevoked lead that has not started ordinary work. Project pause, task
  Stop and capacity do not refuse it; they hold it like any other turn.
- Admission drops `task-unready` for a draft turn, and `task-revision-changed` only
  while the task's title and outcome still match the digest captured when the turn was
  queued: making the task Ready bumps its version but does not make a queued draft turn
  stale, and any edit does. Ordinary work on a Draft task keeps every gate, and the
  draft turn waits on every other admission reason. A draft turn refused before it ran
  gives its messages back: they become pending again and the turn no longer counts as
  the task's draft turn.
- During a draft turn the lead may ask questions, request approvals, and use
  `ensemble_external_action` for `issue.comment` and `issue.labels` where grants allow.
  The service refuses every other coordination tool before dispatch. The existing
  rule that refuses readiness labels and fields stays the only readiness protection:
  a draft turn never makes a task Ready, edits task fields, or creates assignments,
  results, completion requests, pull request bindings or pull request actions.
- A draft turn never activates the lead assignment, so the lead stays `pending`. Its
  callbacks bind to a pending lead only when the request is a draft turn.
- The turn is read-only and has no command network access:
  - Codex runs the turn with a per-turn read-only `sandboxPolicy` on a thread that
    was started with workspace-write. The live proof is in
    `docs/evidence/2026-10-19-codex-read-only-turn.md`.
  - Claude removes the workspace from the sandbox write list and from the hook's
    file-edit roots, leaving only the per-task temporary base.
  - The turn uses the same task workspace an ordinary lead turn would. No new
    workspace kind is added and repository access is not widened.
  - Codex keeps broad host reads under a read-only policy. Ensemble claims no
    independent sandbox; the runtime's sandbox and the Claude hook are the controls.
- When the task becomes Ready, the lead is treated as not started. With routing
  disabled the lead's initial turn runs as ordinary execution and resumes the draft
  conversation. With routing enabled, routing runs as for any task, without a
  preliminary lead turn, even when answers to draft-turn questions are pending; they go
  with the fallback or the routed result. A draft turn already queued or running keeps
  its draft restrictions and finishes before the initial turn. Draft prompts and the
  first ordinary turn after draft turns carry the task's current title and outcome.
- An answer to a draft-turn question waits for the next draft turn or for Ready. It
  never starts a turn. Automatic and rule-driven draft turns, triage procedures and
  readiness proposals are out of scope.

## Considered options

- A new request kind, as for drafting runs ([ADR-1013](1013-project-owned-drafting-runs.md)).
  Rejected: questions, approvals, external actions, conversation capture and history
  all key on an assignment and its execution binding, so a new kind would duplicate
  them. Drafting runs belong to a project and have no task; draft turns belong to a
  task and its lead.
- A separate draft assignment. Rejected: at Ready it would leave two lead-like
  assignments, and result and question routing and ordinary routing would need
  special cases.
- Loosening Draft-task admission for the lead. Rejected: it would let a lead delegate,
  write and open pull requests on an unready task. The exemption is one reason, for
  marked work.
- A read-only thread start with a resume on Ready. Rejected: the per-turn policy is
  proven on the installed runtime and keeps one thread.
