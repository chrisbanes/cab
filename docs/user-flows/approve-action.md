# Approve an exact action

**Status:** built for the three budgeted entry points. The Review material & decide
link opens the exact-material page at the approval item, and the recorded decision
returns to the same item. The budget is asserted at 1366 × 900 and 390 × 844 by
`test/operator/operator-approve-action-browser.test.ts` ("approve an exact action
budget"); its Home cases pin runtime readiness to passing.

## Goal

The operator reads the exact action, target and material, decides once, and sees
the decision recorded against that material.

The Inbox never approves or denies. The decision is made on the retained
exact-material destination, because the [specification](../SPEC.md#github-and-completion)
binds approval to "the action, target, requester and reviewed material; changed
material invalidates approval".

## Entry points

- Home "Needs you" card.
- Inbox queue row.
- Task detail decision card.
- Browser notification (opt-in, Settings → Notifications): opens the exact Inbox
  selection after sign-in. It is outside the budget below, and it never approves.
- Operator CLI `approval decide`.

## Steps

1. The row or card names the exact action ("Create a pull request") with the task
   beneath it and Review material & decide.
2. The request pane shows action, target, requester, material version and any
   independent hold the decision does not clear, then one Review material & decide.
3. The exact-material view shows the material in full with "Approve this exact
   material" and Deny. Approve records the decision in one submission; Deny is the
   alternative, and leaving the page keeps the request pending.
4. The recorded decision shows on the request, the task and the Inbox row, with any
   remaining hold stated beside it.

## Budget

| Entry point | Interactions to a recorded decision | First screen must show |
| --- | --- | --- |
| Home card | 2 (Review material & decide, Approve this exact material) | the exact action and the task |
| Inbox row | 3 (row, Review material & decide, Approve this exact material) | the exact action in the row |
| Task decision card | 2 (Review material & decide, Approve this exact material) | action, target and material version |

The operator CLI is outside the budget: it has no screens.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- Material that changed since the request was read shows "Version n is out of date"
  and requires a fresh read before deciding.
- Denial persists; a replayed decision cannot apply twice.
- A dependency, source or recovery hold stays after approval and is shown with it.
