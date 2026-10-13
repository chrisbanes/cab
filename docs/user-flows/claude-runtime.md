# Add Claude

**Status:** planned changes to the implemented runtime settings and Claude token
reference.

## Goal

An operator who wants a Claude profile can make the token available and confirm it
works without reading the operations guide.

## Entry points

- [Getting started](getting-started.md) optional Claude row.
- Profile form, when Claude is chosen as the runtime and no token is readable.
- [First task](first-task.md) Fix for "Claude token unavailable".

## Steps

1. The panel shows the token-file commands from
   [operations](../operations/standalone-macos.md#claude-subscription-token) with a
   Copy action and a suggested path under the service's private directory.
2. The operator runs them in a terminal; the token never passes through the web UI.
3. The operator enters `file:/absolute/path` (or `env:NAME`) and saves.
4. A live **Token readable** check runs immediately and shows pass, or the unsafe-file
   reason without the path or value.

## Recovery

- Clear removes the reference; Claude work then waits visibly, as today.
- Rotation follows the operations guide; the check re-runs on the next turn and on
  panel open.
