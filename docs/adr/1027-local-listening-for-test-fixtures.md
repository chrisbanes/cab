---
status: accepted
---

# Local listening for test fixtures

A project's browser and HTTP tests start local servers. In a task workspace both harnesses'
sandboxes deny binding a port, so those tests fail with `listen EPERM 127.0.0.1`. Command network
access, the existing per-project expansion, applies only to Codex and also opens outbound
network. The [probe](../evidence/local-listening-probe-2026-11-06.md) measured what each harness
can express.

## Decision

Local listening is a separate per-project setting, `localListening`, off by default. It is a
versioned `project.configure` field that only the operator changes, in Settings or with
`project prepare --local-listening`; agents have no tool for it. Like command network access it
is recorded when a turn is admitted, so a change reaches only later admissions and a running
turn keeps its policy.

- **Claude Code.** A Claude task turn admitted while the setting is on runs with
  `allowLocalBinding: true` in its sandbox `network` options. Outbound network stays denied.
  The control is macOS only. It does not limit the bind address: a command can bind `0.0.0.0`,
  and it can connect to other services listening on the host's loopback interface.
- **Codex.** The App Server's per-turn `sandboxPolicy` has no local-binding field. A Codex
  command can listen only when command network access is on, and then on any interface with
  outbound network open. Admission always records local listening off for a Codex turn, and its
  `sandboxPolicy` does not change.
- Draft turns, drafting runs and turns without a task binding never get local listening.
- Every surface that shows the effective policy states, per harness, what local listening does,
  and that other processes on the host can reach a listening port.

## Considered options

- **Codex's experimental `network_proxy` with a permission profile** (`allow_local_binding`).
  The probe showed loopback binding with outbound denied, but permission profiles reach a thread
  only through thread-scoped config, which Codex refuses to combine with the per-turn
  `sandboxPolicy` cab sends, and it would bring in an unqualified managed proxy.
- **Folding listening into command network access.** It would give Claude turns no way to listen
  without outbound network, and Claude turns would still need a separate control.

## Consequences

- Claude Code task turns can run a project's browser and HTTP tests without outbound network.
- Codex task turns can run them only with command network access, which also opens outbound
  network and binds on any interface.
- A listener in either harness is reachable by other local processes, and on Claude, a listening
  command can reach other loopback services. Neither harness restricts listeners to loopback.
- Linux and other hosts are not qualified; Claude Code documents `allowLocalBinding` as macOS only.
