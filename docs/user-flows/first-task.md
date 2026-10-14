# First task

**Status:** implemented.

## Goal

From **Create and start**, the operator either sees the task running or sees why it
waits, led by the reason to clear first and a link that fixes it.

## Entry points

- [Project setup](project-setup.md) ready check → **Resume and create first task**.
- [Getting started](getting-started.md) First task row.
- Home and project page **New task**.

## Steps

1. Composer opens with the project selected. Before submission it states "Starts
   now." or "It will wait: <reason>", using the same reasons and order as step 3
   for the project, the chosen dependencies and the explicit assignee's runtime.
2. **Create and start** shows "Task created." with **Open task**, the execution state
   and the same wait reasons, the first with its Fix.
3. Task detail shows the current state. A waiting task shows its reasons in the
   table's order: the first is primary and carries its **Fix**, and the rest are
   listed beneath it with their own Fix or link. Inbox and CLI use the same order.

   | Wait reason                         | Fix                                                      |
   | ----------------------------------- | -------------------------------------------------------- |
   | Project paused                      | Resume project (confirmation, then the existing command) |
   | Project has no lead                 | Open project configuration to choose a lead              |
   | Project lead revoked                | Open project configuration to choose another lead        |
   | Runtime unavailable                 | Open [readiness check](readiness-check.md)               |
   | Claude token unavailable            | Open [Add Claude](claude-runtime.md)                     |
   | Lead profile runtime not configured | Open the profile                                         |
   | Held by power supervision           | No Fix; shows the power supervisor's hold reason         |
   | Assignment profile revoked          | Open the assignment's profile; does not re-bind it       |
   | Assignment profile changed          | Open the assignment's profile; does not re-bind it       |
   | Assignment instructions changed     | No Fix; names the assignment's profile                   |
   | Assignment profile not permitted    | No Fix; names the assignment's profile                   |
   | Assignment held                     | No Fix; names the assignment's profile                   |
   | Dependency, approval or source hold | No Fix; link to the blocking task, request or source     |
   | Capacity                            | No Fix; shows what is using capacity                     |

   A Fix that opens a screen is a link; only Resume project sends a command. The
   service derives the reasons from current state on every task read.

4. Once the first turn starts, Home drops the getting-started checklist.

## Recovery

- Stop and Resume on the task are unchanged.
- **Save draft** remains the way to keep a task without starting it.
- A Fix action never clears holds or grants access by implication; it performs only
  the named command.

## Other entry points to keep consistent

Inbox items and the operator CLI's task reads show the same wait reasons; the CLI
prints the matching command or Settings path instead of a link.
