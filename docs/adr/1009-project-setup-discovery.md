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

Discovery uses an installation-level GitHub credential reference, held
server-side like other credentials and used only for reads: repository and branch
lists through REST GETs and Projects through one fixed GraphQL query. The reference
is `env:NAME` or `gh:github.com`, the GitHub CLI's login for github.com. The service
resolves a `gh:` reference for each read with non-interactive `gh auth token
--hostname github.com` under a bounded timeout, and caches nothing for reads. The
keyed `discovery.configure` command sets or clears the reference. Each project
source independently accepts `env:NAME` or exactly `gh:github.com` through its
versioned source-save command. Delivery and routing remain env-only. Discovery
never supplies a missing source credential or changes a source's identity.

The discovery status read reports:

- whether a reference is configured and usable, and its kind;
- the GitHub CLI detection state (`gh auth status --json`): signed in with the
  account login, not installed, not signed in, or unreadable from the service.

It never reports the reference name or token. Detection only offers the login.
Ensemble reads with it only after the operator chooses it in Settings or the setup
alert, and never falls back to it implicitly.

Discovery and project source credentials are removed, by name and value, from the Codex runtime
spawn environment, from each Claude turn and from helper child processes, as
delivery credentials and the Claude token are:

- an `env:` reference by its variable and value;
- a `gh:` reference by `GH_TOKEN`, `GITHUB_TOKEN` and every token value the
  service has resolved. Those values are held for the process lifetime only for
  exclusion and redaction, including after Clear and token rotation. They are never
  reused for reads or persisted. Each resolved token is bounded to 512 bytes;
  distinct rotations grow this exclusion-only memory until service restart.

A Codex runtime keeps the environment it was spawned with, so a reference set
while it runs is excluded from it after the next service restart.

Ensemble does not prevent an agent from running `gh` itself if its sandbox can
reach the operator's keychain. That is a runtime limit, not an Ensemble guarantee.
A project can still set its own source credential later. Discovered lists are suggestions for
the form; they are not stored as access, sources or task data.

When the credential is missing or a read fails, setup shows the reason and accepts
typed owner/name and ref values. When a list is truncated, setup says so and also
accepts a typed repository or ref; a typed repository that the list does contain is
recorded with its node ID. Local checkout verification still applies. A
typed repository is recorded with the provisional identity `github.com/<owner>/<name>`
(lower case), because no node ID can be read without discovery; delivery grants
compare node IDs and fail closed for it until project configuration replaces it.

## Folder picker

A web page cannot learn a folder's absolute path, and the operator may use the UI
from another device. The Ensemble service therefore serves the picker. An
authenticated operator route lists subfolder names and their Git status under the
operator's home folder. It never returns file contents or file names, dot-folders
or symlinks, and returns home-relative paths only. A requested path inside a
dot-folder, typed or reached through a symlink, is refused. Each checkout row adds its
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

Source settings offer GitHub CLI with the detected account or a service environment
variable. Detection alone chooses nothing. Configured settings offer Change and
Clear; Cancel restores only the credential edit, preserving other source drafts.
Missing or unusable credentials show the same actionable reason in source settings,
Sync & placement and preview: configure a source credential, install gh, sign in on
the service host, or check the service's access to the login. Selection, preview,
issue-status and blocker reads resolve the chosen reference on each public read.
An unavailable credential leaves provider knowledge incomplete and blockers unknown.

Change and Clear use the existing keyed source save. They preserve source definitions
and imported history, invalidate activation and require preview at the new source
version. An uncertain save retains the draft and reconciles the same request before
another save. No credential edit activates a selection or resumes work.

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
