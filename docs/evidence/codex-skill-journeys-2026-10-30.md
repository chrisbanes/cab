# Codex skill journey, 30 October 2026

Bounded live qualification that a Codex turn receives its profile's skill plugin
([ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md),
[#1336](https://github.com/chrisbanes/cab/issues/1336)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`): the real `StandaloneService`
and `CodexRuntime` on a disposable repository and temporary data, with the operator's
login linked into cab's own Codex home. Redacted output:
[`codex-skill-journeys-2026-10-30.json`](codex-skill-journeys-2026-10-30.json)
(SHA-256 `69890a914d6b812aa1ce3d8ee005e703b671e0682e5186e36f3e0bd2d5685d22`). The per-thread scoping behind it is in the
[proof record](codex-skill-scope-probes-2026-10-30.md).

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `codex-skill` | passed, attempt 2 | A Codex lead whose profile enables `probe-skill` ran the skill: its script wrote the marker inside the task workspace, the turn recorded the plugin's name, skills and digest (equal to an independent digest of the plugin directory), no plugin hook or MCP server ran, and cab's `auth.json` was still a symbolic link to a regular file (metadata only). One Codex turn. |
| `mixed` | passed, attempt 1 | The existing journey, rerun: a Codex lead delegates to a Claude worker, the worker reports, and the lead's completion request finalizes. Two Codex turns and one Claude turn. |

Every recorded process was verified exited by exact identity.

## Versions and limits

- The journeys run the approved launcher, `codex-cli 0.165.0-alpha.1.2`; the scoping proof
  ran on the `codex` on `PATH`, 0.164.0. Both produced the scoped skill list and the
  skill run.
- The first `codex-skill` attempt passed without the login-link check; the check was added
  and the facet rerun. The ledger lived in a private temporary directory, so the attempt
  count was not shared with earlier rounds.
- The outside write of the skill script is recorded but is not a gate for Codex: its
  workspace-write sandbox also allows the temporary directory the disposable root lives in.
- Codex subagents are not exercised and stay disabled.
