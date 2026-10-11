# Guided project setup evidence (#841)

This records the evidence for guided project setup ([ADR-1009](../adr/1009-project-setup-discovery.md)):
GitHub discovery, the service folder picker, checkout verification and the single
`project.create`. It qualifies deterministic service, SQLite and browser behaviour plus
two bounded live reads. It does not qualify real model or provider execution, a GitHub
write, deployment or human visual acceptance.

## Deterministic coverage

The setup suites below run in `npm run check` (typecheck, lint, format, build, full
suite); the CI result for each head is on PR #870.

- `test/project-setup.test.ts`: atomic create with real SQLite and temporary Git
  checkouts; origin forms and rejections; all-or-nothing rows; replay after restart;
  post-commit unknown outcome; unchanged legacy create receipts.
- `test/operator-setup-api.test.ts`: the discovery credential set, read and clear; fail-closed
  discovery reads that store nothing; home-folder containment, the 200-entry and probe
  bounds; capture-time exclusion of the discovery credential; HTTP session, Origin and CSRF
  checks; no agent tool exposure.
- `test/github-discovery.test.ts`: the reader against a fake `fetch`: pagination and
  truncation, the one read-only GraphQL query, and failure classification including
  rate limits.
- `test/operator-setup-browser.test.ts`, `test/operator-setup-picker-browser.test.ts`,
  `test/operator-discovery-credential-browser.test.ts`: Chromium journeys at 1366×900 and
  390×844, including truncated discovery lists; WebKit smokes cover setup and the picker.

## Live reads (11 October 2026)

Both ran once from a local build of commit `1f944e5a` (before the rebase onto `ecb4c2eb`).
Only counts and booleans were recorded.

| Read | Result |
| --- | --- |
| `GitHubDiscoveryReader` with an operator `gh` token: repositories, branches and Projects of `chrisbanes/ensemble` | 49 repositories, not truncated; `chrisbanes/ensemble` listed; `main` among its branches; Projects read succeeded with 1 linked and 5 owned |
| `listHomeFolders` on the real home folder: `~` and one subfolder | `~` listed entries and none starting with `.`; the subfolder listed 18 entries, 16 of them checkouts, in 242 ms |

Later commits changed how the reader classifies failures (rate limits) and capped the
listing's probes at the first 200 names. For these inputs (49 repositories, at most 18
entries per folder) the results are unchanged.

## Limits

- A typed repository is recorded with the provisional identity `github.com/<owner>/<name>`.
- The discovery token is ambient to the runtime environment; use a dedicated read-only token.
- Text captured before a credential reference is first configured is not re-scanned.
- On macOS, listing may meet privacy prompts or permission errors for protected folders;
  typed paths still work.
- Creation has no delete or archive; recovery is editing in project configuration.
