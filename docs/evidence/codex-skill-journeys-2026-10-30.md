# Codex skill journey, 30 October 2026

Bounded live qualification that a Codex turn receives its profile's skill plugin
([ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md),
[#1336](https://github.com/chrisbanes/cab/issues/1336)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`): the real `StandaloneService`
and `CodexRuntime` on a disposable repository and temporary data, with the operator's
login linked into cab's own Codex home. Redacted output:
[`codex-skill-journeys-2026-10-30.json`](codex-skill-journeys-2026-10-30.json)
(SHA-256 `a21a10c9f7b89f0b1aac7f7e8437d4cff2384b687d0fbd2b85e165aa6629b927`). The per-thread scoping behind it is in the
[proof record](codex-skill-scope-probes-2026-10-30.md).

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `codex-skill` | passed, attempt 2 | A Codex lead whose profile enables `probe-skill` ran the skill: its script wrote the marker inside the task workspace, the turn recorded the plugin's name, skills and digest (equal to an independent digest of the plugin directory), no plugin hook or MCP server ran, and cab's `auth.json` was still a symbolic link to a regular file (metadata only). An operator follow-up then continued the conversation, which takes the runtime's resume path (it unsubscribes the thread and resumes it with the profile's skill scope), and that second turn ran the skill again and recorded its digest. Two Codex turns. |
| `mixed` | passed, attempt 1 | The existing journey, rerun: a Codex lead delegates to a Claude worker, the worker reports, and the lead's completion request finalizes. Two Codex turns and one Claude turn. |

Every recorded process was verified exited by exact identity.

## Versions and limits

- The JSON's `candidate` is the commit the final runs started from; the `codex-skill` run included the follow-up turn check, which was uncommitted when it started and is committed afterwards; the `mixed` run is from the same commit.
- The journeys run the approved launcher, `codex-cli 0.165.0-alpha.1.2`; the scoping proof
  ran on the `codex` on `PATH`, 0.164.0. Both ran the
  skill.
- The recorded run is the last of several: earlier runs, before the login-link check and the
  follow-up turn were added to the facet and before review repairs, passed too. The ledger
  lived in a private temporary directory, so attempt counts were not shared with earlier
  rounds.
- The outside write of the skill script is recorded but is not a gate for Codex: its
  workspace-write sandbox also allows the temporary directory the disposable root lives in.
- Codex subagents are not exercised and stay disabled.
