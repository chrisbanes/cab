---
status: superseded
superseded_by: [ADR-1038]
---

# Retire agents through revocation and hide them from default lists

Superseded by [ADR-1038](1038-coordinate-agents-that-run-elsewhere.md), under which cab coordinates agents that run elsewhere. The text below is the earlier decision.

Proposal for [#1522](https://github.com/chrisbanes/cab/issues/1522).
This document requests a maintainer decision. It changes no accepted contract
and authorises no implementation, installed-data cleanup or rollout. Merging
this proposal, or completing the investigation, does not accept its policy.

## Evidence and context

An agent is a reusable identity; `profile` remains the code, API and CLI name.
At inspected base `e52dc2a598ae347d83151c3858495ac65ebd33c7`, agents can be
created, configured, revoked and restored. Revoked agents remain in ordinary
lists. The CLI warns that creation cannot be undone. The bounded source and
history search found no explicit decision requiring universal permanent agent
retention; that does not establish that retention was accidental.

The [investigation](../evidence/2026-11-15-agent-profile-retirement.md) traces
current references, immutable revisions, receipts and project-deletion survivors.
Foreign keys cover only part of that graph. History readers and privacy
exclusions need revision content, not just an old ID and name. Project deletion
keeps shared agents, their revisions, global agent caps and profile/system
receipts. Its private redaction ledger holds exact values for sanitisation; it
cannot resolve an agent's identity or restore instructions.

## Recommendation

Use the existing revoked state as retirement. Hide revoked agents from default
agent collections and new-selection pickers, with explicit All and Revoked views.
Keep canonical workspace/reference reads complete, existing selected references
visible and ID-addressed settings, instructions and history reachable. Show both
available and revoked counts; a filtered empty list must never mean an empty
installation or enable the starter bundle.

Keep identity, revisions, instructions, runtime settings, historical extension
selections, receipts and capacity overrides. Filtering must never narrow privacy
exclusions. Preserve current and bound names according to each existing reader;
do not promise that all history labels are frozen. Names remain labels: exact
duplicates, case variants and renames continue to identify distinct agents by ID.
There is no name reservation to release and no ID reuse.

Revoke and restore stay versioned, keyed configuration saves. Revocation denies
later admissions; it does not stop an admitted turn, withdraw work, clear holds
or remove project references. Restoration makes the agent available again under
normal admission checks; it neither replays denied actions nor applies a new
revision to an existing started assignment. The investigation gives the proposed
CLI/API/web contract, race and replay rules, and focused validation outline.

## Alternatives

- **Unused-only deletion** could remove a mistaken agent and its content. Every
  creation already produces a revision and receipt, so the literal “no retained
  reference ever” rule needs an explicit exception before it can delete anything.
  Deleted project records also prevent proving lifetime non-use from current
  absence. A defensible weaker rule would need a different accepted guarantee.
- **Hard deletion with a tombstone** offers broader record cleanup, but requires
  explicit rules for live references, immutable revisions, serialized receipts,
  history readers and privacy retention. A minimal identity tombstone cannot
  replace those records. Retaining revision content would limit its storage and
  erasure value while adding irreversible lifecycle and recovery work.

## Consequences, reversal and limits

This is list cleanup, with no storage or erasure benefit. Revoked instructions
continue to contribute to exclusion limits; backups and native runtime history
retain their own boundaries. Native authentication, skills, plugins, MCP servers
and hooks remain owned by the harness under
[ADR-1021](1021-profile-skill-plugins-and-subagents.md), regardless of legacy data
in a profile. Retirement grants no native cleanup authority.

Restore reverses availability and visibility, without changing the identity or
discarding history. Reverting a future filter restores list visibility; reverting
these documents changes no data. A future destructive option would need its own
accepted retention and irreversible recovery contract.

The maintainer must separately accept or reject the model and its visibility,
reference, history and privacy trade-offs before implementation is scoped.
No implementation issues are created by this proposal. Source and existing test
assertions support the investigation; no new runtime, browser or installed-data
behaviour has been qualified.
