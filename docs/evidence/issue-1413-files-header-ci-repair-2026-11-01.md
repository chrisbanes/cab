# Locale-sensitive Files header assertion repair — 2026-11-01

This bounded CI repair follows run `41334239618`, job `workspaces-1`
`124930752946`, on PR #1422. The original failure was a 15-second timeout
matching the PDF header. That trace did not retain the actual header or preview
response; its exact Linux trigger remains unconfirmed pending new CI evidence.

## Demonstrated defect

The product formats byte counts with the browser's `toLocaleString()`. The test
accepted only digits and commas. The operator performed bounded real Chromium
probes against the unchanged assertion and a diagnostic-only working tree:

- en-US passed; ready HTTP200 PDF preview, 780438 bytes, visible `780,438` header.
- fr-FR failed the original matcher with a visible `780\u202f438` byte count,
  ready HTTP200 preview, correct PDF MIME/size/read time, one request and no
  browser errors or alerts.
- An independent de-DE probe likewise failed with `780.438` and a ready preview.

These observations, supplied through cab question
`7ed673c3-72bf-408c-ba6a-30b08d7e4301` revision 2, establish a real
locale-dependent assertion defect. They do not establish the browser locale or
cause of the original Linux CI timeout. The clock function manually produces
HH:MM; locale-based 12-hour formatting was not implicated. No flaky designation,
timeout increase or arbitrary-character regex was used.

## Corrective test change

Starting reviewed/published head remains
`f09419baf2de3f0f07395e6a1d4a007ea9a356b7`, integrated base
`34748252f17289eada522f3e8161bde135ce5353`, same assigned repo-1 checkout.

Only `test/workspaces/operator-files-browser.test.ts` changes at runtime:

- Keep the original test identifier and all text/hash/refresh/disclosure checks.
- Run the same complete header journey explicitly in en-US and fr-FR; verify the
  browser actually uses the requested number locale.
- Derive expected binary-file sizes from the independent PNG/PDF fixture byte
  lengths and expected times from the actual preview response timestamp.
- Validate the preview response is HTTP200/ready with the expected MIME and byte
  count, then format size and HH:MM in the browser and compare the exact visible
  header, including filename, MIME, size, dimensions and separators.
- Preserve the 15-second default wait. A short mismatch diagnostic retains the
  original error as cause and reports expected/actual header, locale, state and
  read time. The large provisional diagnostic-only block is removed.

No product formatting, shared fixture module, workflow, policy, service, #1413
feature, selection guard or token-compatibility code changed. The local helper's
optional locale affects only the two explicit cases; other Files cases retain
their existing setup. No tests were moved or removed; one French browser case is
added through the existing `browserSuite` registration.

The tested single-file source patch is retained at assigned-workspace-relative
`.validation-ci-1422/fix/repair.patch`, SHA-256
`f4e43799324b75191f4351a38aa7a7bb2bdf4da45a907b3eb9d93e17571aa5a3`.
This evidence-only second file follows validation. The scoped Git commit
containing this record identifies the frozen candidate. Linked-worktree Git
metadata remains outside the managed writable boundary; the operator owns that
commit handoff.

## Verification and next action

Own managed verification used pinned Node26.13.0/npm12.2.1: offline `npm ci`,
`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` and
`git diff --check` passed. The two selected browser cases were attempted once;
both failed at `listen EPERM` before browser assertions. Those failures are a
capability limit, not passing regression evidence. Logs are retained in
`.validation-ci-1422/fix/`.

The operator built the frozen source patch on the permitted host with pinned
Node26.13.0/npm12.2.1 and ran from repo-1 without the temporary locale-forcing
preload (the test controls both locales itself):

```sh
TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8 CAB_TEST_PROFILE=chromium node --test --test-name-pattern='Files shows a one-line file header' dist/test/workspaces/operator-files-browser.test.js
```

Both cases passed: 2 tests, 2 passed, 0 failed, 0 skipped. The original English
journey and added French journey each used real browser/HTTP/SQLite execution.
The source patch fingerprint above was unchanged; only this evidence prose was
updated afterward. These are operator-run results, distinct from the managed
startup denials. The scoped two-file candidate proceeds to Watson's focused review. Only the root/lead and original Pat may coordinate any
approved ordinary update to existing PR #1422. A green required final-head
`check` remains necessary before completion; a local pass alone neither proves
the original Linux trigger nor settles CI. If Linux still fails, use the bounded
actual/expected observations and repair its demonstrated cause. No full suite,
CI polling, provider write, delegation, deployed-service operation or deployment
was performed by this assignee.
