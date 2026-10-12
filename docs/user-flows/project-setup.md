# Project setup

**Status:** planned changes to the implemented guided setup
(`/app/settings/projects/new`, design frames 115–117b). Product rules are in
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
   - Lists what was recorded (instructions revision, repository access, linked
     GitHub Project) and any item that would make work wait: runtime unavailable,
     profile runtime not configured, checkout unverified.
   - Primary **Resume and create first task**: resumes the project through the
     existing project command, then opens the composer with the project selected.
     Disabled with the blocking reason while a listed item would make work wait.
   - Capacity changes as other work runs, so it never disables the primary. When
     capacity is full, the check says the first task will wait for capacity.
   - Secondary **Keep paused**, which opens project configuration.

## States

- Profile create fails: the inline form keeps its input and shows the error; setup
  values are untouched.
- Resume outcome unknown: the ready check blocks a second Resume until the project
  is re-read, matching other configuration saves.
- Leaving setup before Create discards the draft; the browser's leave prompt warns
  when any field has changed.

## Recovery

- Resume is reversible through Pause project in project configuration.
- A profile created inline is an ordinary profile, edited or kept in Settings →
  Profiles. Setup never deletes it, even when setup is abandoned.

## Unchanged guarantees

Creation starts no execution; Resume is an explicit operator action; repository
access is exactly the list in step 3; discovery imports nothing until a source is
previewed and activated.
