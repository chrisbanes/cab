# Codex auto-review linkage and overrule probe

Recorded 2026-11-12 for [#1681](https://github.com/chrisbanes/cab/issues/1681), slice T1 of its approved plan, under [ADR-1034](../adr/1034-harness-native-sandbox-escalation.md). The probe is the `codex-overrule` group of `test/execution/sandbox-escalation-qualification/live-escalation.mjs`. It talks to Codex App Server directly, not through the cab service, and changes no runtime code. No credential, token, email or account data is recorded: the only account detail kept is the Codex account `type`. The sanitised output is in [2026-11-12-auto-review-overrule-probe.json](2026-11-12-auto-review-overrule-probe.json).

Host: macOS (Darwin 27.0.0), Apple silicon (arm64), Node v26.13.0.

## Versions

- Codex: the approved launcher `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` reports `codex-cli 0.167.0-alpha.3.2` (launcher SHA-256 `50ab38ba...e379c8`, the same binary as the [2026-11-11 probe](sandbox-escalation-probe-2026-11-11.md)). The thread reported model `gpt-6.1-sol`. The `codex` on `PATH` is not used.
- Protocol: types generated from this launcher with `codex app-server generate-ts --experimental` match the shapes the plan names. `item/autoApprovalReview/{started,completed}` carry `threadId`, `turnId`, `reviewId`, `targetItemId | null`, `review {status, riskLevel, userAuthorization, rationale}` and a typed `action`; the completed notification adds `startedAtMs`, `completedAtMs` and `decisionSource` (`"agent"`). `thread/approveGuardianDeniedAction` takes `{threadId, event: JsonValue}` and returns an empty object. Both notifications are marked `[UNSTABLE]` in the generated types.

## Run

One run, `npm run sandbox-escalation:live -- --group=codex-overrule`, from a clean checkout at candidate `b763410a` after `npm ci` and `npm run build`, with the offline harness test passing at that candidate. It ran from 09:03:37 to 09:04:15 UTC and exited 0. The fixture root was removed and the App Server child stopped. No rerun was made, so the allowance of one fresh attempt for a diagnosed harness defect is unused.

## Stimulus

By controller decision D32, the group uses no denial stimulus. Its one turn asks for an ordinary escalated command, `node chromium.mjs linked`, which launches headless Chromium on a `data:` URL and writes `linked-result.json` in the fixture workspace, with the justification `probe: needs host Chromium`. The turn sets reviewer `auto_review` and the granular policy that enables only `sandbox_approval`, as in the 2026-11-11 `codex-auto-review` group. The harness keeps its overrule path: if a completed review is ever `denied` while its turn runs, it sends `thread/approveGuardianDeniedAction` with the `GuardianAssessmentEvent` mapping, then with the raw completed notification only if the first is rejected, and never after `turn/completed` or as a new turn. The offline test exercises that path against the fake App Server with a scripted denial.

## Results

Each proved cell cites only its own runtime events, and the offline test checks that removing any one of them leaves the cell unproved.

| Sub-contract | Outcome | Evidence or reason |
| --- | --- | --- |
| A review's started and completed notifications pair | proved | `item/autoApprovalReview/started` and `completed` share `reviewId` `3fed604f-db44-4639-9311-59553afa5d41` and `turnId` `01a1ceff-b90e-76b3-8ac5-eef62ea0484e`, the turn the client's `turn/start` returned. `action.type` is `command`, with command `/bin/zsh -lc 'node chromium.mjs linked'`. The completed review is `approved`, `riskLevel: low`, rationale "Auto-review returned a low-risk allow decision." Only `command` reviews were observed. |
| `targetItemId` names the reviewed command item | proved | Both notifications carry `targetItemId` `exec-763965ce-eb5a-4e19-8c0d-eefd394660cf`. The `item/completed` `commandExecution` with exactly that `id`, in the same turn and after the review completed, ran the same command. |
| The linked item's completion is observable | proved | That item completed with `status: completed`, `exitCode: 0` and `durationMs: 1059`. |
| `thread/approveGuardianDeniedAction` is accepted mid-turn after a denial | untested | Denial not elicited: no denial stimulus used (controller decision D32). The reviewer approved the only escalation, so no overrule was sent. |
| The retry after an overrule is reviewed again | untested | Denial not elicited, as above. |
| No turn starts that the client did not request | proved | The only `turn/started` id equals the id the client's `turn/start` returned. With no overrule sent, this does not show how an overrule behaves. |

## Verdict

Under the plan's T1 gate, the overrule result is **denial not elicited**, and review linkage is **proved**:

- T2's reviewer evidence can record the exit code and duration of a reviewed command, from the `item/completed` whose `id` equals the review's `targetItemId`.
- T3 sends only the primary `GuardianAssessmentEvent` mapping, built from the retained completed notification. The overrule stays an unproved limit in `docs/acceptance.md`, `docs/SPEC.md` and the operations guide, and T5 tries the denial and overrule again through cab.

## Limits

- **Overrule:** `thread/approveGuardianDeniedAction` has still never been exercised live. Its `event` is an opaque serialised `codex_protocol::protocol::GuardianAssessmentEvent`, and the harness's snake_case mapping is unverified against a real denial.
- **Escalation outside the sandbox:** the run has no sandboxed control, so Chromium succeeding (`chromium: "ok"`) does not show that the command left the sandbox. The linkage contract does not depend on it; the 2026-11-11 `codex-user` group proved it for an accepted client escalation.
- **One review per item:** the run observed one review for one command item. Execve, stdin and network reviews, which the protocol says can share or lack a target item, were not exercised.
- **Unstable notifications:** the review notification payloads are marked `[UNSTABLE]` and "expected to change soon" in the generated types.
- **Operator configuration:** the run used the operator's `CODEX_HOME`. It holds 2 files in `rules`, counted but not read. The thread reported the operator default reviewer `auto_review`, matching the turn's reviewer. As in the 2026-11-11 probe, the model ran `cat ~/.agents/AGENTS.md`, the operator's global instructions, before the listed command. That read was not an escalation, and its output is not recorded.
