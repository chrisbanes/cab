# Drafting run: bounded live run, 18 October 2026

One live drafting run on the real Codex runtime, made with
`npm run build && npm run drafting:live -- --live` from the harness
`test/execution/drafting-qualification/live-drafting.mjs`. It made exactly one attempt
and was not retried. The run is an issue #1168 acceptance item; CI does not repeat it.

## Prerequisites checked before the run

- Codex CLI `codex-cli 0.163.0` on `PATH`, reporting `Logged in using ChatGPT`
  (`codex login status`, which prints no credential).
- Git and Node v24.22.0 (`.nvmrc`).
- A disposable data directory and a one-commit `greeter` checkout under the system
  temporary directory, both removed afterwards.

## What the run did

The harness started a built `StandaloneService` on the disposable data directory with a
Codex lead profile, a project linked to the checkout at `main`, and asked for a draft
from the idea "Let the greeter take a --shout flag that prints the greeting in
capitals." It polled the run until it settled and checked the acceptance conditions.

## Result

| Check | Result |
| --- | --- |
| Source revision | `55a9172dc7769f1a9843191f139f6a873c1c7c89` (built `dist`) |
| Run states | `running`, then `proposed` |
| Elapsed | 23.2 s of the 600 s limit |
| Proposal validates against the title and outcome schema | Yes (title 30 characters, outcome 694) |
| Capacity after the run | 0 (capacity 0) |
| Disposable copy | Removed (worktree removed) |
| Tasks created in the project | 0 |
| Service stopped; temporary root removed | Yes |

The harness prints states, counts and validity only, never the model's text or a path.

## Limits

- Only the Codex harness ran live. The Claude path is covered by the fake-SDK service
  tests in `test/execution/drafting-service.test.ts`.
- The run proves a completed proposal. Stop, the time limit and restart are covered by
  the deterministic suites, not repeated live.
