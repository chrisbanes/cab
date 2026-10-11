---
status: accepted
---

# Discover repositories and pick checkouts during project setup

These decisions follow the settings and setup designs (`design/design.pen`, frames
114–117 and 131) and amend the guided project setup in
[SPEC.md](../SPEC.md#task-creation-and-project-setup). The operator UI implements
them at `/app/settings/projects/new` and in the Settings index.

## Discovery

Setup lists repositories, refs and GitHub Projects from GitHub instead of asking
for typed identifiers:

- **Repository:** repositories visible to the discovery credential.
- **Ref:** branches of the chosen repository, with the default branch preselected.
- **GitHub Project:** Projects linked to the chosen repositories, then other
  Projects owned by the same owner.

Discovery uses an installation-level GitHub credential reference (`env:NAME`),
held server-side like other credentials and used only for reads: repository and
branch lists through REST GETs and Projects through one fixed GraphQL query. The
keyed `discovery.configure` command sets or clears the reference; reads report only
whether it is configured and has a value. The Codex runtime inherits the service
environment, so the reference should name a dedicated read-only token. A project can
still set its own source credential later. Discovered lists are suggestions for
the form; they are not stored as access, sources or task data.

When the credential is missing or a read fails, setup shows the reason and accepts
typed owner/name and ref values. Local checkout verification still applies. A
typed repository is recorded with the provisional identity `github.com/<owner>/<name>`
(lower case), because no node ID can be read without discovery; delivery grants
compare node IDs and fail closed for it until project configuration replaces it.

## Folder picker

A web page cannot learn a folder's absolute path, and the operator may use the UI
from another device. The Ensemble service therefore serves the picker. An
authenticated operator route lists subfolder names and their Git status under the
operator's home folder. It never returns file contents or file names, dot-folders
or symlinks, and returns home-relative paths only. Each checkout row adds its
`github.com` origin as `owner/name` and its current branch, read with bounded,
non-interactive Git commands. A typed path stays available. Agents and model tools
cannot use this route. Disclose it as listing folders on the host.

## Verification

When a folder is chosen, and again on create, the service checks that it is a Git
checkout. Its origin must match the chosen repository, including the provider
instance, and the ref must be available. A mismatch is a field error that keeps
every other value.

## Linking a GitHub Project

Linking a discovered GitHub Project adds an inactive discovery source. Preview,
readiness and activation stay in project configuration, unchanged.

## Unchanged

Discovery, source selection and a linked GitHub Project grant no repository access.
Access is exactly the repositories the operator adds. Readiness and admission rules
are unchanged.

## Alternatives rejected

- **Native macOS folder dialog launched by the service.** It opens on the host's
  screen, so it fails for remote or phone use and blocks on an unattended host.
- **Browser folder APIs.** They return handles or relative names, not absolute
  paths, and support differs by browser.
- **Storing discovered lists.** They go stale, and stored copies could be mistaken
  for access.

## One create command

"Create paused project" is one keyed `project.create` carrying the name, lead,
optional instructions, verified repositories and at most one linked GitHub Project.
The service verifies every repository first, then records the project, instruction
revision 1, the repository links and the inactive source in one transaction under
one receipt. There are no partially recorded setups: a failed check names the
field, records nothing and the form keeps every value. An unknown outcome is
reconciled by replaying the original key and payload. A create without the setup
fields keeps its existing receipt and hash.
