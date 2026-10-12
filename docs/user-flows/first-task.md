# First task

**Status:** planned changes to the implemented composer and task detail.

## Goal

From **Create and start**, the operator either sees the task running or sees exactly
one reason it waits and a link that fixes it.

## Entry points

- [Project setup](project-setup.md) ready check → **Resume and create first task**.
- [Getting started](getting-started.md) First task row.
- Home and project page **New task**.

## Steps

1. Composer opens with the project selected. Before submission it states whether
   the project would start now or wait, using the same reasons as step 3.
2. **Create and start** opens the new task's detail page.
3. Task detail shows the current state. A waiting task shows its reason with a
   **Fix** action where the operator can clear it:

   | Wait reason                                   | Fix                                                      |
   | --------------------------------------------- | -------------------------------------------------------- |
   | Project paused                                | Resume project (confirmation, then the existing command) |
   | Runtime unavailable                           | Open [readiness check](readiness-check.md)               |
   | Claude token unavailable                      | Open [Add Claude](claude-runtime.md)                     |
   | Lead profile runtime not configured           | Open the profile                                         |
   | Dependency, capacity, approval or source hold | No Fix; link to the blocking task, request or source     |

4. Once the first turn starts, Home drops the getting-started checklist.

## Recovery

- Stop and Resume on the task are unchanged.
- **Save draft** remains the way to keep a task without starting it.
- A Fix action never clears holds or grants access by implication; it performs only
  the named command.

## Other entry points to keep consistent

Inbox items and the operator CLI's task reads show the same wait reasons; the CLI
prints the matching command or Settings path instead of a link.
