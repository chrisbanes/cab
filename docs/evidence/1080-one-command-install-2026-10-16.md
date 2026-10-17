# #1080 one-command install evidence — 2026-10-16

## Outcome

Passed one bounded live run of `ensemble service install TARBALL` on the
maintainer's Mac (macOS 27.0.1, Apple silicon) with the real `/bin/launchctl`,
`/usr/bin/tar` and `/usr/bin/script`. Install unpacked the release tarball,
created the operator auth file from a hidden password prompt on a pseudo-terminal,
installed and started the service, issued the read credential, logged the CLI in,
ran doctor and printed the app URL. The run then upgraded with that credential
and uninstalled. It used a throwaway label and a fresh private temporary root for
every file. It does not qualify the default label, the real `~/Library`
folders, the Keychain write, the browser open or a quarantined download.

## Identity

- Harness: `node test/operations/service-lifecycle-qualification/live-service-lifecycle.mjs --live`,
  run from the implementation worktree with Node v24.21.0.
- Release A: version `0.1.0`, built from `2d2e452e8502d4a94dfcc695d1f2520d5a07939f`
  (the branch head at the run, equal to the reviewed code apart from comment and
  harness changes) with `scripts/package-release.mjs build HEAD --out …`.
- Release B: version `0.1.1-live.980`, a dangling local commit on top of A that
  only sets `package.json` `version` (`ff45d396113c99dd75a2632b2e1d59ac11f5d8cc`).
- Label: `local.ensemble.validation-47f5e5ff`, on a random loopback port. State,
  logs, LaunchAgent, `HOME`, CLI configuration and both builds lived in one
  `mkdtemp` root with mode `0700`, removed after the run.
- Codex: `codex-cli 0.162.1` from `/opt/homebrew/bin`, with the user's existing
  login.

## Steps

| Step | Result |
| --- | --- |
| Preflight | `launchctl print` exited 113 for the label. |
| Build | Both releases built (62 s). Release A was unpacked only to run its `ensemble`, outside `STATE`; the auth file was not created. |
| Install | `bin/ensemble service install <tarball A> --connection live --token-file … --no-open` ran under `/usr/bin/script`. The `New Ensemble operator password: ` prompt appeared, a random password was typed once, and install exited 0 in about 19 s. Install created `STATE/versions/0.1.0` and the auth file (mode `0600`). `plutil -lint` OK; `ProgramArguments[0]` was `STATE/versions/0.1.0/node/bin/node`; `launchctl print` reported `path =` the throwaway plist and a pid; `/app` returned 200. The JSON result held `"connection":"live"`. The terminal output held doctor's `Check Status Reason` table and `Open http://127.0.0.1:PORT/app`, and neither the password nor any `ens_` token. |
| CLI login | The token file was mode `0600`. `auth status --connection live --output json` reported scope `read`, a name starting `install · ` and an expiry exactly 90 days after creation. |
| Upgrade | `service upgrade … --connection live` with that credential exited 0 in about 16 s; readiness reported no Fail (below), release A's pid was gone, the new pid ran release B, and `snapshot verify` on the reported snapshot exited 0. |
| Uninstall | Exited 0 with `"installed":true`; `launchctl print` then exited 113, both pids were gone and the plist was removed. Data, auth file, snapshot, both versions and all four log files remained. |
| Postflight | No change in launchd labels, `~/Library/LaunchAgents`, `~/Library/Application Support/Ensemble` or the top-level `~/Library/Logs` names; the temporary root was removed. |

Readiness reported by the upgrade: runtime-enabled, codex-executable, codex-login,
git, claude-executable and data-paths passed; github-discovery, claude-token and
runtime-harness were not configured.

Snapshot manifest: format `ensemble-sqlite-snapshot-v1`, Node `v24.21.0`, schema 6,
database 1 589 248 bytes, SHA-256 `7a9f16c2…552b`.

## Earlier attempt

The first live run (label `local.ensemble.validation-af066a8a`, same code) passed
every step through uninstall and failed only the postflight comparison, because
six of Spotlight's own `com.apple.mdworker.shared.*` launchd labels came and went
during the run. The label was unloaded (exit 113), no process remained, the
LaunchAgents and Application Support folders were unchanged, and its temporary
root was removed. The harness comparison now ignores only that label prefix; the
second run above is the pass. Both allowed live attempts are used.

## Not qualified

- The default label `local.ensemble.service` and the real `~/Library` paths.
- The Keychain write from install (covered by an injected fake in tests, and by
  the opt-in `ENSEMBLE_KEYCHAIN_LIVE=1` test for the store itself).
- Opening the browser (`--no-open` was used).
- A quarantined, browser-downloaded tarball.
- A non-interactive password source: none exists by design.
