# #980 service lifecycle evidence — 2026-10-14

## Outcome

Passed one bounded live run of `ensemble service install`, `upgrade` and
`uninstall` on the maintainer's Mac (macOS 27.0.1, Apple silicon) with the real
`/bin/launchctl`. It installed release A, upgraded to release B with readiness
passing and a verified snapshot, and uninstalled with the label and every
service process gone. It used a throwaway label and a fresh private temporary
root for every file. It does not qualify the default label, the real
`~/Library` folders, a start at login, or the cutover.

## Identity

- Harness: `node test/980/live-service-lifecycle.mjs --live`, run from the
  implementation worktree with Node v24.21.0.
- Release A: version `0.1.0`, built from
  `b4e63f500943e8fd0ff633b0cd4ab1dc5981757b` with
  `scripts/package-release.mjs build HEAD --out …`.
- Release B: version `0.1.1-live.980`, built from
  `f8aed122e8e87792593ed924a51c5bf59c575e38`, a local commit on top of A that only
  sets `package.json` `version`. It has no branch or other ref and was never pushed.
- Label: `local.ensemble.validation-3d428b3c`. State, logs, LaunchAgent, CLI
  configuration and both builds lived in one `mkdtemp` root with mode `0700`,
  removed after the run.
- Codex: `codex-cli 0.162.1` from `/opt/homebrew/bin`, with the user's existing
  login.

## Steps

| Step | Result |
| --- | --- |
| Preflight | `launchctl print` exited 113 for the label. |
| Build | Both releases built and unpacked into `STATE/versions/<version>` with `--strip-components 1` (54 s). |
| Auth | Operator auth initialized with A's bundled Node and a random password passed to that one child process in its environment and never written to disk; file mode `0600`. |
| Install | `versions/0.1.0/bin/ensemble service install` exited 0. `plutil -lint` OK; `ProgramArguments[0]` was `STATE/versions/0.1.0/node/bin/node`; `launchctl print` reported `path =` the throwaway plist and a pid; `/app` returned 200. |
| CLI login | A `read` credential issued through the session route, stored in a `0600` token file and used by `ensemble auth login --connection live`. |
| Upgrade | `versions/0.1.1-live.980/bin/ensemble service upgrade … --connection live` exited 0 in about 12 s. Release A's pid was gone (`ps -p`), the new pid ran `versions/0.1.1-live.980/node/bin/node`, and `ensemble snapshot verify` on the reported snapshot exited 0. |
| Uninstall | Exited 0 with `"installed":true`; `launchctl print` then exited 113, both pids were gone and the plist was removed. Data, auth file, snapshot, both versions and all four log files remained. |
| Postflight | No change in the comparison below; the temporary root was removed. |

Readiness reported by the upgrade (no Fail, so it passed):

| Check | Status |
| --- | --- |
| codex-executable | pass |
| codex-login | pass |
| git | pass |
| github-discovery | not-configured |
| claude-executable | pass |
| claude-token | not-configured |
| runtime-harness | not-configured |
| data-paths | pass |

Snapshot manifest: format `ensemble-sqlite-snapshot-v1`, Node `v24.21.0`, schema
6, fingerprint `7f658a46…5d02`, database 1 560 576 bytes, SHA-256
`8e710340…f7a`, logical content `6835eb74…eb11`.

## Before and after

Taken just before auth initialization and just after uninstall:

| Compared | Entries | Change |
| --- | ---: | --- |
| `launchctl list` labels | 557 | none |
| `~/Library/LaunchAgents` (recursive names, sizes, mtimes) | 9 | none |
| `~/Library/Application Support/Ensemble` (recursive names, sizes, mtimes) | 23 | none |
| `~/Library/Logs` (top-level names) | 21 | none |

`~/Library/Logs` is compared by name only because other applications write
there continuously. Nothing was written to or removed from these folders, and
no existing job or the Haze prototype was touched.

## Earlier failed attempt

A first run on the previous candidate failed at upgrade stage `health`: upgrade
probed `/app` on the default `--port` (8787) instead of the installed origin.
It behaved as the failure contract says: the new job was booted out with its exit
confirmed, the plist was removed, the snapshot was verified and reported, and
`jobStopped` was true. The label was absent afterwards and no process from that
root remained; the root was then removed. That run recorded no before-and-after
comparison; afterwards no `ensemble` entry existed in `~/Library/LaunchAgents`,
`~/Library/Logs/Ensemble` did not exist, the only `launchctl list` label matching
`ensemble` was the system's `com.apple.ensemble`, and the
`~/Library/Application Support/Ensemble` entries kept their September and
earlier mtimes. Upgrade now probes the recorded origin and rejects `--port`, and
the fake-host test asserts the probed URL.

## Changes after the run

Review repairs after the passing run changed `src/cli/service.ts` without
changing the commands' launchd calls or their order on a successful path:
`init-auth` accepts an explicit file without `HOME`; upgrade preflight also
requires the target's `node/bin/node` and `dist/src/standalone/cli.js`; upgrade
removes the old LaunchAgent right after the confirmed stop rather than on failure
or replacement; Ctrl-C fails a wait at its stage; and failure messages lost an
unused field. The fake-host tests cover each change; the live run was not
repeated.

## Not proven

- The first install with the default label into the real `~/Library` folders,
  beside the earlier pipeline files.
- launchd starting the job at login after a logout or reboot.
- An upgrade over a real data directory with projects, workspaces or a running
  turn.
- Installing from a CI-built tagged release or a quarantined browser download.
- Claude turns under launchd.
- The #761 cutover.
