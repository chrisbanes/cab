# Unblock waiting work

**Status:** planned. Wait reasons with a Fix are implemented on the task, Inbox
and composer; the project page entry point and the budget below are not.

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
| Task detail | 2 (Fix, confirm) | the first reason and its Fix |
| Project page | 2 (Resume project, confirm) | the paused state and Resume |
| Composer | 2 (Fix, confirm) | the verdict and the first reason |

## Recovery

- A Fix never clears holds or grants access by implication.
- An unknown outcome blocks a second send until Check whether it saved replays the
  exact request.
- Pause remains the counterpart in project configuration.
