# All-columns Board evidence (2026-10-15)

Status: implementation candidate for the all-columns Board
([#1042](https://github.com/chrisbanes/ensemble/issues/1042)). Human visual
acceptance has not been performed. The screenshots come from the browser tests that
exercise the Board, using the compiled production bundle, the same-origin service
and the seeded disposable SQLite catalog; they do not qualify a deployed service or
invoke a runtime.

## Reproduction identity

- Source base: `b2d7a2b489444d9e477477d07418c81f7d864086`; branch `cb/issue-1042-all-columns-board`.
- Runtime: Node `v24.21.0`, Playwright Chromium (the responsive matrix also runs WebKit).
- Viewports: 1366×900 desktop, 1024×768 tablet, 390×844 phone.
- Tests: `test/operator/operator-work-browser.test.ts` ("board cards follow the
  frame's anatomy", "board columns share one 1366 screen, collapse to rails and
  scroll only inside the board", "board shows a link bar…"), the Board route in
  `test/operator/operator-responsive-browser.test.ts`, and the Board Back and
  List/Board identity tests in `operator-task-browser` and `operator-task-detail-browser`.

## Screenshots

The frames use fictional fixtures, so the comparison is of composition and states,
not content.

| File | Artboard | Shows |
| --- | --- | --- |
| [1366-board-all-columns.png](ui-workbench/1366-board-all-columns.png) | `04-tasks-board`, `ds-domain-components` | Seven populated Active columns of equal width on one screen; headings with symbol, word and mono count; amber border and "Next: you" on the question card, rose borders for uncertain ownership; "Ready" chips on the dependency-held cards in Waiting; the segmented link bar; the footer sentence |
| [1366-board-rails.png](ui-workbench/1366-board-rails.png) | `23-atlas-project-board` | State Done: every Active column a 44px rail with its count, name and empty sentence vertical; the Ready sentence wraps onto a second line |
| [1024-board.png](ui-workbench/1024-board.png) | `800f-tablet-all-projects-board` | The board scrolls inside itself; the link bar reaches Uncertain |
| [390-board-waiting.png](ui-workbench/390-board-waiting.png) | `25-phone-board-waiting` | One column, the three-column 44px tab grid with Uncertain in rose, Ready chips on held Ready work, in-flow Previous/Next |
| [390-board-uncertain.png](ui-workbench/390-board-uncertain.png) | `25b-phone-board-uncertain` | The Uncertain column with its rose border, the card's phone-only "Uncertain" chip and "Next: you · inspect execution" |

## Deliberate differences from the frames

- A Draft column follows Uncertain; the frames do not draw it.
- The column floor is 140px rather than the frame's 176px, so seven populated
  columns fit at 1366 (the board is 1094px wide there).
- Cards keep the Card primitive's 8px radius (the frame draws 6px).
- The lead reads "<name> · accountable lead", not "Lead · <name>"; there is no
  "No decision" or "No request" footer text.
- The grouping sentence is in the footer rather than the page header, which the
  shell owns; Previous/Next sit under the column rather than in a sticky bottom bar.
- Not built, because no read model carries them: "task 1 of 3", "N more waiting
  tasks", the per-card phone readiness note, relative age, times, short
  identifiers, "Check failed", "repair assigned" and "Repair owner unknown".
- The Overview Board sits in the work panel beside Projects and Completed work, so
  it scrolls inside the board sooner.
