---
status: accepted
---

# Distribute cab as a Mac app through a Homebrew tap

This records the deferred desktop channel alongside the primary npm release in
[ADR-1011](1011-packaging-and-distribution.md). Desktop evaluation and implementation
resume only when explicitly reopened; none of the work below gates the npm release.
The native app remains a candidate pending comparison with Safari Add to Dock and
an explicit desktop choice. Its contracts below are targets, not implemented or
qualified behaviour. The app would be a second channel for the same build, first
for the operator's own Macs, under the `cab` name
([#1154](https://github.com/chrisbanes/cab/issues/1154)), so its bundle identifier
and paths never need a rename migration. It is post-MVP and
does not gate the cutover ([#761](https://github.com/chrisbanes/cab/issues/761)).
Delivery scope and status live in
[epic #1265](https://github.com/chrisbanes/cab/issues/1265).

## App

- A native Swift/SwiftUI `darwin-arm64` app. A window hosts the existing operator UI
  in a `WKWebView`; the service stays Node, bundled with its runtime in the app's
  resources. The web UI is unchanged.
- A menu bar item shows service status and the polled Inbox count, and offers Open
  cab, Stop service and Start service (unregister and register the agent), Open
  logs and Quit. The app registers itself as a login item
  (`SMAppService.mainApp`). Quitting the app leaves the service running.
- The window signs in by exchanging an owner-only local token file over loopback,
  once, for an ordinary session in its own web data store. Browser login,
  sign-out and session revocation are unchanged.
- Notifications stay Web Push. The app posts no native notifications.

## Service lifecycle

- launchd owns the service. The app registers a LaunchAgent with
  `SMAppService.agent` from a static plist inside the bundle, whose program is a
  fixed launcher in the bundle. The app is a client of the service, never its parent.
- A static, signed plist cannot carry per-user values, so the service reads its data
  directory, port, `PATH` and diagnostic retention from an owner-only
  `service.json` in Application Support, resolved from `HOME`, and writes its own
  logs under `~/Library/Logs`. The app writes the file on first run, capturing the
  login shell's `PATH` so `codex`, `claude` and `gh` resolve as they do in a terminal.
  `cab service` and Settings edit it. The non-app channels render their plists
  from the same file.
- The service takes the pre-migration snapshot itself. On start, when the database
  was last written by an older version, it takes and verifies an offline snapshot
  before migrating and refuses to start if either fails. A bundle replaced underneath
  a registered agent, an npm or tarball service upgrade and a manual swap are
  covered alike; `service upgrade` no longer snapshots separately. Migrations stay forward-only with no
  rollback (ADR-1011).

## Channels

- The app is the later desktop channel. npm provides the primary server and CLI
  package; the bundled-Node tarball is optional. `cab service install` remains for
  headless use and LaunchDaemon (pre-login) mode. The channels share the same data
  directory and durable install ownership. A conflicting installation is refused
  even while the owning channel is stopped or disabled; uninstall releases
  ownership only after confirmed shutdown, with an explicit stale-owner recovery
  path. The detailed npm-to-app transition needs qualification when desktop work
  resumes.
- The app installs from a personal tap: `brew install --cask chrisbanes/tap/cab`.
  Release CI pushes the new version and checksum to the tap with a token scoped to
  that repository. The cask links the bundled `cab` CLI onto `PATH`. Upgrades are
  `brew upgrade --cask`; the app does not update itself.
- `brew uninstall` unregisters the agent and keeps all data. `brew uninstall --zap`
  removes everything, including the database, auth and snapshots. That is
  irreversible; there is no recovery after a zap.

## Signing

Open for later desktop work. The app is to be signed and notarized properly; the
identity, entitlements for bundled Node and CI notarization path must be settled
before the first tap release. Stripping quarantine to bypass Gatekeeper is not
the intended path. Whatever is chosen must keep login item and background item
approvals across `brew upgrade --cask`.

## Unproved

A spike must show, before the shell is built, that a locally built app registers its
agent through SMAppService with a bundled Node program, and that the launched
service resolves `codex`, `claude` and `gh` from the configured `PATH`. What
`brew upgrade --cask` does to a registered agent and its approvals depends on the
signing decision and is proved with it. Whether a `WKWebView` in a third-party app can
receive Web Push is unknown; if it cannot, alerts reach the operator through a browser
or another device only.

## Considered options

- **Tauri or Electron.** Rejected: SMAppService, login items and the menu bar are
  first-party Swift APIs, and Electron ships a second runtime.
- **The app owns the service as a child process.** Rejected: work would stop when the
  app quits, and it conflicts with LaunchDaemon mode.
- **The app keeps rendering a plist into `~/Library/LaunchAgents`.** Rejected in
  favour of SMAppService, so macOS shows and manages the item in Login Items.
- **Snapshot on app launch or in a cask preflight.** Rejected: launchd can start the
  replaced service before the app runs, and a preflight only covers Homebrew.
- **Sparkle self-update.** Rejected: it reverses ADR-1011's no self-update and adds an
  update key to manage; Homebrew already delivers upgrades.
- **Native notifications.** Rejected: the service has no push stream, and Web Push
  already covers the host and other devices.
