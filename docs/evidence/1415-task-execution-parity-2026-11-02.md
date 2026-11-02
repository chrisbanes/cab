# Task Execution additive parity — 2026-11-02

This is the additive parity record for [#1415](https://github.com/chrisbanes/cab/issues/1415) under [plan 6565437333](https://github.com/chrisbanes/cab/issues/1415#issuecomment-6565437333), following the #745 retained-control process. It records what the task workspace now replaces and the evidence for it. **It is not removal authority.** `/runtime/task/:id`, its four exclusive POST routes (`/runtime/control/dependency/add`, `/runtime/control/dependency/remove`, `/runtime/control/stop`, `/runtime/control/resume`) and `taskPage()` remain implemented and callable. Removing them needs a separate, explicit maintainer approval of this record and its candidate.

## Candidate

Base `main` is `cd3f5ea0458b4c0e2024f6cec4a1c50a2632a695`, which includes #1416 (bound-turn recovery), #1434 (stacking) and the #1428/#1446/#1449 Delivery work. The plan was written against `2abe0e83`. The recheck at `cd3f5ea0` found that #1416 put bound-turn recovery on `/runtime/assignment/:id` and `/app/assignments/:id/recovery`, not on the task page. Its recovery-page links to the task page were ordinary entry points.

| Commit | Meaning |
| --- | --- |
| `9a77ffe9` | Task read gains `executionRecovery` (task-wide records and holds) and `dependencyCandidates`; pure Execution presentation model. |
| `892ac9db` | Execution tab; header Stop…/Resume… on `task.stop`/`task.resume`; dependency Add/Remove; stale-row Apply; every entry point repointed. Production web source for every capture below. |
| `3f4b5a5a` | SPEC, UI02, UI06 and UI08 describe the additive contract. |

The [capture manifest](1415-task-execution-parity-2026-11-02/manifest.json) records image hashes, viewports and engines. Every capture comes from the production Vite bundle against disposable real-SQLite fixtures with a fake runtime. No model, provider, installed service or Haze instance was used.

## Retained page inventory and replacement

Measured by invoking the actual `/runtime/task/:taskId` handler against a disposable fixture: one stale assignment, one local blocker, one candidate, an open task and 21 recovery records. It renders **5 forms** (`instruction-apply`, `dependency/remove`, `dependency/add`, `stop`, `resume`), **1 editable field** (the `blockerTaskId` select), **5 submit buttons** and **20 recovery records**, with the omission notice.

| Retained page content or control | Replacement | Evidence |
| --- | --- | --- |
| Execution status | Execution tab status badge, from the task read's `execution` | `task-execution-model.test.ts` (every state); `operator-task-execution-browser` |
| Task/project state, readiness, admission gates with reasons | Execution tab facts (task read `admission`, workspace project summary) | model test (admission wording); browser |
| Accountable lead and task-scoped lead execution link | Execution tab: lead name and `/app/tasks/:id?assignment=<lead assignment>` | browser asserts the href |
| Task-scoped assignments: profile, lead, status, runtime line, captured revisions | Inspector assignments table (existing rows and expandable facts) | existing task-detail browser coverage |
| Apply current instructions for the next turn (stale rows) | Expanded stale assignment row, confirmed, `assignment.apply` | browser: stale → Apply → current, row no longer offers it |
| Local dependencies, Remove | Execution tab list, confirmed Remove, `dependency.remove` | browser: Remove, lost reply checked with the same key |
| Add dependency (select + Add) | Execution tab select + Add dependency… confirmation, `dependency.add` | browser: Cancel sends nothing, Add, Remove, Add again |
| Execution ownership holds (Stop, writer, capacity, uncertainty, task) | Execution tab hold lines (`holdLines` wording) | API test; model test; held-after-Resume browser case |
| Newest 20 recovery records, omission notice | Execution tab evidence list and notice | API test (24 records across two assignments); browser (21 records) |
| "Evidence is not proof of termination" warning | Execution tab warning text | model constants; captures |
| "Resume clears only Stop; time, acknowledgement and Resume do not resolve writer ownership" | Execution tab warning; Resume… dialog text | captures; Stop/Resume browser case |
| Best-effort Stop (open tasks only) | Header Stop…, confirmation focused on Keep running, `task.stop` | detail browser case on Chromium and WebKit; stop-visibility browser case |
| Resume task | Header Resume… while stopped, confirmation focused on Cancel, `task.resume` | detail browser case; stop-visibility browser case (a Done task with Stop offers Resume…) |

Stop/Resume JSON readiness was already `yes` in fact (contracts and API existed). The UI02 inventory now says so.

## Deliberate differences

- **Status order.** The tab shows the task read's `execution` order (stopping > uncertain > running > starting > runtime-unconfirmed > …). The retained page derived its own per-assignment order, which ranks Queued above Held. This is the change the issue intends.
- **Holds beyond the newest generation.** The task read's `execution.holds` considers only each assignment's selected (newest) record. The retained page aggregated holds across every task-scoped record. The plan assumed `execution` already carried that aggregate, and it does not: after Resume, a fixture whose oldest record holds writer, capacity and uncertainty reads `execution` = `paused` with no holds. To keep parity without changing derivation semantics, `executionRecovery.holds` reports the aggregate, in the shape the task-wide assignment recovery read uses. The tab lists the union of both and adds "Execution holds are still recorded; recovery is required before another writer" when the status itself is a settled state. The status label is still `execution`'s. This counted as the plan-mismatch repair (one diagnosis, one repair).
- **Assignment status line.** The inspector shows each assignment's existing state, runtime and wait facts. It does not show a per-assignment execution derivation.
- **Lead link.** It opens the lead's task-scoped conversation (`?assignment=`). The retained `/runtime/assignment/:id` stays reachable from the Runtime overview, and each assignment's recovery page is linked from the tab.
- **Evidence detail.** Records are the curated, redacted `assignmentRecoveryRecordSchema` projection: state, request, holds, receipt, workspace disposition and pending-effect count. The retained page printed raw recorded thread, turn and process identities and observation reasons. Those stay on `/runtime/assignment/:id` and in the assignment recovery view.
- **Read bound.** When the task's exclusion read is withheld, because its history exceeds the existing 128-row bound, `executionRecovery` is omitted. The tab says evidence is unavailable; it never shows an empty or safe state.
- **Confirmation.** Add, Remove and Apply now confirm before sending; the retained forms posted directly.
- **Imported tasks.** An imported task gets no candidates, and the tab says local blockers cannot be added. The domain refuses such edges in any case.

## Entry points

| Entry point | Now targets | Evidence |
| --- | --- | --- |
| Task header Execution (`task-header.tsx`) | `/app/tasks/:id?section=execution` (opens the tab in place) | task-detail and task-browser cases; execution browser case clicks it |
| Workspace "Inspect uncertain execution" and wait-reason Execution details (`task-workspace.tsx`) | same | task-detail browser cases assert both hrefs |
| Runtime settings "Task controls" and assignment recovery "Task Stop, Resume and dependencies" (`recovery.tsx`) | same | runtime-recovery browser case asserts both and follows Task controls to the tab |
| Start again "Open recovery" (`task-restart.tsx`, shared with Inbox and Home) | same | restart browser case |
| Legacy `/task/:id` runtime link (`operator.ts`) | same | `operator-view.test.ts` |
| `/runtime` overview task links, `/runtime/assignment/:id` task link and the four retained POST redirects (`taskHref`) | same | `operator-runtime.test.ts` asserts every redirect location |

`rg -n 'runtime/task|runtime/control/(stop|resume|dependency)' src web test` now matches only: the retained route and form definitions in `operator-runtime.ts`; tests of those retained routes (`operator-runtime-task-controls`, `operator-runtime`, `operator-cli-http`, `operator-cli-task-control`, `operator-coordination`, `no-turn-recovery`, `recovery-continuation`, `operator-targeted-reads`, `operator-browser`, `operator-delivery-integration-browser`, `operator-control-inventory`, `operator-foundation-browser`); and opt-in live harnesses that open the retained page directly. No in-app link or redirect targets it. Context menus, notifications and the CLI had no link to it. The two harness steps that assumed the old redirect target (`live-journey-ui.mjs`, `live-operator.mjs`) were adjusted and syntax-checked, not run live. A full migration of the harnesses belongs to the removal step.

Old bookmarks of `/runtime/task/:id` still work until removal; after an approved removal they return the ordinary not-found response with no redirect, by design.

## Validation

Node 26.13.0 / npm 12.2.1 on local macOS, with Playwright Chromium 1248 and WebKit 2370.

- At `1e421ab9`, a complete `npm run check` (static checks, build, every runtime profile, both browser engines) passed **4,600 of 4,602 tests**: 0 failed, 0 cancelled, 2 skipped. An earlier full attempt was cut off by the runner's 15-minute deadline while another checkout's suite ran concurrently. Before the cut-off it exposed two retained-page readers and one tab-list assertion, repaired in `1e421ab9`. The serialized rerun is the result recorded here.
- `npm run typecheck`, `npm run lint` (one pre-existing info) and `npm run format:check` pass.
- `node --check` passes for `live-journey-ui.mjs`, `live-sleep.mjs`, `live-operator.mjs` and `live-journey.mjs`. None was run live.
- Captures come from direct browser runs at production web source `892ac9db`. Each image was inspected.

## Limits

This record does not claim new runtime capability, changed hold or recovery semantics, or a release or cutover qualification. The `execution` derivation's newest-generation hold scope is pre-existing and unchanged; the tab compensates in presentation only.
