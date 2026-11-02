# Task Execution additive parity — 2026-11-02

This is the additive parity record for [#1415](https://github.com/chrisbanes/cab/issues/1415) under [plan 6565437333](https://github.com/chrisbanes/cab/issues/1415#issuecomment-6565437333), following the #745 retained-control process. It records what the task workspace now replaces, what it does not, and the evidence. At the additive checkpoint it was not removal authority: `/runtime/task/:id`, its four exclusive POST routes (`/runtime/control/dependency/add`, `/runtime/control/dependency/remove`, `/runtime/control/stop`, `/runtime/control/resume`) and `taskPage()` remain implemented and callable. Removal needs a separate, explicit maintainer approval of this record and its candidate.

## Candidate

The branch is rebased onto `main` `d4be391f4422aa3f9080150b32393f22fbdf0565`. That base includes #1416 (bound-turn recovery), #1434 (stacking), the Delivery work and #1460 (first turns take current revisions). The plan was written against `2abe0e83`. The recheck found that #1416 put bound-turn recovery on `/runtime/assignment/:id` and `/app/assignments/:id/recovery`, not on the task page. Its recovery-page links to the task page were ordinary entry points.

| Change | Meaning |
| --- | --- |
| Task read | Optional `executionRecovery` (task-wide records and aggregate holds), `dependencyCandidates`, and per-assignment `started`. |
| Execution tab | Status, gates, lead, holds, evidence and dependencies; header Stop…/Resume… on `task.stop`/`task.resume`; dependency Add/Remove; Apply on a stale row of a started assignment; every entry point repointed. |
| Review repairs (`2e057327`) | A withheld recovery read never reads as safe; confirmations open on Cancel; no Apply prompt before a first turn; lost Stop reply and imported-candidate coverage. Production web source for every capture below. |
| Docs | SPEC, UI02, UI06 and UI08 describe the additive contract. |

The [capture manifest](1415-task-execution-parity-2026-11-02/manifest.json) records image hashes, viewports and engines. Captures come from the production Vite bundle against disposable real-SQLite fixtures with a fake runtime. No model, provider, installed service or Haze instance was used.

## Retained page inventory and replacement

Measured by invoking the actual `/runtime/task/:taskId` handler against a disposable fixture: one stale assignment, one local blocker, one candidate, an open task and 21 recovery records. It renders **5 forms** (`instruction-apply`, `dependency/remove`, `dependency/add`, `stop`, `resume`), **1 editable field** (the `blockerTaskId` select), **5 submit buttons** and **20 recovery records**, with the omission notice.

| Retained page content or control | Replacement | Evidence |
| --- | --- | --- |
| Execution status | Execution tab badge, from the task read's `execution` | `task-execution-model.test.ts` (every state); browser |
| Task/project state, readiness, admission gates with reasons | Execution tab facts (task read `admission`, workspace project summary) | model test; browser |
| Accountable lead and task-scoped lead execution link | Execution tab: lead name and `/app/tasks/:id?assignment=<lead assignment>` | browser asserts the href |
| Task-scoped assignments: profile, lead, state, runtime, captured revisions | Inspector assignments table and expandable facts | existing task-detail browser coverage |
| Apply current instructions for the next turn | Expanded row of a **started** stale assignment, confirmed, `assignment.apply` | browser: unstarted stale row offers nothing; once started, Apply → current |
| Local dependencies, Remove | Execution tab list, confirmed Remove, `dependency.remove` | browser: Remove, lost reply checked with the same key |
| Add dependency | Execution tab select and Add dependency… confirmation, `dependency.add` | browser: opens on Cancel, Cancel sends nothing, Add, Remove, Add again |
| Execution ownership holds | Execution tab hold lines (`holdLines` wording), union of `execution` and the task-wide aggregate | API test; model test; held-after-Resume browser case |
| Newest 20 recovery records, omission notice | Execution tab evidence list and notice | API test (24 records across two assignments); browser (21 records) |
| "Evidence is not proof of termination" | Execution tab warning | model constants; captures |
| "Resume clears only Stop; time, acknowledgement and Resume do not resolve writer ownership" | Execution tab warning; Resume… dialog text | captures; browser |
| Best-effort Stop (open tasks only) | Header Stop…, confirmation on Keep running, `task.stop` | task-detail browser (Chromium, WebKit); lost reply checked with the same key |
| Resume task | Header Resume… while stopped, confirmation on Cancel, `task.resume` | task-detail and stop-visibility browser cases |

Stop/Resume JSON readiness was already `yes` in fact; the UI02 inventory now says so.

## Deliberate differences and what the tab does not show

- **Status order.** The tab uses the task read's `execution` order (stopping > uncertain > running > starting > runtime-unconfirmed > …). The retained page derived its own per-assignment order, which ranks Queued above Held.
- **Holds beyond the newest generation.** `execution.holds` considers only each assignment's selected (newest) record. The retained page aggregated holds across every task-scoped record. The plan assumed `execution` already carried that aggregate; it does not. After Resume, a fixture whose oldest record holds writer, capacity and uncertainty reads `execution` = `paused` with no holds.
  - The task read now adds `executionRecovery.holds`, in the shape of the task-wide assignment recovery read. The tab lists the union and, beside a settled status (idle, selected, queued, waiting, paused, not-started, completed, cancelled), says "Execution holds are still recorded; recovery is required before another writer". This was the plan-mismatch repair.
  - **Only the Execution tab shows that aggregate** (C4). The Overview, the header strip, the wait reasons and the task list still show `execution`'s newest-record holds. That derivation is pre-existing and unchanged.
- **When the task-wide read is withheld.** `executionRecovery` is omitted, never sent empty, whenever the task's exclusion read is unavailable. The causes:
  - the exclusion base is missing;
  - a retained binding is unknown or unbound;
  - a captured revision is uncovered;
  - more than 128 assignments, or history over the existing 128-row bound;
  - an older service that doesn't report the block.

  The tab then shows a warning badge (never neutral). Instead of "No unresolved execution hold is reported", it says "Holds from older records can't be read here; open each assignment's recovery", and the evidence notice says the evidence is withheld. API and model tests cover this.
- **Evidence detail dropped from the tab.** Records are the curated, redacted `assignmentRecoveryRecordSchema` projection: intent state, request state, holds, receipt, workspace disposition and pending-effect count. The tab does not show:
  - observation kinds and reasons;
  - the no-turn submission witness and its "not permission to dispatch" warning;
  - the before-turn rejection witness;
  - work revision and binding versions;
  - intent and request reasons;
  - pending-effect states and reasons;
  - task-hold and uncertainty reasons;
  - recorded thread, turn and process identities.

  All of these remain on `/runtime/assignment/:id`, which each record and each assignment links to through its recovery page.
- **Assignment status line.** The inspector shows each assignment's state, runtime and wait facts. The retained page's per-assignment derived status line is not reproduced.
- **Lead link.** It opens the lead's task-scoped conversation. `/runtime/assignment/:id` stays reachable from the Runtime overview and from each assignment's recovery page.
- **Confirmation.** Add, Remove and Apply now confirm before sending; the retained forms posted directly.
- **Apply before a first turn.** Following #1460, a never-started assignment's first turn takes the current revisions, so the tab offers no Apply and makes no stale claim for it. The retained page offered Apply for any stale row.
- **Imported tasks.** No candidates; the tab says local blockers cannot be added. The domain refuses such edges in any case.
- **Candidate cost (R1, not changed).** `dependencyCandidates` is computed on every task read, including polls: one exclusion evaluation per task in the project, sharing the exclusion base as `readProject` does. Moving it behind a tab-requested read is a possible follow-up if large projects show it.

## Entry points

| Entry point | Now targets | Evidence |
| --- | --- | --- |
| Task header Execution (`task-header.tsx`) | `/app/tasks/:id?section=execution`, opening the tab in place | task-detail, task-browser and Execution browser cases |
| Workspace "Inspect uncertain execution" and wait-reason Execution details (`task-workspace.tsx`) | same | task-detail browser cases assert both |
| Runtime settings "Task controls" and assignment recovery "Task Stop, Resume and dependencies" (`recovery.tsx`) | same | runtime-recovery browser asserts both and follows Task controls |
| Start again "Open recovery" (`task-restart.tsx`, shared with Inbox and Home) | same | restart browser case |
| Legacy `/task/:id` runtime link (`operator.ts`) | same | `operator-view.test.ts` |
| `/runtime` overview links, `/runtime/assignment/:id` task link, the four retained POST redirects (`taskHref`) | same | `operator-runtime.test.ts` asserts every redirect location |

`rg -n 'runtime/task|runtime/control/(stop|resume|dependency)' src web test` now matches only: the retained routes in `operator-runtime.ts`; tests of those retained routes; and the opt-in live harnesses. No in-app link or redirect targets the page. Context menus, notifications and the CLI had no link to it.

## What removal will lose or break

- **Bookmarks** of `/runtime/task/:id` return the ordinary not-found response with no redirect, by design.
- **The single-page task-wide raw view**: the evidence detail listed above is per assignment only.
- **The per-assignment derived status line.**
- **The form-based controls**, including posting without JavaScript.
- **Resume on a task that is not stopped**: the retained page always rendered Resume (a recorded no-op); the header offers Resume… only while a Stop is in effect.
- **All four opt-in live harnesses depend on the page or its forms**:
  - `live-journey-ui.mjs` submits the dependency, Stop and Resume forms;
  - `live-operator.mjs` and `live-sleep.mjs` open `/runtime/task/` and read its prose;
  - `live-journey.mjs` posts `/runtime/control/stop` (as a bearer refusal check).

  In this candidate, only the redirect expectations of `live-journey-ui.mjs` and `live-operator.mjs` were adjusted, and all four pass `node --check`. Removal needs these harnesses rewritten against the Execution tab and JSON commands, plus a live re-qualification that has not been run.

## Validation

Node 26.13.0 / npm 12.2.1 on local macOS, with Playwright Chromium 1248 and WebKit 2370.

- After the rebase and review repairs (`2e057327`):
  - static checks pass: `npm run typecheck`, `npm run lint` and `npm run format:check`. Lint reports two infos already on `main`: the Biome schema version and `operator-private-values.test.ts`;
  - the operator API, contract, targeted-read, task-read, model, wait-reason and control-inventory files: 114/114;
  - the Execution browser test on both engines: 4/4;
  - task-detail and runtime-recovery browser files on both engines: 63/63 in one run together with the Execution test.
- The serialized full `npm run check` result for this candidate is recorded in the handback.
- Before the rebase, a full `npm run check` at `1e421ab9` passed 4,600 of 4,602 (0 failed, 2 skipped).
- Captures were inspected. The focus ring on the dialogs' initial button is faint in these captures. That is the existing dialog style for programmatic focus, not a regression; the browser tests assert initial focus directly.

## Limits

No new runtime capability, changed hold or recovery semantics, or release or cutover qualification is claimed. The newest-generation hold scope of `execution` is pre-existing; only the Execution tab compensates for it.

## Removal

The maintainer approved removal for this record and candidate `ae8a55af`: [approval](https://github.com/chrisbanes/cab/issues/1415#issuecomment-6580397694). On `main` `d159dfc0` the branch removes:

- `GET /runtime/task/:id`;
- `POST /runtime/control/dependency/add`, `/runtime/control/dependency/remove`, `/runtime/control/stop` and `/runtime/control/resume`;
- `taskPage()`, `dependencyForm()`, their field parsers, and the `stopTask`/`resumeTask` members of the runtime routes' service interface;
- `test/operator/operator-runtime-task-controls.test.ts` and the task-page parts of the runtime, coordination, recovery, targeted-read and browser tests. Their status and hold assertions moved to the task read.

`/runtime`, `/runtime/assignment/:id`, `/runtime/control/instruction-apply`, `taskHref` (now the Execution tab) and the status, hold and evidence helpers the assignment page uses remain.

The removed routes answer a signed-in, same-origin request with a valid CSRF token exactly as an unknown route does: `404`, the same body, no `Location`, and no dependency or Stop change. `operator-http.test.ts` asserts this once, along with `/runtime` and `/runtime/assignment/:id` returning 200 and `instruction-apply` redirecting to its assignment page. Bookmarks of `/runtime/task/:id` therefore reach the ordinary not-found page, with no redirect.

`rg -n 'runtime/task|runtime/control/(stop|resume|dependency)' src web test scripts` matches only those two negative tests (`operator-http.test.ts` and the rendered-forms check in `operator-control-inventory.test.ts`). Under `docs/`, only dated evidence records still mention the old routes.

The four opt-in live harnesses were rewritten and pass `node --check`. None was run live; re-qualifying them needs its own approval.

- `live-journey-ui.mjs`: dependency Add through the Execution tab, then an exact replay of the captured `dependency.add` command; Stop and Resume through the header; task state and gates read from the tab.
- `live-operator.mjs`: now mounts the React app and JSON API; Stop through the header; holds read from the Execution tab before and after a restart.
- `live-sleep.mjs`: still serves the legacy routes only, so it reads the status and task-wide holds from the lead assignment's retained page.
- `live-journey.mjs`: its bearer-refusal case posts to the retained `/runtime/control/instruction-apply`.
