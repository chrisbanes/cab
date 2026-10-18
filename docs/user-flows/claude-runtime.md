# Add Claude

**Status:** implemented on the runtime page (Settings → Runtime) and as the Fix in
the [project setup](project-setup.md) ready check. The Getting started row,
profile-form and first-task entry points are planned.

## Goal

An operator who wants a Claude profile can make the token available and confirm it
works without reading the operations guide.

Frames: see [First run and onboarding](../../design/DESIGN.md#first-run-and-onboarding).

## Entry points

- Settings → Runtime → Add Claude (implemented).
- [Project setup](project-setup.md) ready check, for a Claude lead whose token is
  unavailable (implemented).
- [Getting started](getting-started.md) optional Claude row (planned).
- Profile form, when Claude is chosen as the runtime and no token is readable
  (planned).
- [First task](first-task.md) Fix for "Claude token unavailable" (planned).

## Steps

1. The panel shows the token-file commands from
   [operations](../operations/standalone-macos.md#claude-subscription-token) and a
   suggested path `$HOME/.ensemble/claude/claude-token`. Copy puts only the commands
   that create the private empty file on the clipboard.
2. The operator runs them in a terminal, copies the token from `claude setup-token`
   and types the `pbpaste` line shown below them. That line is never copied: it reads
   the clipboard, so copying it would replace the token. The token never passes
   through the web UI.
3. The operator clicks Set. While no reference is configured and the service can
   report its home folder, the field opens with `file:<home>/.ensemble/claude/claude-token`;
   saving sends exactly what the field shows. Otherwise the field opens empty and the
   operator enters `file:/absolute/path` (or `env:NAME`). A reference that starts with
   `~`, `$HOME` or `${HOME}` is refused before it is sent, with the full path offered
   when the home folder is known. A configured reference is never shown or replaced.
4. A live **Token readable** check runs immediately and shows pass, or the unsafe-file
   reason without the path or value.

## Recovery

- Clear removes the reference; Claude work then waits visibly, as today.
- Rotation follows the operations guide; the check re-runs on the next turn and on
  panel open.
