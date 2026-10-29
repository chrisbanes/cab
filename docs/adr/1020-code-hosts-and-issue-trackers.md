---
status: accepted
---

# Separate code hosts from issue trackers, adding GitLab and Jira Cloud

GitHub currently fills two roles in cab: it is the **issue tracker** behind task sources and
the **code host** that receives task branches and change requests. The two are combined in
one place: a project's linked repositories live inside its GitHub source configuration and
carry GitHub identities. ADR-1001 deferred Jira, and the specification left Jira out of the
first release and did not mention GitLab. Chris needs cab at work, where the work is tracked in
Jira Cloud and the code is on a self-managed GitLab instance. Both become first-class
providers. Jira and GitLab are planned and not yet implemented.

## Decision

- **Two provider roles.** An issue tracker supplies task sources, external references, status
  mapping and issue writes. A code host supplies repository links, task branches, change
  requests and their delivery. A project can pair any issue tracker with any code host, for
  example Jira issues delivered as GitLab merge requests.
- **Repository links belong to the project.** They leave the GitHub source configuration and
  record their code host and its host name. Existing links migrate as GitHub on `github.com`.
  Hosts are configurable per link, because work runs a self-managed GitLab. A GitLab link
  verifies its checkout's origin against the host and full project path; the numeric project
  ID is operator-supplied until discovery.
- **Local tasks hold every repository link of the project,** for every code host, in their first
  workspace. An imported task still holds only its source repository.
- **Interfaces follow concrete integrations.** The code-host seam is extracted, without
  changing behaviour, when GitLab delivery is built. The issue-tracker seam is extracted when
  Jira is built. Neither is generalised in advance.
- **Storage and seams are provider-neutral.** Imported items, memberships, holds, repository
  links and delivery records are keyed by provider and instance rather than held in
  per-provider tables. A later provider, such as Linear, should then need its own adapter and
  configuration, not a schema fork or changes to coordination.
- **Order of delivery:** repository-link decoupling, then GitLab, then Jira.
- **The delivery lifecycle is unchanged for every provider:** intent before effect, readback
  proof of the exact target, uncertainty kept across restart and no blind replay.
- **GitLab has the same scope as GitHub delivery.** Merge requests come only from task branches
  in the linked project, not forks. Through-merge runs only while GitLab reports the merge
  request mergeable, leased to the expected head SHA. On a project that uses merge trains, the
  merge adds the request to the train and stays pending until it merges or drops out. cab
  never sets auto-merge.
- **Jira Cloud has the scope of GitHub sources, except issue edit and task publication.**
  Those two are deferred: on a Jira task they are shown as unavailable with a reason.
  - Selections are JQL queries. Readiness checks status, labels and single-select fields.
    "is blocked by" links are source-owned task dependencies.
  - Status mapping maps each event to a target status. At write time cab uses the single
    available transition to that status and records a skip when none or several apply.
  - Descriptions are ADF and are read as Markdown. When issue edit is added, it is refused
    unless the current body converts to Markdown and back without loss.
  - When publication is added, it chooses a Jira project and issue type, and a target whose
    create screen requires other fields is disabled.
- **cab proves Jira closure through its own transition.** Change request text carries no
  closing keywords for Jira issues. A transition made by GitLab's Jira integration or by a
  person is an external closure, which holds the task and is reconciled.
- **Jira keys name the work on the code host.** The task branch and change request title of a
  task imported from Jira carry its issue key, so GitLab's Jira integration links them.
- **Credentials.** GitLab reads a token through `glab:<host>`, which uses the GitLab CLI's
  login for that host, or through `env:`. Jira reads an account email and API token through
  `env:`.
- **Grant scope follows the role.** Change request and branch actions stay granted per
  repository. Issue actions on Jira tasks are granted per Jira project.

## Considered options

- **Keep repositories inside each source configuration.** Rejected: a Jira source has no
  repositories, so pairing Jira issues with GitLab code would need a fake pairing.
- **Generalise both seams before building either integration.** Rejected: with no second
  implementation, the interfaces would be guesses. GitHub Project fields and Jira workflow
  transitions differ the most.
- **Let GitLab's Jira integration close issues on merge.** Rejected: cab could only attribute
  the closure from Jira's changelog, which is weaker proof than its own recorded transition.
- **Map status events to transition IDs.** Rejected: transition IDs differ between issue types
  and change when a workflow is edited.
- **Read Jira credentials from the Atlassian CLI.** Rejected: `acli` reports the logged-in
  account but documents no way to obtain its token, so cab could not make its own REST calls.
- **Allow GitLab auto-merge.** Rejected: the merge could land after a later outside change,
  and the outcome would stay pending for longer.
- **Support merge requests from forks.** Rejected for now: every push and recovery path would
  need a second remote identity and its permissions.

## Consequences

- This reopens the Jira deferral in ADR-1001. Linear and other providers are expected
  later but are not scheduled.
- The existing GitHub tables migrate into the provider-neutral storage. Nothing changes for
  GitHub projects.
- Bounded live validation uses gitlab.com and a personal Jira Cloud site. It does not prove
  behaviour against the version or settings of the work GitLab instance.
