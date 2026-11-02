---
status: accepted
---

# Start a dependent on its blocker's head

A blocked task started no work until every blocker was Done, so a chain of changes in one
repository was delivered one merge at a time. A project can now turn on **stacking**: a
dependent with a single blocker starts on that blocker's pushed head while the blocker's change
request is still open. The glossary defines **Stacked dependency**; delivery scope lives in
[#1433](https://github.com/chrisbanes/cab/issues/1433). This decision covers the part that
does not depend on a code host; stack links, merge ordering, adoption after a merge and Unstack
belong to #1435–#1437.

## Decision

- **A project setting, off by default.** `project.configure` sets `stacking` under the
  operator's authority and the project's version, like command network access. The CLI
  (`project prepare --stacking`), the operator API and the Delivery tab edit it. The Delivery
  tab saves it on its own, so it never resets an unsaved policy draft. Every surface states that
  dependents start on unmerged work and that a merge cannot be undone.
- **Only linear chains stack.** A dependency is a stacked dependency when the dependent has
  exactly one blocker, local or native; the blocker is a task in the same project; the blocker's
  change request is in a repository the dependent works in (any linked repository for a local
  task, the source repository for an imported one); the dependent has no workspace yet; and no
  other dependent of that blocker is stacked. Among siblings that could stack, the first
  recorded edge wins, kept in `task_dependency_records`. Every other shape waits until Done as
  before. Task detail, the CLI and the API show why: `stacking-off`, `multiple-blockers`,
  `sibling-stacked`, `cross-repository`, `outside-project` or `dependent-started`.
- **The blocker gate becomes the blocker's open change request.** For a stacked dependency
  the dependency wait is replaced by one condition: the blocker's change request is open, its
  head is the blocker's task branch, and its head commit is the branch's last cab push with no
  outside change. Until then the dependent waits with `stacked-blocker-unpublished`, or with
  `stacked-blocker-unknown` when the change request could not be read, the branch moved outside
  cab, or an imported blocker's state is unknown. An unknown imported-blocker state keeps its
  own hold. Every other admission control still applies, and the same gate holds the
  dependent's delivery actions.
- **The decision is fixed at the first workspace.** When a qualifying dependent's first
  workspace is about to be provisioned, `stacked_dependencies` records the blocker, the
  repository and the blocker's last pushed commit as the parent head. A dependent whose blocker
  is not yet published waits without a workspace, so it never starts from the link base.
  While stacking is on, no waiting stack shape gets a workspace from the link base; it is
  provisioned once the dependent stacks or its blockers are Done. Turning stacking off
  changes only dependents with no record.
- **The workspace starts at the parent head.** The worktree is created at that commit, which
  every task worktree of the linked repository can read without a fetch. An unreachable commit
  fails provisioning visibly; it never falls back to the link base. `branch.push`,
  `branch.force-push` and `branch.adopt` prove ancestry from the current parent head.
- **A moved blocker head queues a restack.** When the blocker's last pushed head differs
  from the parent head and the blocker is not Done, one transaction moves the parent head,
  marks the restack pending and queues a deduplicated delivery event to the dependent's lead.
  The lead rebases and publishes with `branch.force-push` under the project's grant
  (`allow` or `approval`); no new action kind or permission exists. When the dependent's own
  push lands, the restack is current and the workspace's recorded starting point moves to the
  parent head. A chain restacks bottom-up because each restack waits for the push below it.
  The reconcile runs on every scheduler wake and at start, so a missed event is recomputed.

## Considered options

- Make stacking part of the delivery policy. Rejected: the policy is replaced whole by its
  editor, and stacking is about admission rather than write authority.
- Order siblings by the dependency tables. Rejected: native edges are rewritten on every
  refresh and local edges have no order, so "first recorded edge" needs its own record.
- Restack from a hook on the blocker's push. Rejected: a crash between the push and the hook
  would lose the restack. A reconcile from recorded state recomputes it.
- Stack dependents that already have a workspace. Rejected: their work started from the link
  base, and moving it onto the blocker's head would rewrite work the operator did not ask to
  move.

## Consequences

- A stacked dependent runs on unmerged work. If the blocker's change request is closed or
  rewritten, the dependent waits; recovering from a blocker that will not merge is the
  operator's choice and is not automated here.
- After a blocker's push, the dependent's turns wait until the change request shows the new
  head. The delivery refresh brings it, so a restack can lag one refresh.
- A blocker reaching Done queues no restack in this part; rebasing onto the base after a merge
  belongs to #1436. ADR-1018's refusal to publish a task with local dependencies stands.
