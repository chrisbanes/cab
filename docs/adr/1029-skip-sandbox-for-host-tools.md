---
status: accepted
---

# Skip the sandbox for host tools

A project's verification needs host tools that a harness sandbox blocks. Inside it, Chromium fails
before opening a page with `MachPortRendezvous bootstrap permission denied`, and an Android emulator
cannot reach the hypervisor, the adb sockets or the GPU. Command network access and local listening
([ADR-1027](1027-local-listening-for-test-fixtures.md)) widen the network only and do not help.
The cab verification tool (#1585) is the intended long-term replacement; this setting is a
short-term measure until it ships.

## Decision

Skipping the sandbox is a per-project setting, `dangerouslySkipSandbox`, off by default. It is a
versioned `project.configure` field that only the operator changes, in Settings or with
`project prepare --dangerously-skip-sandbox`; agents have no tool for it. Like local listening it is
recorded when a turn is admitted, so a change reaches only later admissions and a running turn
keeps its policy.

It applies to every task turn of the project. Draft turns, drafting runs, read-only turns and
turns without a task binding never get it.

- **Codex.** A task turn admitted while the setting is on sends the per-turn
  `sandboxPolicy: { type: "dangerFullAccess" }`. The approval policy stays `never`.
- **Claude Code.** A task turn admitted while the setting is on runs its query with
  `sandbox: { enabled: false }`. The permission mode, the tool allowlist and disallowed tools, and
  the cab MCP provenance checks do not change. cab's PreToolUse hook still confines Write and Edit
  to the task's writable roots and still refuses a Bash call that sets `dangerouslyDisableSandbox`.
  The hook guards against accidental edits; it is not a boundary, because commands are no longer
  confined.
- **Seatbelt self-test.** The Claude sandbox self-test does not gate a turn that will run
  unsandboxed. The self-test runs before admission, so if the setting changes between the two, the
  turn runs with the recorded, sandboxed policy and the sandbox's `failIfUnavailable` still fails
  it closed. A stale preflight cannot produce an unsandboxed turn.
- **Network access and local listening.** The grant covers outbound network and binding ports, so
  both are superseded while the setting is on. Their stored values do not change, and turning the
  setting off restores them.
- Turning the setting on in Settings needs a confirmation that states the risk; turning it off
  applies at once. The CLI flag is explicit and needs no prompt.
- Every surface that shows the effective policy states the grant and the risks below, per harness.

## Threat model

An agent in an unsandboxed turn acts with the service user's full filesystem, process, network and
credential access. The sandbox was the only real control on what an agent's commands can do, and
this setting removes it for the project. Text the agent reads is untrusted, including issue and
pull request bodies, and can drive that access through prompt injection. cab's tool policy still
governs cab's own tools, but it does not constrain commands.

- Processes an agent starts, such as emulators and browsers, can outlive the turn. cab does not
  clean them up.
- Qualified limits that depended on the sandbox no longer hold: the Claude subprocess environment
  scrub, whose qualification covered sandboxed Bash only; confinement to the per-task temporary
  directory; and the Seatbelt self-test. Claude's edit-tool confinement still applies but is not a
  boundary.
- Only macOS is qualified. cab provides no independent sandbox to compensate.

An operator turns the setting on only for a project whose task sources and repositories they trust
with the service user's access.

## Considered options

- **The cab verification tool (#1585).** It would run a project's verification outside the agent's
  turn without granting the agent host access. It is the intended long-term replacement; this
  setting covers the gap until it ships.
- **Also bypassing approvals or permissions.** Rejected. It would break cab's tool policy and the
  approval contract that S02 (#689) owns. The setting removes only the sandbox.
- **A variant that keeps network denied.** Rejected. Claude Code cannot express it once its sandbox
  is off.
- **An expiry or per-command grant.** Not adopted. The setting has no expiry; whether to remove it
  is decided when #1585 ships.

## Consequences

- Task turns of an opted-in project can launch browsers and Android emulators in both harnesses.
- Such a turn has the service user's full access, so a compromised or prompt-injected agent can
  read credentials, change the host, and reach the network.
- Started processes can accumulate across turns until the operator stops them.
- The sandbox's isolation and the limits qualified under it apply to a project only while the
  setting is off.
- Linux and other hosts are not qualified.
