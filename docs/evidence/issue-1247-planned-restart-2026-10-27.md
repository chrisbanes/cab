# Planned restart releases interrupted task turns

Qualification for [#1247](https://github.com/chrisbanes/ensemble/issues/1247). One bounded live run against real Codex, using a temporary Ensemble data directory and a disposable project and task. No installed service, its data directory, launchd job or `~/.ensemble-dev` was touched. The run used two real turns: the interrupted turn and its requeued successor, which was then stopped.

Command: `npm run planned-restart:live` (`test/execution/planned-restart-qualification/live-restart.mjs --live`). Codex CLI `codex-cli 0.164.0` with the local ChatGPT login, Node `v24.22.1`. The script waits five seconds after the turn binds, then calls `service.stop()`, the same call the CLI's SIGINT/SIGTERM path makes.

## Result

Redacted output of the passing run (`failure: null`). Work, thread and turn IDs are generated identifiers for the disposable task.

| Observation | Value |
| --- | --- |
| Stop duration | 66 ms |
| Interrupted generation after stop | `resolved-failed`, "Interrupted by planned shutdown; requeued" |
| Writer admission and capacity rows after stop | 0 and 0 |
| Held executions after stop | 0 |
| Shutdown resolution recorded | yes |
| Shutdown target left behind | none |
| Requeued generation after restart | admitted, running, same thread as the interrupted turn, new turn |
| Held executions after restart | 0 |
| Fixture removal | true |

## Finding: a turn that has only just started

A first attempt called `service.stop()` as soon as the turn bound. App Server answered the interrupt with `no active turn to interrupt` within milliseconds, the interrupt settled `failed`, and the turn kept today's restart hold after the five-second wait (writer, capacity and held execution retained, no resolution). That is the specified behaviour for a failed interrupt and is documented as a limit in the operations guide and design. The script therefore waits until the turn is demonstrably running before stopping.

## Automated coverage

`test/execution/planned-shutdown.test.ts` uses real SQLite and fake runtimes: clean interrupt with restart and same-thread resume, a turn that never reports, completion within the wait, a submission in flight (binds, fails, or admitted before submission), a mixed Codex and Claude shutdown with one hung runtime, a Claude-only clean interrupt, operator Stop precedence, an interrupt response that follows the terminal status, and the state API's resolution, replay, hold, cleanup and migration cases. `test/execution/claude-runtime-service.test.ts` exercises the real Claude runtime through a planned stop.
