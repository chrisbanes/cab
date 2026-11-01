# Empty connection selection repair — 2026-11-01

This is the bounded repair of Watson F1 from review result
`2c7c6c02-576b-4726-b15a-59588aa9f57a`, continuing implementation result
`2c921fbb-d126-4654-8f4c-d60a46601346`. The original #1413 criterion 15 remains
unchanged: a supplied invalid selection cannot trigger automatic local access.

## Source

The repair starts from reviewed head
`109122ef64dd55701b5617ca4d28bafbae3f47af` on `cb/local-cli-access-1413` in
the same assigned `repo-1` checkout. Integrated main remains
`34748252f17289eada522f3e8161bde135ce5353`.

The tested three-file repair is preserved at workspace-relative
`.validation-1413-f1/repair.patch`, SHA-256
`e35fa63a196426516ebb6d762932a40c87535a0b9886063fa0d3a439e1e6efa3`.
It changes `src/cli/main.ts`,
`test/operator/operator-cli-local-access.test.ts` and
`docs/design/operator-cli-inventory.json`. This evidence-only file follows those
tests. No shared fixture, service rule, database schema or public contract changed.
The repair is not yet committed: linked-worktree Git metadata remains outside
the managed runtime's writable boundary. The previously established operator-owned
Git handoff is required; unsupported Git writes were not retried.

## Repair

Automatic discovery and auth-login guards now distinguish `undefined` from a
supplied empty connection name. The existing selector/login validation refuses
empty explicit and environment selections before local material or authenticated
HTTP. Option conflicts use presence checks, including `--local --connection ""`.
The related empty `--url` and `--token-file` cases cannot fall into automatic
login, and an explicitly supplied `--local-state` still requires local selection.
Existing nullish explicit/environment precedence remains intact.

The regression exercises 28 CLI invocations: handwritten auth reads, browse
reads, representative writes and login, with empty explicit/environment names;
conflicting local/connection or token options; and state-location requirements.
It uses valid local material with an HTTP sentinel and malformed material with
distinct refusal behavior. All invalid cases return usage/selection failures
without credential-store access or HTTP. No socket or mocked service response is
needed to establish this pre-authentication refusal boundary.

Optional review note S1 is also addressed: the `connection local` inventory row
now cites the committed HTTP/SQLite and foreground qualification, identifies it
as real bounded evidence, and retains the sibling installed-service and
second-machine private HTTPS limitations. It does not claim the historical CLI8
remote journey or final-head CI has run for this repair.

## Validation

All commands use pinned Node `26.13.0` and npm `12.2.1`.
`TMPDIR` for tests is inside the assigned workspace at `.validation-1413-f1`;
command logs are retained there.

| Command | Outcome |
| --- | --- |
| `npm ci --offline --cache ../.validation-1413/prior/npm-cache` | Passed; 295 packages, no dependency changes. |
| `npm run build` followed by `node --test --test-name-pattern='empty connection selections' dist/test/operator/operator-cli-local-access.test.js` before the code repair | Failed as expected: empty explicit selection reached local authentication and returned unavailability instead of selection refusal. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed; existing informational diagnostics remain. |
| `npm run format:check` | Passed. |
| `npm run build` | Passed after repair. |
| `node --test dist/test/operator/operator-cli-local-access.test.js dist/test/operator/operator-cli.test.js dist/test/operator/operator-cli-help.test.js dist/test/operator/operator-cli-qualification-inventory.test.js` | 50 tests: 33 passed, 17 failed, 0 skipped. The new regression and every non-socket case passed; all 17 failures are `listen EPERM` at loopback listener startup. No assertion failure remains in that run. |
| `git diff --check` | Passed. |

The earlier full check on runtime head
`942501802141d9244e3b8bed351bca4b2e09f8c3` (4,288 passed, 1 skipped), and
the evidence-only `109122ef` update, remain historical qualification under the
[original evidence record](issue-1413-local-access-2026-11-01.md). They do not
prove this repair or substitute for affected-range re-review. This repair
restores the existing selection contract without shared fixture or cross-suite
contract changes, so the follow-up's bounded validation reuses that full-suite
evidence and runs affected CLI checks rather than a new full local check.

## Handoff

The lead must arrange the existing operator-owned scoped commit and permitted
execution of the affected HTTP cases against the resulting frozen SHA, then
request Watson's affected-range re-review. Final-head required `check` CI remains
a merge gate. No publication, provider mutation, service operation, delegation or
deployment was performed; no acceptance criterion was waived. Same-account trust
and sibling installed-service scope are unchanged.
