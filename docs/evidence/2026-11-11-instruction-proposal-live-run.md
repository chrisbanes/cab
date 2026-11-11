# Instruction proposal run: bounded live run, 11 November 2026

One live instruction proposal run on the real Codex runtime, one attempt, not retried.
It was made with `npm run build && npm run drafting:live -- --live --instruction` from
`test/execution/drafting-qualification/live-drafting.mjs`, for issue #1568; CI does not
repeat it.

## Prerequisites checked before the run

- `codex-cli 0.167.0`, reporting `Logged in using ChatGPT` (`codex login status`, which
  prints no credential).
- Node v26.13.0 (`.nvmrc`), Git, and a built `dist` of the candidate.
- A disposable data directory and a one-commit `greeter` checkout under the system
  temporary directory, both removed afterwards. The run made no GitHub call.

## What the run did

The harness started a built `StandaloneService` with a Codex lead profile and a project
linked to the checkout, gave the project its own instructions, and recorded two operator
messages on one unready task, both asking for a README usage example for each new flag.
It then started one instruction run for the project's instructions with both messages
selected and no note, polled it until it settled and checked the acceptance conditions.

## Result

| Check | Result |
| --- | --- |
| Source revision | Base `02b9f2d8bf634eb31d23defa7d6cc31ae8465a85` with the #1568 working tree, built into `dist` before it was committed (the harness reports `git rev-parse HEAD`) |
| Run states | `running`, then `proposed` |
| Elapsed | 31.3 s of the 600 s limit |
| Proposal validates against the `cab_propose_instruction_edit` schema | Yes (summary 50 characters, stored remainder 1,237) |
| Evidence names each selected item exactly once | Yes |
| Insufficient evidence declared | No |
| Project instructions revision | Unchanged |
| Capacity after the run | 0 |
| Disposable copy | Removed |
| Tasks, assignments and delivery records created | 0, 0, 0 |
| Service stopped; temporary root removed | Yes |

The harness prints states, counts and validity only, never the model's text or a path.
