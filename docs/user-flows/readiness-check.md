# Readiness check

**Status:** implemented. Install stays the procedure in
[standalone macOS operations](../operations/standalone-macos.md). The Getting
started Runtime row and first-task Fix actions that read these checks are planned.

## Goal

After install, and whenever something stops working, one check tells the operator
what the service can and cannot use, with one fix line per problem.

## Entry points

- `ensemble doctor` in the operator CLI (any read credential; the service must advertise `diagnostics.read`).
- Settings → Readiness panel.
- [Getting started](getting-started.md) Runtime row and [first task](first-task.md)
  Fix actions.

Both surfaces read the same service-side checks, so they report what the running
service sees rather than the operator's interactive shell.

## Checks

| Check               | Pass                                                                                               | Fix line on failure                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex executable    | Resolves on the service `PATH`                                                                     | Install Codex into the fixed `PATH`                                                                                                                                                                                                                                  |
| Codex login         | App Server initializes authenticated, without a model turn                                         | Run `codex login` as the service user. If Codex's approval policy or sandbox mode is not the one Ensemble requires, set it to `never` and `workspace-write` and restart the service.                                                                                  |
| Git                 | Resolves on the service `PATH`                                                                     | Install git                                                                                                                                                                                                                                                          |
| GitHub discovery    | Configured and readable, or not configured                                                         | Run `gh auth login`, or Settings → discovery credential                                                                                                                                                                                                              |
| Claude executable   | Not configured, or `claude` resolves on the service `PATH` and reports a version                   | Install Claude Code into the fixed `PATH`, then restart the service. If `claude --version` fails, run it as the service user or reinstall Claude Code.                                                                                                               |
| Claude token        | Not configured, or the reference is readable and safe                                              | Not configured: add a token in [Add Claude](claude-runtime.md). A `file:` problem: make it a private regular file you own (mode 600), or clear the reference. An `env:` variable: set it and restart the service, or clear the reference. Restart required: restart. |
| Runtime harness     | Each runtime a profile uses is running, and each profile's model and reasoning effort are accepted | Restart the service, or edit the profile's model or reasoning effort                                                                                                                                                                                                 |
| Data and auth paths | Private, canonical, owned by the service user                                                      | Named path rule, without the path value in shared output                                                                                                                                                                                                             |

- A check that is not configured is reported as such, not as a failure. Claude
  executable is not configured while Claude is unused (no token reference and no
  active Claude profile); once either exists, a missing `claude` is a failure.
- Claude executable shows the version that `claude --version` prints, as in
  `Claude executable (2.1.296)`. Ensemble reports it and never compares it. Only the
  Claude Code version the pinned SDK declares was qualified; any other version is a
  [disclosed limit](../adr/1011-packaging-and-distribution.md).
- Every row that is not a pass shows its fix line, in the CLI and in Settings. A
  failed re-run keeps the last results visible, marked as the last fetched, with a
  warning; Run again is never disabled, so keyboard focus stays on it.
- Output never includes token values or paths, and never a profile name: Runtime
  harness counts the profiles whose model or reasoning effort the runtime does not
  accept; each profile's runtime is on its Settings page.
- The Claude sandbox self-test needs a task workspace and admits exactly one turn,
  so it runs before each turn and a failure shows on the waiting task, not here.
- Claude's supported models are read from its runtime before the first Claude turn.
  Until then a Claude profile cannot be confirmed, and Runtime harness fails with
  "Claude's supported models are not known yet"; run a Claude task, then run the
  check again.
- `ensemble doctor` exits 0 whenever the read succeeds, whatever the checks report;
  its JSON `data` is the service's `data` unchanged.
- Re-running is the only action. The check changes nothing.
