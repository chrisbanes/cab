# Add Claude

**Status:** implemented on the runtime page (Settings → Runtime). The Getting
started row, profile-form and first-task entry points are planned.

## Goal

An operator who wants a Claude profile can make the token available and confirm it
works without reading the operations guide.

## Entry points

- Settings → Runtime → Add Claude (implemented).
- [Getting started](getting-started.md) optional Claude row (planned).
- Profile form, when Claude is chosen as the runtime and no token is readable
  (planned).
- [First task](first-task.md) Fix for "Claude token unavailable" (planned).

## Steps

1. The panel shows the token-file commands from
   [operations](../operations/standalone-macos.md#claude-subscription-token) with a
   Copy action and a suggested path `$HOME/.ensemble/claude/claude-token`.
2. The operator runs them in a terminal; the token never passes through the web UI.
3. The operator enters `file:/absolute/path` (or `env:NAME`) and saves.
4. A live **Token readable** check runs immediately and shows pass, or the unsafe-file
   reason without the path or value.

## Recovery

- Clear removes the reference; Claude work then waits visibly, as today.
- Rotation follows the operations guide; the check re-runs on the next turn and on
  panel open.
