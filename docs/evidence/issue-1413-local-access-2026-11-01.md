# Local operator access candidate — 2026-11-01

Status: implementation preserved for review, blocked before a committed candidate
and full acceptance evidence. Nothing was published, deployed or pushed. No other
implementation agent was used.

## Source identity

- Exact checkout: `repo-1` in cab workspace
  `059c76cf-63df-4fd2-808d-4b9a9112b6fa`.
- Clean starting base and unchanged detached Git HEAD:
  `59ec42c9eef2a6fc87e06c82b4b01ff2bed40609`.
- The tested source is the working-tree candidate, **not that base commit alone**.
  The implementation patch, including the two new TypeScript files and excluding
  this evidence-only document, has SHA-256
  `8a9985a27ea16eb2053cfcefd9db55e2a8819972396bb25c5c28630cb39c6d96`.
- Patch and command logs are retained in the assigned workspace's
  `.validation-1413/`, beside `repo-1`. This document changes no runtime source.
- Commit attempt failed before staging: Git cannot create
  `/Users/chris/dev/ensemble/.git/worktrees/repo-1/index.lock` (`Operation not
  permitted`). No commit exists for this candidate. No parent source was edited.

## Candidate behavior

Shared startup creates protected generation material in
`DATA_DIR.local-access/connection.json`, outside the data snapshot and managed
workspace trees, bound to the existing installation identity. The HTTP listener
publishes its actual numeric loopback endpoint. Local authentication reuses the
bearer route-authority and command layers with read/write CLI authority and no
expiry; browser sessions and session-only routes remain separate.

The CLI retains token selection and failure behavior, considers automatic local
discovery only for an empty unresolved configuration, and supports explicit
`--local --local-state DATA_DIR`. `connection local NAME` validates live identity
before saving and preserves old token storage. Local status/login/logout explain
OS-account authority. File/path protection, redirect refusal, managed guards and
diagnostic exclusions are implemented. Installed-service discovery and lifecycle
integration remain outstanding in the sibling issue.

## Verification

Toolchain: Node `v26.13.0` from `.nvmrc`, npm `12.2.1` from `packageManager`,
resolved through `/Users/chris/.local/share/mise/installs/node/26.13.0/bin`.
Temporary files stayed inside the assigned workspace; final test runs set
`TMPDIR` to its `.validation-1413` directory. The CLI fixture directs automatic
discovery to a missing fixture-local state path, never the host installation.

| Command | Outcome |
| --- | --- |
| `npm ci --cache .task-tmp/npm-cache` | Failed: registry DNS `ENOTFOUND`. |
| `npm ci --offline --cache .task-tmp/npm-cache` | Passed after copying the existing package cache into the workspace; 295 packages, 0 reported vulnerabilities. No dependency or lockfile changes. |
| `npm run typecheck` | Passed on current source. |
| `npm run lint` | Passed on current source; existing informational diagnostics remain. |
| `npm run format:check` | Passed on current source. |
| `npm run build` | Passed on current source. |
| `node --test --test-name-pattern='service local material rotates\|local state rejects\|managed local commands\|every CLI error code\|CLI imports no service\|every command a remedy' dist/test/operator/operator-cli-local-access.test.js dist/test/operator/operator-cli.test.js` | Passed: 6 tests. |
| `node --test --test-skip-pattern='auth login ends' dist/test/operator/operator-cli-help.test.js dist/test/operator/operator-cli-qualification-inventory.test.js` | Passed: 18 tests. The HTTP login journey is explicitly excluded. |
| `node --test dist/test/operator/operator-cli-local-access.test.js` | 3 passed, 5 failed. All five failures occur at `listen EPERM` on `127.0.0.1`, before the intended HTTP assertions. |
| `npm run test:built -- --suite=operator --profile=service` | Failed: 1,410 tests, 605 passed, 154 failed, 651 skipped, 0 cancelled. Socket cases are denied; three source-observation/GitHub-discovery assertions also fail and remain unattributed pending execution with the required capabilities. |
| `npm run check` | Static stage passed. Full runtime execution encountered the same unavailable capabilities and was interrupted (exit 130); no full-check pass or complete runtime result is claimed. |
| `git diff --check` | Passed. |

The passing focused tests establish generation rotation and retained-installation
protection, file/path/origin rejection, managed refusal before local reads/HTTP,
CLI import boundaries, error remedies, help and inventory consistency. They do
not establish the live HTTP journey, adoption, compatibility matrix, redaction
integration or shared route/session behavior for local access. Tests for those
surfaces are present but their acceptance evidence remains unverified. Earlier
intermediate runs are superseded by the current-source results above.

## Required next action

cab questions `8dbf899f-acca-40c5-968a-5e9d03fd8e7c` and
`c085b891-7958-45dc-bd7b-0c0d78f2b4ab` record the loopback and Git-metadata
capability blockers. The lead must arrange permitted execution for this exact
preserved checkout, then complete the HTTP journey, diagnose remaining suite
failures, run the required checks, commit and freeze the candidate for independent
review. The required final-head `check` CI context remains a merge gate.
This record does not qualify release, installed-service integration or cutover.
