# Three-pane Inbox evidence (2026-10-15)

Status: implementation candidate for the Inbox slice of moving the web UI to the
Design canvas direction ([#1040](https://github.com/chrisbanes/ensemble/issues/1040)).
Human visual acceptance has not been performed. The screenshots come from
`operator-inbox-browser`, using the compiled production bundle, the same-origin
service and disposable SQLite fixtures; they do not qualify a deployed service or
invoke a runtime.

## Reproduction identity

- Source base: `1c3007176b8480c58842a1862d5cc64a082770c3`; branch `cb/issue-1040-three-pane-inbox`.
- Runtime: Node `v24.21.0`, Playwright Chromium (WebKit for the engine-specific question cases).
- Viewports: 1366×900 desktop, 1024×768 drawer shell, 390×844 phone.

## Checks

Type checking, lint, formatting and build passed. The focused suites passed:
`operator-inbox-browser` (17), `operator-inbox-presentation` (14),
`operator-shell-browser`, `operator-responsive-browser`, `operator-question-cards-browser`
(Chromium and WebKit), `operator-question-browser`, `operator-inspection-navigation-browser`,
`operator-work-browser`, `operator-web-browser` and `operator-inbox-background-refresh-browser`.
The full `npm run check` result is recorded on the pull request.

## Screenshots

Compared with the canvas artboards `02-inbox-approval`, `09-phone-inbox-queue`,
`10-phone-question` and `800b-tablet-inbox-question`.

| File | Shows | Against the artboard |
| --- | --- | --- |
| [1366-inbox-approval.png](ui-workbench/1366-inbox-approval.png) | Approval selected with a source-owned dependency hold | `02-inbox-approval`: 340px queue with the `h1`, summary and Refresh, filters and the "Questions & approvals · oldest first" group; selected row with the overlay fill and 2px indigo edge; request pane with the kind badge, position, Open task and Previous/Next, the identity line, the bordered facts grid, the hold and the sticky bar with one "Review material & decide" link; 280px inspector with task, source, next action, Lead, Requester, Chain, Holds and Evidence. The page does not scroll. |
| [1366-inbox-question.png](ui-workbench/1366-inbox-question.png) | Question selected in a paused project | `02-inbox-approval` layout with the question form; the submit area is the sticky bar and the inspector lists the "Project paused" hold. |
| [390-inbox-queue.png](ui-workbench/390-inbox-queue.png) | Phone queue | `09-phone-inbox-queue`: page header with menu, title and count; full-width filters; grouped flat rows; footer caption. No horizontal scroll. |
| [390-inbox-detail.png](ui-workbench/390-inbox-detail.png) | Phone request detail | `10-phone-question`: Back to Inbox header with "Question · N of M" and Open task; evidence links in the request pane; sticky submit area. No Previous/Next or inspector. |

## Recorded deviations

The deviations from `02-inbox-approval` are listed in `design/DESIGN.md`
("Inbox and structured questions"): no short identifiers, so the identity line is
"requester · version N · HH:MM" and the Chain uses assignment names; the headline
stays the task title; no reviewed-material excerpt, tabs, out-of-date note or
approved state; kind badges without a "Pending" or execution-uncertain subtype; no
task state badge or synced-at time in the inspector.
