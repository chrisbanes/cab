# Getting started

**Status:** planned. Today a new installation lands on "Create a project in existing
operator controls to begin." with no link.

## Goal

After the first sign-in, the operator always knows the next step to a running task,
and each step opens the screen that completes it.

## Entry points

- Home (`/app`) while no task has run in this installation.
- Account menu → Getting started, until it is dismissed.

## Checklist

Each row is derived from current service state on every read; there is no stored
wizard progress. A row shows Done, Next or Needs attention, with one action.

| Row               | Done when                                                                          | Action                                                                                |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Runtime           | The Codex login is readable by the service ([readiness check](readiness-check.md)) | Open readiness check                                                                  |
| GitHub            | A discovery credential is configured and readable                                  | **Use GitHub CLI login (@account)** when detected; otherwise Set discovery credential |
| Lead profile      | At least one profile exists                                                        | Create in [project setup](project-setup.md)                                           |
| Project           | At least one project exists and is enabled                                         | Create project, or **Resume** a paused one                                            |
| First task        | A task has started a turn                                                          | Create task ([first task](first-task.md))                                             |
| Claude (optional) | A Claude token reference is readable                                               | [Add Claude](claude-runtime.md)                                                       |

- Only the first incomplete required row is primary; the rest are secondary.
- GitHub is optional for a repository-free project: the row says so and never blocks
  the Project row.
- The checklist leaves Home after the first task starts a turn. The account-menu
  entry remains until the operator dismisses it.

## Recovery

- A row that regresses (login expired, token removed) returns to Needs attention
  on Home even after dismissal, because it reflects current state.
- Dismissal is per installation and can be undone from the account menu.

## Out of scope

Install and service start; see [readiness check](readiness-check.md).
