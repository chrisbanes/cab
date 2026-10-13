# Project setup

**Status:** implemented (`/app/settings/projects/new`, design frames 115–117b and
145–147). Product rules are in
[SPEC](../SPEC.md#task-creation-and-project-setup).

## Goal

One uninterrupted pass from "new project" to a project ready for its first task.
The operator never leaves setup to create a prerequisite.

## Entry points

- [Getting started](getting-started.md) Project row.
- Settings → Projects → New project.
- Empty home and sidebar "No projects yet".

## Steps

1. **Lead.** Choose a lead profile. With no profiles, the step shows an inline
   profile form (name, summary, instructions, runtime with Codex preselected) in
   place of the list. Creating it selects it and keeps every other setup value.
2. **Instructions.** Unchanged.
3. **Repositories.** Unchanged: discovered repository and ref, folder picker,
   checkout verification, typed fallback. When discovery is unconfigured, the
   existing setup alert (117b) configures it in place.
4. **Create.** Creates the project paused, as today.
5. **Ready check.** Replaces the "Recorded … as a paused project" alert:
   - Lists what was recorded (instructions, repository access, linked GitHub
     Project) and states that nothing has run. Repositories were verified before the
     project was recorded, so no checkout item can follow.
   - Lists any item that would make the lead's work wait, from the workspace and
     readiness reads: no lead profile, the lead's runtime unavailable or not enabled,
     a Claude model or reasoning effort the runtime does not accept (Fix opens the
     lead profile), Codex executable or sign-in unavailable for a Codex lead, Claude
     token unavailable for a Claude lead (Fix opens [Add Claude](claude-runtime.md)).
     An unreadable readiness check counts as a wait item, so the check fails closed.
     Fix links open in a new tab so the check stays; **Check again** re-reads
     readiness, the workspace and capacity once the item is fixed.
   - Primary **Resume and create first task**: resumes the project through the
     existing project command, then opens the composer with the project selected.
     Disabled with the blocking reason while a listed item would make work wait.
   - Capacity changes as other work runs, so it never disables the primary. When
     capacity is full, the check says the first task will wait for capacity.
   - Secondary **Keep paused**, which opens project configuration.

## States

- Profile create fails: the inline form keeps its input and shows the error; setup
  values are untouched.
- Resume outcome unknown: the ready check blocks a second Resume until its one
  action replays the exact request, matching other configuration saves. A project
  changed elsewhere asks for a review before Resume is sent again.
- Closing or reloading setup before Create discards the draft; the browser's leave
  prompt warns when any field has changed. Moving to another page in Ensemble keeps
  the draft for the session.

## Recovery

- The ready check is shown once, right after creation. Later, Resume is the Pause
  project switch in project configuration, and Resume is reversible there.
- A profile created inline is an ordinary profile, edited or kept in Settings →
  Profiles. Setup never deletes it, even when setup is abandoned.

## Unchanged guarantees

Creation starts no execution; Resume is an explicit operator action; repository
access is exactly the list in step 3; discovery imports nothing until a source is
previewed and activated.
