# Approve an exact action

**Status:** built for the three budgeted entry points. The Review material & decide
link opens the approval review on the task's Overview
(`/app/tasks/:id?request=<interaction>`), and the recorded decision shows in the same
panel. The budget is asserted at 1366 × 900 and 390 × 844 by
`test/operator/operator-approve-action-browser.test.ts` ("approve an exact action
budget"); its Home cases pin runtime readiness to passing.

## Goal

The operator reads the exact action, target and material, decides once, and sees
the decision recorded against that material.

The Inbox never approves or denies. The decision is made in the task's approval
review, which shows the exact material, because the [specification](../SPEC.md#github-and-completion)
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
3. The approval review shows the action, target, version and material fields with
   "Approve this exact material" and Deny. Approve records the decision in one
   submission; Deny is the alternative, and Leave pending keeps the request open.
4. The recorded decision shows on the request, the task and the Inbox row, with any
   remaining hold stated beside it.

## Budget

| Entry point | Interactions to a recorded decision | First screen must show |
| --- | --- | --- |
| Home card | 2 (Review material & decide, Approve this exact material) | the exact action and the task |
| Inbox row | 3 (row, Review material & decide, Approve this exact material) | the exact action in the row |
| Task decision card | 2 (Review material & decide, Approve this exact material) | action, target and material version |

The operator CLI is outside the budget: it has no screens.

## Recovery

- An approval decided, changed or withdrawn since it was read records nothing and
  offers Review current material before deciding again.
- An unconfirmed send offers Check whether it saved, which resends the same request.
- Material or a target the read withholds can only be denied.
- Denial persists; a replayed decision cannot apply twice.
- A dependency, source or recovery hold stays after approval and is shown with it.
