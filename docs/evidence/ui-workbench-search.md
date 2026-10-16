# Workbench Search evidence (2026-10-16)

Status: implementation candidate. Human visual acceptance has not been performed.
The screenshots come from `test/operator/operator-search-browser.test.ts`, using the
compiled production bundle, the same-origin service and disposable SQLite fixtures;
they do not qualify a deployed service or invoke a runtime.

## Reproduction identity

- Source base: `359c92c3b35b5249dbf7429af90870d7f0d533a3`.
- Runtime: Node `v26.9.0`, Playwright Chromium.
- Viewports: 1366×900 desktop, 390×844 phone.

## Screenshots

| File | Shows | Compared with |
| --- | --- | --- |
| [1366-search.png](ui-workbench/1366-search.png) | Cross-project search with type, date and history filters: query field, inline filter row, coverage note, results panel with count, type chips, a Historical badge, quoted excerpts with the query marked, mono provenance and "Open task → matching result" links; New task is the only primary | `73-search` |
| [1366-search-selected.png](ui-workbench/1366-search-selected.png) | After opening the historical R2 result and going Back: same query and filters, the selected match highlighted with the Selected badge and its link focused | `73-search` (selected row) |
| [390-search.png](ui-workbench/390-search.png) | Phone: Search records beside the field, the two-column filter grid with 44px controls, a checklist excerpt shown as plain text | `74-phone-search` |

## Deliberate differences

The differences are the ones `design/DESIGN.md` records under "Implementation
status → Search": the route title, the secondary Back, Refresh and Search records
buttons, From/Through dates, provenance limited to what the search read model
carries (no AT-142 short IDs, revisions, assignments or UUIDs), excerpts trimmed
around the match, the shared status alert in place of the `75-search-states`
panels, and the phone filter grid in place of the summary filter button.
