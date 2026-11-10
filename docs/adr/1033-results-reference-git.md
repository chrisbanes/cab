---
status: accepted
---

# Results reference git, not retained copies

cab copies a result's linked files and its turn diff into SQLite when the agent reports it
(retained result evidence), so the result stays inspectable after the workspace changes or is
removed. The copies carry about ten identity fields, have per-file, per-result, per-task and
per-installation quotas, record gaps that are never backfilled, and recheck path exclusions on
every read.

Git already preserves almost all of it. On the development installation, every result over two
days had a manifest: 440 retained files, all source files from task repositories, and 437 of them
reachable from a commit. Only 3 files (72 KB, one task) were uncommitted. No diff was ever
retained (all 931 diff items were gaps), no artifact, image or PDF item was captured, no review
comment anchored to a retained item, and nothing records the operator opening one.

## Decision

A result references git instead of retaining copies.

- **Result identity.** When the agent reports a result, cab records the workspace's HEAD commit,
  its branch and whether the working tree had uncommitted changes. Linked files are references
  read from the workspace, or from the recorded commit once the workspace has moved on.
- **Uncommitted work.** While a result recorded uncommitted changes and its work is neither
  committed nor delivered, workspace cleanup refuses to remove that workspace and names the
  result. Resetting the task remains the operator's explicit way to discard it.
- **Removal.** Retained result evidence is removed: capture, storage, quotas, the task workspace
  section, CLI browsing and the `result-evidence` review anchor. A store migration drops the
  retained tables and their BLOBs. Backups taken before the migration keep them.
- **Older results.** Results recorded before this change read their linked files as references,
  as results recorded before retention existed already do.

## Considered options

- **Keep only uncommitted files.** Rejected. It keeps the capture, quota and gap machinery for
  three files in two days, which blocking cleanup preserves without copies.
- **Commit on result.** Rejected. cab would author commits in the agent's branch, which changes
  delivery history the agent and operator own.
- **Keep the feature and fix diff capture.** Rejected. The data shows no use that git does not
  already cover.

## Consequences

Inspecting an old result depends on its commit still existing in the task repository. A file an
agent links but never commits, such as a screenshot or report, survives only while its workspace
does. `docs/SPEC.md`, `CONTEXT.md` (the retained result evidence term) and the operator UI change
with the implementation.
