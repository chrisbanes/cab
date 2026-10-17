# Getting started

**Status:** implemented.

## Goal

After the first sign-in, the operator always knows the next step to a running task,
and each step opens the screen that completes it.

## Entry points

- Home (`/app`) until a task starts a turn; the card is then the only content
  below the page heading (no board, stat strip or task filters).
- Account menu → Getting started (`/app/getting-started`), until it is dismissed.

## Checklist

Each row is derived from current service state on every read; there is no stored
wizard progress. A row shows Done, Next or Needs attention, with one action.

| Row               | Done when                                                                          | Action                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Runtime           | The Codex login is readable by the service ([readiness check](readiness-check.md)) | Open readiness check                                                                                          |
| GitHub            | A discovery credential is configured and readable                                  | Set discovery credential, or Discovery settings when done                                                     |
| Project           | An enabled project has a lead profile that is not revoked                          | Create project; **Choose a lead** for an enabled project without one; **Resume** when every project is paused |
| First task        | A task has started a turn                                                          | Create task ([first task](first-task.md)); unavailable until a project exists                                 |
| Claude (optional) | A Claude token reference is readable and `claude` is on the service `PATH`         | [Add Claude](claude-runtime.md); Open readiness check when `claude` is not runnable                           |

- Only the first incomplete required row is primary; the rest are secondary.
- GitHub is optional for a repository-free project: the row says so and never blocks
  the Project row. It is informational and links to Settings → GitHub discovery. The one-click
  **Use GitHub CLI login (@account)** is offered in [project setup](project-setup.md)
  step 3 (the first-run path) and, separately, on the Settings → Readiness GitHub
  discovery row ([readiness check](readiness-check.md)); see "GitHub discovery
  credential" in `design/DESIGN.md` for why.
- Settings actions open their own section, so no two rows open the same place:
  `/app/settings#readiness`, `#github-discovery`, `#readiness-claude-executable`
  and `/app/settings/runtime#add-claude`.
- Create task is shown but unavailable while no project exists: it stays focusable
  and its reason ("Needs a project first.") is announced.
- A required row (Runtime, Project, First task) that is not done
  shows Needs attention when a later required row is done or a turn has started;
  otherwise the first shows Next and the rest Not started.
- The summary counts the three required rows ("1 of 3 required steps done").
- The checklist leaves Home after the first task starts a turn, including on
  return to Home, reload or another session; Home then shows the board with only
  the rows that need attention above it. The account-menu entry remains until the operator
  dismisses it from the checklist page.

## Recovery

- A row that regresses (login expired, token removed) returns to Needs attention
  on Home even after dismissal, because it reflects current state.
- Dismissal is per installation and can be undone from the account menu (Show
  getting started) or the checklist page.

## Out of scope

Install and service start; see [readiness check](readiness-check.md).
