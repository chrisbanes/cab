# Triage an uncertain execution

**Status:** built. The Inbox intervention and task holds link to the assignment
recovery page, and `test/operator/operator-triage-uncertainty-browser.test.ts`
asserts the budget below at 1366 × 900 and 390 × 844. The Not started section is asserted
by `test/operator/operator-task-restart-browser.test.ts`.

## Goal

When cab cannot say whether an execution has ended, the operator reaches the
evidence for it in a few steps, sees the next supported step, and is never offered
an action that pretends to clear it.

The recovery page is read-only: it releases no ownership and accepts no proof.
Recovery that releases a generation needs the evidence-bearing operations whose
"evidence and attestations the operator states explicitly"
([specification](../SPEC.md#execution-and-recovery)).

## Entry points

- Home "Needs you" card (execution uncertainty first).
- Inbox intervention row.
- Task detail holds and status strip.
- Settings → Runtime → Task recovery destinations.
- Operator CLI `recovery` reads.

## Steps

1. The card or row says what is uncertain and names the task. The Home card, or
   the Inbox's request pane once the row is selected, also says that ownership stays
   held and offers Inspect execution. It shows no last-observed time.
2. Inspect execution opens the task's decision card, where each hold line links
   the assignment recovery page: "Recovery evidence" for one assignment,
   "<profile>: recovery evidence" for each of several, or "Execution details"
   for a task with no assignment. The page shows the holds grid, the held
   generation with its last observation, and the next supported step.
3. Older generations in the same state are collapsed under one line with a count.
4. The next supported step is the only primary action; advanced destinations are
   listed as links.

## Not started: refused before it ran

A request the service refused at admission because its captured revisions no longer
matched, with nothing recorded as having run, is **Not started**, not Uncertain. It
raises the `not-started` attention code, and Start again is its one action, offered
beside the state:

- Task detail, in the decisions beside the task: **Start again**.
- Inbox intervention: the request pane's **Start again**.
- Home "Needs you" card: **Start again** in the card.
- `cab task start-again TASK_ID --expected-version N`.

Start again re-captures the request at the current task, profile and instructions
revisions and queues it under every current admission check, in the same workspace.
The refused request and its refusal stay in the history, and nothing is sent to the
lead. It is one interaction at each entry point and sends exactly one command.

When Start again is not offered (a source hold, a held assignment, a request cut off
during submission or any execution that may have run), the same place shows why and
links to the recovery or the source review that applies. A task whose turn ran or
may have run stays Uncertain and follows the steps above.

**Reset task** is the other way to start work again: it replaces every assignment's
conversation and starts the lead fresh in the same workspace, from the task header
(with a confirmation that says it cannot be undone) or `cab task reset`. It is
offered only when nothing is queued, running or unresolved and the task has no hold.
The old conversation and workspace stay readable.

## Budget

| Entry point | Interactions to the recovery page | First screen must show |
| --- | --- | --- |
| Home card | 2 (Inspect execution, then the hold line) | what is uncertain and "Ownership stays held" |
| Inbox row | 3 (row, Inspect execution, then the hold line) | what is uncertain and "Ownership stays held" |
| Task detail | 1 (the hold line) | the hold named with a recovery link |

Settings → Runtime → Task recovery destinations is the fallback list and is
outside the budget.
The operator CLI is outside the budget: it has no screens.

## Recovery

- A paused project keeps Resume project as the Fix for that reason, and its
  confirmation states that stop, task, writer and uncertainty holds remain. Those
  holds are shown as holds with their recovery link, never as a Fix, so clearing
  the pause is not mistaken for clearing them.
- Unknown ownership or age is stated once, in the headline, and not repeated as
  field values.
- The page refreshes without losing the selected generation.
