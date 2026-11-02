# Signal restart and bound-turn recovery, both runtimes

Live qualification for [#1416](https://github.com/chrisbanes/cab/issues/1416). Each
case ran a disposable cab service, with its own data directory, operator origin and
non-imported disposable project and tasks, against real Codex and Claude Code. The
installed service, its data directory, launchd job, port 8787 and the installed Haze
prototype were not touched. The run is the plan's six-case matrix: group SIGINT and
service-PID SIGTERM with two restarts for each runtime, and one uncertain bound-turn
CLI recovery for each runtime.

Command: `node test/execution/signal-qualification/live-signals.mjs --live
--max-turns 20 --max-attempts 1 --deadline-ms 1800000 --grant GRANT_FILE`, with root
grant `cab-1416-live-2026-11-02-d`. The driver refuses without that grant, exact
limits, a clean tree matching the grant's head and tree, and an unused grant marker.
It rebuilds `dist/` from that tree before the attempt.

## Candidate

| Item | Value |
| --- | --- |
| Source | `ccaa00f1a6a0bb25cb793f4d4b99c55aea1c3931`, tree `02b0b7730230d6c37915236db569f3176de7f3f1`, clean |
| Diff from main `8d5cbce3e01fc56dc31abf2dcc7a7c42c97a1c49` | 44 files, +9285/−276; `git patch-id --stable` `0a09307dc5a2ff03643d978867fba5f474fbac04`; `git diff --binary` SHA-256 `dedc02036028b18ad8c2a77baaec87365e4b4686beecbd5c2c3cf9e68254e8cc` |
| Rebuilt `dist/` (`dist/src`, `dist/operator`) | SHA-256 `dab8af7265b0adeb129236533b521e743364fb5657d9be854d6a7667a71173af` |
| Node | `v26.13.0` |
| Claude Agent SDK | `0.3.312` |
| Codex CLI | `codex-cli 0.166.0`, model `gpt-6.1-sol`, approval policy `never` |
| Claude Code CLI | `2.1.316 (Claude Code)`, model alias `haiku`, effort `low` |
| Run | 2026-11-02 11:52:50–11:56:32Z, exit 0, `{"passed":true,"turns":14,"settings":6}` |

Retained private artifacts (owner-only, outside the repository; content not
reproduced here):

| Artifact | SHA-256 |
| --- | --- |
| `evidence.json` | `2c43bcdf331d6cecce95c5f66de504379a699b108803aaf88caa965eeaa490c0` |
| `session.jsonl` (turn ledger) | `c2c0e3072011f5ae2c728b19405c9b72769afc365a419ae7a8e9b273c8433d16` |
| `codex-group-SIGINT` trace | `f6538982d974853bc63d58c30b74caeec5fbc11dc0340139165b04de9202a4be` |
| `codex-PID-SIGTERM` trace | `ef5c2bfd4d1a1b2b726e00a4cb58feb6585152bbf7627d7b6633317b89c665b9` |
| `codex-uncertain` trace | `ecd1ad48f000fb46a2ee7de41dfef4c6238d669a5748b5ca1e66b7d284d060ab` |
| `claude-group-SIGINT` trace | `3ad7f37974cc0a8e3248b075655517c399145801be6904805587ca70c24f3891` |
| `claude-PID-SIGTERM` trace | `ba2602e4c5f354bb9e256cd66407c8cc86c977a60bc322152afbc3ef63f940bb` |
| `claude-uncertain` trace | `e3204a7d270d9b6f5e6a95bb5296200589d8a345a47f0d3c6c4e5e10b679351d` |

Traces and ledger hold event names, timings, generated work, thread and turn IDs,
process identities and counts. They hold no prompt or model output text and no
credential value. The Claude token was an `env:` reference: Codex hosts never
received it, and each Claude host restored it only after its reference (and so its
exclusion) was configured.

## Results

| Case | Turns | Result |
| --- | --- | --- |
| `codex-group-SIGINT` | 2 | Interrupt acknowledged, exact terminal `failed`, one shutdown resolution; restart 1 resumed the same thread and workspace and the successor completed; restart 2 dispatched nothing in the 30 s observation; pending stopped-task inbox identity preserved, no duplicate result |
| `codex-PID-SIGTERM` | 2 | Same as above |
| `codex-uncertain` | 3 | Seed by the task lead completed; follow-up resumed the completed lead (`task follow-up`); bound turn held with its process live; `recovery get` reported `termination-live` and `prepare` was refused (exit 4); the exact process was ended; Stop and project pause applied; after restart `prepare`, `submit` and an identical replay receipt; Stop and pause still held; inbox preserved; recovery dispatched nothing; continuation by `task message` recorded one recovery continuation and completed on the existing conversation; one recovery receipt |
| `claude-group-SIGINT` | 2 | As for Codex; active barrier was the durable binding plus the CLI's saved prompt, reached with 0 text events |
| `claude-PID-SIGTERM` | 2 | As above |
| `claude-uncertain` | 3 | As for `codex-uncertain` |

The ledger recorded 14 reservations and 14 consumes: 2 per clean case and 3 per
uncertain case (seed and follow-up in generation 0, continuation in generation 1).
It also recorded 6 settings reads, one per Claude host generation that started a
turn. No reservation was refunded and there was no `failed` entry. Expected 14,
hard cap 20, one attempt, 120 s per turn, 60 s to the active barrier, 30 s
no-duplicate observation and a 30-minute session.

## Signal identity proofs

Before each signal the driver read the target's PID, parent, process group, start
time and boot session. It required an exact match with the owned child it created,
that the target led its own process group as the group's only member, and that the
driver was outside that group.

| Case | Signal | Target PID / PGID | Group members | Driver PID / PGID | Barrier to signal |
| --- | --- | --- | --- | --- | --- |
| `codex-group-SIGINT` | SIGINT to group −17010 | 17010 / 17010 | 17010 only | 16849 / 16832 | 59 ms |
| `codex-PID-SIGTERM` | SIGTERM to 20285 | 20285 / 20285 | 20285 only | 16849 / 16832 | 56 ms |
| `claude-group-SIGINT` | SIGINT to group −23666 | 23666 / 23666 | 23666 only | 16849 / 16832 | 38 ms |
| `claude-PID-SIGTERM` | SIGTERM to 24844 | 24844 / 24844 | 24844 only | 16849 / 16832 | 38 ms |

Each target's parent was the driver, and its start time and boot session matched
at signal time. In the uncertain cases the driver ended only the held turn's
recorded process (matched by PID, start time and boot session; SIGTERM, then
SIGKILL only after a bounded wait) and verified that it had exited before recovery.

## Cleanup

All 16 owned service hosts (3 per clean case, 2 per uncertain case) and every
runtime and settings-read process they reported (fsynced trace rows plus IPC) were
verified exited by exact identity. Every case's cleanup record is `verified: true`
with no failure. A later read-only check found none of the 37 recorded identities
present and no reused PIDs. Root removed the three `auth.json` links that
production Codex home preparation creates in the disposable data directories; no
other host state remained.

## Attempts

Each attempt used a separate root grant; all four markers are consumed. Across the
attempts, 30 live turns were used.

| Attempt | Source | Turns | Outcome and cause |
| --- | --- | --- | --- |
| 1 | `67ede901` | 4 | `codex-group-SIGINT` passed. `codex-PID-SIGTERM` failed at the successor's 120 s turn deadline. The interrupted first turn had produced no story text, so the resent brief made the successor write the whole story (about 2,000 output tokens at about 20 tokens/s; case 1's successor needed 105.5 s). Repair: the brief tells a continuing turn to reply in one sentence and report. |
| 2 | `842f165d` | 5 | Both Codex clean cases passed. `codex-uncertain` failed at the follow-up: a completed non-lead assignment refuses operator messages (`conflict`). Repair: the uncertain case runs through the task lead and resumes it with `task follow-up`. Holds were also moved after the exact process end, because a Stop interrupt ends a per-turn Claude CLI before `recovery get`. |
| 3 | `ccaa00f1` | 7 | All three Codex cases passed. The first Claude case was refused by the settings check because the grant named the resolved model ID rather than the CLI alias; no Claude turn ran. |
| 4 | `ccaa00f1` | 14 | All six cases passed (this record). |

## Offline coverage (not live evidence)

`test/execution/signal-qualification-contract.test.ts` checks the driver's
contracts: opt-in and limits, the durable turn and settings ledger, prompt fencing,
exact-identity signalling and cleanup, driver signal and crash cleanup, private
failure reasons, the token custody order, the Claude barrier, early failure of a
delegating seed or wrong feedback route, and fault controls for each repair. It
also runs both uncertain journeys end to end through the real driver, service host
and CLI over model-free fake runtimes. With `CAB_SIGNAL_OFFLINE_MATRIX=1` it runs
the six-case matrix the same way (14 turns, 6 settings reads).
`test/execution/process-signal-shutdown.test.ts` qualifies the signal handling
against fake protocol children. None of this is credited as real-runtime evidence.

## Limits not qualified here

- Planned-shutdown requeues of imported (source-backed) tasks still hold after
  restart with `task-revision-changed`; tracked in
  [#1454](https://github.com/chrisbanes/cab/issues/1454). These journeys used
  disposable non-imported tasks.
- One run per runtime and signal on one macOS host; no repeated-signal drain,
  descendant containment or host restart, sleep or wake.
- The installed LaunchAgent service (`kickstart -k`) was not exercised; the
  foreground service process received the signals.
- Model behaviour is not guaranteed: briefs keep turns short, and the driver fails
  early on a delegating seed or wrong feedback route instead of proving
  compliance.
- The fake Codex app-server reuses one thread ID; only live runs show distinct real
  thread identities.
- The Claude barrier relies on the CLI's session file, which recorded the prompt
  before the signal in this run; that timing is not otherwise bounded.
- The settings allowance of six has no spare: an extra Claude runtime generation,
  restart or failed settings read stops the case.
