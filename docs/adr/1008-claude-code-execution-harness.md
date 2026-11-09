---
status: accepted
---

# Add Claude Code as a second execution harness

This amends [ADR-1004](1004-standalone-service.md), which deferred Claude for agent
execution. The Claude harness is implemented and qualified with limits by bounded
live journeys ([#827](https://github.com/chrisbanes/cab/issues/827)).
Delivery scope and status live under
[epic #777](https://github.com/chrisbanes/cab/issues/777).

## Selection

The execution runtime is an agent setting. The operator can enable or disable
each runtime, and new agents default to the first enabled one
([ADR-1012](1012-operator-controlled-runtime-enablement.md)).
An assignment conversation stays bound to the harness that started it; changing a
agent's harness affects new conversations only and never migrates a live session.
One task may therefore mix Codex and Claude assignments. cab keeps admission,
ownership, coordination, policy and task completion for every harness.

Claude agents expose model and reasoning effort, validated against the values the
installed integration supports. Permission mode, built-in tools and sandbox controls are cab policy; native
configuration sources belong to the service user.

## Integration

Use the TypeScript Claude Agent SDK behind the existing `Runtime` interface. Each
turn is one `query()` that resumes the assignment's Claude session, so each turn has
its own `claude` subprocess and process identity. cab mints the turn identity;
the SDK session ID is the conversation identity. Interrupt uses the query's abort
path. Generalise the interface only where the Claude integration demonstrates a
different need.

cab coordination tools are served through an in-process SDK MCP server.

## Authentication

Use the service user's native Claude Code subscription login and preserve `HOME`
and `CLAUDE_CONFIG_DIR`. Validate model-free account metadata before releasing a
prompt: a first-party provider and subscription; reject an explicitly reported
API-key source. The installed CLI may omit that optional source field. cab excludes
API credential inputs and selects no alternate authentication path. No API billing
or provider fallback is authorised. cab neither injects a setup token nor changes
personal credentials. Legacy token references remain only for history, receipt
replay and credential redaction; new token-reference writes are refused.

## Execution policy

Match the Codex default policy and disclose where enforcement differs:

- `permissionMode: "dontAsk"`, an explicit built-in tool allowlist, cab's MCP
  tools and trusted inherited MCP/Skill tools. No interactive approvals.
- A `PreToolUse` hook sees every tool call, records it, and denies calls outside
  policy, because allow rules bypass `canUseTool`.
- Shell commands run in Claude Code's sandbox (Seatbelt on macOS): writes to the
  task workspace and explicit writable roots only (except the sandbox temporary
  directory below), an empty network allowlist and no unsandboxed retry. Commands
  never run unsandboxed.
- Before each turn, cab runs a sandbox self-test in the turn's spawn context.
  If the sandbox cannot run, the turn does not start: the work waits visibly as an
  unavailable runtime, never falls back to another harness, and leaves no
  uncertainty hold because no agent command ran. Claude Code reports a sandbox
  that breaks mid-turn only as failed commands (exit 126), not a failed query;
  this is a disclosed limit.
- Claude Code points the sandbox `TMPDIR` at a per-OS-user directory
  (`/tmp/claude-<uid>`) that is shared across tasks and writable from the sandbox.
  The runtime redirects it to a per-task root or denies it where Claude Code
  supports that; otherwise it is a disclosed shared write root in the effective
  policy, and task-root-only writes are not claimed.
- The hook confines file-editing tools to the same roots. This is hook enforcement,
  not OS confinement, and must be disclosed with the effective policy.
- Reads keep full access subject to host permissions, as with Codex.

User, project and local configuration loads through Claude Code's native mechanisms
([ADR-1021](1021-profile-skill-plugins-and-subagents.md)). This includes trusted
hooks and MCP servers, whose effects are outside cab's command confinement.
The SDK-supplied reserved `cab` server must be connected with SDK provenance before
prompt release; a collision refuses dispatch. cab validates its own tool calls and
keeps explicit built-in file-edit and unsandboxed-command checks.
The `Agent` tool retains its in-turn policy and shared recovery boundary; cab rejects
isolation, model, effort and mode overrides. Named-agent definitions and background
subagents retain their disclosed limits.

Native `AskUserQuestion` is disabled. Agents ask the operator through
`cab_ask_question`, which is durable across restarts.

## Recovery

Claude takes the existing Codex recovery contract. A turn running during a service
crash, process loss or unverified Stop leaves a visible uncertainty hold and
retains writer and capacity holds. Explicit operator recovery may resume the
session; a tool call cut off by the crash is not re-run, and the agent must check
its effects. Nothing silently retries or releases ownership.

## Qualification

Deterministic tests cover fault handling, capability rejection and policy denial.
Before the harness is advertised, bounded real-runtime journeys must pass for a
Claude-only task, a mixed Codex and Claude task, and Stop plus a crash mid-turn.
Untested surfaces remain disclosed limits.

## Outside this decision

OpenCode, Pi, remote workers ([#778](https://github.com/chrisbanes/cab/issues/778)),
conversation transfer between harnesses, API-key billing and native Claude
`AskUserQuestion` bridging.
