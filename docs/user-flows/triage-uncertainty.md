# Triage an uncertain execution

**Status:** built. The Inbox intervention and task holds link to the assignment
recovery page, and `test/operator/operator-triage-uncertainty-browser.test.ts`
asserts the budget below at 1366 × 900 and 390 × 844.

## Goal

When Ensemble cannot say whether an execution has ended, the operator reaches the
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

## Budget

| Entry point | Interactions to the recovery page | First screen must show |
| --- | --- | --- |
| Home card | 2 (Inspect execution, then the hold line) | what is uncertain and "Ownership stays held" |
| Inbox row | 3 (row, Inspect execution, then the hold line) | what is uncertain and "Ownership stays held" |
| Task detail | 1 (the hold line) | the hold named with a recovery link |

Settings → Runtime → Task recovery destinations is the fallback list and is
outside the budget.
The operator CLI is outside the budget: it has no screens.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- A paused project keeps Resume project as the Fix for that reason, and its
  confirmation states that stop, task, writer and uncertainty holds remain. Those
  holds are shown as holds with their recovery link, never as a Fix, so clearing
  the pause is not mistaken for clearing them.
- Unknown ownership or age is stated once, in the headline, and not repeated as
  field values.
- The page refreshes without losing the selected generation.
