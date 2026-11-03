# Task edit and source review parity — 2026-11-02

This is the reviewable additive parity record for [#1417](https://github.com/chrisbanes/cab/issues/1417) under the approved plan ([comment 6579387003](https://github.com/chrisbanes/cab/issues/1417#issuecomment-6579387003), revision 1). It is not removal authority: `/task/:id` and its `/command` handling remain implemented at this checkpoint, and removal needs explicit maintainer approval of this record and the removal scope below. The candidate integrates main `4c740e24567a95e570376635698872a447f037bd`.

## What the retained page renders

The audit reads `LocalOperatorUi.task()`, the `task.configure` and `source.review` cases of `submit()`, `COMMANDS` and the `kind === "task"` GET dispatch in [operator.ts](../../src/standalone/operator.ts). It records field names, not values.

`task()` renders, for every task: the title as `h1`, the outcome, the Ready or "Not ready (unmet)" line with the task state, the configuration-eligibility sentence with its admission reasons, the caveat that readiness and configuration eligibility do not confirm runtime admission, and a link to the task's runtime status. For an imported task it adds a "GitHub source" block: the provider closure sentence, provider instance, repository, number and node id, the observed state, the observed title and body, the memberships as `projectId/selectionId` pairs with the raw Project fields, the native blockers (or the stored `importedBlockers` value), and the source hold reason. An active hold adds one form (`source.review`: hidden `projectId`, `taskId`, `expectedVersion` and the single `decision` option Resume source hold). A local task adds one form (`task.configure`: hidden `projectId`, `taskId`, `expectedVersion`; editable `title`, `outcome`, `ready`).

`submit()` requires a non-empty `title` and `outcome` for `task.configure` and sends `ready` from the checkbox; `source.review` accepts only `resume-source-hold`. Both go through the `/command` allowlist with session, Origin and CSRF checks, and both reach the same domain handlers the JSON commands reach.

## Destination of every fact and control

| Retained page fact or control | Workspace destination |
| --- | --- |
| Title (`h1`) | Page header title and the strip. |
| Outcome | Header subtitle (first line) and the strip's "Full desired outcome" disclosure. |
| Ready or Not ready with the unmet readiness text; task state | The strip's state badge and readiness text (`taskReadiness`, which carries the unmet rule). |
| Configuration eligibility and admission reasons | The Overview wait list (`WaitReasons`) and the Execution tab's admission gates. The retained "Configuration eligibility only" sentence is not repeated. |
| "Readiness and configuration eligibility do not confirm runtime admission or execution" | The Edit dialog description ("Ready makes it eligible for future admission; it does not start work") and the source-hold card's caveat (`sourceHoldResumeCaveat`). |
| Link to runtime status, controls and recovery | The header's Execution link. |
| Provider closure sentence | The strip's readiness text (`Held · closed on GitHub`, `Held · closure not attributed to cab`, `Done · closed on GitHub`) and, for a hold, the card's reason line. |
| Repository, number and the issue link | The strip's source chip and the inspector's source group identity link. |
| Observed state | The inspector's "Issue open/closed · synced …" line. |
| Observed title and body | The source-hold card (source title beside the task title; source body and task outcome under "Source and task text"). With live text they normally equal the task's own. |
| Project fields | The inspector's "Project fields" rows, as `field: option`, falling back to the node IDs when a name is not known. |
| Native blockers and `importedBlockers` | The inspector's Dependencies block and the wait list (`imported-blockers-blocked` and `imported-blockers-unknown`). |
| Source hold reason | The card's reason line and the inspector's "Source hold · …" line (`source.hold.reason`, null for an inactive or unrecognised stored value). |
| Resume source hold (`source.review`) | The Overview decision card, shown only for an active hold, through the receipted JSON `source.review` command. |
| Last source decision | The inspector's "Last source decision · Resumed source hold · time" line (the retained page did not render it). |
| Local `title`, `outcome`, `ready` (`task.configure`) | The header's **Edit task…** dialog for a local task, through the receipted JSON `task.configure` command. |

### Deliberate differences

- The provider instance and node id prose are dropped; the identity label and URL stay.
- The raw `projectId/selectionId` membership pairs are replaced by field names and values; sync status stays summarized in the inspector's sync line.
- The digest-based source decisions were removed by #1432 and are not restored. `source.review` accepts only `resume-source-hold`.
- The Edit dialog is offered for a local task of any state, as the retained page was, and not for an imported task (its title and outcome are source-owned). A task whose title or outcome the read withholds or redacts (`task.textExact` is false) is not offered it, and the dialog sends only the fields the operator changed, so a projection is never written back. Such a task has no Edit task… at all, so its Ready is changed through `cab task configure TASK_ID --ready true|false`.
- A changed title or outcome must be non-empty, as on the retained form; an untouched one is not sent.
- A stale version, an imported task, no active hold, or incomplete source or readiness evidence is a definite `409 conflict`; the web shows its conflict line and rereads. The domain message text is not carried.
- The brief mentions the legacy home's task list. `home()` no longer renders one, so that part is a no-op.

## Entry points

| Entry point | Result |
| --- | --- |
| Task header Edit task… (desktop and the phone "Task actions" disclosure) | Implemented; the dialog keeps the disclosure's Escape and focus behaviour. |
| Task Overview decision card | Implemented. `?section=decisions` opens it; that one href serves the Restart "Review the source" link, the Inbox and attention intervention destinations, and the task list's decision link, so none changed. |
| Inspector source group | Hold reason, Project fields and last decision added. |
| CLI | No `source.review` or `task.configure` CLI command is added (`docs/design/operator-cli-inventory.json` records that `source.review` has a JSON contract the CLI does not expose). |
| Notifications, context menus, extensions | None of these exposed `/task/:id` editing or source review. |
| Retained page links | "Edit task and review source" (`web/src/task-workspace.tsx`) and "Advanced source review controls" (`web/src/sync-placement.tsx`) remain until removal. |

## Evidence

Browser evidence ran against the production bundle with real-SQLite fixtures and no provider or model call. The screenshots are synthetic fixtures, with no credentials or private paths.

| File | Viewport | SHA-256 |
| --- | --- | --- |
| [task-edit-desktop.png](1417-task-edit-source-review-parity-2026-11-02/task-edit-desktop.png) | 1366×900, dialog | `bdfcd45796e92a087e823f1b04c601a642474f156893ceb3624e68b937766093` |
| [task-edit-phone.png](1417-task-edit-source-review-parity-2026-11-02/task-edit-phone.png) | 390×844, dialog opened from Task actions | `f8a6ac96a5d6b4aba5aedd4678cac26311ccbb175f03513abd1aeb7ebcbe4e98` |
| [source-hold-desktop.png](1417-task-edit-source-review-parity-2026-11-02/source-hold-desktop.png) | 1366×900, decision card | `507da80a37b851f227af9f735ba36596f7b2fed4320360dbbbbe2e557a910bec` |
| [source-hold-phone.png](1417-task-edit-source-review-parity-2026-11-02/source-hold-phone.png) | 390×844, decision card via `?section=decisions` | `4bb4c84f3b0ed296c709e2944a3e938f605f234700720897cbbcad7184529c05` |

Keyboard path: `operator-task-edit-browser.test.ts` focuses Edit task…, opens it with Enter, finds Save disabled while the outcome is empty, closes with Escape without saving, and returns focus to the trigger; on a phone it opens through "Task actions", fits the viewport, closes with the first Escape and closes the disclosure with the second. `operator-source-hold-browser.test.ts` focuses Resume source hold and activates it with Enter. API rules (the four refusals, the replay, the receipt and the `hold.reason` fail-closed read) are tested once in `operator-api.test.ts`; wording is tested in `operator-task-overview.test.ts`.

## Removal scope for approval (T5)

On approval, remove only this issue's page and handlers:

- `LocalOperatorUi.task()`, `closureDetail`, `ruleView` and their now-unused imports in `src/standalone/operator.ts`; the `task.configure` and `source.review` cases of `submit()`; both discriminants from `COMMANDS`; the `kind === "task"` GET dispatch; and `task` from `LEGACY_PAGE`.
- The two links ("Edit task and review source" in `web/src/task-workspace.tsx`, "Advanced source review controls" in `web/src/sync-placement.tsx`).
- Page-only tests and live-script callers (`operator.test.ts`, `operator-browser.test.ts`, `operator-cli-http.test.ts`, `operator-foundation-browser.test.ts`, `operator-control-inventory.test.ts`, `operator-task-detail-browser.test.ts`, `operator-http.test.ts`, `live-journey-ui.mjs`, `live-routing.mjs`, `live-operations.mjs`), migrated offline, and the docs finalized as removed.

Resulting behaviour: an authenticated `GET /task/<id>` is a `404` "Not found" with no `Location`; an anonymous one is a `404` with no `Set-Cookie` and no login form; `POST /command` with `task.configure` or `source.review` (valid session, origin and CSRF) is a `400` "Command rejected" with domain state unchanged; `/app/tasks/<id>` and `?section=decisions` are unchanged. Old bookmarks to `/task/<id>` break on purpose, with no redirect.

Left to other issues: `/`, `/profile/:id`, `/assignment/:id`, `/runtime*`, `document()`, the `/command` endpoint itself and the form helpers `home()` and `profile()` still use (#1415, #1419, #1420), plus a CLI `source.review` command.
