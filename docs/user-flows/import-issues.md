# Import issues from GitHub

**Status:** implemented, with the budget asserted by the journey test.

## Goal

After the operator saves a GitHub source, the same screen previews and activates the
saved sources and reads them from GitHub, then says which were imported.

## Entry points

- GitHub source tab of project configuration, after Save changes: the Import issues
  panel. It is also offered whenever a saved source is inactive or has never been read,
  so it survives leaving the tab and a lost reply.
- Sync & placement keeps later refreshes and placement. It is not part of the budget.
- Operator CLI `project preview-source` is outside the budget: it has no screens.

## Steps

1. Save changes. Focus moves to the Import issues panel, which names what is not
   imported yet ("Saved. acme/atlas isn't imported yet.").
2. Preview and import now sends one keyed preview-and-activate command for each saved
   inactive source, in saved order, then one installation-wide refresh.
3. The activation line comes from the previews' receipts ("Previewed 10:47. acme/atlas
   and Atlas roadmap are active."). The read line comes only from the refresh's state
   ("Read acme/atlas and Atlas roadmap completely at 10:47.") with View imported tasks.
   A partial, never or unavailable read says so and claims no import. The refresh
   creates no receipt.

## Budget

| Entry point | Interactions to imported tasks | First screen must show |
| --- | --- | --- |
| Unsaved source on the GitHub source tab | 2 (Save changes, Preview and import now) | after Save, the Import issues panel and its action; after the press, the activation line, the read line and View imported tasks |

The journey test asserts the count and that each first screen is in view at 1366 × 900
and 390 × 844. Adding or editing the source is the edit being saved, not an interaction.
Frames: `119d-github-source-import-ready` to `119e-github-source-imported`.

## Recovery

- A preview whose outcome is unknown stops the chain before any refresh. Check whether
  it saved resends the exact request with the same key, so a source is never activated
  twice; the chain then continues from the next source.
- A refresh that is not confirmed says "The sources are active." and offers Refresh
  again, which sends only the refresh.
- A source saved elsewhere refuses the preview: the warning offers Review changes,
  which reads the new version and offers the action again under new keys.
- An unusable source credential keeps the action focusable with the reason beside it
  and the link to Set or change source credential.
- An unsaved edit removes the panel until it is saved or discarded.
