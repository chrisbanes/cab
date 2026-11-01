# Automatic local operator access — 2026-11-01

Status: local qualification of the foreground/local-access slice for #1413. Independent review, PR publication and the required final-head GitHub check are separate gates. Installed-service discovery and lifecycle integration remain in the sibling slice under #1412.

## Candidate

The implementation was preserved in its assigned checkout and committed as `e40ecd63d13dc8f9d5f144ce3c749dde936c1724`. Current main `34748252f17289eada522f3e8161bde135ce5353` was integrated. Runtime qualification uses `942501802141d9244e3b8bed351bca4b2e09f8c3`, which includes the CLI expectation repairs and retained-review/secret-rotation repair. An evidence-only update may follow without changing the tested runtime.

Shared startup creates protected generation material outside the data snapshot and task workspace trees, bound to the existing installation identity. The foreground HTTP listener publishes its actual numeric loopback endpoint. Local access reuses the existing route authority and command layer with read/write CLI authority. Browser sessions and session-only routes remain separate.

The CLI preserves selected token connections and their scope, expiry and revocation. It considers automatic local access only when no connection resolves, supports explicit `--local --local-state DATA_DIR`, and validates live identity before deliberate saved-connection adoption. Existing token storage is preserved. Managed assignments are refused before local material reads or authenticated HTTP.

## Automated verification

Toolchain: Node `v26.13.0` from `.nvmrc`, npm `12.2.1` from `packageManager`.

| Check | Outcome |
| --- | --- |
| `npm ci --offline` | Passed: 295 packages installed; no dependency changes. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed; existing informational diagnostics remain. |
| `npm run format:check` | Passed. |
| `npm run check` | Passed: 4,289 tests; 4,288 passed, 1 skipped, 0 failed. Static checks and build completed before the runtime suite; Chromium and WebKit were included. |
| Complete CLI test file | 22 passed after aligning old assertions with the required access-mode metadata and empty-configuration discovery behavior. |
| Local-access and local-review test files | 30 passed, including unsafe filesystem/transport state, saved-token compatibility, managed refusal, secret redaction and retained-review restart reconciliation. |
| `git diff --check` | Passed. |

The first complete run exposed a real restart regression: the rotating local secret changed the retained-review policy fingerprint. The repair keeps the stable control directory in that fingerprint and redacts generation secrets by their distinctive pattern, including when embedded in other text. The existing restart-review assertion remains unchanged.

## Bounded production foreground journey

An isolated private installation ran the built production foreground operator entry point and ordinary CLI commands against its live loopback HTTP service. Browser authentication was initialized for that isolated service; the CLI used no password login, provisioned token or Keychain storage.

1. Read an empty project list through local access and verify auth status reports local mode.
2. Prepare and apply a project creation through the ordinary live command API, then read it back.
3. Verify the project has no execution requests, then gracefully stop the owned service.
4. Restart the same installation, read the persisted project without another CLI login and verify the installation identity is unchanged.
5. Run `doctor` through the selected local connection, gracefully stop the owned service and remove its isolated files.

All steps passed on the runtime qualification commit. No model turn was run. This exercised the production startup/publication hook as well as the real HTTP/SQLite test seam.

## Boundaries

The managed implementation runtime could not bind loopback sockets or write linked-worktree Git metadata. The operator performed those steps on the same preserved candidate; no acceptance criterion was replaced with a mock or waived. Earlier incomplete managed-suite runs are not acceptance evidence.

Automatic access trusts the service's OS account. Managed-assignment refusal prevents accidental privilege crossing; this does not claim isolation from a hostile process under the same OS user. This record does not qualify installed-service integration, release or production cutover.
