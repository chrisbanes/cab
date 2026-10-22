# Unblock waiting work

**Status:** implemented. Wait reasons with a Fix appear on the task and the
composer, and the project page's paused banner and the getting-started Project row
offer Resume, which confirms once and sends only the project resume. The Inbox shows
holds without a Fix and is outside the budget. The budget is asserted only for a
paused project (Resume project, the one Fix with a confirmation) at 1366 x 900 and
390 x 844 by `test/operator/operator-unblock-work-browser.test.ts` ("unblock waiting
work budget"), on task detail, the getting-started Project row on Home, the project page and the
composer. It does not cover the created-task receipt or the Project row at
`/app/getting-started`.

## Goal

Wherever the operator sees that work is waiting on something they can change,
the fix is beside it, performs that one action, and the wait reason updates in
place.

## Entry points

- Task detail decision card and status strip.
- Composer "If you create it now" and the created-task receipt.
- Project page paused banner.
- Getting-started checklist Project row.
- Operator CLI task reads (prints the command or Settings path).

## Steps

1. The wait reasons are listed in the fixed order the
   [specification](../SPEC.md#task-creation-and-project-setup) defines, the first
   primary with its Fix.
2. Resume project confirms once, stating that holds and access are unchanged, then
   sends only the project resume. Every other Fix opens the screen that clears it.
3. The reason list re-reads after the Fix; a cleared reason disappears and the next
   becomes primary.

## Budget

| Entry point | Interactions to the fix sent or its screen open | First screen must show |
| --- | --- | --- |
| Task detail | 2 (Fix, confirm) | the first reason, with its Fix where one exists |
| Getting-started Project row | 2 (Resume, confirm) | the paused project and Resume |
| Project page | 2 (Resume project, confirm) | the paused state and Resume |
| Composer | 2 (Fix, confirm) | the verdict and the first reason |

The budget applies where the specification gives the wait a Fix; a dependency,
approval, source, capacity, power-supervision, held-assignment or recovery wait
shows its blocking link or explanation instead, and no Fix is invented for it.
The operator CLI is outside the budget: it has no screens.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- A Fix never clears holds or grants access by implication.
- Holds a Fix leaves in place are listed beneath it with what clears each and a
  link to each assignment's recovery page (the task's Execution view when it has
  no assignment); the Resume project confirmation names them.
- An unknown outcome blocks a second send until Check whether it saved replays the
  exact request.
- Pause remains the counterpart in project configuration.
