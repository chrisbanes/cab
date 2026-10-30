---
status: accepted
---

# Load profile skill plugins and allow in-turn subagents

This amends [ADR-1008](1008-claude-code-execution-harness.md), whose agents load no
plugin configuration and cannot start subagents. The operator's development workflow
depends on skills, most of them distributed as plugins, and several of those skills
delegate work to subagents. Delivery scope lives in
[#1336](https://github.com/chrisbanes/cab/issues/1336).

The Codex home, login link and previous-home refusal below are implemented. Profile
skill plugins and in-turn subagents are the accepted target and are not implemented yet;
[ADR-1008](1008-claude-code-execution-harness.md) and `docs/SPEC.md` describe the
implemented Claude contract until they are.

## Decision

- An agent profile lists skill plugins: local plugin directories on the service
  host, and which of their skills are enabled. Like other profile settings, an
  assignment keeps the profile revision it started with.
- Both harnesses receive the same skill set. Claude receives the plugins through the
  Agent SDK's local `plugins` option and the enabled names through its `skills`
  option. Codex receives the same skills through cab's own Codex home instead of the
  service user's `~/.codex`.
- Plugins contribute skills, their instructions and their scripts only. Hooks and
  MCP servers a plugin declares do not run, so repository and plugin content still
  cannot change cab's tool policy. Claude keeps `strictMcpConfig` and adds
  `managedSettings: { disableAllHooks: true }`; Codex receives skill directories, not
  installed plugins. Skill scripts run through the harness's ordinary shell tool under
  the existing sandbox and network policy. The
  [probe record](../evidence/skill-plugin-probes-2026-10-29.md) shows that
  `disableAllHooks` leaves cab's in-process `PreToolUse` callback running and denying
  out-of-policy calls, that a plugin's own hook and MCP server do not run, and that the
  skill's script ran under the sandbox with its outside write denied.
- cab records a digest of each loaded plugin with the turn, alongside the existing
  instruction digest, so a changed plugin is visible in the conversation history.
- Claude may start subagents through its `Agent` tool, which requires removing `Task`
  from the disallowed tools too. Every subagent tool call goes through the same
  `PreToolUse` hook (marked with `agent_id`), allowlist and sandbox as the main agent,
  including a denied outside write and denied network, and subagents remain part of
  the turn: an operator Stop leaves no process. Killing the service mid-subagent leaves
  the CLI and its tool processes running until recovery terminates them by recorded
  identity, exactly as for the main agent. That existing recovery boundary is accepted
  for subagents and gets no new rules. `AskUserQuestion`, web tools and plan mode stay
  disallowed.
- Codex subagents stay disabled (`features.multi_agent=false`). Enabling them needs a
  later decision backed by a sandbox and Stop proof.
- The effective policy discloses the loaded plugins, the enabled skills, and that
  skills are instructions to the agent rather than cab policy.

## Codex home and login

Codex App Server runs with a `CODEX_HOME` and an isolated `HOME` that cab owns under
its data directory, so no skill, plugin or setting is read from the service user's
`~/.codex` or `~/.agents`. With only `CODEX_HOME` overridden, `~/.agents/skills` still
loaded ([probe record](../evidence/skill-plugin-probes-2026-10-29.md)).

- **Login.** cab's home holds `auth.json` only as a symlink to the service user's
  Codex login (`$CODEX_HOME/auth.json` from the service environment, else
  `~/.codex/auth.json`). cab never copies, migrates, creates, reads or hashes a login.
  A regular file or a link to another target in its place makes Codex unavailable; it
  is never repaired by copying, and readiness reports a missing target or a replaced
  link without naming paths. Codex starts with `cli_auth_credentials_store=file`: the
  keyring and auto modes key credentials by the `CODEX_HOME` path and would ignore the
  link, so a keyring-backed login cannot be used.
- **Refresh.** Codex writes a refreshed login in place through the link and keeps it,
  as the [refresh probe](../evidence/codex-auth-link-refresh-2026-10-30.md) shows on
  the installed Codex with a dummy target and then the operator's own login. If a Codex
  release ever replaces the link with a regular file, the operator's login may need an
  interactive `codex login`; cab does not fall back to a copy.
- **Agent shells keep the real `HOME`.** Codex starts with
  `shell_environment_policy.set.HOME=<service user's HOME>`, so commands behave as
  before, such as git configuration. Only Codex itself runs isolated: shell commands
  still see cab's `CODEX_HOME`, and the sandbox's host-permitted reads, including the
  operator's `~/.codex`, are unchanged.
- **Features.** Codex also starts with `features.plugins=false` and
  `features.skill_mcp_dependency_install=false`.
- **Conversations started earlier.** A Codex conversation started under the previous
  home is not resumed. Admission refuses the request, naming "Started under the
  previous Codex home; restart the task" in its revision refusal, before it holds a writer, capacity or recovery
  state, so the operator can use Reset task; the runtime also refuses the resume before
  any App Server request. There is no sessions link and no copy of rollouts. The thread's qualification row records the
  home it was started under: rows that exist at upgrade have none, and a resumed
  thread with no row is treated the same way. Captured history stays readable.

## Considered options

- Loading the operator's own Claude and Codex configuration. Rejected: it brings
  every installed hook, MCP server and setting into agent turns, and makes a task's
  behaviour depend on unrelated interactive setup.
- Skill directories only, without plugins. Rejected: most of the operator's skills
  are distributed as plugins, and copying them out would drift from their updates.
- Service-wide skills. Rejected: profiles already carry instructions and execution
  settings, and different agent roles need different skills.
- Loading plugin hooks with disclosure. Rejected: plugin hooks run outside the
  sandbox and could weaken cab's tool policy.

## Consequences

- Skills that rely on network access, `gh` or pull request publication still fail
  in the sandbox or conflict with cab-owned publication
  ([ADR-1016](1016-ensemble-owned-commit-publication.md)); the skills need a cab mode
  or cab-aware instructions.
- Plugin directories are read from the service host, so the operator keeps them
  installed and updated there.
- Subagents increase token use and the number of concurrent tool calls within one
  turn; capacity still counts the assignment, not its subagents.
