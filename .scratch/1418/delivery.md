# T1 delivery policy draft preparation

Pure-model preparation only. `web/src/delivery-policy-draft.ts` clones the strict core policy shape while translating the persisted credential reference into a non-secret intent. It preserves grant/check ordering, duplicates, optional properties and empty values. Status mapping coverage is checked against allow-mode issue.status grants and the actual tracker container/repository identity. Change text reports only visible editable fields.

The assigned pure test covers all 17 actions, optional branch prefix, grant/check details, mapping coverage and hidden credential material. No operator wiring or API assumptions were added. T2/T3/T4 and broader shared integration remain outside this preparation.

## T1 verification

- `npm ci`: passed (fsevents install script remained blocked by npm policy).
- `npm run build`: passed; existing Vite Node-module externalization and large-chunk warnings only.
- `node --test dist/test/operator/delivery-policy-draft.test.js dist/test/operator/operator-settings-presentation.test.js`: 25 passed, 0 failed.
- `npm run typecheck`: passed.
- `npx biome lint --error-on-warnings web/src/delivery-policy-draft.ts test/operator/delivery-policy-draft.test.ts`: passed.
- `npx biome format web/src/delivery-policy-draft.ts test/operator/delivery-policy-draft.test.ts`: passed. Biome reports existing schema version 2.6.3 vs CLI 2.6.4 informational mismatch.

An earlier broad `npm run test:built -- --suite=operator --profile=service` run executed 134 files, not just the new pure tests, and had numerous unrelated failures. Logged failing names included `polled task list, project and Inbox reads redact stored workspace paths without launching Git`, `browse pages filter, page and reject stale cursors without changing UI defaults`, `adoption rebinds the next turn to current revisions, version-checked`, `a lost reply is reconciled with operation get and replays once`, `setup routes require an operator session, CSRF and same origin and are not agent tools`, `a gh discovery reference reads with the gh login on every read and never reveals its token`, `the setup home read returns the service home to a signed-in session`, `the setup home read refuses read and read-write bearer credentials`, `the setup home read refuses missing, anonymous, signed-out and expired sessions`, `the setup home read records and logs nothing and the home stays out of every other read`, and `unknown task and assignment ids are 404 over the API and HTTP; malformed ids are 400`. These were outside T1 and were not changed; that run alone does not establish whether each is baseline or environment-related.

T1 only: no shared API, exports, UI wiring, domain policy or documentation changed. T2/T3/T4 remain stopped for root integration.
