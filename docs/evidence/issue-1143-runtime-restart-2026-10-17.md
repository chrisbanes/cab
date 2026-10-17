# Issue #1143 automatic runtime restart: bounded live check, 2026-10-17

**Candidate:** branch `cb/issue-1143-runtime-restart` at `87e72666`. The later commit
`e262afbf` (queued work waits while a replacement runtime is still starting) was added
after this run and is covered by a fake-runtime test, not by this check. **Host:** the
operator's Mac, Node 24.22.0, `codex-cli 0.162.1` on `/opt/homebrew/bin`, Codex signed in.
The run used a fresh temporary data directory under a scratch root, removed afterwards. No
installed service, LaunchAgent, Haze, other Codex process or real Ensemble data was touched.

## What ran

A scratch script (not committed) started the production `StandaloneService` from `dist/` with
the real `createRuntime`, only the `codex` runtime and power supervision off. Before each
signal it checked the App Server child with `ps -o ppid=,lstart=,command=`: the parent PID was
the script's own process, the start time matched the runtime's recorded identity and the
command was `codex app-server`. Only then did it send one `SIGTERM` to that exact PID. One
Codex model turn ran (a task whose brief asked for the single word OK). Timings are seconds
since the script started.

| Step | Observation |
| --- | --- |
| Start | Codex `available`; `verifyCodexLogin()` returned `verified`. |
| Idle kill (t 0.6) | Status became `unavailable` with `restart: pending`, attempt 1, next time 30 s later, 203 ms after the signal. |
| Attempt 1 | At t 30.8 (30.2 s after the kill) the status read `available` again with a new App Server child (a different PID, verified the same way). |
| Queued kill (t 30.9) | Signalled the new child 0.1 s after it appeared, while attempt 1 was still finishing its start. The status became `unavailable` with `restart: pending`, **attempt 2**, 2 min later, and the history recorded attempt 1 as `failed` with failure `exited`. The count continued, as the 10-minute rule requires. |
| Work queued during the outage (t 33) | A Codex task created now waited: state `ready`, reason "Codex runtime unavailable; turn it off and on in Settings → Runtime, or restart the service" (the unchanged stored text), no thread started. |
| Attempt 2 | At t 151.3 (120.4 s after the kill) the runtime was `available` with a new verified child. |
| Admission | The waiting task was admitted by the existing scheduler wake and completed at t 163.1 with exactly one turn. |
| Stop | `service.stop()` resolved in 289 ms. The last App Server child was gone (`kill -0` failed) and the script exited with no pending restart sleep: the process ended on its own, 0 ms after cleanup. |

A first attempt of the script failed before any turn: it read the process identity in the
instant the status turned `available` and the new App Server had not yet recorded it (a script
bug, since the status reads `available` while an attempt's start finishes). The service
stopped cleanly and no model turn ran. The recorded run is the second.

## Limits

- Exhaustion (three failed attempts), the 10-minute reset, disabling during backoff and a
  boot-time start failure were not exercised live. The fake-clock service tests cover them,
  and the Inbox, CLI and browser tests cover the exhausted state.
- Claude was not run. The same code path serves both harnesses; the independent restart is
  covered by a fake-runtime test.
- Only the App Server process was killed. A held running turn was not part of this check; the
  fake-runtime tests assert that held work stays held and is never resumed by a restart.
- The kill of the second App Server landed while attempt 1 was still starting, so the
  history shows attempt 1 as failed (`exited`) rather than started. That is the intended
  accounting for a runtime lost during its own attempt.
- The calls went straight to the service, not through the operator API, CLI or web, which have
  their own automated tests.
