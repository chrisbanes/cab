# Decision question form journeys, 6 November 2026

Bounded live check that a lead facing several operator decisions asks one structured
question with options and recommendations, on each harness
([#1533](https://github.com/chrisbanes/cab/issues/1533)). The driver is
`test/execution/mixed-runtime-qualification/live-journeys.mjs`
(`npm run mixed-runtime:live -- --live --facet <facet>`): the real `StandaloneService` with the
real Claude CLI or Codex App Server, on a disposable repository and temporary data. Redacted
output, an array of the two facet records:
[`decision-question-form-journeys-2026-11-06.json`](decision-question-form-journeys-2026-11-06.json)
(SHA-256 `ba3bf3735eeb3f2cded468c04f9707f90c91d4e39471a1ceec5a577c6dda02b7`).

The brief states three separate decisions only the operator can make (git metadata write
access, local listening ports for browser tests, permitting named agents or revising their
role requirements) and says to ask the operator through cab. It does not name `form`: the
`cab_ask_question` description and the turn's role text carry the shape. A plain `{question}`
fails the facet as model compliance.

## Result

| Facet | Result | Observation |
| --- | --- | --- |
| `claude-decision-question` | passed, attempt 1 | The stored question is a form with 3 single-choice questions, 2, 3 and 2 options, and a recommended option on all three. One Claude turn, run by the `claude` on `PATH`. |
| `codex-decision-question` | passed, attempt 1 | The same shape: 3 single-choice questions, 2 options each, a recommended option on all three. One Codex turn. |

Every recorded process was verified exited by exact identity.

## Versions and limits

- Candidate `600a51bf`; later commits on the branch do not change the guidance text.
- Agent SDK 0.3.316 with Claude Code 2.1.318 on `PATH`, the approved Codex launcher
  `codex-cli 0.166.0-alpha.6`, model `haiku` at low effort for Claude.
- One scenario and one model per harness, one run each. The check shows the shape (form,
  several questions, options, recommendations), not the quality of the options.
- The harness session ledger from 5 November had passed its two-hour cap and was set aside,
  starting a new session; neither facet had a prior attempt.
