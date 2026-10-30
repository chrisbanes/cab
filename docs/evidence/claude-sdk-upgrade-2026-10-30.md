# Claude Agent SDK 0.3.312 upgrade qualification

[PR #1346](https://github.com/chrisbanes/cab/pull/1346) updated the SDK
from 0.3.310 to 0.3.312 but left `claudeSdkVersion` at 0.3.310. The failing
`node24-execution-2` and `node26-service-2` jobs reported that exact-version
mismatch. The assertion and runtime policy remain unchanged.

The existing isolation and permission-policy probes were rerun against the locked
SDK before publishing the updated marker:

- Node 24.22.2 and npm 11.19.1; dependencies installed with `npm ci`.
- SDK 0.3.312, with bundled Claude Code 2.1.312 reported in init metadata.
- Eight model-backed queries using `haiku` / `low` and the configured subscription
  token; the reported model was `claude-haiku-5-5` and `apiKeySource` was `none`.
- A disposable home, config and workspace with seeded decoys. Its SDK module path
  linked to this checkout's installed dependencies, without a latest-version lookup.
- All recorded process identities were verified gone after the probes.

All six [isolation facets](claude-sdk-upgrade-isolation-2026-10-30.jsonl) passed:
subscription authentication, configuration and instruction isolation, decoy
plugin/skill/agent/MCP exclusion, dedicated transcript placement and model discovery.
Positive controls loaded the seeded decoys.

All five [permission-policy facets](claude-sdk-upgrade-policy-2026-10-30.jsonl)
passed: hook correlation and denial, continued execution after denial, the exact
advertised tool allowlist, absence of AskUserQuestion and Agent/Task, and stable
permission/MCP configuration after writes and resume.

This is bounded evidence for the SDK update. It does not repeat crash, abort,
subprocess environment scrubbing, full sandbox, temporary-root or service/UI live
qualification, and does not qualify independently installed Claude CLI versions.
Existing recovery boundaries and sandbox limits remain in effect.
