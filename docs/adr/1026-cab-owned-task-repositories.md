---
status: accepted
---

# Task worktrees come from cab-owned repositories

A task workspace was a worktree of the operator's checkout, so its Git metadata lived in the
operator's common directory, outside every writable root. Agents could edit files but not
create a branch or commit, and delivery needs a committed branch. Making the operator's common
directory writable would let an agent write `hooks/` or `config`, which run the next time the
operator or cab runs Git, and a writable `refs/` would let it move the operator's branches. The
glossary defines **Managed repository**.

## Decision

New task worktrees are made from a managed repository: one bare repository per project and
source common directory, at `<data>/repositories/<first 32 hex of sha256(projectId + "\0" +
sourceGitCommonDir)>`.

- cab creates it with `git init --bare --template= --ref-format=reftable` and the source's object
  format in a temporary sibling, writes `objects/info/alternates` naming the source's `objects/`,
  sets `gc.auto=0`, `maintenance.auto=false` and `core.logAllRefUpdates=true`, and renames it into
  place. A per-repository lock serializes creation and validation. No clone or fetch runs, so
  cab's Git stays offline.
- Each later use validates that it is a real directory, bare, reftable, with exactly that
  alternates line. A mismatch leaves the task provisioning with the reason; cab never repairs it.
- A task turn may write, besides its workspace, the repository's `objects/` and `reftable/` and
  the worktree's admin directory `worktrees/<name>/`, in both Codex and Claude Code. The root,
  `config`, `info/`, `packed-refs` and hooks stay read-only, and nothing in the operator's
  checkout is writable. The path has no `.git` segment, so neither harness's `.git` protections
  apply to these roots. Claude's file-editing tools keep only the workspace and its temporary
  directory.
- The binding records `gitCommonDir` (the managed repository, the worktree's real common
  directory), `sourceGitCommonDir` (the operator's, the repository link's identity) and
  `gitDirectory` (the admin directory). The workspace manager compares the worktree's common and
  admin directories with the binding before it runs status, add or remove, and runs
  `worktree remove` in the managed repository, whose config agents cannot write. The base `ref`
  resolves in the source; a stacked dependent's requested commit resolves in the managed
  repository. Comparisons read base branches from the source checkout.
- The worktree's index is agent-writable, so an agent can stage a submodule whose own
  configuration would run in cab's status and diff. cab passes `--ignore-submodules=dirty` to
  its worktree status and diff reads, which a `.gitmodules` file cannot override, and sets
  `diff.ignoreSubmodules=dirty` for every Git child.
- A binding without `sourceGitCommonDir` is a legacy worktree of the source. It validates, runs
  without Git roots and cleans up as before. Drafting runs keep disposable worktrees of the
  source.

## Considered options

- **Narrow roots in the operator's common directory.** A worktree shares `refs/` with the
  operator's checkout, so writable refs move the operator's branches. With the files backend,
  ref deletion and rebase also need `packed-refs` at the root.
- **The files ref backend in the managed repository.** The planning probe showed branch
  deletion, tag deletion and rebase lock `<common>/packed-refs.lock` at the root. Reftable keeps
  refs and reflogs in `reftable/`.
- **A clone or fetch of the source.** It needs a transport, which cab's offline Git refuses.
- **cab-mediated Git.** Keeping metadata read-only and committing through a cab tool conflicts
  with agents' normal Git use.

## Consequences

- Agents branch, commit, amend and rebase with normal Git; delivery pushes from the worktree,
  whose scratch repository follows the nested alternate to the source's objects.
- Tasks of one project share objects and refs: an agent can move another task's branches and
  delete or corrupt its unpushed commits, and a changed alternates file stops new workspaces
  until the operator repairs it. cab's delivery binds exact commits.
- If the operator prunes objects a task's base needs, that task's repository loses them.
- `git fetch`, `pull`, `gc` and `worktree add` fail in a task workspace, because they write the
  root. Git LFS content is not available in a task worktree, and submodule metadata is not
  writable. Reftable needs Git 2.45 or later.
- Existing workspaces are not migrated and have no Git write access.
- Managed repositories are kept after their project is deleted; the operator can remove them.
