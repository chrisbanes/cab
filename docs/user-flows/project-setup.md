# Project setup

**Status:** implemented (`/app/settings/projects/new`, design frames 115–117c and
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

Steps 1, 2 and 3 read in one column, in that order. "What creation does" (two
bullets) sits beside them from 1121px and after them below it. A sticky bar holds a
note, **Cancel** and then **Create paused project** at every width.

1. **Lead.** Choose a lead profile. With no profiles, the step shows an inline
   profile form (name and runtime with Codex preselected) in place of the list, with
   the line "Add a summary and instructions later in Settings → Profiles." Creating
   it selects it and keeps every other setup value. The profile and the project are
   two separate submissions.
2. **Instructions.** Unchanged.
3. **Repositories.** Discovered repository and ref, folder picker, checkout
   verification, typed fallback. While discovery is unconfigured the step starts
   collapsed (117c) with the line "Optional. Without a repository the project is
   repository-free; adding one also offers GitHub discovery." and **Add a
   repository**. Opening it moves focus to its first control and reveals the setup
   alert (117b) with **Use GitHub CLI login** when gh is signed in, the one place
   setup offers it, and **Set discovery credential**. It opens by itself for a row
   that holds a value, a rejected repository or GitHub Project, and an unsettled
   GitHub CLI login. It never closes again: clearing a row means choosing "No
   repository · repository-free". The GitHub source credential line appears here
   once a repository row is filled.
4. **Create.** Creates the project paused, as today. A rejection or an unknown
   outcome appears at the top of the form (116, 116b) and keeps every value. Create
   is always drawn. It is focusable but inactive, with its reason, while the project
   or the inline profile is being saved or its outcome is unknown, and while a profile
   name is typed that has not been recorded, whether or not the service refused it.
   Clearing the name or recording the profile releases it. A repeated click or Enter
   sends nothing more.
5. **Ready check.** Replaces the form and takes focus; the heading "Set up your
   first project" stays for the visit. It replaces the "Recorded … as a paused
   project" alert:
   - Lists what was recorded (instructions, repository access, linked GitHub
     Project) and states that nothing has run. Repositories were verified before the
     project was recorded, so no checkout item can follow. The GitHub source
     credential line, with its **Check again**, appears only when the project has a
     repository: setup records the credential only then.
   - Lists any item that would make the lead's work wait, from the workspace and
     readiness reads: no lead profile, the lead's runtime unavailable or not enabled,
     a Claude model or reasoning effort the runtime does not accept (Fix opens the
     lead profile), Codex executable or sign-in unavailable for a Codex lead, Claude
     executable not on the service `PATH` or Claude token unavailable for a Claude
     lead (the token's Fix opens [Add Claude](claude-runtime.md)).
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
  changed elsewhere asks for a review before Resume is sent again; the review
  judges the project's current lead on fresh reads before Resume unlocks.
- Closing or reloading setup before Create discards the draft; the browser's leave
  prompt warns when any field has changed. Moving to another page in Ensemble keeps
  the draft for the session.
- Reloading after Create shows a blank "Create project" form for a second project,
  with no ready check and no leave prompt. A project created in another tab does not
  change the first-project heading until the next visit.

## Recovery

- The ready check is shown once, right after creation. Later, Resume is the Pause
  project switch in project configuration, and Resume is reversible there.
- A profile created inline is an ordinary profile, edited or kept in Settings →
  Profiles. Setup never deletes it, even when setup is abandoned.

## Unchanged guarantees

Creation starts no execution; Resume is an explicit operator action; repository
access is exactly the list in step 3; discovery imports nothing until a source is
previewed and activated.
