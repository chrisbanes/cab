# #827 Claude execution harness journeys, 12 October 2026

This records the bounded live qualification (task T3 of
[#827](https://github.com/chrisbanes/ensemble/issues/827)) of the Claude runtime
under [ADR-1008](../adr/1008-claude-code-execution-harness.md). The driver is
`test/c5/live-journeys.mjs` (`npm run c5:live -- --live --facet <facet>`), which runs
the real `StandaloneService` with the real `ClaudeRuntime` and the ChatGPT.app Codex
launcher against a disposable repository and temporary data. Redacted per-attempt
output:
[`issue-827-claude-journeys-2026-10-12.json`](issue-827-claude-journeys-2026-10-12.json)
(SHA-256 `0389d1162b12dc8e6cab1a6d85989c1d196c7caaa832e90a53c6148f1410c1ae`).

## Result

All four journeys passed and the scrub facet qualified the token scrub for
sandboxed Bash. The terms recheck found no change since ADR-1008 was recorded.

| Facet | Disposition | Observation |
| --- | --- | --- |
| Scrub (C5-4) | qualified (attempt 2) | Sandboxed Bash saw neither `CLAUDE_CODE_OAUTH_TOKEN` nor the service's `env:` reference variable, and the token value was absent from its full environment. The positive control `ENSEMBLE_C5_CONTROL` was present, so the probe did read Bash's environment. `ps -E` on Bash's parent was refused inside the sandbox, so the parent's environment was not readable that way. |
| Stop (C5-3) | passed (attempt 2) | Stop during a running `/bin/sleep 120` was acknowledged and its terminal observed. The work stayed `held` with the Stop, writer, capacity and uncertainty holds; the Claude CLI exited by itself; no turn started in the following 30 s. |
| Crash (C5-3) | passed (attempt 2) | The child service was SIGKILLed by exact PID during a follow-up turn running `/bin/sleep 120`. After restart the work was `held` with unknown observations, writer, capacity and uncertainty holds, the same through `OperatorApi.readExecution`; no turn started in a 30 s quiet window and the holds stayed. After `resolveHeldExecution` with a bound-turn receipt and one operator message, exactly one Claude turn ran on the same session (`threadId`, the SDK session ID) as the crashed and the earlier completed turn, and the holds were released only after it. |
| Claude-only (C5-1) | passed (attempt 1) | Claude lead `ensemble_delegate`; Claude worker `ensemble_ask_question`, answered through the domain answer command, then `ensemble_report_result` with the nonce; lead `ensemble_request_completion`; the completion finalized and the task reached `done`. Four Claude turns. |
| Mixed (C5-2) | passed (attempt 1) | Codex lead `ensemble_delegate`; Claude worker `ensemble_report_result` with the nonce; Codex lead `ensemble_request_completion`; the completion finalized. Two Codex turns and one Claude turn. |

Every recorded Claude CLI, Codex App Server and child service process was verified
exited by exact identity (`MacProcessTerminationVerifier`).

## Versions and candidate

- Node `v24.21.0`; Agent SDK `0.3.296`; bundled Claude Code `2.1.296`.
- Codex launcher `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`,
  `codex-cli 0.162.0-alpha.17.2`, SHA-256
  `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8`.
- Claude profiles used `haiku` at `low` effort, except the second Stop attempt
  (`sonnet`, `low`; see Attempts).
- The JSON records each attempt's candidate commit before the branch was rebased
  onto `e0979727`. The passing attempts ran at the commits now named "Report a
  result from shell-only Claude journey turns" (scrub), "Run the Claude journey's
  long probe command as /bin/sleep" (Stop) and "Crash a follow-up Claude turn so
  recovery has a session to resume" (crash, Claude-only, mixed). The rebase changed
  no driver or runtime file.

## Budget

| Facet | Attempts | Claude turns | Codex turns | Per-attempt cap (Claude/Codex) |
| --- | ---: | ---: | ---: | --- |
| Scrub | 2 | 2 | 0 | 1/0 |
| Stop | 2 | 2 | 0 | 1/0 |
| Crash | 2 | 5 | 0 | 2/0, then 3/0 (see Attempts) |
| Claude-only | 1 | 4 | 0 | 8/0 |
| Mixed | 1 | 1 | 2 | 3/4 |
| **Total** | 8 | **14 of 30** | **2 of 10** | |

The session ran from 07:41 to 08:00 BST, within the 2 h cap; no turn reached its
4 min cap and no attempt its 20 min cap. One ledger refusal occurred (scrub attempt
1).

## Attempts and corrections

| Attempt | Failure | Cause and correction |
| --- | --- | --- |
| Scrub 1 | `probe files timed out`; a second turn was refused by the ledger | Harness defect. A lead turn that ends without a result or waiting action queues a reporting-repair turn, which the one-turn cap refused. The probe briefs now end with `ensemble_report_result`; a deterministic test checks that a facet turn needs no repair turn. |
| Stop 1 | `the turn ended before Stop` | Harness defect. Claude Code `2.1.296` refuses a foreground command that starts with a bare `sleep N` for N ≥ 25 ("Blocked: standalone sleep"), so the turn ended at once. The probe command is now `/bin/sleep 120`, and the test checks that no brief starts with a bare `sleep`. The driver had classified this as model compliance, so the ledger escalated attempt 2 to `sonnet`. The plan allows escalation only after a model-compliance failure, so this escalation was a misclassification, disclosed here; it stayed within the caps. |
| Crash 1 | `the recovered turn did not resume the same session` | Plan assumption corrected (one diagnosis, one repair cycle). The service continues an assignment from its latest completed turn. Attempt 1 crashed the assignment's first turn, so there was no completed turn and the recovered turn correctly started a fresh session; holds, quiet window, single recovered turn and release all passed. The crash facet now completes one turn first and crashes a follow-up, which needs three Claude turns, so its per-attempt cap rose from 2 to 3 within the unchanged 30-turn session cap. |

## Terms recheck

On 12 October 2026 the
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
was fetched and compared with the Internet Archive capture of 8 October 2026
22:03 UTC (the day ADR-1008 was recorded): the text is identical. It says Pro and
Max limits assume ordinary individual use of Claude Code and the Agent SDK, and that
developers building products should use API keys and may not offer Claude.ai login
or route other users' requests through subscription credentials. A single-operator
service driven by its owner is still not addressed explicitly.

## Observations beyond the pass criteria

- **Claude CLI after a service crash.** After the service was SIGKILLed, its Claude
  CLI process kept running its turn and had not exited 10 s later; the driver
  stopped it by exact verified PID (SIGTERM). The bound-turn recovery receipt
  already requires the operator to prove the process has exited.
- **Recovery resumes the latest completed session.** A crash during an assignment's
  first turn continues in a fresh session after recovery, because no completed turn
  exists to resume (crash attempt 1). This is the service's existing recovery
  behaviour for every runtime.
- **Recovery route.** Recovery used the service seam `resolveHeldExecution`; there
  is no operator HTTP or CLI route for bound-turn recovery
  ([#899](https://github.com/chrisbanes/ensemble/issues/899) records the gap). The
  held state was read in process through `OperatorApi.readExecution`, not through
  the HTTP `execution.read` token scope.

## Not tested (limits)

- Hook and stdio MCP children: not applicable. The `PreToolUse` hook runs in
  process and the strict MCP configuration allows no stdio servers.
- Other ways a sandboxed process could read its parent's environment than `ps -E`.
- Several concurrent tasks with separate temporary bases.
- Claude sessions resumed after a Claude Code upgrade.
- Model-originated escalation attempts.
- Platforms other than macOS.
- Token expiry or revocation mid-turn.
- The launchd-installed service, and the operator HTTP read of a held execution.

## Method and cleanup

Chris granted the run in chat on 12 October 2026 ("OK for 827"): reading only
`CLAUDE_CODE_OAUTH_TOKEN` from `~/.env` through the driver's `loadToken()`, and the
plan's turn budget. The driver put the token into the service environment only as
the `env:` reference variable, configured the reference and restarted the service
before any Claude turn. Each attempt used a fresh `ensemble-c5-*` root (mode 0700)
under the temporary directory with a local Git repository and no remote; the crash
facet ran the service in a forked child process. A budget ledger in the temporary
directory enforced the caps across invocations. The scrub probe's files were read
in memory, reduced to booleans and deleted before evidence was written. Each
attempt redacted its output at write time and refused to print it on any leak-scan
finding. Every root and per-task `ens-*` temporary base under `/tmp` was removed by exact path; none
remained afterwards, and no Claude CLI or Codex App Server process started by the
driver remained. The installed prototype, operator data and `~/.codex` were not
touched.
