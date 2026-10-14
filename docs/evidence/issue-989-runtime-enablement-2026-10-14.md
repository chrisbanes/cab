# Issue #989 runtime enablement: bounded live check, 2026-10-14

**Candidate:** branch `cb/issue-989-runtime-toggles` at c87a967f (service code unchanged since).
**Host:** the operator's Mac, Node 24.21.0, `codex-cli 0.162.1` and Claude Code 2.1.296 on
`/opt/homebrew/bin`. A fresh data directory under a temporary scratch root; no installed
service, LaunchAgent, Haze or real Ensemble data was touched.

## What ran

A script started the production `StandaloneService` (real `createRuntime`, runtimes
`codex` and `claude`, power supervision off) from `dist/`, then called
`configureRuntime` directly. No model turn was requested from either runtime.

| Step | Observation |
| --- | --- |
| Start | Both runtimes started (`available`); `verifyCodexLogin()` returned `verified`. |
| Disable Claude (no bound work) | Claude `not-configured`, reason `disabled`; no confirmation needed. |
| Enable Claude with `claude` off the service `PATH` | Refused, `runtime-executable-missing`, harness `claude`; the setting stayed disabled. |
| Disable Codex (no bound work) | Codex `not-configured`, reason `disabled`; the App Server was stopped and the login check returned `unavailable`. |
| Enable Codex | A new Codex App Server started in the running service in 573 ms; `available`, login `verified`. |
| Stop | Clean shutdown. |

## Limits

- **Unproven live:** the planned `mixed-runtime:live --facet toggle` journey (disable
  Claude mid-turn, the turn finishes, the follow-up waits, re-enable admits it) needs
  Claude turns, and no Claude subscription token was available on this host. The facet
  was not added or run. Drain-then-stop, no fallback and re-admission are covered only
  by the fake-runtime service, API, CLI and browser tests.
- No Codex turn ran, so a live Codex drain was not observed either.
- The calls went straight to the service, not through the operator API, CLI or web.
