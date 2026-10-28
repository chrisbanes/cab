---
status: accepted
---

# Let the operator enable and disable each execution runtime

The service ran every production runtime and required Codex: it refused to start
without Codex, and profiles defaulted to it. An operator who uses only one runtime
still saw the other's readiness checks and alerts. Delivery scope lives in
[#989](https://github.com/chrisbanes/cab/issues/989).

## Decision

- Each execution runtime (Codex, Claude) has an installation-wide enabled setting,
  persisted with the installation's other settings. A missing setting means enabled,
  so upgrades keep their behaviour. Profiles still choose their runtime; this setting
  decides whether the installation runs it at all.
- Any runtime may be disabled, including all of them. No runtime is required: the
  service starts with none enabled, and a runtime that fails to start, Codex included,
  is reported unavailable instead of stopping the service.
- A toggle takes effect in the running service. Disabling stops new admissions for
  that runtime; running turns finish and are never cancelled. Work bound to a
  disabled runtime waits as not enabled and never falls back to another runtime.
  Enabling starts the runtime in place.
- Enabling is refused while the runtime's binary does not resolve on the service
  `PATH`. A binary that resolves but fails to start is saved as enabled and reported
  unavailable.
- New profiles default to the first enabled runtime in the order Codex, Claude, and
  to Codex when none is enabled.
- Readiness fails when no runtime is enabled. A disabled runtime's own checks report
  not configured, never fail, and raise no destructive alert.

## Considered options

- Keeping Codex required and only allowing Claude to be disabled. Rejected: it
  leaves no path for a Claude-only installation.
- Refusing to disable a runtime that holds bound or running work. Rejected: one stale
  task would block the operator, and waiting is reversible by enabling again.
- Applying toggles at the next service start. Rejected: a toggle that does nothing
  until restart reads as broken, and the secondary-runtime start and stop paths
  already exist.
