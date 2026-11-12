# Escalate-approval live qualification

Recorded 2026-11-12 for [#1679](https://github.com/chrisbanes/cab/issues/1679). The run is at candidate `f7fa0d5d0240b85b168a7b37fd4cd8155b5ccb2a` (on `main` at `492d85b4`), built into `dist` from that tree. The branch was then rebased onto `78a519c2`; `git range-diff` shows its commits unchanged. The commits it moved past change the result review panel, the ready check, their tests, Inbox presentation and documentation, but not the escalation service, runtime or store code. No credential, token or account data is recorded. The sanitised output is in [2026-11-12-escalate-approval-live.json](2026-11-12-escalate-approval-live.json). The harness replaced the fixture root with `<fixture>` and the home directory with `~`. Two edits were made after the run, and the harness now does the first itself:
- the per-user temporary directory in the sandboxed Playwright error was replaced with `<tmpdir>`;
- the top-level `run` block (command, start, end, exit) was added from the shell that ran it.

## Run

- **Command:** `npm run escalate-approval:live`, which takes exactly `--live --one-attempt`. It ran once, from 03:52:57 to 03:54:56 UTC, and exited 0.
- **Offline gate:** the run's offline contract passed at the same candidate before the run (`sandbox-escalation-qualification-harness.test.ts`, 7 of 7; from the test log, not the JSON). It covers the grammar refusal and the classification.
- **Runtime:** Codex launcher `codex-cli 0.167.0-alpha.3.2` (SHA-256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8`) on the service user's own login.
- **Host:** Node v26.13.0 (from the JSON) on macOS 27.0.1 (read separately with `sw_vers`).

The harness starts the real `StandaloneService` and Codex App Server on a disposable data directory under `~/.cache`. It sets up one project at sandbox level `escalate-approval` and one task, whose workspace holds the fixed `chromium.mjs` script. That script launches headless Chromium through Playwright and writes `{chromium}` to `<label>-result.json`.

The task's Codex lead runs three turns on one thread. The harness forwards exactly one turn per step, found by its marker; it refused none. It plays the operator through the operator API (`approval.decide`, `message`, `task.stop`). From the App Server traffic it records only metadata: approval requests, `serverRequest/resolved`, command item completions and turn ends. It never records command output.

1. **Approve:** the agent runs `node chromium.mjs control` inside the sandbox, then escalates `node chromium.mjs escalated`. The operator approves the escalation.
2. **Decline:** the service is stopped and restarted, so the next turn resumes the thread in a new App Server process. An operator message starts a follow-up turn that escalates `node chromium.mjs declined`, and the operator declines it.
3. **Interrupt:** a further follow-up escalates `node chromium.mjs held`. Nobody answers, and the operator stops the task.

## Result

| Step | What cab sent | What happened | Escalation evidence |
| --- | --- | --- | --- |
| Approve | `turn/start` with `workspaceWrite` and `approvalPolicy: {granular: {sandbox_approval: true, rules: false, mcp_elicitations: false, skill_approval: false, request_permissions: false}}`, `approvalsReviewer: "user"` | The sandboxed control failed (`browserType.launch: EPERM: operation not permitted, mkdtemp '<tmpdir>/playwright-artifacts-…'`). The approved escalation wrote `chromium: "ok"`. | `operator`, `accept`, outcome `approved`, exit code 0, 516 ms reported by Codex |
| Decline | The same turn policy after `thread/resume` | Resume succeeded; Codex reported the thread's approval policy as `never`. The declined command item completed `declined`, nothing was written, and the turn completed. | `operator`, `decline`, outcome `declined`, no exit code |
| Interrupt | The same turn policy; no answer; then `task.stop` | Codex sent one `serverRequest/resolved` in this step, after the Stop. The turn ended `interrupted`. | `obsolete`, no decision |

Every check passed:
- **Approve:** the policy sent, the control failed in the sandbox, the escalated command ran outside it, the evidence was recorded, and there was no anomaly.
- **Decline:** the thread resumed with an accepted policy, the declined command wrote nothing, the evidence was recorded, the turn completed, and there was no anomaly.

"No anomaly" means no unexpected-request report in that step, unmatched resolutions included. After the Stop, the work read as held (`held: true`), as a Stop leaves it. No unexpected-request report was made in this step; in particular the late resolution was not reported as an unmatched native-input resolution.

## Observations and limits

- **Resume policy:** after an escalate-approval turn, a resumed thread reported `approvalPolicy: "never"`, not the granular object; cab sends `never` on `thread/resume`. cab still accepts the exact granular object, but this run did not observe Codex reporting it.
- **Resolution after a Stop:** Codex sent a `serverRequest/resolved` after the turn was interrupted. The harness kept its count and time, not its request id. No anomaly followed, as expected if cab consumed it against the ended escalation it still holds.
- **Approval callbacks:** each command item had one approval request. No request carried `approvalId`, so several callbacks per item were not observed, and that case remains unqualified.
- **Request fields:** every request carried `availableDecisions`, `command`, `commandActions`, `cwd`, `environmentId`, `itemId`, `kind`, `proposedExecpolicyAmendment`, `reason`, `startedAtMs`, `threadId` and `turnId`. None carried `networkApprovalContext` or `additionalPermissions`.
- **Other approval kinds:** the model attempted none, so their refusal is proved only by the deterministic suites.
- **Expiry:** the 15-minute expiry was not repeated live; the [probe](sandbox-escalation-probe-2026-11-11.md) proved the 15-minute hold.
- **Cleanup:** the services stopped and the fixture root was removed.
