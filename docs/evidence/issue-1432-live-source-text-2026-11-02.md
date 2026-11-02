# #1432 live imported source text, 2 November 2026

Offline evidence for [#1432](https://github.com/chrisbanes/cab/issues/1432): imported
tasks follow their issue's title and body without a review hold, and a lead's next
turn carries the change. Implemented on `cb/issue-1432-live-source-text` from `main`
at `5ca0155e`. Every case runs against real SQLite with fake GitHub, Jira and
runtime adapters; none is a live runtime or provider qualification.

| Acceptance criterion | Evidence |
| --- | --- |
| Text sync updates title and outcome, no hold or admission reason, at every stage | `test/sources/github-dependencies.test.ts`, `github-reconciliation.test.ts` (stage and hold matrix), `test/execution/lead-current-text.test.ts` (unstarted, running, handed back), Done cases in `github-reconciliation.test.ts` |
| Other hold reasons and generations survive a text edit | `github-reconciliation.test.ts`: `closed`, `closure-attribution-unproved`, `closure-read-unavailable`, `readiness-lost`, `withdrawn` |
| cab's own confirmed `issue.edit` syncs without a hold | `test/delivery/operator-issue-edit.test.ts`; stale-source fence in `test/coordination/task-comments.test.ts` |
| Unstarted lead's first turn carries current text, also when queued before the edit | `lead-current-text.test.ts`, `test/execution/refused-initial-continuation.test.ts` |
| Next turn carries the current text and a capped diff; uncertain submission is not seen; no change, no diff | `lead-current-text.test.ts`, `test/execution/lead-text-store.test.ts` (confirmation order, replay, caps, bounded diff), `test/coordination/draft-turn.test.ts` |
| No inbox event, no turn, `cab_report_result` not blocked | `lead-current-text.test.ts` (activity counts, report during the edited turn) |
| Queued follow-up and pending routing survive text, refused after readiness change | `lead-current-text.test.ts`, `test/sources/github-service.test.ts` (routing) |
| Handback flag on task read and handback review, no inbox item or reopen | `lead-current-text.test.ts` (task read), `lead-text-store.test.ts` (revert, Done, upgrade baseline), `github-reconciliation.test.ts` (provider-completed and imported Done) |
| `source.review` Resume only; closure hold resumes after reopen | `github-dependencies.test.ts`, `test/operator/operator-control-inventory.test.ts` (retained form offers Resume only) |
| Never-started assignments show no instructions or profile staleness | `test/operator/operator-wait-reasons.test.ts` |
| Upgrade releases only `changed-text` holds and adopts observed text | `test/sources/source-storage-migration.test.ts`: legacy GitHub-named and neutral stores, both trackers, repeated IDs across Jira sites, two passes, injected-failure rollback |
| One Jira service test | `test/sources/jira-service.test.ts`; Jira Done completion with changed text in `jira-closure-service.test.ts` |
| Docs | `docs/SPEC.md` (Live source text), `docs/acceptance.md` A23, ADR-1001, ADR-1018, `docs/design/ui02-foundation.md`, `ui06-configuration.md` |

Validation during implementation (Node 26.13.0, npm 12.2.1): `npm run typecheck`,
`npm run check:style` and `npm run build` passed, and the service-profile `sources`,
`coordination`, `delivery` and `execution` suites passed. The full `npm run check` at
the delivered head is recorded with the delivery, not here, since this record is part
of that head.

Limits: a hold that a `changed-text` hold had replaced before the upgrade cannot be
recovered; the next authoritative sync re-establishes structural holds. Lead text is
recorded only for generated lead requests; an explicitly submitted prompt carries its
own text.
