# Settings as section pages

Unaccepted design proposal for maintainer review, reusing [PR #1613](https://github.com/chrisbanes/cab/pull/1613). No production routes, reads or behaviour
change in this PR. Proposal publication or merge is not design acceptance; later implementation requires explicit acceptance and authorization. [Open the six artboards](index.html) in a browser; their fixture
data is illustrative and their controls do not save. The gallery has fixed desktop
and phone viewports; [the prototype](artboard.html) responds to your browser width.

## Current source and scope

The audit uses [main at a1ab52f5](https://github.com/chrisbanes/cab/tree/a1ab52f5729317a6b0cc552e99aed96d1d90c01f), not the artboards as evidence of shipped behaviour. The [design-only brief](https://github.com/chrisbanes/cab/issues/1581#issuecomment-6746154794) and [r1 plan](https://github.com/chrisbanes/cab/issues/1581#issuecomment-6876502974) govern this delivery. The brief's “no artboard” statement is stale; the existing proposal remains unaccepted.

Today `/settings` mounts the long index; only Runtime already has its section page. The following owners must agree in any later implementation:

| Current source | Verified responsibility; later change |
| --- | --- |
| [`app.tsx`](../../web/src/app.tsx) | `knownRoute` allow-list and pathname dispatch are separate; both need the exact proposed sections. `parentRoute` owns phone Back. `AccountRows` currently marks Settings current only at `/settings`; section and existing detail descendants need consistent Settings ancestry. `account-menu.tsx` also opens the root. |
| [`operator-web.ts`](../../src/standalone/operator-web.ts) | `OperatorWebBoundary.shell` separately permits index, Runtime, create and UUID detail/recovery paths. Register only the proposed concrete section paths; no wildcard `/settings/*` contract. |
| [`operator.ts`](../../src/standalone/operator.ts) | GET/HEAD `/app/...` returns 308 to the root path with query, without a new cookie; leading slashes are collapsed. The browser owns the fragment. |
| [`settings-view.ts`](../../web/src/settings-view.ts) | `settingsHeader` owns titles and crumbs; intermediate Projects/Agents crumbs currently have no href. Keep first-project setup's latched Overview/New project exception and the `?tab=github` → Task source alias. |
| [`settings-sections.ts`](../../web/src/settings-sections.ts) | Safe fragment decode, section order/selection and `useFragmentLanding` share landing decisions with App. Saved scroll wins; entry URL, nav key and authentication scope distinguish history entries. |
| [`settings-index.tsx`](../../web/src/settings-index.tsx) | All panels mount, Readiness moves first when turnStarted is false, select-plus-Go uses max-width 759px and an effect corrects focused content after reordering. Page separation can retire these index-only mechanics. |

The source audit includes all href helpers and literal Settings callers, push payloads, Recovery/Readiness landing, create/detail headers, shell history, sign-in and page loaders. The route/read tables below allocate existing behaviour; they do not authorize changes to provider access, credentials, holds, approvals or recovery. Concurrent #1666 recovery work is not a dependency or an assumed shipped capability. No production, accepted SPEC, DESIGN or user-flow file changes here.

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

Through 759px, a full-width house-style Button labelled **Sections · Projects**
(or the current section) appears below the page header. It uses `aria-expanded` and `aria-controls` for one labelled navigation list. Opening it exposes all nine
ordinary links in document flow, with 44px minimum targets; activating a link navigates
immediately and closes it on arrival. It does not navigate on arrow keys or require
Go. The current section remains visible when closed. At short heights, the document
scrolls; no overlay traps focus or covers settings. Keep the global navigation
drawer distinct from this local section disclosure. At 760px the local list becomes persistent; the global drawer still applies through 1120px. Use one navigation tree, not hidden duplicate links. On resize, move focus to the current link if the trigger disappears, or to the trigger before hiding a focused list. The native button supplies Enter/Space; links use Tab/Shift-Tab and Enter without menu roles or arrow-key routing.

On new section navigation, move focus to the destination heading and start at the top;
Back/Forward restores the entry's saved position. Readiness-check and Add Claude
links instead focus their target heading once its resource is ready. Preserve
existing draft and command-outcome semantics when moving between pages: unfinished
input stays in the shared draft store; failed saves keep input; navigation never
saves or discards credentials implicitly. Section Refresh refreshes its mounted resources alongside the existing shared-shell refresh.
Loading, retry and stale/read-only states remain local to the affected content.

A delayed check/Add Claude target may land once for that navigation identity after its own read succeeds. Initial loading shows no fabricated values; an initial failure shows Unavailable/Retry and does not consume the pending target. Retry may complete the original landing, unless the reader has moved focus, typed, touched or scrolled in the meantime. Then retain their position and leave the check reachable normally. A successful response without a known requested check leaves the page heading/content; no endless wait. A stale prior response remains visibly stale, with failure/retry, and cannot stand in for a fresh target result. Background refresh never steals focus. Back/Forward saved scroll/focus takes precedence even if a target renders later; never reuse another URL's copied history state. Preserve the shell's authentication scope and entry URL/key when replacing legacy/root URLs, rather than restoring private focus across sign-out.

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

The gallery also links annotated initial-loading, failed-read/Retry and delayed-check variants. Their timer and Retry change illustrative fixtures only. The mockup uses query URLs and ordinary document navigation; it does not register production routes, perform reads, run checks or request notification permission. The global drawer is a shell illustration, not a second implemented navigation flow.

For fresh Chromium evidence, run the existing helper with `CAB_TEST_EVIDENCE_DIR` set to an absolute, real directory beneath `.scratch/issue-1581-evidence/r1/` (for this delivery: `test-diagnostics`). Missing, relative, symlink-escaped and other-revision paths are rejected before browser launch. Captures never write into `design/`. Source-relative gallery links remain reviewable without generated PNGs. The font files use existing dependencies after `npm ci`, with system-font fallback.

Fresh Chromium qualification produced and visually inspected 25 captures: six desktop/phone frames (three pairs), Readiness in light and dark at 390×480, 800×768, 1024×768 and widths 759/760/1119/1120/1121, plus loading/error/delayed-target variants. All mockup assertions passed: one h1/current link, matching crumb, ordinary link/Back navigation, heading focus, Enter/Space disclosure, Tab/Shift-Tab order, hidden-link exclusion, resize focus, touch activation, 44px disclosure/link targets, overflow and zero page errors. `node --check`, typecheck, lint, format and the design-only diff checks passed. The output guard rejected missing/relative/outside-revision/source/symlink destinations before launch.

This is prototype evidence, not production qualification. Production route/legacy 308/sign-in integration, real read isolation/cancellation/stale handling, saved cab history/focus, Add Claude and command reconciliation remain later implementation evidence. No screen reader/VoiceOver, physical touch device, Firefox or WebKit pass is claimed; no macOS WebKit was run. The headless touch check uses Chromium emulation. The prototype's browser Back check verifies navigation, not cab's private history restoration. The global drawer remains an inert illustration. The controller's final-head CI and external review gates remain separate from these local checks.

## Route table

All destinations below are proposed. Existing detail URLs remain supported.
Legacy rewrites use client-side `replaceState`, before section resources mount:
URL fragments never reach the server, so an HTTP redirect alone cannot do this.
Preserve unrelated query parameters. A rewrite must not add a Back-button loop.

| Current section or entry | Canonical destination | Compatibility / entry-point change |
| --- | --- | --- |
| `/settings` (no recognised fragment) | `/settings/readiness` before first turn; `/settings/projects` otherwise | Workspace-based resolver above; generic Settings entries in the account menu and shell can keep `/settings` |
| Deleted project's **Projects** return (`DeletedProject` in `project-lifecycle.tsx`) | `/settings/projects` | Change the current `/settings` literal to the concrete Projects route, including before the first turn |
| Projects; `/settings#projects` | `/settings/projects` | `settingsSectionHref("projects")`; project setup return; project detail and create crumbs |
| Runtime summary; `/settings#runtime` | `/settings/runtime` | `settingsSectionHref("runtime")`; remove summary step |
| Agents; `/settings#profiles` | `/settings/agents` | `settingsSectionHref("profiles")` keeps internal id; profile-config return and agent crumbs |
| Routing; `/settings#routing` | `/settings/routing` | Each row still links `/projects/:id/settings?tab=routing` |
| GitHub discovery; `/settings#github-discovery` | `/settings/github-discovery` | Project setup and Getting started links |
| GitLab credentials; `/settings#gitlab-credentials`, including literal `delivery-config.tsx` link | `/settings/gitlab-credentials` | Preserve host credential controls |
| CLI credentials; `/settings#cli-credentials` | `/settings/cli-credentials` | Preserve issue/rotate/revoke controls |
| Notifications; `/settings#notifications` | `/settings/notifications` | Change `operator-push.ts` payload for future notifications; rewrite already-delivered URLs indefinitely |
| Readiness; `/settings#readiness` | `/settings/readiness` | `wait-fix-href`, Getting started and `settingsSectionHref("readiness")` |
| `/settings#readiness-<known check id>` | `/settings/readiness#readiness-<check id>` | `readinessCheckHref`; wait for check render, then focus and scroll its heading |
| `/app/settings#…`, `/app/settings/runtime#add-claude`, `/app/projects/:id/settings?tab=…` | Root path/query via existing 308, then browser fragment translation | Preserve fragments through redirect and unauthenticated sign-in/return; retain same-origin safeguards and do not turn `/app//…` into an external redirect |
| Task, project, delivery, source-import, composer and wait-fix detail links | Existing `/projects/:id/settings?tab=…#…` and `/profiles/:id/settings` | Keep exact identity, query/tab aliases and source-readiness/status-mapping anchors; only ancestor navigation changes |
| `/settings/runtime` and hard-coded runtime links | unchanged | `app.tsx` back target, `setup-model.ts`, Getting started, runtime-restart copy and recovery crumbs remain valid |
| `/settings/runtime#add-claude` | unchanged | Preserve Add Claude target and delayed-resource focus |
| `/settings/projects/new` | unchanged | Normal crumb: Settings → Projects (link) → Create project; first-project exception preserved |
| `/settings/profiles/new` | unchanged | Settings → Agents (link) → Create agent; do not rename this existing URL |
| `/profiles/:id/settings` | unchanged | Settings → Agents (link) → agent name |
| `/projects/:id/settings?tab=…` | unchanged | Settings → Projects (link) → project → selected tab |
| `/assignments/:id/recovery` | unchanged | Settings → Runtime (link) → Assignment recovery |
| Unknown or malformed `/settings#…` | normal `/settings` landing, remove unsupported fragment | No arbitrary element selection or decode exception; unknown check ids have no focus target |
| Unknown `/settings/:section` | existing not-found page | Do not silently alias misspelled paths |

All 11 known readiness ids from [`src/operator/readiness.ts`](../../src/operator/readiness.ts) remain stable: `runtime-enabled`, `codex-executable`, `codex-login`, `git`, `github-discovery`, `claude-executable`, `claude-token`, `runtime-harness`, `skill-plugins`, `data-paths`, `gitlab-credentials`. In particular, the historical `claude-token` id now describes native login; do not rename compatibility ids to fit current labels.

Phone Back is a parent link, distinct from browser Back. Propose Settings for a section page, Projects for normal project create/detail, Agents for agent create/detail and Runtime for assignment recovery. Keep the first-project Overview return. Concrete ancestor crumbs preserve these same destinations; final crumbs stay text. Generic Settings uses the root resolver, while a Projects-labelled return must open Projects even before the first turn. Later tests must cover both account-menu surfaces and direct load/reload/sign-in, not only intercepted clicks.

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

Shared App reads are session bootstrap, workspace, task list, Inbox summary outside Inbox, and authenticated live updates. They are not section fan-out and are not a zero-request promise. Header Refresh retains existing shared refresh plus the mounted page's hooks; no hidden section subscribes. Action-time rereads (Runtime confirmation preflight, credential list reconciliation, recovery-options evidence) remain attached to their actual action, not eager section entry. Runtime assignment detail additionally reads its task/evidence; it does not cause all assignment evidence to load on the section page.

Initial resource states `empty`/`loading` show loading, not empty-success data. A failure without data is error/Retry. Refresh with prior data is stale/pending; a failed refresh keeps prior data visibly stale with error. Existing `ResourceController` abort/generation fencing and authentication scope must continue to reject late replies and clear unauthenticated data. Per-project configuration failures stay independent, with Retry for that project; the four-worker bound covers Projects and Routing. Source-observation failure is Unavailable, never fabricated “Not synced”. Runtime hold information remains attributed to its read; missing/stale runtime evidence must not be presented as a confirmed zero holds.

`ConfigurationDrafts` remains App-owned: preserve editing, rejection/conflict, sending, recorded and unknown outcomes across section navigation. An unknown command keeps its original frozen request identity and reconciliation action; remounting must not create a second send or imply a save succeeded. Discovery's cross-surface unsettled-save hold remains effective between Readiness and discovery. Private reveals remain session/owner-scoped and abort on departure; one-time CLI issuance secrets stay session-only, with no new persistence guarantee. Navigation neither sends nor discards a draft, clears an execution/source hold, changes approval policy nor widens repository access.

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
   (including unauthenticated sign-in return). Create, archive and delete a project
   before any turn starts, then follow its Projects return: assert Projects opens
   rather than the generic Readiness landing.
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

## Proposed foundation wording

Proposed addition to `design/DESIGN.md`, **only after explicit acceptance and later implementation**:

> Global Settings uses a stable nine-link section navigation. Desktop content retains the 176px local column within the existing 232px/48px shell. Through 759px a house Button exposes the same ordinary links inline, reports expanded state, and keeps the current section visible while closed. At 760px local links remain visible; the global drawer threshold stays 1120px. Phone controls retain 44px targets. Section route, page title, current link, ancestor crumbs and parent Back agree. New navigation focuses its heading; saved browser-history restoration and reader interaction take precedence over delayed target landing.

This changes navigation composition, not tokens, typography, colour, global drawer or density foundations. It is proposed text, not a change to the accepted foundations. Fixtures keep compact panels, 13px body text and visible state words; no form redesign or unrelated copy programme is included. Throwaway artboards can be discarded or reverted if the recommendation is rejected, with no production records affected.

## Maintainer decisions

The recommendation remains open for explicit design acceptance:

| Choice | Recommendation and credible alternative | Consequence for later work |
| --- | --- | --- |
| Grouping | Keep nine sections. Combining the three credentials saves two rows but mixes authority/lifecycles and eager reads; combining Projects/Routing saves one row but hides the cross-project routing directory or expands Projects' concern. | Grouping changes composition, loader allocation and compatibility destinations; medium estimate may increase. |
| Runtime | Open the existing page directly. Retaining a summary keeps a shorter glanceable entry but adds a click and an additional runtime-read consumer. | Direct reuse is the smaller medium slice; summary needs its own evidence. |
| Root | Workspace-based Readiness iff turnStarted is false; otherwise Projects, including successful unknown state. Initial failure remains Retry. A link-only overview avoids choosing a default but adds an interaction and screen. | Overview adds a page; neither alternative permits a failure-to-empty inference or background redirect. |
| Phone | House Button plus inline ordinary links. Always-visible wrapped links remove the reveal tap but push content down; a house Sheet/drawer saves vertical space but adds overlay/focus/Back interactions alongside global navigation. Native details/summary is simpler HTML but navigation announcements vary across browser/AT combinations. | A drawer materially expands focus and history validation; inline disclosure is bounded. |
| Order | Stable Projects → Runtime → Agents → Routing → GitHub discovery → GitLab credentials → CLI credentials → Notifications → Readiness. Readiness first is a landing choice, not a reorder. | Dynamic order recreates displacement/focus work; keep the medium slice bounded. |
| Crumbs and Back | Link concrete ancestor sections; final crumb is text. Parent Back follows that hierarchy; browser Back restores its own entry. An alternative generic Settings parent is simpler but may resolve to a different section before first turn. | Concrete parents need focused header/Back tests; no existing create/detail URL rename. |
| Foundations | Accept the proposed wording above only with the navigation choices. Alternative: retain current long-index foundation and reject these artifacts. | No accepted DESIGN/SPEC/user-flow edit until later authorized implementation. |

The four later increments require explicit design acceptance and a separately authorized implementation contract. They are not four mandated PRs, new issues or elapsed-time promises. This proposal can be revised or rejected; merging its artifacts does not record a choice, close #1581 or start production work.
