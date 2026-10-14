---
status: accepted
---

# Let the operator enable and disable each execution runtime

The service ran every harness in its fixed production list and required Codex: the
list had to include the default harness, and a Codex start failure stopped the
service. Claude was Not enabled only when `claude` was missing at startup. The
operator could not turn either runtime off.

## Decision

- Each execution runtime (Codex, Claude) has one installation-wide enabled setting,
  stored in the domain store beside the other installation settings. A missing
  setting means enabled, so an upgrade changes nothing.
- No runtime is required. Any runtime can be disabled, including all of them, and
  the service starts and serves the operator UI with none enabled. An enabled
  runtime that fails to start, Codex included, is unavailable; it does not stop the
  service.
- The setting applies live:
  - Disabling stops new admissions for that runtime at once. Running turns finish
    and are never cancelled. The runtime keeps running until no submitting, running
    or held execution it owns remains, then stops. Work bound to it waits with the
    existing Not enabled wait and never falls back to another runtime.
  - Enabling starts the runtime in the running service through the same create,
    attach, bounded start and detached stop paths as a secondary runtime at start-up,
    then wakes the scheduler. Re-enabling a runtime that is still draining keeps it.
    Enabling an enabled but unavailable runtime retries on a fresh instance.
- Enabling is refused while the runtime's executable (`codex`, `claude`) is not on
  the service `PATH`; the refusal names it and nothing is saved. If it resolves but
  the runtime fails to start, the setting is saved and the runtime is reported
  unavailable with a readiness Fix.
- Disabling a runtime that bound tasks use (non-terminal work bound to its harness)
  needs confirmation that states the count. The server enforces it: the web asks in a
  dialog, the CLI requires `--yes`. Without bound work there is no confirmation.
- New profiles default to the first enabled runtime in the order Codex, Claude, and
  to Codex when none is enabled.
- Readiness adds a first check, "An execution runtime is enabled". A runtime's own
  checks report Not configured with "Disabled in Settings" or "`<binary>` not found on
  PATH"; only an enabled, unavailable runtime fails. A disabled runtime raises no
  destructive alert.
- The operator command is `runtime.configure`, with a normal mutation receipt; the
  operator CLI exposes it as `ensemble runtime list|enable|disable`.

## Considered options

- **Codex-only disable, or Claude-only.** Rejected: a required runtime keeps the
  service fatal on its start failure and gives the operator no way to run a
  Claude-only installation.
- **Refuse to disable a runtime that bound work uses.** Rejected: it forces the
  operator to stop or finish tasks first. Waiting is already the behaviour for a
  missing executable, keeps every conversation on its own runtime and is reversed by
  enabling again.
- **Apply the setting at the next start only.** Rejected: a restart interrupts every
  running turn, which is what a live toggle avoids.

## Consequences

- Effective enablement is the persisted setting combined with whether the
  executable resolved and how the start went. Status reads distinguish disabled,
  executable missing and unavailable.
- A held execution keeps its runtime alive while disabled, so recovery keeps its
  inspector; after a restart with the runtime disabled it stays held, as with a
  missing executable.
- Per-profile enablement, runtime or model setting edits beyond enablement, and
  migrating bound conversations between runtimes stay out of scope.
