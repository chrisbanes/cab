# Issue #989 runtime enablement: bounded live check, 2026-10-14

**Candidate:** branch `cb/issue-989-runtime-toggles`, service code as committed with this
record. **Host:** the operator's Mac, Node 24.21.0, `codex-cli 0.162.1` and Claude Code
2.1.296 on `/opt/homebrew/bin`, Codex signed in. Each run used a fresh data directory
under a temporary scratch root; no installed service, LaunchAgent, Haze or real
Ensemble data was touched.

## What ran

Scripts started the production `StandaloneService` (real `createRuntime`, runtimes
`codex` and `claude`, power supervision off) from `dist/` and called
`configureRuntime` directly. Two Codex model turns ran; no Claude turn ran.

**Run 1: start, refusal and Codex restart without turns**

| Step | Observation |
| --- | --- |
| Start | Both runtimes `available`; `verifyCodexLogin()` returned `verified`. |
| Disable Claude (no bound work) | `not-configured`, reason `disabled`; no confirmation needed. |
| Enable Claude with `claude` off the service `PATH` | Refused, `runtime-executable-missing`; the setting stayed disabled. |
| Disable Codex (no bound work) | Stopped at once; the login check returned `unavailable`. |
| Enable Codex | A new Codex App Server started in the running service in 573 ms; login `verified`. |

**Run 2: Claude on live, and a Codex drain with a real turn**

| Step | Observation |
| --- | --- |
| Disable, then enable Claude | `not-configured` (`disabled`), then `available` again in the running service. |
| Task 1 turn admitted on Codex | Intent `submitting`. |
| Disable Codex without confirmation | Refused, `runtime-confirmation-required`. |
| Disable Codex with confirmation, mid-turn | Setting saved; status `not-configured` (`disabled`); the App Server kept running (login still `verified`). |
| Task 2 created | Waited with "Codex runtime is not configured"; nothing ran on Claude. |
| Task 1 turn | Completed about 4 s later; the App Server then stopped (login `unavailable`); task 2 stayed `ready`. |
| Enable Codex | New App Server started without a restart; task 2 was admitted and completed. |

## Limits

- No Claude turn ran: no Claude subscription token was available on this host, so the
  planned `mixed-runtime:live --facet toggle` journey (a Claude mid-turn drain) was not
  added or run. The Claude drain is covered by fake-runtime service and browser tests;
  the live drain above used Codex.
- The calls went straight to the service, not through the operator API, CLI or web,
  which have their own automated tests.
