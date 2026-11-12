# Claude `auto` hook-allow probe

Recorded 2026-11-12 for [#1682](https://github.com/chrisbanes/cab/issues/1682), slice T1 of its approved plan. Before either Claude escalate level is built on `auto`, the probe checks four things under cab's hook matcher options. First, that a flagged Bash call the PreToolUse hook holds and then `allow`s runs outside the sandbox. Second, whether Claude's classifier also decides that call. Third, whether the hook can hold longer than the 60 s default. Fourth, whether the installed Claude Code supports `onFailure: "block"` and reports `supportsAutoMode`. The probe is the `claude-auto-hook-allow` group of `test/execution/sandbox-escalation-qualification/live-escalation.mjs`. It talks to the SDK directly, not through the cab service, and changes no runtime code. The sanitised output is in [2026-11-12-claude-auto-hook-allow-probe.json](2026-11-12-claude-auto-hook-allow-probe.json). No credential, token, email or account data is recorded. The harness keeps only the hook-option fields and each model's `value` and `supportsAutoMode` from the initialize reply.

Host: macOS (Darwin 27.0.0), Apple silicon (arm64), Node v26.13.0.

## Versions

Claude Agent SDK 0.3.319 (declares Claude Code 2.1.319); installed `claude` 2.1.322. The session reported model `claude-sonnet-5-5`.

## Run

`npm run sandbox-escalation:live -- --group=claude-auto-hook-allow` ran once, from clean candidate `441d9336`, with `CLAUDE_CODE_OAUTH_TOKEN` exported. It started at 15:14:34 UTC and ended at 15:16:09 UTC. It exited 0 with `pass: true`, the fixture root and Claude Code's task-output directory were removed, and the one query ended `success`. This is the only attempt; no rerun was needed. The offline harness test passed at the candidate before the run. After the run, review tightened the classifier. A proof now needs exactly one call per stimulus and that call's own successful run. An aborted hold counts as untested, not as a refutation. The bypass comparison counts only a non-denial signal for a comparison call that ran. The run's trace reclassifies to the same outcomes under the final rules.

## Fixture

The fixture and stimulus are the ones from [the 2026-11-11 probe](sandbox-escalation-probe-2026-11-11.md): a 0700 root under `~/.cache` with `chromium.mjs <label>`, which launches headless Chromium and writes `{ chromium: "ok" | <error> }` to `<label>-result.json`. One SDK `query()` uses `permissionMode: "auto"`, `allowedTools: []`, only the Bash tool, `settingSources: []`, `strictMcpConfig` and an empty `CLAUDE_CONFIG_DIR`. Its sandbox block is cab's, with `allowUnsandboxedCommands: true`. The PreToolUse matcher is registered with `timeout: 960` and `onFailure: "block"`, as T2 plans for `escalate-approval`. `canUseTool` records and denies.

The prompt asked for three benign Bash calls, one at a time:

1. `node chromium.mjs control`, unflagged. The hook passes it through.
2. `node chromium.mjs hook-allowed`, with `dangerouslyDisableSandbox: true`. The hook holds it for 75 000 ms, standing in for an operator approval, then returns `allow`.
3. `node chromium.mjs classified`, flagged. The hook passes it through, so the classifier decides it. It is the same-run comparison for the classifier signals.

The hook denies any other command. The model made exactly these three calls, in order.

## Results

All times are milliseconds from the start of the query.

| Cell | Outcome | Evidence or reason |
| --- | --- | --- |
| `controlRunsSandboxed`: under `auto`, unflagged Bash runs sandboxed through `autoAllowBashIfSandboxed` | proved | `toolu_01JyZEx5iopchurejt11maUR`. The hook passed it at 2 408 and `PostToolUse` followed at 4 135. No `canUseTool`. Chromium failed inside the sandbox: `browserType.launch: Target page, context or browser has been closed` at `chrome-headless-shell` launch. |
| `hookAllowRunsOutside`: the held, hook-allowed flagged call runs outside the sandbox | proved | `toolu_01GE5BY15MA6ULGHN8BE1mZ1` wrote `chromium: "ok"`, while the same-run control above failed. Its tool result was not an error, and its `PostToolUse` carried `dangerouslyDisableSandbox: true`. |
| `hookHoldBeyondDefault`: the hook holds past the 60 s default with matcher `timeout: 960` | proved | Same call. Hook input at 5 592, hook returned `allow` at 80 596 (held 75 004 ms, not aborted), and `PostToolUse` followed at 81 685. |
| `hookAllowBypassesClassifier`: the classifier does not decide a hook-allowed call | untested | No classifier signal of any kind was emitted: no `system` / `permission_check_status` and no `permission_denied`. The comparison call (`toolu_012ryP8DXaJq6QCy4DYVmB39`) has nothing attributable either, so silence for the hook-allowed call shows nothing. `canUseTool` was not called for any call. |
| `onFailureBlockSupported`: the installed CLI reports support for `onFailure: "block"` | proved | The initialize reply reported `hook_on_failure_supported: true` and `hooks_applied: true` for the matcher sent with `onFailure: "block"`. |
| `supportsAutoModeReported`: `supportedModels()` reports `supportsAutoMode` | proved | Each listed model reported `supportsAutoMode: true`: `default`, `sonnet`, `fable`, `opus` and `haiku`. |

The comparison call ran: auto mode let it through without `canUseTool`, and it wrote `chromium: "ok"`.

## Outcome branch: B

The plan's branch B applies: an operator approval is not shown to be final.

- The hook-allowed call ran outside the sandbox after a 75 s hold, so `escalate-approval` on `auto` with a hook hold is viable. Branch C does not apply.
- Whether the classifier also decided the hook-allowed call is untested. The run emitted no per-call classifier signal at all, so branch A's proof is unavailable. The `escalate-approval` disclosure must say that Claude's classifier can still refuse an operator-approved call. Under the plan, `canUseTool` then allows only a `tool_use_id` the operator already accepted, so no second Inbox item is opened.

The hook options and `supportsAutoMode` are supported, so neither re-plan trigger applies.

## Limits

These are recorded limits for T2–T4:

- **Classifier observability:** this run emitted no classifier stream message. The #1678 run emitted two unattributed `permission_check_status` messages for two classified calls. A classifier approval of a call is therefore visible only as the call running with no `canUseTool` callback. Timing does not separate the two either. After its hook, the comparison call took 4 316 ms to reach `PostToolUse`. The hook-allowed call took 1 089 ms after its hook returned, and the unflagged control took 1 727 ms. Chromium's launch time dominates both, so the difference proves nothing.
- **`onFailure: "block"` behaviour:** support is proved by the CLI's initialize reply. No hook failure was staged, so a hook throw or timeout blocking the call was not exercised live. That behaviour is documented by SDK 0.3.319 (`HookCallbackMatcher.onFailure`).
- **Hold length:** a 75 s hold is proved under matcher `timeout: 960`. The 15-minute hold is inferred from the option, not exercised.
- **Model names:** `supportedModels()` lists aliases (`default`, `sonnet`, `fable`, `opus`, `haiku`), while the session's `init` reported `claude-sonnet-5-5`. The auto-mode check in T2 must look up the turn's configured model by the same `value` that cab's settings read already uses, not by the `init` model id.
- **Classifier denial and undecided calls:** not elicited, under the benign-stimulus rule. The classifier allowed the only call it decided.
- **Version skew:** installed `claude` 2.1.322 is newer than the SDK's declared 2.1.319.
