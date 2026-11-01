# Token API-v1 identity compatibility repair — 2026-11-01

This bounded repair addresses PR #1422 thread
`PRRT_kwDORzdwYM6ycnxJ`, latest comment `PRRC_kwDORzdwYM8AAAABCHEBqg`,
under original #1413 criteria 15 and 17. Separately installed API-v1 clients use
a strict identity schema, so adding `accessMode` to token identity responses
breaks them even though the API version remains unchanged.

## Source and change

Starting reviewed/published head is
`0247a5197cf991b2c6a258b3e82d57781f17eba5`, integrated base
`34748252f17289eada522f3e8161bde135ce5353`, in the same assigned `repo-1`
checkout on `cb/local-cli-access-1413`.

The service now omits `accessMode` for token identity responses, retaining the
prior strict API-v1 wire shape. Local identities retain their mode and nullable
expiry. The shared schema remains optional without a default: adding a default
would reintroduce the token field during server parsing. Current CLI auth-status
JSON instead derives mode from its selected connection, as its human and resolved
service output already do. No API-version, authority, session or lifecycle rule
changed. The selection-repair guards and its committed evidence are unchanged.

The regression in the existing HTTP boundary suite freezes the old strict schema
from base `34748252`, including non-null token expiry, independently of the
current schema. It parses real service token identity responses for both scopes,
checks one-day expiry and expired/revoked refusal, and checks current CLI token
mode in human/JSON output. Existing shared route-authority tests remain in that
suite; their policy matrix was not duplicated.

The tested three-file patch changes `src/standalone/operator.ts`,
`src/cli/main.ts` and `test/operator/operator-cli-http.test.ts`. It is retained at
workspace-relative `.validation-1413-token-v1/repair.patch`, SHA-256
`3701ecd660b63e6978a156c6263f8c182a29df3873681ea8d2872474a327d2eb`.
This evidence-only fourth file follows validation. Git metadata remains outside
the managed writable root; the established operator-owned commit handoff is
required, and unsupported Git writes were not retried.

## Validation

Pinned toolchain: Node `26.13.0`, npm `12.2.1`. Logs and test temporary files are
inside the assigned workspace at `.validation-1413-token-v1`.

| Command | Outcome |
| --- | --- |
| `npm ci --offline --cache ../.validation-1413/prior/npm-cache` | Passed; no dependency changes. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed; existing informational diagnostics remain. |
| `npm run format:check` | Passed. |
| `npm run build` | Passed. |
| `node --test dist/test/operator/operator-cli-http.test.js` | 9 tests: 3 passed, 6 failed at loopback `listen EPERM`; no assertion failure. The new real-service regression is blocked before its assertions, not qualified. |
| `node --test --test-name-pattern='auth status prints\|foreground local access' dist/test/operator/operator-cli.test.js dist/test/operator/operator-cli-local-access.test.js` | Both selected real-service cases blocked at `listen EPERM`; no passing claim. |
| `git diff --check` | Passed. |

The historical full check and selection-repair validation remain evidence for
unchanged surfaces only. No new full-suite run, fixture refactor or unrelated
change is part of this repair. The managed socket failures do not waive the
required host regression evidence.

## Handoff

The operator must build/run the two focused commands above with permitted
loopback access and commit the scoped repair in this preserved checkout, returning
the frozen exact head and outcomes to Churchill. Watson must review that focused
range before additional publication. Only Pat may later update existing PR #1422
by approved ordinary branch push after SHIP; no new PR or force push is requested.
This is the specific token-compatibility repair, not a new full-suite or CI pursuit.
No delegation, provider mutation, deployed-service operation, merge or deployment
was performed. Same-account trust and sibling installed-service scope remain
unchanged.
