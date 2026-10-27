# Claude Agent SDK 0.3.310 upgrade qualification

[PR #1225](https://github.com/chrisbanes/ensemble/pull/1225) updated the SDK
from 0.3.304 to 0.3.310 but left `claudeSdkVersion` at 0.3.304. Both failing
CI jobs reported that exact-version mismatch. The runtime, service and
qualification-harness tests reproduced it locally: 52 of 53 passed before the
marker change, and all 53 passed afterwards. The assertion and runtime policy
remain unchanged.

The existing isolation and permission-policy probes were rerun against the locked
SDK before publishing the updated marker:

- Node 24.22.1 and npm 12.2.1; dependencies installed with `npm ci`.
- SDK 0.3.310, with bundled Claude Code 2.1.310 reported in init metadata.
- Eight model-backed queries using `haiku` / `low` and the configured subscription
  token; the reported model was `claude-haiku-5-5`.
- A disposable home, config and workspace with seeded decoys. Its SDK module path
  linked to this checkout's installed dependencies, without a latest-version lookup.
- All recorded process identities were verified gone after the probes.

All six [isolation facets](claude-sdk-upgrade-isolation-2026-10-27.jsonl) passed:
subscription authentication, configuration and instruction isolation, decoy
plugin/skill/agent/MCP exclusion, dedicated transcript placement and model discovery.
Positive controls loaded the seeded decoys.

All five [permission-policy facets](claude-sdk-upgrade-policy-2026-10-27.jsonl)
passed: hook correlation and denial, continued execution after denial, the exact
advertised tool allowlist, absence of AskUserQuestion and Agent/Task, and stable
permission/MCP configuration after writes and resume. The SDK's warning that bare
`allowedTools` entries bypass `canUseTool` remains consistent with Ensemble's
hook-enforced policy.

This is bounded evidence for the SDK update. It does not repeat crash, abort,
subprocess environment scrubbing, full sandbox, temporary-root or service/UI live
qualification, and does not qualify independently installed Claude CLI versions.
Existing recovery boundaries and sandbox limits remain in effect.
