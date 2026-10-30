# Claude skill plugin and subagent journeys, 30 October 2026

Bounded live qualification of profile skill plugins and in-turn subagents for the
Claude runtime ([ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md),
[#1336](https://github.com/chrisbanes/cab/issues/1336)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`): the real
`StandaloneService` and `ClaudeRuntime` on a disposable repository and temporary
data, with the existing turn caps. Redacted output of the passing attempts:
[`skill-plugin-journeys-2026-10-30.json`](skill-plugin-journeys-2026-10-30.json)
(SHA-256 `83a19fb7cd1df3a1b9b1e829ccc1e3c0820510b079707881462a1ca0a6579892`).

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `claude-skill` | passed, attempt 1 | The profile's `probe-skill` ran through the `Skill` tool: its script wrote the marker inside the task workspace and its outside write was denied by the sandbox. The plugin's own `PreToolUse` hook and stdio MCP server did not run. The turn recorded the plugin's name, skills and digest, and the digest equals an independent digest of the plugin directory. |
| `claude-subagent-stop` | passed, attempt 1 | A subagent's Bash `/bin/sleep 120` was recorded as a diagnostic item attributed to the subagent. Operator Stop was acknowledged and its terminal observed; the work stayed held with the Stop, writer, capacity and uncertainty holds. The Claude CLI and the two processes below it (recorded by exact identity while the subagent ran) had exited, and no turn started afterwards. |
| `claude-subagent-crash` | passed, attempt 2 (see Attempts) | The child service was SIGKILLed by exact PID during a subagent's `/bin/sleep 120`. The CLI survived the kill and was ended by its recorded identity, then its two descendants were verified gone. After restart the work was held with writer, capacity and uncertainty holds, the same through `OperatorApi.readExecution`, with no turn in a 30 s quiet window. The recovery resolution then released the holds. |

Every recorded Claude CLI, Codex App Server and child service process was verified
exited by exact identity.

## Versions and candidate

Node `v24.22.1`; Agent SDK `0.3.310`; Claude Code `2.1.311` on `PATH`. All three ran at the profile-skill-plugins candidate recorded in the JSON, with
Claude profiles on `haiku` at `low` effort. The Codex launcher is started by the harness
but takes no turn in these facets.

## Attempts and limits

- `claude-subagent-stop`: two earlier attempts failed on a harness defect in the new
  descendant capture (a process id compared as a string); no model failure. They were
  followed by the passing attempt in a fresh ledger directory.
- `claude-subagent-crash`: the first two attempts (haiku, then sonnet) ran the original
  facet, which resumes the session with one more turn after recovery. Both ended
  `model-compliance`: the resumed turn did not complete within its 4 minute cap, with
  the holds, CLI termination and descendant checks already as above. In the haiku
  attempt the resumed turn started and did not finish; in the sonnet attempt no
  resumed turn was started within the cap. The cause is not diagnosed. The facet was
  then scoped to what the plan requires (visible holds, termination by recorded
  identity, hold release) and the resumed turn after a mid-subagent crash is
  **untested**, recorded as `resumedTurnAfterSubagentCrash: "untested"`. A first
  run of the scoped facet failed on a harness check that expected the second service
  generation to have run a query; the passing attempt follows it. The scoped runs used
  a fresh ledger directory, so the per-facet attempt count restarted.
- `TMPDIR` was set to a private directory for these runs, so the ledger and
  disposable roots lived there and were removed by the driver.
- Claude turns used across all attempts: 1 (skill), 3 (subagent stop: two harness
  failures and the pass), 9 (subagent crash: 3 and 2 in the full-scope attempts, 2 and
  2 in the scoped ones).
