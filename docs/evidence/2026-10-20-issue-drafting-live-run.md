# Issue drafting run: bounded live runs, 20 October 2026

Two live Improve with lead runs on the real Codex runtime, one attempt each. The first
failed the harness's own check and is kept below as a failed checkpoint; the second, with
the corrected check, passed. Both were made with
`npm run build && npm run drafting:live -- --live --issue` from
`test/execution/drafting-qualification/live-drafting.mjs`. Each made exactly one attempt
and was not retried. Both belong to issue #1182; CI does not repeat it. The Codex
launcher was the approved ChatGPT application's `codex-cli/bin/codex`, put first on
`PATH` for the run.

## Prerequisites checked before the run

- `codex-cli 0.163.0-alpha.10.2`, reporting `Logged in using ChatGPT`
  (`codex login status`, which prints no credential).
- Node v24.22.0 (`.nvmrc`), Git, and a built `dist` of the candidate.
- A disposable data directory and a one-commit `greeter` checkout under the system
  temporary directory, both removed afterwards. The imported issue came from an
  in-process fake GitHub source; the run made no GitHub call and held no GitHub write
  grant.

## What the run did

The harness started a built `StandaloneService` with a Codex lead profile and a project
linked to the checkout, imported one fixed thin issue ("Greeter flag", "add a shout
option") as a task, and asked the lead to improve it with no operator note. It polled the
run until it settled and checked the acceptance conditions.

## Result

| Check | Result |
| --- | --- |
| Source revision | `126ae28045532ac874847d48c0253b0ccff723cf` (built `dist`) |
| Run states | `running`, then `proposed` |
| Elapsed | 38.3 s of the 600 s limit |
| Proposal validates against the issue edit schema | Yes (title 33 characters, body 916) |
| Capacity after the run | 0 |
| Disposable copy | Removed |
| Tasks created in the project | 0 |
| Delivery records | 0 |
| Assignments | The harness reported 1 and failed the run's own check (below) |
| Service stopped; temporary root removed | Yes |

## Failed checkpoint and diagnosis

The harness exited 1 because it counted assignments after the run and expected none. An
imported task already has its lead assignment when it is imported, so the count included
an assignment the run did not create: this was a defect in the harness's check, not
evidence that the run created one. The check now compares against a count taken just
before the run starts, for tasks, assignments and delivery records. The corrected check
was run live once more, with the maintainer's authorization for exactly one further
attempt (second run, below). The deterministic suite
`drafting-service.test.ts` measures the same three counts before and after an issue run
and finds no change.

The harness prints states, counts and validity only, never the model's text or a path.

## Second run, with the corrected check

One further attempt, authorized by the maintainer on 20 October 2026, with the same
launcher, prerequisites (`codex login status` reported `Logged in using ChatGPT`), fixed
issue and limits. It was not retried.

| Check | Result |
| --- | --- |
| Source revision | `49c4727efc18fe6f6cf2509847c2974a6f47d398` (built `dist`) |
| Run states | `running`, then `proposed` |
| Elapsed | 31.2 s of the 600 s limit |
| Proposal validates against the issue edit schema | Yes (title 37 characters, body 857) |
| Capacity after the run | 0 |
| Disposable copy | Removed |
| Tasks, assignments and delivery records created, against the pre-run baseline | 0, 0, 0 |
| Harness exit status | 0 |
| Service stopped; temporary root removed | Yes |

All finite pass conditions held on this one run, so the live qualification is complete.

## Limits

- Only the Codex harness ran live. The Claude path is covered by the fake-SDK service
  tests in `test/execution/drafting-service.test.ts`.
- The run proves a completed proposal against the real instruction and tool schema. Stop,
  the time limit and restart are covered by the deterministic suites, not repeated live.
- The GitHub write and read-back paths are not part of this run.
