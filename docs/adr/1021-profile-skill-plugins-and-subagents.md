---
status: accepted
---

# Load agent skill plugins and allow in-turn subagents

This amends [ADR-1008](1008-claude-code-execution-harness.md), whose agents load no
plugin configuration and cannot start subagents. The operator's development workflow
depends on skills, most of them distributed as plugins, and several of those skills
delegate work to subagents. Delivery scope lives in
[#1336](https://github.com/chrisbanes/cab/issues/1336).

All of this is implemented: the Codex home, login link and previous-home refusal, agent
skill plugins for both harnesses, and in-turn subagents for Claude. The Claude
[journey record](../evidence/skill-plugin-journeys-2026-10-30.md) shows a skill running,
a subagent under Stop, and a crash during a subagent; the
[Codex skill proof](../evidence/codex-skill-scope-probes-2026-10-30.md) and
[Codex journey record](../evidence/codex-skill-journeys-2026-10-30.md) show per-thread
skills and a Codex turn running its agent's skill.

The plugin layouts and load scope below are implemented
([#1524](https://github.com/chrisbanes/cab/issues/1524)); the
[layout journey record](../evidence/skill-plugin-layout-journeys-2026-11-05.md) shows a
nested skill of `mattpocock-skills` running on each harness. Installed plugins are
implemented too ([#1525](https://github.com/chrisbanes/cab/issues/1525)); the
[installed-plugin journey record](../evidence/installed-plugin-journeys-2026-11-05.md)
shows a plugin installed and then updated with each tool's own CLI, with the next turn
running the update.

## Decision

- An agent lists skill plugins and which of their skills are enabled. A plugin
  is either one the operator installed and enabled in Claude Code or Codex, named by
  tool and plugin id (see Installed plugins below), or a local plugin directory on the
  service host. Like other agent settings, an assignment keeps the agent revision
  it started with; an installed plugin's content is whatever is installed when each
  turn starts.
- Both harnesses receive the same skill set from the same directory. Claude receives the
  plugins through the Agent SDK's local `plugins` option and the enabled names through
  its `skills` option. Codex receives each plugin's skill directories as extra skills
  roots of its App Server and scopes each thread to its agent's enabled skills (see
  Codex skills below). A plugin with a Claude plugin manifest serves both runtimes; one
  with only a Codex manifest serves Codex agents only (see Plugin layout below).
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
  instruction digest, so a changed plugin is visible in the turn's execution detail.
- Claude may start subagents through its `Agent` tool, which requires removing `Task`
  from the disallowed tools too. Every subagent tool call goes through the same
  `PreToolUse` hook (marked with `agent_id`), allowlist and sandbox as the main agent,
  including a denied outside write and denied network, and subagents remain part of
  the turn: an operator Stop leaves no process. Killing the service mid-subagent leaves
  the CLI and its tool processes running until recovery terminates them by recorded
  identity, exactly as for the main agent. That existing recovery boundary is accepted
  for subagents and gets no new rules. `AskUserQuestion`, web tools and plan mode stay
  disallowed. cab refuses isolation, model, effort and mode overrides in a subagent call (the settings of
  a named agent definition, including a plugin's, are untested), and
  does not show its prose as the lead's conversation. Plugin hooks are switched off
  through Claude Code managed settings, which an organisation's managed-settings tier can
  replace, so that guarantee is qualified for a personal login only. Background subagents
  and a turn resumed after a crash during a subagent are not demonstrated (see the
  journey record).
- Codex subagents stay disabled (`features.multi_agent=false`). Enabling them needs a
  later decision backed by a sandbox and Stop proof; the Codex skill proof only records
  what was observed.
- The agent settings show the plugins and enabled skills, and the effective policy
  states that skills are instructions to the agent rather than cab policy.

## Plugin layout

cab finds a plugin's skills the way the runtimes do, so a plugin loads in cab as it does
in Claude Code and Codex:

- **Discovery.** Skills are the directories listed in the Claude manifest's
  (`.claude-plugin/plugin.json`) `skills` array, the directory named by the Codex
  manifest's (`.codex-plugin/plugin.json`) `skills` field, and the flat `skills/*/` scan.
  In a probe, the Claude CLI loaded the listed nested paths in addition to its one-level
  scan, and Codex App Server listed skills up to six directories below a root.
- **Names.** A skill is named by its `SKILL.md` frontmatter `name`, else its leaf
  directory: both runtimes report that name without a category prefix. Two skills of one
  plugin with the same name are refused.
- **Scoping.** Codex threads are scoped by the discovered `SKILL.md` paths.
- **Load scope.** The digest, the size, file and depth bounds and the link rules cover
  the manifests and the enabled skills' directories only, because nothing else reaches
  the agent. A symbolic link that resolves inside the plugin directory is allowed; one
  that resolves outside it is refused.
- **Codex-only plugins.** A plugin without a Claude manifest can be enabled only on a
  Codex agent: the Claude CLI would name it after its directory, which for an
  installed plugin is a version. An agent change to the Claude harness that keeps one
  is refused, and a Claude conversation whose agent enables one is held with a reason
  naming the plugin.

## Installed plugins

An agent can name a plugin the operator installed and enabled in Claude Code
(`claude:<plugin>@<marketplace>`) or Codex (`codex:<plugin>@<marketplace>`). cab takes
only that plugin's skill directories from the install; the isolation above is unchanged:
cab's own Codex home, plugin hooks off, `strictMcpConfig` and `features.plugins=false`.
No hook, MCP server, app or setting is read from the operator's configuration.

- **Resolution.** Each turn start resolves the plugin to its install directory, and both
  harnesses load from that directory, so an agent never sees two versions of a plugin.
  Claude Code: the plugin is enabled in `~/.claude/settings.json` and resolved through
  `installed_plugins.json`. Codex: the plugin is enabled in `config.toml` and has exactly
  one version directory in its plugin cache. Neither format is a documented interface:
  cab validates both at runtime and fails closed.
- **Unavailable.** A plugin that cannot be resolved (uninstalled, disabled, an unknown
  record format or two Codex versions) holds the turn with a reason that names the
  plugin and no path, and readiness reports it. Installing or enabling it again
  recovers: the held work is re-checked on a timer, because a change in either tool is
  not a cab event. Only Claude Code's user-scope install counts; project and local
  installs belong to a repository's own settings. An agent enables a plugin once by
  manifest name, so the same plugin from both tools, or a local copy of it, is refused.
- **Updates.** Updating a plugin in Claude Code or Codex updates it for cab's next turn,
  and the turn's plugin digest shows the change. A turn whose install directory is
  removed while it runs, for example by an update, can fail; whether either tool does so
  during a session is unproven.

Local plugin directories remain for plugins that are not installed, such as one under
development.

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
  previous Codex home; restart the task" in its revision refusal, before it holds a
  writer, capacity or recovery state, so the operator can use Reset task (Start again
  keeps the conversation and is refused the same way). A refused draft turn gives its
  message back. The runtime also refuses the resume before any App Server request.
  There is no sessions link and no copy of rollouts. The thread's qualification row
  records the home it was started under: rows that exist at upgrade have none, and a
  resumed thread with no row is treated the same way. Captured history stays readable.

## Codex skills

One Codex App Server process serves every Codex conversation, and its extra skills roots
are process-wide, so the roots are the union of every agent's plugin skill
directories and each thread is scoped by `skills.config` entries in its `thread/start`
and `thread/resume` config. A thread whose agent enables skills disables every other
listed skill (the plugins' other skills, the bundled skills and repository skills). A
thread whose agent enables none disables the skills of cab's plugin roots only and
keeps what it saw before; a process that never loaded plugins sends no skills config at all.
The [proof](../evidence/codex-skill-scope-probes-2026-10-30.md) on Codex 0.164.0 shows:

- Two threads on one App Server see different skills, and a restarted App Server resumes
  a thread with the same scope.
- A loaded thread ignores config sent on resume and also sees plugin roots that join the
  process later, so before each resume that carries skills config cab sends
  `thread/unsubscribe` for the (idle) thread and then resumes it with the current
  config. A plugin directory that joins the process during a running turn can therefore
  reach that turn until its conversation's next turn.
- The scope is a model-facing list, not a security boundary: a thread given the path of
  a disabled skill can still read its `SKILL.md`, and skills are instructions to the
  agent, not cab policy. Scripts run through the shell tool under the existing sandbox.
- A model-driven shell prints the real `HOME`, skill discovery loads nothing from it, and
  the login link stays intact.

Codex subagents stay disabled whatever the proof shows: with the feature on in a separate
process, the recorded run showed the model delegating to a subagent whose outside write
did not land, but two processes below the App Server were still running 3 s after
`turn/interrupt`. That is a demonstrated gap in interrupt containment, and one more reason
the feature stays off.

## Considered options

- Loading the operator's own Claude and Codex configuration. Rejected: it brings
  every installed hook, MCP server, app and setting into agent turns, including
  personal integrations such as mail, calendar and home automation, and makes a task's
  behaviour depend on unrelated interactive setup. Installed plugins take only skill
  directories from it.
- Local plugin directories only. Rejected: the operator's plugins are installed in
  Claude Code and Codex at versioned paths, so each update broke the agent or needed
  a second checkout to maintain.
- cab-managed marketplaces, fetched, pinned and updated by cab. Rejected: a second place
  to install and update the same plugins, with its own fetching, credentials for private
  repositories and storage, when both tools already install them.
- Copying installed plugins into a cab store, on import or at assignment start.
  Rejected: an import is another update step to manage, and a per-assignment copy adds
  storage and collection to keep a version the operator has already replaced.
- Each harness loading its own tool's install of a plugin. Rejected: the two tools hold
  different versions of the same plugin, so an agent's skills would differ by harness.
- Skill directories only, without plugins. Rejected: most of the operator's skills
  are distributed as plugins, and copying them out would drift from their updates.
- Service-wide skills. Rejected: agents already carry instructions and execution
  settings, and different agent roles need different skills.
- Loading plugin hooks with disclosure. Rejected: plugin hooks run outside the
  sandbox and could weaken cab's tool policy.

## Consequences

- Skills that rely on network access, `gh` or pull request publication still fail
  in the sandbox or conflict with cab-owned publication
  ([ADR-1016](1016-ensemble-owned-commit-publication.md)); the skills need a cab mode
  or cab-aware instructions.
- Plugins are read from the service host: installed plugins need Claude Code or Codex
  installed there for the service user, with the plugins enabled.
- An assignment no longer pins plugin content: each turn uses the current install, and
  the turn digest records which content it ran.
- Subagents increase token use and the number of concurrent tool calls within one
  turn; capacity still counts the assignment, not its subagents.
