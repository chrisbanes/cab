# Claude Agent SDK 0.3.304 upgrade qualification

The SDK update in [#1188](https://github.com/chrisbanes/ensemble/pull/1188)
failed the exact-version guard because `claudeSdkVersion` still named 0.3.300.
Before advancing that marker, the existing isolation and permission-policy probes
were rerun against SDK 0.3.304 and its bundled Claude Code 2.1.304. Both passed.
The version assertion remains unchanged, and Ensemble's runtime policy is unchanged.

## Scope and environment

The [upstream changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.304/CHANGELOG.md)
changes omitted permission-mode defaults and enables fork subagents by default.
Ensemble supplies `permissionMode: "dontAsk"`, exposes six built-in tools,
excludes Agent/Task, and uses `PreToolUse` to deny calls outside policy. The
probes check those controls and configuration isolation with the new SDK.

- Checkout: `5cfec41e3f1b47e25185a28fa9cd451f0ac118f5` before the marker change.
- Node 24.22.0; locked SDK 0.3.304 and zod 4.6.7 from `npm ci`.
- The existing qualification driver loaded those installed dependencies through
  a disposable root's `sdk/node_modules` symlink. No newest-version lookup was used.
- Runtime: the SDK's default bundled Claude Code 2.1.304, reported by `system/init`.
  The separately installed CLI was 2.1.309 and was not used for these probes.
- Eight model-backed queries, `haiku` / `low`, resolved to `claude-haiku-5-5`,
  using the configured subscription token. No API key was passed.
- Isolated home, configuration and workspace with seeded decoys; no installed
  Ensemble service, task data or prototype was changed. Every recorded process
  identity was verified gone at the end.

## Results

| Probe | Evidence | Result |
| --- | --- | --- |
| Isolation, F7.1–F7.6 | [Redacted trace and observations](claude-sdk-upgrade-isolation-2026-10-23.jsonl) | All six facets passed. Subscription authentication worked; decoy hooks, environment, instructions, memory, plugins, skills, agents and MCP configuration stayed unloaded. Positive controls loaded the decoys. Transcripts stayed under the dedicated config directory. |
| Policy, F5.1–F5.5 | [Redacted trace and observations](claude-sdk-upgrade-policy-2026-10-23.jsonl) | All five facets passed. Hook IDs matched every tool call, the outside write was denied and the turn continued, the advertised tools exactly matched the allowlist, AskUserQuestion and Agent/Task were absent, and config writes/resume did not change permissions or MCP servers. |

The SDK warns that bare `allowedTools` entries bypass `canUseTool`. This matches
Ensemble's existing contract: the hook enforces policy. The live denial succeeded
without a `canUseTool` callback, and a WebFetch variant was denied by `dontAsk`.
Built-in CLI plugins and skills appeared in init metadata; the isolation result
covers the seeded user/project decoys, not the absence of built-in features.

The pre-change Claude runtime, service and qualification-harness tests passed
52 of 53 cases; the sole failure was the stale version marker. After the marker
change, all 53 passed on Node 24.22.0 and Node 26.12.1.

## Limits

This is bounded upgrade evidence for isolation, tool policy and deterministic
runtime behavior. It does not repeat the crash, abort, full sandbox, temporary-root
or complete service/UI live qualifications. Their existing recovery boundaries and
sandbox limits remain in effect. It does not qualify the independently installed
2.1.309 executable or assert compatibility with arbitrary external CLI versions;
[ADR-1011](../adr/1011-packaging-and-distribution.md) retains that limit.
