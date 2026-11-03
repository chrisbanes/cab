# Shared task comments: implementation evidence

Dated 2026-11-03. Issue #842, plan revision 1 (digest `1e382c7e1806c68918fb1d4e947219730d20db6c5f36ee9da3bfce4d90c041ce`), base `5ddcada0bd43bb5cd218fb3db7d96a057c9809ae`.

## What was exercised

- Core (real SQLite, `test/coordination/task-conversation-comments.test.ts`): zero, one and several recipients; pending, running and completed lead and delegate; wrong-task, unknown, duplicate, stale, held, closed-task and unresolved-destination refusals with no partial rows; injected failure on the second delivery, the follow-up insert and the receipt insert; exact-key replay across restart and state change; reordered recipients; migrating twice and upgrading a database without the new tables, with foreign key checks.
- Service (`test/coordination/task-comment-api.test.ts`): preview modes, typed receipt, inert text mentions, refusal statuses, lost wake-up recovered from the receipt, one timeline entry per comment across pages, no-lead placement, no overlapping turn behind a running one, pause holding a queued comment.
- Execution (`test/execution/recovery-continuation.test.ts`): an input delivery records the ordinary-message recovery continuation; a record-only comment does not.
- Startup (`test/operations/startup-snapshot.test.ts`): migration level 10, its schema pin, and a lower-level database snapshotted before the new tables exist.
- Browser (`test/operator/operator-task-comment-browser.test.ts`, Chromium and WebKit for the main flow): default and removable lead chip, keyboard picker, mixed preview, record-only send, receipt-first check, mismatched receipt staying frozen, refusal keeping draft and selection, contextual feedback and assignment Reply entry points. Existing reply, search, task detail, review, comments, conversation and coordination browser tests were updated where the default reply is now the shared comment.

## Limits

- No live model turn or live service was used; the runtime is the existing fake runtime over real SQLite.
- A comment records enqueue or resume, not execution success. There is no recall; Stop and pause are the recovery controls.
- The CLI keeps single-recipient `task message` and `task follow-up`; shared comments are a browser and JSON command surface.
- WebKit on macOS does not Tab to buttons, so keyboard option walking is asserted in Chromium only.

## Runs

Static checks (`typecheck`, `lint`, `format:check`, `build`) and the full suite as two shards (`npm run test:built -- --shard=1/2` and `--shard=2/2`) ran on the candidate head named in the delivery record; the only failures on the first pass were registry ETARGET errors installing `lucide-react@1.66.0` in the two packaging tests (which passed on rerun), one load-driven WebKit wait and the control inventory row, both repaired.
