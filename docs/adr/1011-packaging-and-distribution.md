---
status: accepted
---

# Distribute Ensemble as a self-contained versioned release

Ensemble runs from a reviewed checkout built in place, which ties the LaunchAgent and
the cutover packet to a development tree and the host's nvm-managed Node. Ship it as
one self-contained release instead, first for the operator's own Macs, without
blocking a later public release.

## Artifact

- One package with one `ensemble` executable. The service, offline operations,
  operator auth and the operator CLI are its subcommands; the operator CLI remains an
  HTTP client of the service (ADR-1010), so a separate CLI package can follow later.
- A release is a `darwin-arm64` tarball containing the built service and operator UI,
  production dependencies and the exact Node runtime from `.node-version`, verified
  against its published checksum at build time. Other platforms stay deferred
  (ADR-1004); the platform is part of the artifact name.
- A tag push builds the release in CI and attaches it with `SHA256SUMS` and a
  manifest of commit, Node version and tree digest to a GitHub Release. The same
  script produces local development builds. Versions are semver `0.x` from
  `package.json`; pre-1.0 releases promise no CLI or API compatibility.
- The release does not redistribute Anthropic's `claude` binary. Like `codex`,
  `claude` resolves from the LaunchAgent's fixed `PATH` and is passed to the Claude
  Agent SDK. Ensemble does not gate the CLI version: readiness reports the version
  found, and compatibility is between the SDK and the CLI. Only the version the
  pinned SDK declares (`claudeCodeVersion`) has been qualified. Another version may
  fail at startup, or start and enforce the CLI-side sandbox, tool and permission
  controls differently; that is a disclosed limit, not a fail-closed boundary.
  Qualification evidence records the version used.
  Claude stays optional (ADR-1008), so a missing `claude` on the service `PATH` leaves
  only that harness Not enabled (`not-configured`), with no alert: Claude work waits
  and never falls back, and installing `claude`, then turning Claude off and on in
  Settings → Runtime or restarting the service, enables it.
  A `claude` that resolves but whose runtime fails is unavailable instead. The
  operator turns each runtime on or off in Settings → Runtime (ADR-1012).
- An npm package is a later channel for the same build. It is not a native app:
  a desktop wrapper (Tauri or similar) would need signing, notarization and a second
  owner of the service lifecycle, and can be added later around the same install.

## Install and upgrade

Each release unpacks into its own immutable
`~/Library/Application Support/Ensemble/versions/<version>/` directory. Data, auth and
snapshots live beside `versions/`, logs in `~/Library/Logs/Ensemble/`, separate from
development builds. The LaunchAgent binds the exact versioned executable, never a
`current` symlink, so the plist states the running version.

`ensemble service install | upgrade | uninstall` owns the LaunchAgent (and, in daemon mode, its record). Upgrade stops
the exact job, takes and verifies an offline snapshot, renders the plist for the new
version and starts it, then runs the readiness checks. Uninstall removes the job and
keeps data, auth, snapshots and version directories. There is no self-update.

`service install --mode daemon` is the opt-in alternative that starts the service at
boot, before any login. Ensemble never runs as root: the command runs as the service
account, renders the same plist plus `UserName` and `HOME`, records it
(`mode` in the one install record per label), and prints the `sudo` commands that
copy it to `/Library/LaunchDaemons` and load it; it only ever calls `launchctl print`.
The modes are never both installed; uninstall clears the daemon record only once the
service processes observed under launchd are confirmed gone. Upgrade refuses a daemon install, so upgrading
means switching to the LaunchAgent, upgrading, and switching back. A daemon cannot read the login
keychain, so GitHub credentials there use a file-based `gh` login
(`gh auth login --insecure-storage`, a plaintext token at rest) through the existing
`gh:github.com` reference; there is no `file:` GitHub reference and no credential code.
With FileVault on, a power cut leaves the disk locked until someone unlocks it; planned
restarts use `sudo fdesetup authrestart`. The pre-login start is qualified on a real
host by [#1149](https://github.com/chrisbanes/ensemble/issues/1149). See the
[operations procedure](../operations/standalone-macos.md#launchdaemon-mode).

There is no rollback between Ensemble versions. Migrations are forward-only and run
on start, so upgrades fix forward. A failed upgrade leaves the job stopped and
reports the verified snapshot and logs; recovery is a fixed release and another
upgrade. The snapshot is for disaster recovery through `restore` into a new data
directory, not a way back to an older version. This does not change the cutover's
return path to the Haze prototype controller.

## Name

The product stays Ensemble for private `0.x` releases. The `ensemble` npm name is
taken, and the binary name, data marker, keychain item, config directory and
LaunchAgent label become persisted compatibility surface once installed. Settle the
name before any public or npm release; renaming afterwards needs migrations for each.
