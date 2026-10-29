---
status: proposed
---

# Load profile skill plugins and allow in-turn subagents

This amends [ADR-1008](1008-claude-code-execution-harness.md), whose agents load no
plugin configuration and cannot start subagents. The operator's development workflow
depends on skills, most of them distributed as plugins, and several of those skills
delegate work to subagents. Delivery scope lives in
[#1336](https://github.com/chrisbanes/cab/issues/1336).

The decision stays proposed until the probes below settle the open enforcement
questions; ADR-1008 and `docs/SPEC.md` describe the current contract until then.

## Decision

- An agent profile lists skill plugins: local plugin directories on the service
  host, and which of their skills are enabled. Like other profile settings, an
  assignment keeps the profile revision it started with.
- Both harnesses receive the same skill set. Claude receives the plugins through the
  Agent SDK's local `plugins` option and the enabled names through its `skills`
  option. Codex receives the same skills through a cab-owned Codex home instead of
  the service user's `~/.codex`.
- Plugins contribute skills, their instructions and their scripts only. Hooks and
  MCP servers a plugin declares do not run, so repository and plugin content still
  cannot change cab's tool policy. Skill scripts run through the harness's ordinary
  shell tool under the existing sandbox and network policy.
- cab records a digest of each loaded plugin with the turn, alongside the existing
  instruction digest, so a changed plugin is visible in the conversation history.
- Claude may start subagents through its `Agent` tool. Every subagent tool call goes
  through the same `PreToolUse` hook, allowlist and sandbox as the main agent, and
  subagents remain part of the turn: Stop, crash recovery, uncertainty holds and the
  recovery contract cover them without new rules. `AskUserQuestion`, web tools and
  plan mode stay disallowed. Codex subagents are enabled only if the probe shows the
  same coverage.
- The effective policy discloses the loaded plugins, the enabled skills, and that
  skills are instructions to the agent rather than cab policy.

## Open enforcement questions

The probe must answer these before the decision is accepted:

- Whether disabling hooks (`disableAllHooks`, applied as managed-hooks-only) also
  disables cab's in-process `PreToolUse` callback. If it does, cab instead refuses a
  plugin that declares hooks.
- Whether strict MCP configuration excludes plugin MCP servers, or a managed server
  allowlist naming only cab's server is needed.
- Whether subagent tool calls reach cab's hook and sandbox, and whether Stop and a
  crash mid-subagent leave no process running unsupervised.
- How Codex App Server discovers skills under an isolated home, how its login is
  supplied there, and whether its subagents meet the same coverage.

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
