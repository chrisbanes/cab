# Native harness setup, 9 November 2026

The native configuration prerequisites for [#1569](https://github.com/chrisbanes/cab/issues/1569)
passed on both installed harnesses. Integrated Stop and explicit recovery are now
qualified for both: Claude's third lifecycle attempt passed three fresh recovery
turns, reusing the verified Stop proof from attempt 2. Both earlier failures remain
recorded. This is bounded qualification, not deployment approval.

The [approved plan](https://github.com/chrisbanes/cab/issues/1569#issuecomment-6720804732)
uses the service user's native authentication, instructions and extensions while
cab retains coordination and conservative execution ownership. The bounded driver
is `test/execution/user-setup-qualification/run.mjs`; its lifecycle facet uses the
production service and runtimes with disposable task workspaces and a separate
database. [Sanitized observations and input digests](issue-1569-native-setup-2026-11-09.json)
identify the tested source. Raw account metadata, configuration and ledger remain
private; they are not part of this evidence export.

## Observations

| Surface | Result | Evidence |
| --- | --- | --- |
| Codex native start/resume | Passed | Native instruction/skill discovery, harmless inherited fixture MCP and bound cab callback; the same owned conversation resumed. |
| Claude native start/resume | Passed on native attempt 3 | Native instruction/skill, project fixture MCP/hook and two bound cab callbacks; the same owned session resumed. A colliding project `cab` server was separately refused before releasing a model prompt because its provenance was not `sdk`. |
| Codex integrated Stop | Passed | Acknowledged interrupt and observed terminal; Stop, writer, capacity and uncertainty holds retained; no blind resubmission. |
| Codex integrated recovery | Passed | Completed seed, interrupted follow-up, retained crash ownership and explicit recovery on the same conversation. Both result callbacks ended successfully. |
| Claude lifecycle attempt 1 | Failed before model dispatch | Cab required an optional account metadata field omitted by the installed CLI. No model slot was used. The field is now optional; positive first-party subscription metadata is still required. The real production preflight passed after repair without a model prompt. |
| Claude lifecycle attempt 2 | Partial: Stop passed, seed failed | Stop retained all holds and no resubmission. The seed's native terminal completed, but cab held the work after an unexpected permission request for `mcp__cab__cab_report_result`; no cab result callback ran. The failed seed does not qualify a completed coordinated turn. |
| Claude lifecycle attempt 3 | Passed | Completed coordinated seed, interrupted follow-up and explicit recovery on the same native conversation; two ended successful cab callbacks. Reused the exact verified Stop evidence from attempt 2, without refunding either earlier slot. |
| Owned-process cleanup | Passed for recorded identities | Every recorded process in the lifecycle evidence was verified exited. Personal configuration, unrelated sessions and old cab homes were retained. |

Installed versions were Node `26.13.0`, npm `12.2.1`, Codex `0.166.0`, Claude Code
`2.1.318` and Claude Agent SDK `0.3.316`. These results cover the local macOS
service environment. They do not qualify launchd, other platforms or arbitrary
inherited extension effects.

## Corrections and completed proof

The second Claude failure exposed an invalid `mcp__*` allow rule. Claude's
[permission contract](https://code.claude.com/docs/en/agent-sdk/permissions)
requires a literal server prefix before a tool wildcard. Production now explicitly
allows `mcp__cab__*`; every cab call still requires SDK server provenance and the
bound coordination validation. Prompt admission also requires exactly one
connected SDK `cab` status: empty, duplicate or conflicting status arrays refuse
before a prompt. This closes an accepted-payload ambiguity found during review;
normal startup producing duplicate entries was not observed. Trusted non-cab MCP tools receive a
[PreToolUse approval](https://code.claude.com/docs/en/agent-sdk/hooks).
Native deny/ask rules and the unexpected-permission rejection remain effective.
The repair passed deterministic checks and the production Claude recovery journey.
The successful seed and explicit continuation both ended their bound cab result
callbacks. The interrupted follow-up retained writer, capacity and uncertainty
holds across restart; recovery alone submitted no model turn, and the explicit
continuation resumed the same conversation. All four recorded owned process
identities were verified exited.

The user approved one third Claude lifecycle attempt with three fresh turns in a
new 15-minute window from dispatch. The window began at 10:00:41 Europe/London
and the attempt finished within it; the four-minute turn cap was unchanged.
The retained ledger counts 14 of 14 slots: Claude eight, Codex six, including the
earlier quota-rejected request and failed seed. The original expired windows and
every failed attempt remain recorded. Stop was reused only after its exact
retained evidence digest, observed terminal, ownership holds, no resubmission
and verified cleanup passed validation. No further live attempt is authorised,
and no provider, model or API billing fallback was used.

## Automated coverage and delivery gates

Runtime and service checks cover native environment inheritance, subscription
admission, SDK cab provenance, credential exclusions, legacy resume refusal,
Stop and recovery. SQLite transition checks preserve historical settings,
receipt replay and pending ownership while rejecting new retired writes.
Archival/deletion checks limit native runtime calls to attributable native cab
conversations. Chromium checks cover native setup guidance, profile edits,
drafts, focus and navigation.

Initial full checks exposed a stale retired-endpoint expectation and a test-runner
import masked by old build output. Both are repaired, and a clean rebuild passes.
Fresh registry metadata resolved `ETARGET` for the unchanged pinned dependency;
the package suites then exposed a Codex-only fixture accidentally depending on
the host's Claude login. That fixture now explicitly disables Claude through the
supported CLI. All nine package checks and 74 affected runtime, admission,
source-copy and qualification-driver checks pass. No assertion or dependency
version was removed to conceal a failure. The final full `npm run check` passed
with fresh metadata: 5,796 tests registered, 5,744 passed, 52 skipped and zero
failures. This includes static checks, the service build and Chromium coverage;
WebKit was not run on macOS. Independent code review accepted the repaired
candidate after checking the runner import and unambiguous MCP admission. The
production implementation is unchanged by the final qualification-driver amendment;
its 11 contract checks also pass, including the exact recovery cap and retained
Stop evidence checks. Final-head CI remains required after publication.

The [operations guide](../operations/standalone-macos.md) retains backup and
rollback steps for a separately approved service switch. No installed service,
Haze prototype, merge or deployment was changed by this qualification.
