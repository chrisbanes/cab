---
status: accepted
---

# Publish a local task by converting it in place

A task was local or imported for its whole life. The operator can now publish a local
task to GitHub, which creates an issue in a linked repository. If the sync then found that
issue it would import a second, unrelated task. The glossary defines **Task publication**;
delivery scope lives in [#1167](https://github.com/chrisbanes/ensemble/issues/1167).

## Decision

- **The same task becomes the issue's imported task.** After the create resolves, one
  transaction gives the task the issue's external identity and writes what the sync would have
  written: the imported-task row, the observed issue (title and the body as created, marker
  included), a source review with observed and accepted digests equal so the first sync raises
  none, the target membership with the Project fields confirmed so far, an `open` issue
  status so local dependents keep an open blocker rather than an unknown one, and the
  captured GitHub source text. The task keeps its id, history, version line and Ready flag;
  `importedBlockers` becomes `unknown` and the next sync recomputes everything it owns.
  From then on the title and description are source-owned (SPEC "Imported issues and source
  ownership"). This makes **local to imported** a one-way step of a task's life.
- **A published task is a never-started, open, local task** with no local dependency edges as
  a dependent (a task that blocks others may be published; a GitHub issue follows GitHub
  dependencies only, and local edges are neither dropped nor converted). Targets are the
  `repository` selections of linked repositories and the unfiltered `project` selections
  crossed with them; `search` and filtered `project` selections cannot be predicted and are
  listed disabled with the reason.
- **Duplicate safety.** The create carries the operation marker. Read-back lists the
  credential user's issues and confirms exactly one marker issue with the exact text; finding
  none proves nothing. An unknown outcome holds the task, is resolved by the read-back or by
  the operator (**Link** a named issue after the marker is verified, or **Abandon**), and is
  never resent. While a create is unresolved, a sync skips any new issue carrying its marker.
- **GitHub's lists trail a create.** A converted task is forgiven one complete read that omits its
  issue (it keeps its membership, Ready flag and no hold); a second consecutive omission withdraws it,
  and a listing releases a withdrawn hold on a converted Ready task. This is limited to just-published
  tasks: for any other imported issue the first omission withdraws it and the hold stays until the
  operator resolves it, as before.
- **Recovery is closing the issue on GitHub.** Nothing in Ensemble reverses a publish, and
  Abandon only forgets an unproved create, which may leave a duplicate. Both are stated in the
  confirm step.
- **Authority** is the operator publication caller and its readiness exemption, recorded in
  [ADR-1017](1017-non-agent-readiness-writes.md).

## Considered options

- Create a new imported task and retire the local one with a supersession link. Rejected:
  it forks the task's identity, so dependents, assignments, review evidence and links would
  all have to follow, and the old task would stay as a second row for the same work.
- Leave the local task and let the sync import the issue as a separate task. Rejected: this is
  the duplicate the feature exists to prevent.
- Convert local dependency edges into GitHub dependencies, or drop them. Rejected for now: it
  writes more to GitHub than the operator reviewed, or loses information silently. Publishing is
  refused while the task depends on others.
