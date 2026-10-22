# Inspect changes and reply

**Status:** built for the budgeted entry points. Changes opens on the Branch
comparison, and the file rail's heading shows the file and +/− line counts. The
latest result links to Changes with its changed-file count, and the changed-file list
fits the 390 × 844 first screen. An Inbox evidence link opens the task's History tab.
The budget is asserted at 1366 × 900 and 390 × 844 by
`test/operator/operator-inspect-changes-browser.test.ts` ("inspect changes budget").

## Goal

From a task, the operator sees what the agent changed, reads the diff, and sends
feedback to the lead without leaving the task.

## Entry points

- Task detail Changes and Files tabs.
- Latest result on the task Overview.
- Inbox request pane evidence links.
- Operator CLI `workspace` and `result` reads.

## Steps

1. Changes opens on the changed-file list for the task repository's configured ref
   (Branch target). Last turn and Uncommitted remain selectable.
2. Selecting a file shows Before and After, split or unified; a line or range can
   carry a review comment.
3. Files opens expanded to the repository root with changed files marked; opening a
   file shows its current content with one line of provenance.
4. The reply box sends the comments and a message to the lead as local feedback. A
   review "delivers local feedback only. It does not publish to GitHub, approve or
   reject work, change readiness, grant merge authority or clear holds"
   ([specification](../SPEC.md#task-workspace-inspection-and-local-review)).

## Budget

| Entry point | Interactions to a diff | First screen must show |
| --- | --- | --- |
| Task header | 2 (Changes, file) | the changed-file list with counts |
| Latest result | 2 (Changes link, file) | the result summary and its changed-file count |

The reply box is reachable from the diff without scrolling past the brief or
retained evidence. An Inbox evidence link lands on the task evidence it names (1).
Inbox requests name no diff; the diff is reached through the task (Changes, file).
The operator CLI is outside the budget: it has no screens.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- A comparison that cannot be computed names the reason in a sentence and keeps the
  last computed one visible as stale.
- A sent review shows its receipt; a failed send keeps the comments as a draft.
- An ordinary refresh re-reads the workspace and keeps an unsent draft. When
  repository access or exclusions change, the draft's text and anchors are
  rechecked and any content the session may no longer read is removed, as the
  [specification](../SPEC.md#task-workspace-inspection-and-local-review) requires.
