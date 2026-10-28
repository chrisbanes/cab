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
  from the base the workspace was provisioned at, proving each ancestry from rehashed
  commit objects so that a forged commit-graph, replace ref or lying object cannot fake it. Uncommitted changes are never
  pushed and are reported in the receipt.
- A push is accepted only when the remote branch is where Ensemble last left it, and every
  push, fast-forward or not, is leased to the head Ensemble observed (creation expects the
  branch absent). Ensemble owns a commit on the branch only if it pushed it or an attempt of
  that push may have landed (unproved, reported pushed by Git, concluded not applied from a
  read, or never settled); a push that never started or was rejected owns nothing, so an
  equal remote is accepted only on such a retry. Any other remote head, seen at a push or on
  the task's PR, is an **outside change**: the push is refused, the lead is woken, handback
  settlement is invalidated and completion held. PR actions naming the task branch need the
  commit Ensemble last pushed. A rewritten history means the next review covers the whole
  new head. After an outside change the lead may request a recovery, either
  `branch.force-push` that names the outside head (overwrite) or `branch.adopt` (keep it).
- Transport is the one exception to Ensemble's offline Git: HTTPS to the verified
  github.com repository only, with the delivery credential supplied to that single
  push child through its environment, never in argv, any Git configuration, a file or
  an agent environment. The push runs in a scratch repository that reads the
  worktree's objects through an alternate, so repository-local, user and system Git
  configuration (`url.*`, `http.*`, `credential.*`, `include`, hooks) cannot apply;
  the explicit command line is the whole configuration, and the credential helper
  answers only for the exact repository over HTTPS. Time and output are bounded; a
  timeout, cancellation or unobserved exit is uncertain and is settled by reading the
  remote ref. Adopting an outside head adds one fetch child under the same isolation: it
  fetches exactly one sha from the verified repository in a scratch repository, with
  `core.alternateRefsCommand` neutralised so Git never runs in the agent-writable
  alternate and `transfer.fsckObjects` on. The fetch is also bounded in size: Ensemble
  watches the bytes the child writes to its scratch object store, stops it past 512 MiB
  (checked every 200 ms, so the stop is approximate by about one interval of transfer)
  and refuses the adoption. The ancestry proof runs in the scratch
  repository with no credential and rehashes every commit it reads, including those
  the alternate supplies, and Git runs against the worktree afterwards only to write an
  Ensemble-owned ref, without its hooks or a credential.
- Ensemble does not delete branches, push tags or forks, or poll for pushes without a
  PR. Merged branches follow the repository's own head-branch deletion setting.

## Limit

Ensemble cannot prevent a push made with ambient host credentials once a project's command
network access is enabled ([#1191](https://github.com/chrisbanes/ensemble/issues/1191)). It
detects the result as an outside change, and discloses the limit. An outside change
also ends Ensemble's plain publication to that branch until the remote head returns to the
commit Ensemble last pushed, because that commit is the only lease. The way out is a
recovery the lead requests and the operator always approves, never covered by an `allow`
grant: `branch.force-push` naming the outside head overwrites it under a lease on that
head, and `branch.adopt` (grantable with approval only) records it as the branch's own
after the fetch child proves it descends from the provisioned base. Both bind the branch,
the outside head and the commit Ensemble last pushed.

## Considered options

- Letting the agent push with a scoped token. Rejected: it widens agent credentials
  and loses the exact-commit approval and readback.
- A deny-list of repository Git configuration keys. Rejected: a missed key that
  redirects Git would leak the token; a scratch repository has no such surface.
- Creating the branch through the REST API. Rejected: the commit objects still have to
  reach GitHub, and the REST route cannot push a local history.
