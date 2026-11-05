# Skill plugin layout journeys, 5 November 2026

Bounded live qualification that a plugin in the layout Claude Code and Codex use loads in
cab on each harness ([ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md),
"Plugin layout"; [#1524](https://github.com/chrisbanes/cab/issues/1524)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`): the real `StandaloneService`
with the real Claude CLI or Codex App Server, on a disposable repository and temporary
data. Redacted output:
[`skill-plugin-layout-journeys-2026-11-05.json`](skill-plugin-layout-journeys-2026-11-05.json)
(SHA-256 `034fd0334e20756412a414f82510e305dc89b032453dcf710242653117a4a119`).

The plugin is a copy of the operator's installed `mattpocock-skills` 1.3.1 (Claude Code
cache), copied with its symbolic links. That tree is what cab refused before: 1825 files
over 23 MB, mostly `node_modules`, 10 internal symbolic links, and skills at
`skills/<category>/<name>/SKILL.md` listed in the manifest's `skills` array. The profile
enables the nested skill `grilling` (`skills/productivity/grilling`).

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `claude-nested-skill` | passed, attempt 1 | The profile check accepted the skill. A Claude lead invoked it by name with the `Skill` tool and reported the first bold phrase of its instructions ("design tree"). The turn recorded `mattpocock-skills` with skill `grilling` and a digest equal to an independent digest of the plugin's load scope. One Claude turn, run by the `claude` on `PATH`. |
| `codex-nested-skill` | passed, attempt 1 | The same check on a Codex lead: the thread was scoped to the skill's discovered `SKILL.md`, the lead used the skill and reported the same phrase, the turn recorded the same name, skill and digest, and cab's `auth.json` was still a symbolic link to a regular file (metadata only). One Codex turn. |

Every recorded process was verified exited by exact identity.

## Versions and limits

- Candidate `79355e0f`. Agent SDK 0.3.316 with Claude Code 2.1.318 on `PATH`, the approved
  Codex launcher `codex-cli 0.166.0-alpha.6`, model `haiku` at low effort for Claude.
- The reported phrase shows that the skill's instructions reached the agent. It does not
  show how: the Codex agent may read the `SKILL.md` through its shell, and the scope is a
  model-facing list, not a boundary (see ADR-1021, "Codex skills").
- Only local plugin directories are exercised. Installed plugins as a profile source are
  [#1525](https://github.com/chrisbanes/cab/issues/1525).
