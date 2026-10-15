# Workbench task detail header, tabs and inspector evidence (2026-10-15)

Status: implementation candidate for [#1041](https://github.com/chrisbanes/ensemble/issues/1041)
(W4 of [#1035](https://github.com/chrisbanes/ensemble/issues/1035)). Human visual
acceptance has not been performed. The screenshots come from
`test/operator/operator-task-detail-browser.test.ts`, using the compiled production
bundle, the same-origin service and disposable SQLite fixtures; they do not qualify
a deployed service or invoke a runtime.

## Reproduction identity

- Source base: `15e16a300145d760a00f082b92e6e3f231920523`; branch `cb/issue-1041-task-detail-tabs`.
- Runtime: Node `v24.21.0`, Playwright Chromium (WebKit for the tab keyboard case).
- Viewports: 1366×900 desktop, 1024×900 tablet (asserted, not captured), 390×844 phone.

## Screenshots

| File | Shows | Compared with |
| --- | --- | --- |
| [1366-task-detail.png](ui-workbench/1366-task-detail.png) | A local task with an open approval: header, strip ("Next: you · review material & decide"), tabs, the decision card leading with the approval and the holds it does not clear, the brief, and the inspector (Holds · 3, Dependencies, Execution, Results & artifacts) | `03-task-detail` |
| [1366-task-detail-imported.png](ui-workbench/1366-task-detail-imported.png) | An imported task blocked by an open GitHub issue: ID slot and "Imported · fixture/source#42 ↗" chip, "Requirements · GitHub", and the inspector's "GitHub source · read-only" group, "Dependencies · managed in GitHub" and the "Ensemble execution" divider | `03-task-detail`, `12-imported-task-source-execution` |
| [1366-task-detail-history.png](ui-workbench/1366-task-detail-history.png) | History after a timer poll, at the scroll it had before the poll, with the expanded assignment kept | `800c-tablet-task-evidence` (tab header) |
| [390-task-detail.png](ui-workbench/390-task-detail.png) | Phone: header actions at 44px, the strip with the Next button, the tab list fitting the width, the decision card first | `47-phone-task-overview`, `53-phone-failed-refresh-uncertain`, `55-phone-parallel-delegation` |
| [390-task-detail-imported.png](ui-workbench/390-task-detail-imported.png) | Phone imported task: chip, readiness "Ready · waiting on outside/repo#7", source tools, tabs | `47-phone-task-overview` |

## Deliberate differences

The comparison found the composition in place (header, strip, five tabs, decision
card first, stacked Overview cards beside a 280–320px inspector, the inspector
below the reply on a phone). The differences are the ones `design/DESIGN.md`
records under "Task detail, composer and Stop":

- The ID slot and source chip sit in the strip under the title, because the shell
  page header is shared; the header keeps its page-ground background and the
  hairline sits under the tabs.
- No short identifiers (AT-142, AP-17, A-104, R2, V-22), "Updated" time, tab
  counts, GitHub Project status, "Unblocks" list, "Last turn" time, workspace path
  or per-task artifact list: no read carries them. The inspector lists recorded
  results and the bound pull request instead of artifacts.
- The full header shows on every tab rather than `06-workspace-changes-review`'s
  compact header; the tabs scroll with the page.
- The phone keeps the tabs and one reading column. The drill-in rows, the sticky
  Execution / Message lead bar of `47-phone-task-overview` and the GitHub source /
  Ensemble tab pair of phone frames 14 and 15 are not built.
- The decision card's approval link is a secondary button, as before; the decision
  itself stays on the coordination view.
