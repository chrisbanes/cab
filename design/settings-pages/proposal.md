# Settings as section pages

Design proposal for maintainer review. No production routes, reads or behaviour
change in this PR. [Open the six artboards](index.html) in a browser; their fixture
data is illustrative and their controls do not save. The gallery has fixed desktop
and phone viewports; [the prototype](artboard.html) responds to your browser width.

## Recommendation

Keep the nine existing sections and their order. Give each a page with persistent
Settings navigation. Keep Routing separate: it is a useful cross-project entry
point, even though its controls remain in each project's Routing tab. Keep the
three credential pages separate: GitHub discovery, GitLab host credentials and CLI
credentials have different authority and lifecycle. Combining them would save two
navigation rows but load unrelated credentials and obscure those boundaries.

Use the existing Runtime page as the section page. Drop the old summary card and
its extra Open runtime step; retain capacity, availability, holds and recovery
on `/settings/runtime`. The navigation label is **Runtime & recovery**; retain
**Runtime capacity and recovery** as the page heading and **Runtime** as its crumb.
No new overview, router dependency or aggregate settings API is proposed.

`/settings` is a landing resolver, not another screen. Once the existing workspace
read settles, replace the URL with `/settings/readiness` when
`gettingStarted.turnStarted === false`, otherwise `/settings/projects`. An unknown
start state uses Projects, matching today's default order. Do not infer first run
from project count. If the workspace read fails, show its failure and Retry; keep
section links available rather than treating failure as a confirmed empty workspace.
Explicit section URLs and recognised legacy fragments take precedence over this
resolver, including before the first turn. Do not move the navigation order when
the first turn begins; do not redirect someone already reading a section.

## Layout and interaction

Desktop keeps the global shell and uses the existing Settings two-column pattern:
176px section navigation and a flexible content column. The active link has a
2px edge, tonal selection and `aria-current="page"`. Navigation is ordinary links,
not tabs: browser history, opening a new tab and keyboard activation work normally.
Each page has one h1, its own description and `Settings › Section` breadcrumb.
Settings returns through the landing resolver. Detail screens link the section
crumb back to its concrete route (Agents, Projects or Runtime); the final crumb is
plain text. Preserve the special first-project setup header and Overview return.

At phone widths, a full-width native disclosure labelled **Sections · Projects**
(or the current section) appears below the page header. Opening it exposes all nine
links in document flow, with 44px minimum targets; activating a link navigates
immediately and closes it on arrival. It does not navigate on arrow keys or require
Go. The current section remains visible when closed. At short heights, the document
scrolls; no overlay traps focus or covers settings. Keep the global navigation
drawer distinct from this local section disclosure.

On section changes, move focus to the destination heading and start at the top;
Back/Forward restores the entry's saved position. Readiness-check and Add Claude
links instead focus their target heading once its resource is ready. Preserve
existing draft and command-outcome semantics when moving between pages: unfinished
input stays in the shared draft store; failed saves keep input; navigation never
saves or discards credentials implicitly. Refresh refreshes only the mounted page.
Loading, retry and stale/read-only states remain local to the affected content.

### Review artboards

| State | Desktop 1366 × 900 and phone 390 × 844 |
| --- | --- |
| Returning `/settings` landing → Projects | First pair in [the gallery](index.html) |
| First-turn `/settings` landing → Readiness | Second pair in [the gallery](index.html) |
| Explicit Notifications page | Third pair in [the gallery](index.html) |

Open Sections in any phone frame to inspect all destinations. The artboard reuses
the existing monochrome tokens, Geist typography, hairlines, panels and state words;
there is no visual rebrand. Fixtures omit full configuration forms to focus review
on page structure. A real failed read must never show these example values.

`node design/settings-pages/capture.mjs` can capture PNGs and check navigation,
history, keyboard disclosure, touch targets and overflow in Chromium after `npm ci`.
The local sandbox denied Chromium's macOS bootstrap, so these automated browser
assertions have not run. The HTML artboards remain reviewable without that tool.
All six dark-theme frames were visually inspected in native Chrome. Opening the
phone Projects disclosure revealed all nine links; activating Notifications loaded
its page, updated the heading and breadcrumb, and closed the disclosure. Light,
tablet and short-phone automated checks remain unverified. The font files load
from the existing dependencies after `npm ci`; otherwise system fonts are used.

## Route table

All destinations below are proposed. Existing detail URLs remain supported.
Legacy rewrites use client-side `replaceState`, before section resources mount:
URL fragments never reach the server, so an HTTP redirect alone cannot do this.
Preserve unrelated query parameters. A rewrite must not add a Back-button loop.

| Current section or entry | Canonical destination | Compatibility / entry-point change |
| --- | --- | --- |
| `/settings` (no recognised fragment) | `/settings/readiness` before first turn; `/settings/projects` otherwise | Workspace-based resolver above; account menu, shell and lifecycle links can keep `/settings` |
| Projects; `/settings#projects` | `/settings/projects` | `settingsSectionHref("projects")`; project setup return; project detail and create crumbs |
| Runtime summary; `/settings#runtime` | `/settings/runtime` | `settingsSectionHref("runtime")`; remove summary step |
| Agents; `/settings#profiles` | `/settings/agents` | `settingsSectionHref("profiles")` keeps internal id; profile-config return and agent crumbs |
| Routing; `/settings#routing` | `/settings/routing` | Each row still links `/projects/:id/settings?tab=routing` |
| GitHub discovery; `/settings#github-discovery` | `/settings/github-discovery` | Project setup and Getting started links |
| GitLab credentials; `/settings#gitlab-credentials` | `/settings/gitlab-credentials` | Preserve host credential controls |
| CLI credentials; `/settings#cli-credentials` | `/settings/cli-credentials` | Preserve issue/rotate/revoke controls |
| Notifications; `/settings#notifications` | `/settings/notifications` | Change `operator-push.ts` payload for future notifications; rewrite already-delivered URLs indefinitely |
| Readiness; `/settings#readiness` | `/settings/readiness` | `wait-fix-href`, Getting started and `settingsSectionHref("readiness")` |
| `/settings#readiness-<known check id>` | `/settings/readiness#readiness-<check id>` | `readinessCheckHref`; wait for check render, then focus and scroll its heading |
| `/settings/runtime` and hard-coded runtime links | unchanged | `app.tsx` back target, `setup-model.ts`, Getting started, runtime-restart copy and recovery crumbs remain valid |
| `/settings/runtime#add-claude` | unchanged | Preserve Add Claude target and delayed-resource focus |
| `/settings/projects/new` | unchanged | Normal crumb: Settings → Projects (link) → Create project; first-project exception preserved |
| `/settings/profiles/new` | unchanged | Settings → Agents (link) → Create agent; do not rename this existing URL |
| `/profiles/:id/settings` | unchanged | Settings → Agents (link) → agent name |
| `/projects/:id/settings?tab=…` | unchanged | Settings → Projects (link) → project → selected tab |
| `/assignments/:id/recovery` | unchanged | Settings → Runtime (link) → Assignment recovery |
| Unknown or malformed `/settings#…` | normal `/settings` landing, remove unsupported fragment | No arbitrary element selection or decode exception; unknown check ids have no focus target |
| Unknown `/settings/:section` | existing not-found page | Do not silently alias misspelled paths |

Known fragments are matched after safe decoding, against the existing section and
readiness-check ids. If a known check is absent in a response, remain on Readiness
with the normal page heading and content; never wait forever or focus another check.
Apply the same rule on direct new check links. Keep compatibility handling on
hashchange as well as initial entry and history traversal.

## Read inventory

This separates page reads from the existing shared shell/session, workspace and
live-update subscription. Those shared reads remain; a Notifications visit can still
have a workspace request. Existing endpoints are sufficient. Abort page-owned reads
on departure; late responses must not populate another page. Keep the four-worker
bound for project configuration reads and individual Retry controls.

| Page | Additional reads when mounted | Deliberately absent |
| --- | --- | --- |
| `/settings` resolver | None beyond shared workspace | No section reads before destination resolves |
| Projects | `/api/operator/projects/:id/configuration` per visible project; `/api/operator/source-observations`; `/api/operator/runtime` for each project's recorded-hold indicator; `/api/operator/workspace?includeArchived=true` only when Show archived is selected | Credential, readiness and notification reads |
| Runtime & recovery | `/api/operator/runtime`; retain existing action-time preflight re-reads and assignment recovery evidence reads on its separate detail page | Project configuration fan-out, observations, discovery |
| Agents | Shared workspace profiles; no additional section read | Runtime endpoint: displayed runtime comes from each profile's workspace value |
| Routing | `/api/operator/projects/:id/configuration` for the listed projects | Observations, runtime, all credential reads |
| GitHub discovery | `/api/operator/discovery` once | Readiness's second discovery read |
| GitLab credentials | `/api/operator/code-host-credentials` | Other credentials, discovery, readiness |
| CLI credentials | `client.credentials()` (`/api/operator/credentials`) | Other sections' reads; one-time secret remains session-only |
| Notifications | `client.notifications()` (`/api/operator/notifications`); local permission/service-worker/subscription inspection | Config fan-out, observations, runtime, readiness, discovery; no permission prompt on navigation |
| Readiness | `/api/operator/readiness` and `/api/operator/discovery` once, retaining its existing one-step discovery repair | Projects, runtime-summary and all other credential UI reads |

Projects intentionally retains the runtime read because its existing hold indicator
needs it. Dropping it just to claim fewer reads would change the information shown.
Readiness still needs discovery for its inline repair; splitting pages removes the
index's duplicate read without adding a cache. Successful discovery repair refreshes
Readiness and its discovery row locally; the separate discovery page reads fresh
when visited. No hidden pages subscribe to header refresh or start background reads.

## Implementation slices and evidence

These are estimates of reviewable slices, not elapsed-time promises. They belong
to a subsequent implementation task; merging this proposal does not perform that work.

1. **Route and entry contract (medium):** central section-id → route mapping;
   `/settings` resolver and legacy rewrites; register all nine routes in the
   client known-route allow-list, pathname dispatch and server shell matcher
   (`src/standalone/operator-web.ts`).
   Update listed href callers, push URL, header crumbs, parent/back targets and
   Settings account-menu current matching. Pure tests cover mappings, malformed
   fragments, first-turn true/false/unknown and header wording. Browser tests cover
   initial legacy entry, hashchange, Back/Forward, direct loads and reloads
   (including unauthenticated sign-in return).
2. **Page composition and navigation (medium):** mount only one section, reuse
   panels and existing Runtime page, isolate page loaders, add the phone disclosure.
   Preserve configuration concurrency, retry, archived visibility, drafts, writes
   and feedback. Browser request assertions cover positive and negative reads per
   route, cancellation, local Refresh, first-run explicit deep links, phone
   keyboard/touch links and active route state at desktop and phone.
3. **Target focus and obsolete code (small–medium):** remove fragment-derived
   section selection, order-change scroll correction, select-plus-Go and old
   index-only landing support. Replace the broad `useFragmentLanding`,
   `landingElement` and shell exemption with the smallest target-ready focus
   handling needed for Readiness checks and Add Claude. Keep history restoration
   precedence; verify delayed reads, retries, missing targets, user interaction
   during loading and Back/Forward. Do not delete still-required landing behaviour
   merely because section anchors are gone.
4. **Docs and qualification (small):** update `docs/user-flows/readiness-check.md`,
   `getting-started.md`, relevant first-run/project-setup/Claude/unblock journeys,
   `docs/SPEC.md` and these foundations to describe shipped navigation. Update
   section, browser layout and presentation tests. Run required static/build
   checks and affected operator suites; final `check` CI must pass before merge.
   Review desktop, phone, tablet, short phone, light/dark, long lists and failures.

No current-tense user-flow or SPEC changes accompany this design-only proposal;
those documents must describe the shipped application until implementation.

## Maintainer decisions

Approve or amend these after inspecting the artboards:

- Keep all nine sections, with Routing and each credential type separate.
- Use the existing Runtime page directly, without a summary screen.
- Resolve `/settings` to Readiness before the first turn and Projects otherwise;
  keep a fixed navigation order and honour explicit destinations.
- Use the inline Sections disclosure on phones rather than horizontally scrolling
  links or an action select. It costs one tap to reveal destinations, keeps all
  labels readable, and avoids adding another drawer.

These choices are recommendations, not recorded maintainer approval. Approval of
this design PR preserves the design-only boundary.
