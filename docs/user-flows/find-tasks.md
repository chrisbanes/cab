# Find tasks

**Status:** implemented. The behaviour is asserted by the `task filters are remembered…`, `active filters are counted…`, `typing in the text filter…` and `Back and Forward show…` journeys in `test/operator/operator-work-browser.test.ts`, with the parsing rules in `test/operator/operator-task-list.test.ts`.

## Goal

The operator returns to the same filtered task list after opening a task, leaving the
list or reloading, and always sees which filters are hiding work.

## Entry points

- Sidebar Tasks, the All tasks links and a task's Back link open `/app/tasks`.
- Overview and project pages show the same work list, so they share the filters.
- App links that name a state or an import (View completed, a Running wait link and
  View imported tasks) carry their own filters, including Any readiness, so the list
  shows everything the link promises.

## Steps

1. The list is the URL: Project, State, Source, Readiness, text and List or Board are
   query parameters, so a link or a reload shows the same list.
2. The browser remembers the last filters shown, in `localStorage` under
   `ensemble.task-filters.v1`. It is a per-device, per-browser-profile preference,
   not a credential, so signing out keeps it, and the service stores nothing. A URL
   that has filters always wins and becomes the remembered set. A task page URL with
   no filters is rewritten in place (no extra Back step) to the remembered ones.
   Blocked or unavailable storage falls back to the defaults. A visit that sets no
   filter stores nothing.
3. Tasks, Overview and project pages share one remembered set. A project page takes
   its project from its route: it neither applies nor overwrites the remembered
   Project.
4. Readiness defaults to Ready, so a Draft task (not Ready) is hidden until Readiness
   is Not Ready or Any readiness (`ready=any`). Ready is omitted from URLs like
   `view=list`; a missing, empty or unknown `ready` means Ready.
5. With More filters closed, its summary counts the hidden filters that differ from
   the defaults ("More filters · 2 active"). Reset filters, at the end of that line,
   appears when any filter differs and keeps List or Board. It is a normal navigation, so Back returns to
   the filtered list, which becomes the remembered set again.
6. The count line reads "N tasks", "No tasks" when nothing is in scope, or "No tasks
   match these filters" when filters hide everything. Overview states the same in its
   empty panel.
7. The first keystroke in Filter tasks adds a history entry and later ones replace
   it, so one Back returns to the list without the text. Every other filter change adds
   an entry. Back and Forward show the filters each entry had: an entry that a filter change
   or Reset left bare, with the filters at their defaults, stays the defaults instead of
   taking the remembered set.

## Budget

| Entry point | Interactions to the previous filtered list | First screen must show |
| --- | --- | --- |
| Sidebar Tasks after leaving the list | 1 (Tasks) | the remembered filters in the URL and the toolbar, and the active count |

