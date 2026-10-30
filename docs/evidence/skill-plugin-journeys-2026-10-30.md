# Claude skill plugin and subagent journeys, 30 October 2026

Bounded live qualification of profile skill plugins and in-turn subagents for the
Claude runtime ([ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md),
[#1336](https://github.com/chrisbanes/cab/issues/1336)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`): the real
`StandaloneService` and `ClaudeRuntime` on a disposable repository and temporary
data, with the existing turn caps. Redacted output of the passing attempts:
[`skill-plugin-journeys-2026-10-30.json`](skill-plugin-journeys-2026-10-30.json)
(SHA-256 `840eed875570aa5743fe4b2ce19ae6220c56cd501653f73ae9e4b2c7d2563863`).

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `claude-skill` | passed, attempt 1 (haiku), skill names qualified by plugin | The profile's `probe-skill` ran through the `Skill` tool: its script wrote the marker inside the task workspace and its outside write was denied by the sandbox. The plugin's own `PreToolUse` hook and stdio MCP server did not run. The turn recorded the plugin's name, skills and digest, and the digest equals an independent digest of the plugin directory. |
| `claude-subagent-stop` | passed, attempt 1 | A subagent's Bash `/bin/sleep 120` was recorded as a diagnostic item attributed to the subagent. Operator Stop was acknowledged and its terminal observed; the work stayed held with the Stop, writer, capacity and uncertainty holds. The Claude CLI and the two processes below it (recorded by exact identity while the subagent ran) had exited, and no turn started afterwards. |
| `claude-subagent-crash` | passed, attempt 1 (scoped) | The child service was SIGKILLed by exact PID during a subagent's `/bin/sleep 120`. The CLI survived the kill; the harness ended it by its recorded identity (cab itself only verifies exit, as in #827) and its two descendants were then verified gone. After restart the work was held with writer, capacity and uncertainty holds, the same through `OperatorApi.readExecution`, with no turn in a 30 s quiet window. The recovery resolution then released the holds. |

Every recorded Claude CLI, Codex App Server and child service process was verified
exited by exact identity.

## Versions and candidate

Node `v24.22.1`; Agent SDK `0.3.310`; Claude Code `2.1.311` on `PATH` (the SDK
declares `2.1.310`). Claude profiles ran on `haiku` at `low` effort, `sonnet` where
noted. The Codex launcher is started by the harness but takes no turn in these facets.
The recorded `claude-subagent-*` runs are the second round and `claude-skill` is a third run: the first round (the same facets, before the
review repairs to the subagent input check, subagent conversation text, plugin digest
and `skipMcpDiscovery`) passed on the first commit of this branch, and the final round
reran all three on the code in the pull request. The JSON's `candidate` is the commit
the final round started from; the working tree then also held the review repairs.

## Attempts and limits

- **Resumed turn after a crash during a subagent: not demonstrated.** The original
  `claude-subagent-crash` also resumed the session with one more turn after recovery.
  Two attempts (haiku, then sonnet) ended `model-compliance`: in the haiku attempt the
  resumed turn started and did not finish within its 4 minute cap, and in the sonnet
  attempt none was started within the cap. The cause is not diagnosed. The facet was
  then scoped to what the plan requires (visible holds, termination by recorded
  identity, hold release), and the JSON records
  `resumedTurnAfterSubagentCrash: "not-demonstrated"`.
- **Background subagents** (the Claude Code default for the `Agent` tool) were not
  exercised against Stop or resume.
- **Managed settings.** Plugin hooks are switched off through Claude Code managed
  settings, which an organisation's managed-settings tier can replace. These runs used a
  personal login.
- **Harness defects.** `claude-subagent-stop` failed twice on a defect in the new
  descendant capture (a process id compared as a string), and one scoped crash run
  failed on a check expecting the second service generation to have run a query; none is
  a model failure. In the second round `claude-skill` failed once on `haiku` (the
  skill's marker never appeared, `model-compliance`) and passed on `sonnet`; it was rerun once more
  after review changed the enabled skill names to `<plugin>:<skill>`, and passed on `haiku`.
- These runs used private ledger directories (`TMPDIR` set), so the per-facet attempt
  count restarted between rounds and after the scoped change; the per-attempt turn caps
  were unchanged and each directory was removed.
