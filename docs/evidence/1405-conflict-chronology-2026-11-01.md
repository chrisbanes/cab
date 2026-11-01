# Setup conflict action chronology

Source: [cab #1405](https://github.com/chrisbanes/cab/issues/1405),
[approved plan](https://github.com/chrisbanes/cab/issues/1405#issuecomment-6565084067).
Baseline: `2abe0e836fd0807115270cb569609ffdcbcadcbc`.
Platform: Darwin arm64, Node 26.13.0, npm 12.2.1, Playwright 1.64.1 Chromium.

## Controlled observations

The test-local `prepare` callback installs routes before creating the project.
Three chronology cases use the real Setup, React import panel, service and fake
GitHub provider. No production instrumentation or production change is present.
The original journey is retained unchanged. Element handles measure connection
of the specific outcome/action, rather than counting React renders.

| Schedule | Ordered observations | Result |
| --- | --- | --- |
| Private read before external save | Configuration 1; private response 1; external save 2; refused preview expectedVersion 1; two Check again responses replay the original configuration 1 | Same outcome and button remain connected; ordinary Review changes click succeeds |
| Private read delayed after conflict | Configuration 1; private request held before fetch; external save 2; refused preview expectedVersion 1; release private response 2; automatic configuration response 2 | Original button disconnects; import panel remains connected |
| Ordinary operator refresh | Configuration 1; private response 1; external save 2; refused preview expectedVersion 1; two equivalent responses retain identity; Check again reads configuration 2 | Original button disconnects; import panel remains connected |

The equivalent-response control deliberately replays the original configuration
snapshot, including `observedAt`, while the service is already at version 2. It
isolates unchanged loaded data from the subsequent real version transition. Two
animation frames after each response follow the existing project-configuration
browser-test precedent; they are rendering opportunities, not proof of a specific
private hook state. The diagnostic event labelled `configuration-response` is the
route's decoded response before fulfillment, not a direct React-state reading.
The DOM observation after that response establishes the presentation change.

In every case, the only import command is the stale preview, with no refresh,
activation, task import or Resume caused by reads. Readiness deliberately fails
`codex-login` so the real Check again control is available. The operator scenario
is reachable without a synthetic application callback. Source-version movement
changes the conflict draft selected by `ImportPanel`; these results do not show
an unchanged-state remount defect.

## Proof limit and dependent stop

These schedules establish a version-changing removal path and its unchanged-data
counter-control. They **do not establish the cause of the historical CI failure**.
The delayed-private schedule intentionally has no completed private response before
the external save. The original test waits for that response path before saving;
its wait therefore excludes this particular schedule. The original journey passed
alongside the controlled cases. Replacing its wait, or changing product lifetime,
would presently be a hypothesis rather than a calibrated repair.

T1 is incomplete: no deterministic adverse schedule both honors the original
path-presence synchronization and reproduces its click failure. T2 is held under
the approved stop rule. No synchronization change, memoization, forced click,
timeout change, or production repair is proposed. The retained tests are causal
diagnostics, not a claim of repaired regression coverage or acceptance completion.

The next bounded investigation must explain how a newer private/configuration read
can remain after the original response-path wait has passed, or identify another
transition at the failing revision. This requires controller disposition before
selecting a T2 branch. Shared import entry points are Setup ready check, GitHub
source settings and Sync & placement; no production change affects those other
entry points. No context-menu, extension or notification invokes this action.

## Validation and remaining gates

`npm ci`, `npm run build`, `npm run typecheck`, `npm run lint` and
`npm run format:check` passed for the retained diagnostic changes. The focused
Chromium command selected all three chronology cases plus the unchanged original
journey: four passes, no skips. After adding the retained-panel identity assertion,
the planned six-file `CAB_TEST_BROWSER_ENGINE=all node --test` selection passed
214 tests with zero failures or skips in 116.014 seconds. This includes Setup,
source import, project configuration, resource polling, settings state and private
values; it renews evidence for the final test code. It does not reproduce Linux
owning-shard load. Logs and attempt history are retained in
`.scratch/1405/`, with the single delivery record at `delivery.md`.

Initial test startup inside the sandbox failed with localhost `listen EPERM`.
The same command outside the sandbox exercised dynamic fixture ports. An initial
controlled run exposed a test teardown error after Review changes started an
unawaited configuration route; waiting for that response and draining routes
corrected the instrumentation. Two initial diagnostic build attempts failed on
unsupported TypeScript Promise typing and an incorrect domain selection property;
these were corrected in test-local code. None is evidence of a product failure.

No local supported Linux execution tool was found (`docker`, `podman`, `colima`,
`orb`, `limactl`, `nerdctl`). No remote operation was performed. T3's three complete
Linux owning-shard repetitions have not started because T1 and T2 are incomplete.
Independent final review and final-head required CI remain controller-owned gates.
This record does not satisfy #1404's operational reliability measurement.
