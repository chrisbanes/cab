# First run to first task

**Status:** implemented. The screens exist ([getting started](getting-started.md),
[project setup](project-setup.md), [first task](first-task.md)) and the one-command
install is implemented ([operations](../operations/standalone-macos.md#install)).
The interactions budget is asserted at 1366 × 900, 390 × 844 and in WebKit at
390 × 844 by `first run budget: seven interactions from sign-in to a created task`
in `test/operator/operator-first-run-browser.test.ts`, from a fresh sign-in on Home.
The install command and the other ways to reach project setup (the account menu's
Getting started page, Settings → Projects → New project, the sidebar's New project
link) are not asserted; they lead to the same setup screen.

## Goal

From a downloaded release to a task running its first turn in one sitting, with
each screen leading to the next and nothing to look up.

## Entry points

- A release tarball on a Mac with Codex or Claude Code installed.
- A fresh sign-in on an installation with no project.

## Steps

1. One install command unpacks the release, asks for the operator password when no
   auth file exists, installs the LaunchAgent, waits for the service and opens the
   sign-in page. The `tar -xzf` line before the command only makes the tarball's own
   `ensemble` runnable ([operations](../operations/standalone-macos.md#install)).
2. Sign in. Home shows the getting-started card and nothing else until the first
   turn.
3. Project setup creates the lead profile inline (name and runtime), then the project;
   the ready check replaces the form and offers Resume and create first task.
4. The composer opens with the project selected; Create and start.
5. Task detail shows the running turn, or the wait with its Fix where one exists
   and otherwise the link to what blocks it.

## Budget

| Entry point | Interactions to a created task | First screen must show |
| --- | --- | --- |
| Fresh sign-in, no project | 7 (Create project, fill setup, Create profile, Create paused project, Resume and create first task, fill, Create and start) | the getting-started card with Create project in the first view |

Count clicks and key presses after sign-in; one screen's form fill (one or more
fields before that screen's next action) counts as one. Install and service start are
outside the count, and the other setup entry points are not budgeted here.

| Entry point | Screens to a running task | First screen must show |
| --- | --- | --- |
| Install command | 5 (sign-in, Home, setup, ready check, composer) | after install: the sign-in page, opened for the operator |
| Fresh sign-in, no project | 4 (Home, setup, ready check, composer) | the getting-started card with one primary action |

Each getting-started row has one action and no two rows open the same screen.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- The readiness check names each problem with one fix; a problem the service can
  fix on its own (a data directory mode) is fixed, not reported.
- Leaving setup before Create discards the draft with a prompt; a created project
  stays paused until Resume.
- GitHub is optional for a repository-free project. Setup step 3 (behind Add a
  repository) is the one place the first-run path offers the one-click GitHub CLI
  login; Settings → Readiness offers it again later, as a separate step.
