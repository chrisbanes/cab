---
status: accepted
---

# Add Claude Code as a second execution harness

This amends [ADR-1004](1004-standalone-service.md), which deferred Claude for agent
execution. The Claude harness is implemented and qualified with limits by bounded
live journeys ([#827](https://github.com/chrisbanes/ensemble/issues/827)).
Delivery scope and status live under
[epic #777](https://github.com/chrisbanes/ensemble/issues/777).

## Selection

The execution runtime is an agent profile setting. Codex remains the default.
An assignment conversation stays bound to the harness that started it; changing a
profile's harness affects new conversations only and never migrates a live session.
One task may therefore mix Codex and Claude assignments. Ensemble keeps admission,
ownership, coordination, policy and task completion for every harness.

Claude profiles expose model and reasoning effort, validated against the values the
installed integration supports. Permission mode, tools, sandbox and configuration
sources are Ensemble policy, not profile settings.

## Integration

Use the TypeScript Claude Agent SDK behind the existing `Runtime` interface. Each
turn is one `query()` that resumes the assignment's Claude session, so each turn has
its own `claude` subprocess and process identity. Ensemble mints the turn identity;
the SDK session ID is the conversation identity. Interrupt uses the query's abort
path. Generalise the interface only where the Claude integration demonstrates a
different need.

Ensemble coordination tools are served through an in-process SDK MCP server.

## Authentication

Use the operator's own Claude subscription through a `claude setup-token` token,
mirroring the Codex operator login. API-key billing stays deferred.

The token is configured as a reference and never stored or rendered back. Two
forms are accepted:

- `file:/absolute/path` names an owner-only file holding the token. This is the
  form for the installed LaunchAgent service, whose plist and environment then
  hold no Claude secret. The path is absolute with no empty, `.` or `..` segment.
- `env:NAME` names a variable in the service environment, like Ensemble's other
  provider credentials; it suits foreground and development runs.

`file:` is added alongside `env:NAME` rather than replacing it: it alone solves the
installed service, and the environment form keeps its exclusion and restart rules.
Configuration checks only the syntax, so the file can be created afterwards.

The file is read without caching whenever a Claude preflight, turn start or status
read needs the token, and whenever spawn environments and operator reads compute
their exclusions. It is opened without following a final symbolic link, and the
opened descriptor must be a regular file owned by the service user, with no group
or other permission bits and at most 4096 bytes, before anything is read. Its
content, with trailing whitespace removed, must be one run of printable ASCII
characters. Otherwise the file is never read and Claude work waits with a reason
such as `subscription token file permits group or other access`, which names
neither the path nor the value; the status read shows the token unavailable.
Intermediate symbolic links in the path (such as macOS `/var`) are followed and
the parent directories' ownership is not checked; the operator keeps the file in a
private directory. Replacing the file atomically rotates the token from the next
turn without a restart; a running turn keeps the value it started with.

The Claude runtime ([#825](https://github.com/chrisbanes/ensemble/issues/825))
sets the resolved token only as the Claude subprocess's token variable; it never
logs it. Every other spawn environment, including Codex and helper children such
as `git`, omits the token variable and any variable holding the same nonempty value.
Operator reads and conversation history redact the reference, its variable name
or file path, and the value. A token already inherited by the running runtimes
(an `env:NAME` reference configured after start, or a file whose value is also in
the service environment) holds activation until restart, as for delivery
credentials. Delivery credentials are likewise excluded from the
Claude spawn environment. Inside the Claude process, the runtime enables Claude
Code's subprocess environment scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`) so
Bash, hooks and stdio MCP children do not inherit the token; its effect is
qualified before the harness is advertised, and any residual exposure is a
disclosed limit. An invalid token fails the turn visibly. Operator setup,
clearing and configured/available status belong to the harness UI
([#826](https://github.com/chrisbanes/ensemble/issues/826)).

Anthropic's terms bar third-party products from offering subscription login to
others, and say advertised Pro/Max limits assume ordinary, individual use of
Claude Code and the Agent SDK. A single-operator service driven by its owner is
not addressed explicitly. Recheck the
[current terms](https://code.claude.com/docs/en/legal-and-compliance) before
advertising the harness and when self-hosting by others is considered.

## Execution policy

Match the Codex default policy and disclose where enforcement differs:

- `permissionMode: "dontAsk"`, an explicit built-in tool allowlist, Ensemble's MCP
  tools, and every other tool disallowed. No interactive approvals.
- A `PreToolUse` hook sees every tool call, records it, and denies calls outside
  policy, because allow rules bypass `canUseTool`.
- Shell commands run in Claude Code's sandbox (Seatbelt on macOS): writes to the
  task workspace and explicit writable roots only (except the sandbox temporary
  directory below), an empty network allowlist and no unsandboxed retry. Commands
  never run unsandboxed.
- Before each turn, Ensemble runs a sandbox self-test in the turn's spawn context.
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

Agents load no user, project or plugin Claude configuration: no setting sources,
strict MCP configuration and a dedicated Claude configuration directory. Ensemble
supplies repository instructions (`CLAUDE.md`, `AGENTS.md`) as instruction text, so
repository content cannot add permission rules, hooks or MCP servers.

Native `AskUserQuestion` is disabled. Agents ask the operator through
`ensemble_ask_question`, which is durable across restarts.

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

OpenCode, Pi, remote workers ([#778](https://github.com/chrisbanes/ensemble/issues/778)),
conversation transfer between harnesses, API-key billing and native Claude
`AskUserQuestion` bridging.
