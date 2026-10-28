---
status: accepted
---

# Run drafting as a project-owned run, not a Draft task

The task composer lets the operator hand a rough idea to the project lead and get
back an editable title and outcome. Every agent turn with coordination belongs to a
task, and Draft (unready) tasks never run turns. Delivery scope lives in
[#1168](https://github.com/chrisbanes/cab/issues/1168).

## Decision

- A **Drafting run** belongs to a project and has no task. It is a third turn-request
  kind beside direct and assignment turns, so it uses the same scheduler, admission
  transaction, runtime waits and capacity reservations. It counts against the global
  and project active-turn limits.
- It runs on the project lead's profile and runtime with a fixed drafting instruction
  and one result tool. It has no coordination, delivery or GitHub tools. It works in a
  disposable detached worktree of the project's linked repositories with network off,
  deleted when the run ends. Because neither runtime has a read-only mode, the
  composer and SPEC disclose that reads keep the runtime's normal host access.
- It creates no task, assignment, task workspace or result. The operator's Save draft
  or Create remains the only way anything persists.
- Stop, a fixed 10-minute cap and a service restart hold the run until the runtime is
  seen to end, and only then release capacity, delete the worktree and settle the run.
  Termination that cannot be verified keeps the capacity; drafting has no recovery
  page.
- The run records its lifecycle in its own table and keeps an unclaimed proposal for
  24 hours so the composer can reattach after leaving or reloading.
- The lifecycle, workspace, capacity and Stop logic do not depend on the composer.
  The instruction and the proposal schema are the only composer-specific inputs, so
  [#1182](https://github.com/chrisbanes/cab/issues/1182) can improve imported
  issues with the same runs.

## Considered options

- A Draft task whose first assignment writes its own brief. Rejected: it reuses tasks,
  assignments and results, but Draft tasks are not Ready and so never run. Running
  them would bend admission, or mean marking a rough idea Ready, which contradicts
  what Ready means. It would also create a task before the operator chose to.
- A dedicated drafting profile or a read-only runtime mode. Rejected as out of scope:
  the lead's profile already carries the project's context, and neither runtime can
  enforce read-only access today.
- Releasing capacity when Stop is acknowledged or the cap expires. Rejected: only an
  observed end shows the runtime has stopped acting, as for every other execution.
