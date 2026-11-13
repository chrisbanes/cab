# Claude escalation live qualification

Recorded 2026-11-13 for [#1682](https://github.com/chrisbanes/cab/issues/1682), slice T4: both Claude escalate levels through the real service. The harness is `test/execution/sandbox-escalation-qualification/live-claude-escalation.mjs` (`npm run claude-escalation:live`), classified by `claude-escalation-outcomes.mjs`. The sanitised outputs of the three attempts, and the diagnosis after attempt 1, are in [2026-11-13-claude-escalation-live.json](2026-11-13-claude-escalation-live.json). No credential, token or account data is recorded, and no command output: only each fixture script's own Chromium result string. Claude ran on the service user's native Claude Code login; the harness read no secret.

Host: macOS (Darwin 27.0.0), Apple silicon (arm64), Node v26.13.0. Claude Agent SDK 0.3.319; installed `claude` 2.1.322. Model alias `sonnet`.

## Run

One service runs two tasks of one Claude lead profile, one turn each, sequentially. Each task is in its own project, at its own level:

- **escalate-approval:** three Bash calls. `node chromium.mjs control-approval` runs unflagged inside the sandbox. `node chromium.mjs approved` is flagged, and the harness, acting as the operator through the operator API, approves it. `node chromium.mjs declined` is flagged and declined.
- **escalate-auto-review:** `node chromium.mjs control-review` runs unflagged. `node chromium.mjs reviewed` is flagged, and Claude's classifier decides it. A call it left undecided would have been approved in the Inbox.

All stimuli are benign Chromium launches (controller decision D32). The harness observes the real SDK query: PreToolUse and post-tool hooks, `canUseTool` asks and stream messages, by `tool_use_id`. It reads cab's stored escalations and reviews by turn and item. A cell is proved only from its own turn's events, including that turn's sandboxed control and its successful end.

## Attempts

| Attempt | Candidate | Start (UTC) | End (UTC) | Result |
| --- | --- | --- | --- | --- |
| 1 | `2a64bbe0` | 2026-11-12 18:24:48 | 18:25:01 | failed: both turns started in `default`, not `auto` |
| 2 | `e84c25f3` | 2026-11-13 18:41:09 | 18:41:48 | failed: harness defect; the hook decisions were not recorded |
| 3 | `7cde5a72` | 2026-11-13 19:03:54 | 19:04:31 | **passed**: every required cell proved |

Attempts 1 and 2 exited 1 with `pass: false`; attempt 3 exited 0 with `pass: true`. Each stopped the service, released the per-task temporary bases and removed its fixture. `dist` was rebuilt from the candidate immediately before attempts 2 and 3.

- **Attempt 1** failed on a product defect, fixed before attempt 2.
- **Attempt 2** qualified that fix but hit a harness defect.
- **Attempt 3** was the one fresh attempt that controller decision D44 authorized for that diagnosed harness defect.
- Before attempt 3, an offline test drove the harness's hook observer, which the live run imports. It showed the observer records each hook's decision and return time on the stored record. The same test fails under the old copy-then-mutate order.

### Attempt 1 and the diagnosis

- **What happened.** Both turns were admitted at their levels, but Claude Code's init reported `permissionMode: "default"`. cab's guard failed each turn before any tool call, and both intents ended `resolved-failed`. Every cell is untested: turn not confirmed in auto mode.
- **The T1 probe still holds.** It had reported `auto` with an empty config directory, `settingSources: []`, a token login and minimal options.
- **Bisection.** Eleven model starts, each aborted at init with no tool call, varied one factor at a time from the service's configuration. They isolated cab's turn environment. With everything else unchanged, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` alone made Claude Code start in `default`. The TodoWrite gates alone did not.
- **Ruled out:** native login versus token, native versus empty config directory, native versus empty setting sources, cab's turn options and the inherited process environment.

| Case | Auth | Config dir | Setting sources | Options | Env | Mode |
| --- | --- | --- | --- | --- | --- | --- |
| probe | token | empty | none | minimal | minimal | `auto` |
| service | native | native | default | cab | cab | `default` |
| service, no setting sources | native | native | none | cab | cab | `default` |
| service, empty config | native | empty | default | cab | cab | `default` |
| service, token | token | native | default | cab | cab | `default` |
| service, minimal options | native | native | default | minimal | cab | `default` |
| service, minimal env | native | native | default | cab | minimal | `auto` |
| service, cab's turn variables only | native | native | default | cab | minimal + cab's 5 variables | `default` |
| service, inherited env only | native | native | default | cab | process env | `auto` |
| service, scrub only | native | native | default | cab | minimal + `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` | `default` |
| service, task gates only | native | native | default | cab | minimal + the two TodoWrite gates | `auto` |

By maintainer decision, escalate-level turns now omit the scrub. Strict, draft and read-only turns keep it. The disclosure states that sandboxed Bash at the escalate levels can read the service's environment, from which cab removes only its own and Claude's credential variables.

### Attempt 2

**Both turns started in `auto`**, were admitted at their levels, and ended `completed` with an SDK `success`. No unexpected request was reported in either turn. The one-turn budget refused one further turn per task, which the cells do not depend on.

What attempt 2's own records show (`tool_use_id`s are in the JSON):

- **escalate-approval:**
  - The control was unflagged, so it ran sandboxed: its hook ran and its post-tool hook followed, with no permission ask. Chromium failed: `browserType.launch: Target page, context or browser has been closed`.
  - `approved` was flagged. cab recorded the operator's acceptance for that item in that turn, with exit code 0 and a service-measured 1 116 ms. Its post-tool hook followed, and it wrote `chromium: "ok"`.
  - `declined` was flagged. cab recorded the operator's decline with no exit code. Its tool result was an error, no post-tool hook followed, and it wrote no result file.
- **escalate-auto-review:**
  - The control was unflagged and Chromium failed, as above.
  - `reviewed` was flagged and reached no `canUseTool`. Its post-tool hook followed, and it wrote `chromium: "ok"`.
  - cab recorded a reviewer approval for that item: no risk level, no rationale, no overrule, exit code 0, runtime-measured 3 028 ms. The task had no Inbox item.

**The defect.** The harness recorded each PreToolUse hook's input, but its record was a copy. The decision and return time it set after the hook returned landed on the original object and never reached the evidence. Without the hook's own decision, no cell can be proved.

- At run time the classifier read the missing decision as a contradiction and reported `refuted`.
- The final classifier reads it as missing evidence: each required cell is **untested** ("the hook's decision was not recorded"). The JSON keeps the run-time outcomes as `outcomesAtRun`.
- The harness now records the decision on the stored record.

### Attempt 3

**Both turns started in `auto`**, were admitted at their levels, and ended `completed` with an SDK `success`. No unexpected request was reported in either turn. As in attempt 2, the one-turn budget refused one further turn per task, which the cells do not depend on. Each proof below cites only its own turn's records.

- **escalate-approval control** (`toolu_01AQ6qtjSgy1x98YLgQfFWnX`) is **proved**.
  - The call was unflagged. The hook passed it on: input at 6 188 ms, returned at 6 190 ms.
  - No permission ask followed, and its post-tool hook came at 7 291 ms.
  - Chromium failed inside the sandbox: `browserType.launch: Target page, context or browser has been closed`.
- **approve** (`toolu_016bAyCrqg877UqVefmCfEfd`) is **proved**.
  - The call was flagged. The hook held it from 8 620 ms and returned `allow` at 9 362 ms.
  - cab recorded the operator's acceptance for that item in that turn (interaction `22c58354…`), with exit code 0 and a service-measured 2 894 ms.
  - Its post-tool hook followed at 12 252 ms, and it wrote `chromium: "ok"`.
- **decline** (`toolu_01CAFWQbTA1Lx36SdTq2bvWx`) is **proved**.
  - The call was flagged. The hook held it from 13 487 ms and returned `deny` at 14 455 ms.
  - cab recorded the operator's decline (interaction `6da226a6…`) with no exit code.
  - Its tool result was an error, no post-tool hook followed, and it wrote no result file.
- **escalate-auto-review control** (`toolu_01NWCq3VdR6ATXBgzuMe1WE7`) is **proved**.
  - The call was unflagged, and the hook passed it on.
  - No permission ask followed, and its post-tool hook came at 26 074 ms.
  - Chromium failed inside the sandbox.
- **classifier approval** (`toolu_016YM5sdZA4VgF1s1oPmC3uE`) is **proved**.
  - The call was flagged, and the hook passed it on at 28 682 ms.
  - It reached no `canUseTool`. Its post-tool hook followed at 33 099 ms, and it wrote `chromium: "ok"`.
  - cab recorded a reviewer approval with that `tool_use_id` as its review id and target, in that turn. It has no risk level, no rationale and no overrule, exit code 0, and a runtime-measured 4 419 ms.
  - The task had no Inbox item.

## Outcomes

These are the outcomes under the final classifier. Each attempt is a separate run.

| Cell | Attempt 1 | Attempt 2 | Attempt 3 |
| --- | --- | --- | --- |
| escalate-approval control | untested: not in auto mode | untested: hook decision not recorded | **proved** |
| approve | untested: not in auto mode | untested: hook decision not recorded | **proved** |
| decline | untested: not in auto mode | untested: hook decision not recorded | **proved** |
| escalate-auto-review control | untested: not in auto mode | untested: hook decision not recorded | **proved** |
| classifier approval | untested: not in auto mode | untested: hook decision not recorded | **proved** |
| undecided call | untested: none elicited (D32) | untested: none elicited (D32) | untested: none elicited (D32) |
| classifier denial | untested: no denial stimulus (D32) | untested: no denial stimulus (D32) | untested: no denial stimulus (D32) |
| cancelled ask then post-tool hook (#1715 residual risk) | not observed | not observed: no ask in either turn | not observed: no ask in either turn |

## Limits

- **Coverage.** Attempt 3 proves the required cells: the operator's approve and decline at escalate-approval, a classifier approval at escalate-auto-review, and each turn's sandboxed control. Attempts 1 and 2 prove nothing.
- **The classifier approval is inferred.** cab infers it from the call running with no `canUseTool` ask. Claude Code shows no classifier decision directly.
- **The scrub finding** is from model starts aborted at init on Claude Code 2.1.322. Another version may behave differently. cab's guard fails any escalate turn that does not start in `auto`.
- **Classifier denial, undecided calls and the cancelled-ask risk** were not elicited, under the benign-stimulus rule.
