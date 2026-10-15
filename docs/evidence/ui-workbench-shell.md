# Workbench tokens, state badges and shell evidence (2026-10-15)

Status: implementation candidate for the first slice of moving the web UI to the
Design canvas direction. Human visual acceptance has not been performed. The
screenshots come from the browser tests that exercise the changed surfaces, using
the compiled production bundle, the same-origin service and disposable SQLite
fixtures; they do not qualify a deployed service or invoke a runtime.

## Reproduction identity

- Source base: `91b24b9b2ec572aab6f632c1eb900592898e005b`; branch `cb/ui-workbench-tokens-shell`.
- Runtime: Node `v24.21.0`, Playwright Chromium (WebKit for engine-specific cases).
- Viewports: 1366×900 desktop, 390×844 phone.

## Checks

Type checking, lint, formatting and build passed. Every test suite passed when run
per suite (`npm run test:built -- --suite=<suite>`): operator 632, coordination
386, workspaces 240, sources 162, delivery 85, execution 548, operations 173,
infrastructure 60. A single local `npm run check` exceeded the runner's global
time limit under load; the three settings tests it reported pass in isolation.

## Screenshots

| File | Shows |
| --- | --- |
| [1366-overview.png](ui-workbench/1366-overview.png) | Sidebar (mark, Search work with ⌘K, navigation, projects, running-turns meter, account), top bar (breadcrumb, Connected, New task), state badges |
| [1366-inbox.png](ui-workbench/1366-inbox.png) | Inbox filling the viewport below the top bar |
| [1366-settings.png](ui-workbench/1366-settings.png) | Settings breadcrumb in the top bar |
| [1366-board-running.png](ui-workbench/1366-board-running.png) | Task state badges (symbol + word in the state colour) |
| [1366-not-found.png](ui-workbench/1366-not-found.png) | Not found: no breadcrumb or New task |
| [390-overview.png](ui-workbench/390-overview.png), [390-drawer.png](ui-workbench/390-drawer.png) | Phone shell: page-header New task and drawer navigation |
