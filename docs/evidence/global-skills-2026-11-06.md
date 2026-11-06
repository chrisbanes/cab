# Global skills qualification, 6 November 2026

Both Claude and Codex passed the integrated global-skills journey at
`fd93b6c6f76c16e761ea8c4f2ace1d75d8a94242`. The driver was
`test/execution/mixed-runtime-qualification/live-journeys.mjs`, using a disposable
service home, actual profile selections and the production service/runtime adapters.

Runtime versions: Node 26.13.0, Agent SDK 0.3.316, Claude Code 2.1.318 from PATH
(Haiku, low effort), and Codex CLI 0.166.0-alpha.6. No operator skill installation,
configuration or installed Haze prototype was changed.

| Facet | Result | Observed behavior |
| --- | --- | --- |
| `claude-global-skill` | Passed; exit 0, three turns | A manifest-free skill installed through an external directory link read its relative resource, then read updated instructions/content in the same conversation. Service-recorded adapter digests changed and matched the loaded content. |
| `codex-global-skill` | Passed; exit 0, three turns | The same selected-skill, relative-resource, conversation-refresh and digest checks passed through Codex thread setup and resume. |

In each facet, the third turn deliberately omitted the resource. Both runtimes
reported `RESOURCE_MISSING`, which the successful-answer assertion rejected.
An unselected source skill was absent from the adapters and was not reported as
available. Each run recorded three successful result callbacks, no other cab
callbacks and no rejected callbacks. Service shutdown, temporary-root removal and
exit of every captured process identity were verified.

The commands were `npm run mixed-runtime:live -- --live --facet claude-global-skill`
and the corresponding `codex-global-skill` command. Earlier harness attempts failed
on stale assignment versions or missing Codex thread settings; the successful runs
include those repairs. A preliminary synthetic-adapter proof also passed on both
runtimes at `6413756c1438a23b793eaff91d8474316f2ebb58`.

At integrated implementation head `5a9a22b6fc422981b9d7950ecccee1322d7950e7`, static
checks and full Chromium test coverage passed: 5,626 passed, zero failed, 50 skipped.
The monolithic test run reached its 15-minute deadline; the complete set was then
verified with the documented two-shard selection, covering all 466 files exactly
once. Two offline-stack cases failed during concurrent shard execution and passed
without code changes when their shard ran alone. Independent review found no
actionable issues.

These runs demonstrate selected skill loading and the observed callback behavior;
they do not establish an independent host sandbox or a universal tool allowlist.
The adapter cache has per-adapter bounds but no total size limit. Codex's documented
process-wide root visibility during active turns remains unchanged. WebKit was not
run on macOS; browser coverage here is Chromium.
