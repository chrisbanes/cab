# Escalate-auto-review live qualification

Recorded 2026-11-12 for [#1681](https://github.com/chrisbanes/cab/issues/1681), slice T5 of its approved plan. The run is at candidate `339ba2d39da10f0ace75c9df78325f7abe2bf8ba` (on `main` at `0419e5cb`), built into `dist` from that clean tree. No credential, token or account data is recorded. The sanitised output is in [2026-11-12-escalate-auto-review-live.json](2026-11-12-escalate-auto-review-live.json). The harness replaced the fixture root with `<fixture>`, the per-user temporary directory with `<tmpdir>` and the home directory with `~`.

## Run

- **Command:** `npm run escalate-auto-review:live`, which takes exactly `--live --one-attempt`. It ran once, from 13:48:34 to 13:49:03 UTC, and exited 0. No rerun was made, so the allowance of one fresh attempt for a diagnosed harness defect is unused.
- **Offline gate:** the run's offline contract passed at the same candidate before the run (`sandbox-escalation-qualification-harness.test.ts`: the grammar refusal and the classifier).
- **Runtime:** Codex launcher `codex-cli 0.167.0-alpha.3.2` (SHA-256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8`) on the service user's own login. The operator's `CODEX_HOME` holds 2 files in `rules`, counted but not read.
- **Host:** Node v26.13.0 on macOS.

The harness starts the real `StandaloneService` and Codex App Server on a disposable data directory under `~/.cache`. It sets up one project at sandbox level `escalate-auto-review` and one task, whose workspace holds the fixed `chromium.mjs` script. That script launches headless Chromium through Playwright and writes `{chromium}` to `<label>-result.json`.

The task's Codex lead runs one turn, which the harness forwards by its marker; it refused none. The agent runs `node chromium.mjs control` inside the sandbox, then escalates `node chromium.mjs reviewed` with `sandbox_permissions: "require_escalated"`. By controller decision D32 the run has no denial stimulus: the escalated command is the same harmless browser launch. The harness would decline anything that reached the Inbox; nothing did. From the App Server traffic it records only metadata: the turn's policy, review notifications, command item completions, client approval requests and turn ends. It never records command output. It then reads the task through the operator API.

## Results

| Cell | Outcome | Evidence |
| --- | --- | --- |
| A reviewer approval is recorded with its command's result | proved | Turn `01a1d004-7644-7b33-a9ab-6a204eef4def` sent the sandbox-only granular policy with `approvalsReviewer: "auto_review"` and `workspaceWrite`. The sandboxed control failed (`browserType.launch: EPERM: operation not permitted, mkdtemp '<tmpdir>/playwright-artifacts-…'`). Review `693314b4-52c5-4db1-b157-65e475cc77ce` started and completed in that turn for `/bin/zsh -lc 'node chromium.mjs reviewed'`, a `command` action with target `exec-3aac6afc-1dbe-4745-b083-8d8a9faa7bd1`, and was `approved` at `riskLevel: low` ("Auto-review returned a low-risk allow decision."). The item with that id completed `completed`, exit code 0, in 742 ms, and wrote `chromium: "ok"`. The turn completed `completed`. The task read's review `693314b4-…` reads decider `reviewer`, decision `accept`, outcome `approved`, risk `low`, exit code 0 and 742 ms from the runtime. No escalation reached cab as a client request, and nothing was reported unexpected. |
| A reviewer denial offers an advisory overrule | untested | Denial not elicited: no denial stimulus used (controller decision D32). The reviewer denied nothing. |
| An overrule is accepted and the retry is reviewed again | untested | As above. |
| A re-review after an overrule gets a new `reviewId` (review note F9) | untested | As above: it needs an overrule. |
| Observation: overrule eligibility | observed | The recorded working directory is `.`, inside the task workspace, so a denial of this command would have been offered an overrule. |

## Verdict

The finite pass rule for this run is met: the approval cell is proved from its own turn's events, and the run passed with the service stopped and the fixture removed. The reviewer's decision, risk level, rationale, exit code and duration reach cab's record and the task read as the deterministic suites show. The overrule remains the disclosed limit from the [T1 probe](2026-11-12-auto-review-overrule-probe.md): it is qualified only against a fake App Server.

## Limits

- **Overrule:** `thread/approveGuardianDeniedAction`, its `GuardianAssessmentEvent` mapping and the re-review have not been exercised live.
- **One review:** the run saw one review for one command item, of a `command` action. Execve, stdin and network reviews were not exercised.
- **Unstable notifications:** Codex marks the review notifications `[UNSTABLE]`; cab checks their shape at runtime.
- **Operator configuration:** the run used the operator's `CODEX_HOME` and its default reviewer settings; the turn's own reviewer was `auto_review`.
