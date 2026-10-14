# #950 first-run journey: bounded live qualification

On 14 October 2026 the implementation agent ran the first-run journey once on candidate
`4d3e1a7f` (`4d3e1a7f77c6f59fd05fd2f425b5a0218c094507`). That candidate merges
`origin/main` at `15e0a66f`. The journey starts on a fresh data directory with the
production web bundle and the real Codex App Server, and ends with a running task.
`npm run check` passed on this tree before the attempts: 2045 tests, 2044 passed,
0 failed, 1 skipped.

## Bounds and setup

- **Allowance:** the planned single attempt, plus one more after an ordinary fixable
  cause, with at most one model turn. One turn was used.
- **Runtime:** Node 24.21.0 and npm 12.2.0. The built service ran the `operator`
  command on a free loopback port, with all production runtime harnesses enabled. The
  Codex App Server used the operator's existing ChatGPT login. Chromium was driven
  headless at 1366×900.
- **Isolation:** each attempt created new private data and auth directories under the
  system temporary folder, with a generated operator password. Both were removed after
  the service exited. The operator's own Ensemble data, the installed Haze prototype and
  any running service were not touched.
- **Recorded:** step results, row states, booleans and timings only. No prompts, tokens,
  paths or account identities were recorded.

## Attempt 1: stopped by the power gate

Steps 1–5 passed, with the same row states as attempt 2.

Step 6 failed. Create and start recorded the task with its lead assignment, but the task
stayed `queued` for the 180 s bound (90 reads), and no turn started.

An offline probe of the same production service on a fresh data directory, with no task
and no turn, found the cause: power supervision held admission. Its reason was
"Power-event history is incomplete or ambiguous". The reason did not change over 35 s
on this host.

This is the existing power gate on this Mac, not a #950 behaviour. Ordinary cleanup ran:
no turn had started, the service exited cleanly and the scratch directories were
removed.

## Attempt 2: passed

The second attempt changed one thing: power supervision was disabled
(`power: { enabled: false }`), as in the `cli8` and `s05` live harnesses.

| Step                                                    | Result                                   | Time (s) |
| ------------------------------------------------------- | ---------------------------------------- | -------- |
| 1. Sign in                                              | Passed                                   | 1.3      |
| 2. Home checklist, read once readiness settled           | Passed; old empty-Home copy absent       | 31.7     |
| 3. Repository-free setup with an inline lead profile     | Passed; "none · repository-free"         | 31.8     |
| 4. Ready check → Resume and create first task            | Passed; primary enabled                  | 32.1     |
| 5. Composer prediction                                   | Passed; "Starts now."                    | 32.2     |
| 6. Create and start                                      | Passed; a turn recorded, task `running`  | 34.3     |
| 7. Home after the first turn                             | Passed; no checklist, 0 attention rows   | 35.8     |

- **Row states at step 2:**
  - Runtime: Done
  - GitHub: Optional
  - Lead profile: Next (primary)
  - Project: Not started
  - First task: Not started
  - Claude (optional): Optional
- **Step 6:**
  - The workspace read reported `turnStarted: true` on the second read, 2.1 s after
    Create and start.
  - The task had no waits.
- **Cleanup:**
  - The task was still running, so the journey pressed Stop on the task.
  - The final state read after Stop failed while the page navigated, so the stopped
    state is not recorded.
  - The service then shut down on SIGTERM: it exited cleanly with no stderr output.
  - The scratch directories were removed.
  - No runtime process started by the journey remained.
- **Duration:** 37.3 s in total.

## What this does not qualify

- Admission with power supervision enabled on this host. Attempt 1 shows that the power
  gate can hold a fresh installation's first task. That task showed `queued` with no wait
  reason, because the power hold is not one of the derived waits.
- Claude, GitHub discovery or repository access, a turn's outcome or result delivery,
  physical devices, or human visual acceptance.
