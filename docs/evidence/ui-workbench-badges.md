# Neutral state badges with a symbol (2026-10-15)

Status: implementation candidate. Human visual acceptance has not been performed.
The screenshots come from the browser tests that exercise the changed surfaces,
using the compiled production bundle, the same-origin service and disposable SQLite
fixtures; they do not qualify a deployed service or invoke a runtime.

## Reproduction identity

- Source base: `b2d7a2b489444d9e477477d07418c81f7d864086`; branch `cb/issue-1044-neutral-badge-symbols`.
- Runtime: Node `v24.21.0`, Playwright Chromium (WebKit for engine-specific cases).
- Viewports: 1366×900 desktop, 390×844 phone.

## Checks

The browser tests assert that every state badge on the shell, Settings index, project
configuration, profile, GitHub source, Sync & placement, Runtime, Recovery, readiness,
Add Claude and getting-started screens holds an `svg[aria-hidden="true"]` beside its
word (`unpairedBadges` in `test/fixtures/operator-settings.ts`). Count and label badges
("N unresolved", "Matches <repository>", "New repository link") stay symbol-less.

## Screenshots

| File | Shows |
| --- | --- |
| [1366-sidebar-paused-project.png](ui-workbench-badges/1366-sidebar-paused-project.png) | Sidebar with Relay paused: idle badge with a pause symbol |
| [390-drawer-paused-project.png](ui-workbench-badges/390-drawer-paused-project.png) | Phone drawer with the same Paused badge |
| [1366-settings.png](ui-workbench-badges/1366-settings.png) | Settings index with a symbol on every state badge |
| [390-settings.png](ui-workbench-badges/390-settings.png) | Settings index on a phone |
