# Build tooling validation — 1 November 2026

## Static validation

Local validation used Node 24.22.2 and npm 12.2.1. A timed
`npm run check:static` after deleting `dist/` completed successfully in 4.054
seconds; an immediate repeat completed successfully in 1.518 seconds. These are
single local wall-clock samples, not hosted CI measurements or a controlled
before/after comparison. Both the service executable and operator HTML existed
after the clean build.

The static check compiles and typechecks the service once, typechecks the web
app, bundles the web app and checks Biome lint/format rules concurrently. The
no-emit service check has a separate incremental cache from the emitting build.

`npm run typecheck`, `npm run lint` and `npm run format:check` passed. The full
`npm run check` passed with 4,258 tests passed, no failures and one skipped test,
including Chromium and WebKit. The new infrastructure tests verify concurrent
static tasks, failure gating before tests, and incremental compilation after
no-emit checks, type errors and removal of `dist/`. An offline `npm ci --dry-run`
also accepted the updated lockfile.

## Shard timing source

The Chromium and service weights were refreshed using the existing timing
updater and successful receipts from
[CI run 41289759634](https://github.com/chrisbanes/cab/actions/runs/41289759634),
head `437d2bd58d1cf5a52709e4e585561af4f04c1a62`, attempt 1:

- 385 Chromium receipts from the six Node 24.22.2 test jobs.
- 385 service receipts from the two Node 26.13.0 test jobs.
- No unsuccessful receipts; the `all` profile was left unchanged.

The timing updater consumed only `file-timings.ndjson` records from the artifacts.
The new build-workflow test uses the runner's median fallback until measured.

The composer drafting file took 219,004 ms in that hosted run. Its 30 journey
manifests recorded 215,722 ms executing test bodies in total, including 9,676 ms
across fixture creation, web startup and browser launch. The slowest cases exercise lost
stop responses and recovery after leaving the composer. This change preserves
those journeys and their recovery waits; it refreshes shard weights without
adding jobs or claiming a measured reduction in test duration.
