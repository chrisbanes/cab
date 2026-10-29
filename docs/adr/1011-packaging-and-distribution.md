---
status: accepted
---

# Distribute cab through one npm package

cab runs from a reviewed checkout built in place, which ties the LaunchAgent and
the cutover packet to a development tree and the host's nvm-managed Node. npm is
the primary first-release channel: one package installs the server, web UI and
`cab` executable. The Mac desktop app is deferred and does not gate this release.

## Artifact

- Publish `@chrisbanes/cab` with one `cab` executable. The service, offline
  operations, operator auth and operator commands are subcommands of the same
  product. Operator commands remain HTTP clients of the service (ADR-1010),
  including when connecting to another machine; they need no separate CLI package.
- The npm package contains the compiled service and built operator UI, with
  production dependencies declared for installation. Users install a supported
  Node.js LTS runtime separately; installation needs no checkout or local build.
  macOS Apple Silicon remains the first qualified service platform (ADR-1004).
  npm distribution does not establish support for other platforms or Node versions.
- A tag push validates and builds the package in CI, publishes that exact tested
  package to npm, and records the package version, integrity and source commit in
  the GitHub Release. Versions are semver `0.x` from `package.json`; pre-1.0
  releases promise no CLI or API compatibility.
- The existing self-contained `darwin-arm64` tarball remains an optional channel
  for installations that want the exact Node runtime from `.nvmrc` bundled. It
  includes production dependencies, `SHA256SUMS` and a release manifest. It is
  not a prerequisite for publishing or qualifying the npm release.
- The release does not redistribute Anthropic's `claude` binary. Like `codex`,
  `claude` resolves from the LaunchAgent's fixed `PATH` and is passed to the Claude
  Agent SDK. cab does not gate the CLI version: readiness reports the version
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
- A Mac app installed through a Homebrew tap is a deferred channel for the same
  build ([ADR-1019](1019-mac-app-channel.md)). Desktop feasibility, signing,
  notarization and Homebrew upgrades are not npm release gates.

## Install and upgrade

The target first-install flow is:

```sh
npm install -g @chrisbanes/cab
cab service install
```

Installing the npm package makes `cab` available; starting a local service is an
explicit action. A remote operator uses the same package without installing a
local service. npm install/update/remove must not implicitly start a scheduler,
migrate a database or delete operator data.

The service must run from stable versioned files, with an explicit supported
Node runtime binding. A global npm update or uninstall must not replace or remove
files used by the running service. Service installation and upgrade own that
binding; package replacement alone is not a completed service upgrade. The npm
staging mechanism, runtime requirements and exact upgrade commands need
implementation and qualification before being documented as supported operations.

Data, auth and snapshots stay under `~/Library/Application Support/cab/`, logs
under `~/Library/Logs/cab/`, separate from the npm installation and development
builds. `cab service uninstall` stops and removes the service while keeping that
state; package removal is a separate step. Reinstallation must find retained data.

`cab service install | upgrade | uninstall` owns the LaunchAgent (and, in daemon mode, its record). The
plist binds the selected runtime and service version. Upgrade stops the exact job,
confirms shutdown before changing that binding, renders the plist for the new version
and starts it, then runs the readiness checks. The service takes and verifies the
offline pre-migration snapshot itself on start, before migrating, and refuses to
start if either fails. Uninstall removes the job and
keeps data, auth, snapshots and version directories. There is no self-update.
Active work follows the existing shutdown/recovery contract: unresolved outcomes
retain their holds, with no duplicate dispatch or external effects.

`service install --mode daemon` is the opt-in alternative that starts the service at
boot, before any login. cab never runs as root: the command runs as the service
account, renders the same plist plus `UserName` and `HOME`, records it
(`mode` in the one install record per label), and prints the `sudo` commands that
copy it to `/Library/LaunchDaemons` and load it; it only ever calls `launchctl print`.
The modes are never both installed; uninstall clears the daemon record only once the
service processes observed under launchd are confirmed gone. Upgrade refuses a daemon install, so upgrading
means switching to the LaunchAgent, upgrading, and switching back. The service takes
the same pre-migration snapshot when a daemon starts against older data, in the
`snapshots` directory beside its data directory, which the service account owns. A daemon cannot read the login
keychain, so GitHub credentials there use a file-based `gh` login
(`gh auth login --insecure-storage`, a plaintext token at rest) through the existing
`gh:github.com` reference; there is no `file:` GitHub reference and no credential code.
With FileVault on, a power cut leaves the disk locked until someone unlocks it; planned
restarts use `sudo fdesetup authrestart`. The pre-login start is qualified on a real
host by [#1149](https://github.com/chrisbanes/cab/issues/1149). See the
[operations procedure](../operations/standalone-macos.md#launchdaemon-mode).

There is no rollback between cab versions. Migrations are forward-only and run
on start, so upgrades fix forward. A failed upgrade leaves the job stopped and
reports the verified snapshot and logs; recovery is a fixed release and another
upgrade. The snapshot is for disaster recovery through `restore` into a new data
directory, not a way back to an older version: an older binary refuses data a newer
release started, before it writes anything. This does not change the cutover's
return path to the Haze prototype controller.

## Implementation state

The package is named `@chrisbanes/cab` and remains marked private. The current
release builder and tagged workflow produce the bundled-Node tarball; npm
publishing and npm-based service installation/upgrade are not implemented or
qualified. The service takes and verifies the pre-migration snapshot
on start, in either service mode, and `service upgrade` takes none of its own.
The package version is the release identity: a database whose recorded release
(`startup-state.json` in the data directory) is older than the running release, or
unrecorded, is snapshotted before any migration; equal versions take none. Shared app configuration is deferred with ADR-1019. Delivery scope and
qualification are owned by [#1267](https://github.com/chrisbanes/cab/issues/1267).
