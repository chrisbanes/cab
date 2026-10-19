# Create a task

**Status:** implemented. The budget is asserted at 1366 × 900 and 390 × 844 by `create a task budget: three interactions from New task` in `test/operator/operator-composer-layout-browser.test.ts`, from New task on a project page and on the tasks overview. Getting started, Project setup and the project page open the same project-scoped composer URL.

## Goal

The operator describes the outcome, sees whether it would start now, and creates
it in one submission.

## Entry points

- New task in the top bar.
- Project page New task.
- Getting-started First task row.
- [Project setup](project-setup.md) ready check → Resume and create first task.
- Operator CLI `task create`.

## Steps

1. The composer opens with the project selected when the entry point names one.
2. Project, title and desired outcome are the form; optional context, references,
   assignee and dependencies disclose beneath them.
3. "If you create it now" states Starts now or Will wait with the reasons, and the
   caveat that created is not running only with Will wait; the bar beside Create
   and start and Save draft only explains that Save draft keeps it without starting.
4. Draft with lead, a closed panel above the fields, takes a rough idea and has the
   project lead propose a title and outcome from the linked repositories
   ([Drafting runs](../SPEC.md#drafting-runs)). Empty fields are filled; a field
   already written shows the proposal beside it with Replace or Keep mine. Nothing is
   saved until Save draft or Create and start. The panel is outside the budget below:
   it adds no step to a task written by hand.
5. Create and start shows "Task created" with Open task and any wait, with its
   Fix where the specification gives one and otherwise the link to what blocks it.

## Budget

| Entry point | Interactions to a created task | First screen must show |
| --- | --- | --- |
| Any | 3 (open, fill, Create and start) | project, title, outcome and the verdict |

Unfinished input survives navigation on this device and is offered for recovery.
The operator CLI is outside the budget: it has no screens.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- Save draft keeps the task without starting it; drafts are not Ready.
- A refused creation keeps the input and names the field.
- An unknown outcome offers Check whether it saved, which replays the exact request.
- A stopped or failed draft shows Retry and Dismiss and keeps the idea, title and
  outcome. Reloading or locking a phone reattaches to a draft in progress.
  A stopping draft offers Stop again, which retries removing a working copy that was held.
