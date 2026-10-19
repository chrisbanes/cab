# Issue #1190 evidence: Codex model and reasoning effort per profile (2026-10-19)

Slice evidence for [#1190](https://github.com/chrisbanes/ensemble/issues/1190). It
records the App Server request placement the implementation relies on and one bounded
live run through the real service.

## Environment

- Codex launcher `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`,
  `codex-cli 0.163.0-alpha.10.2` (SHA-256 `50ab38ba…e379c8`), with the host's existing
  login. Node 24.22.0. No credentials, account data or operator data are recorded.

## Request placement (probe, 2026-10-18)

A throwaway stdio JSON-RPC probe drove `codex app-server` once in a disposable
workspace: one attempt, two `turn/start` calls, no retries. Sanitised output:
[issue-1190-app-server-settings-probe-2026-10-18.json](issue-1190-app-server-settings-probe-2026-10-18.json).

| Request | Observed |
| --- | --- |
| `model/list` | One page of 7 models; each has `model`, `isDefault`, `hidden`, `supportedReasoningEfforts[].reasoningEffort` and `defaultReasoningEffort`; exactly one `isDefault` |
| `thread/start` with `model` and `config.model_reasoning_effort` (a non-default model and a non-default effort) | The response reports the same `model` and `reasoningEffort` |
| `turn/start` with `model` and `effort` | The turn completes |
| `thread/resume` without settings | Reports the same `model` and `reasoningEffort` |
| `turn/start` with an unknown `model` | Accepted by the RPC; the turn then fails with a 400 `invalid_request_error` ("model … is not supported when using Codex with a ChatGPT account"). It is not a JSON-RPC error, so preflight against `model/list` is the only check before admission |

## Bounded live run

`npm run codex-settings:live` (`test/operator/diagnostics-qualification/live-diagnostics.mjs
--codex-settings --live --one-attempt`) at `01e95a0e`: one attempt, 10-minute bound,
exit 0, about 13 s. It starts the real service on a disposable data directory, waits
for the runtime's `model/list`, creates a lead profile with a model and its lowest
reasoning effort from that list, runs one task turn and reads the execution through the
built CLI over loopback. Sanitised output:
[issue-1190-codex-settings-live-2026-10-19.json](issue-1190-codex-settings-live-2026-10-19.json).

| Surface | Observed |
| --- | --- |
| Configured profile runtime | `gpt-5.6-luna`, effort `low`; `profile get` returns `{"harness":"codex","model":"gpt-5.6-luna","reasoningEffort":"low"}` |
| Execution diagnostics, service-admitted | `profile.model` `gpt-5.6-luna`, `profile.reasoningEffort` `low` |
| Execution diagnostics, runtime-reported | `model` `gpt-5.6-luna`, `reasoningEffort` `low` |
| Execution | `completed`, thread and turn bound |
| Sentinel and cleanup | Sentinel absent from CLI output and database bytes; service stopped, process exit verified, fixture removed |

`startTurnCalls` is 2: the harness refuses every `turn/start` after the first, so
the second call (a result-repair turn) never reached the runtime.

## Offline coverage

| Behaviour | Test |
| --- | --- |
| Catalogue read, parameters on `thread/start` and `turn/start`, unchanged parameters without settings, preflight reasons, single-flight retry | `test/execution/codex-runtime.test.ts` |
| Captured revision per assignment and drafting run, preflight wait, no settings argument without settings, diagnostics entries | `test/execution/codex-profile-settings.test.ts`, `test/execution/drafting-service.test.ts` |
| Schema, summary and unsupported-field rules | `test/execution/operator-execution-runtime.test.ts` |
| Readiness | `test/coordination/readiness.test.ts` |
| Profile write validation and the wait Fix | `test/operator/operator-api.test.ts` |
| Settings → Profiles set, show, clear and reject | `test/operator/operator-profile-config-browser.test.ts` |
| CLI set, show and clear | `test/workspaces/operator-cli-change.test.ts` |
