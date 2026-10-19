---
status: accepted
---

# Publish task commits through Ensemble, never through the agent

No product path published a task's commits to GitHub. `pr.create` needs its head
branch to exist already, Ensemble's own Git children use no network transport, and
agent turns run with network off. Delivery scope lives in
[#1199](https://github.com/chrisbanes/ensemble/issues/1199).

## Decision

- Ensemble publishes; agents never push. Two delivery actions, `branch.push`
  (fast-forward) and `branch.force-push` (force-with-lease), are granted per
  repository as `allow` or `approval` like every other delivery action, with the same
  operation IDs, intent before effect, readback and no blind replay. Approval binds
  the exact commit.
- Ensemble assigns one **task branch** per task and repository,
  `<project prefix><task id hex>-<title slug>`, and the agent cannot choose a name.
  The operator sets the prefix per project (default `ensemble/`). The name is
  persisted at first use and never renamed. `pr.create` accepts only the assigned
  branch as its head.
- The agent names an exact commit. Before any network call Ensemble proves offline
  that the commit is the task worktree's `HEAD` or an ancestor of it and descends
  from the base the workspace was provisioned at. Uncommitted changes are never
  pushed and are reported in the receipt.
- A push is accepted only when the remote branch is where Ensemble last left it. The
  lease for a force-push is the commit Ensemble last pushed. Any other remote head,
  seen at a push or on the task's PR, is an **outside change**: the push is refused,
  the lead is woken and handback settlement is invalidated. A rewritten history means
  the next review covers the whole new head.
- Transport is the one exception to Ensemble's offline Git: HTTPS to the verified
  github.com repository only, with the delivery credential supplied to that single
  push child through its environment, never in argv, any Git configuration, a file or
  an agent environment. The push runs in a scratch repository that reads the
  worktree's objects through an alternate, so repository-local, user and system Git
  configuration (`url.*`, `http.*`, `credential.*`, `include`, hooks) cannot apply;
  the explicit command line is the whole configuration, and the credential helper
  answers only for the exact repository over HTTPS. Time and output are bounded; a
  timeout, cancellation or unobserved exit is uncertain and is settled by reading the
  remote ref.
- Ensemble does not delete branches, push tags or forks, or poll for pushes without a
  PR. Merged branches follow the repository's own head-branch deletion setting.

## Limit

Ensemble cannot prevent a push made with ambient host credentials once agent network
access is enabled ([#1191](https://github.com/chrisbanes/ensemble/issues/1191)). It
detects the result as an outside change, and discloses the limit. An outside change
also ends Ensemble's publication to that branch until the remote head returns to the
commit Ensemble last pushed, because that commit is the only lease; adopting an
outside head needs a separate operator action that this decision does not provide.

## Considered options

- Letting the agent push with a scoped token. Rejected: it widens agent credentials
  and loses the exact-commit approval and readback.
- A deny-list of repository Git configuration keys. Rejected: a missed key that
  redirects Git would leak the token; a scratch repository has no such surface.
- Creating the branch through the REST API. Rejected: the commit objects still have to
  reach GitHub, and the REST route cannot push a local history.
