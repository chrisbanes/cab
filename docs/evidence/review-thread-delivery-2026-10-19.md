# Review thread delivery live qualification

Status: **bounded live run passed, one attempt, cleanup verified** (19 October 2026).

Source revision `03c878041c34b07a569fbb57484b1d1948047bf9` (branch
`cb/issue-1192-review-thread-grants` rebased onto `main` at
`65ce9b130c8534ddcacbe4af0a35744375d385c5`), Node `v24.22.0`. The delivery files
`src/core/delivery.ts`, `src/standalone/github-delivery.ts` and
`src/standalone/delivery.ts` are unchanged after this run.

Command, from the worktree root after `npm run build`:
`node test/delivery/github-qualification/live-review-threads.mjs --live --result <file>`.
The credential came only from the product's `ghToken()` helper in process. Requests
were limited to `api.github.com`, the maintainer-owned fixture repository
`chrisbanes/ensemble-s07a-fixture`, the delivery GraphQL documents and the scratch
PR and thread ids. Independent readback used `gh api graphql`.

Setup wrote one scratch branch with one file, one draft PR (#5) and one review
comment, which created one thread. The run performed exactly two provider mutations.

| Pass condition | Result |
| --- | --- |
| 1. `inspectPr` lists the thread unresolved, latest = setup comment | `thread-listed-unresolved` |
| 2. Reply preflight, perform and readback; exactly one marker comment (independent read) | `confirmed-success` |
| 3. Resolve naming the pre-reply comment is refused in preflight, zero mutations | `refused-in-preflight` |
| 4. Resolve naming the reply; `isResolved` and `resolvedBy` = credential user (independent read) | `confirmed-success` |
| 5. Second resolve refused as already resolved, zero mutations | `refused-in-preflight` |
| 6. Total provider mutations | 2 |

Summary printed by the run:

```json
{
  "runId": "dbbd7748",
  "pr": 5,
  "threadNodeId": "PRRT_kwDOU35Mcc6tx8gR",
  "setupCommentNodeId": "PRRC_kwDOU35Mcc8AAAABAOhDYg",
  "replyNodeId": "PRRC_kwDOU35Mcc8AAAABAOhFOw",
  "mutations": 2,
  "passed": true,
  "cleanup": "closed+deleted"
}
```

Cleanup: the scratch PR #5 is closed (not merged) and branch
`qual/review-threads-dbbd7748` is deleted; a follow-up read returned `closed` and
HTTP 404 for the ref. The resolved thread and reply remain on the closed PR.

Limits: the run exercises the provider seam directly; the service, store, restart and
approval paths are covered by the deterministic tests, not by this run. It does not
cover rate limiting, pagination beyond one page, or concurrent human activity on the
thread.
