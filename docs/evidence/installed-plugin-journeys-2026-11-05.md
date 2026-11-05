# Installed plugin journeys, 5 November 2026

Bounded live qualification that a profile can use a plugin installed in Claude Code or
Codex, and that updating it in the tool changes the next turn
([ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md), "Installed plugins";
[#1525](https://github.com/chrisbanes/cab/issues/1525)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`). It runs the real
`StandaloneService` with the real Claude CLI or Codex App Server, on a disposable
repository and temporary data. Redacted output:
[`installed-plugin-journeys-2026-11-05.json`](installed-plugin-journeys-2026-11-05.json)
(SHA-256 `bdfe68516832138a1c0f7ec52da93c59c37f474215fb816755296fd222cb890b`).

## Setup

Each facet starts from a local git marketplace that serves the plugin `cab-probe` to
both tools.

- **The plugin.** It has one skill, `cab-probe-phrase`, whose instructions give a phrase
  in bold. It also declares a hook (`SessionStart` and `PreToolUse`) and an MCP server.
  Each of them would leave a marker file if it ever ran.
- **Install.** The tool's own CLI installs the plugin into a disposable home that the
  service environment points at:
  - Claude Code: `CLAUDE_CONFIG_DIR`, with `claude plugin marketplace add` and
    `claude plugin install`.
  - Codex: `CODEX_HOME`, with `codex plugin marketplace add` and `codex plugin add`. The
    disposable Codex home holds only a link to the operator's login.
- **Turn 1.** The lead profile names `<tool>:cab-probe@cab-probe-mkt`, and the first task
  runs at version 1.0.0.
- **Update.** The marketplace is bumped to 1.1.0 with a new phrase, and the tool's CLI
  updates the plugin:
  - Claude Code: `claude plugin marketplace update` and `claude plugin update`.
  - Codex: `codex plugin add` again.
- **Turn 2.** A second task for the same lead runs at version 1.1.0.

The operator's own Claude Code and Codex configuration was not read or changed.

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `claude-installed-plugin` | passed, attempt 1 | The profile check accepted the plugin, and each Claude lead reported its version's phrase. Turn 1 recorded `cab-probe` from install 1.0.0, and turn 2 from install 1.1.0. Each digest equals an independent digest of that install directory, and the digest changed with the update. No hook or MCP marker appeared. The run took two Claude turns, with the `claude` on `PATH`. |
| `codex-installed-plugin` | passed, attempt 1 | The same checks passed on a Codex lead. The digests are the same as in the Claude run, because the plugin content is the same. cab's `auth.json` was still a link to a regular file (metadata only). The run took two Codex turns. |

Every recorded process was verified as exited, by exact identity.

The Claude Code update kept the 1.0.0 directory and repointed its record to 1.1.0. The
Codex update replaced the 1.0.0 directory, so after the update the App Server's
process-wide skills roots still listed a root that no longer existed. The second Codex
task ran normally regardless.

## Versions and limits

- Candidate `29f963c8`. Review repairs made after these runs change the profile editor
  and the readiness check, and make Codex refuse an unreadable (rather than missing)
  plugin cache directory as an unrecognised record. None of them changes the resolution,
  loading or digest path these runs exercise.
- Agent SDK 0.3.316 with Claude Code 2.1.318 on `PATH`, which also ran the Claude plugin
  commands.
- The approved Codex launcher `codex-cli 0.166.0-alpha.6`, which also ran the Codex
  plugin commands.
- Model `haiku` at low effort for Claude.
- A reported phrase shows that the skill's instructions reached the agent. It does not
  show how: the Codex agent may read the `SKILL.md` through its shell (see ADR-1021,
  "Codex skills").
- Each update happened between turns. A turn running while its install directory is
  removed is not exercised (an accepted limit in ADR-1021).
- The marketplace is a local git directory, not a remote one. cab reads only the records
  the install leaves, so the source of the install is outside what cab depends on.
