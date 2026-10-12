# Readiness check

**Status:** planned. Install stays the procedure in
[standalone macOS operations](../operations/standalone-macos.md).

## Goal

After install, and whenever something stops working, one check tells the operator
what the service can and cannot use, with one fix line per problem.

## Entry points

- `ensemble doctor` in the operator CLI.
- Settings → Readiness panel.
- [Getting started](getting-started.md) Runtime row and [first task](first-task.md)
  Fix actions.

Both surfaces read the same service-side checks, so they report what the running
service sees rather than the operator's interactive shell.

## Checks

| Check               | Pass                                                       | Fix line on failure                                      |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Codex executable    | Resolves on the service `PATH`                             | Install Codex into the fixed `PATH`                      |
| Codex login         | App Server initializes authenticated, without a model turn | Run `codex login` as the service user                    |
| Git                 | Resolves on the service `PATH`                             | Install git                                              |
| GitHub discovery    | Configured and readable, or not configured                 | Run `gh auth login`, or Settings → discovery credential  |
| Claude token        | Not configured, or the reference is readable and safe      | See [Add Claude](claude-runtime.md)                      |
| Data and auth paths | Private, canonical, owned by the service user              | Named path rule, without the path value in shared output |

- A check that is not configured is reported as such, not as a failure.
- Output never includes token values; it names references, not secrets.
- Re-running is the only action. The check changes nothing.
