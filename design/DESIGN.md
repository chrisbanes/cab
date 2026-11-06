# cab UI design foundations

The visual foundations of the cab operator web UI: direction, tokens,
typography, layout, shared components and interaction guidance. Shipped screens are
defined by the web app (`web/src/`) and its browser journey tests; this document
holds the rules that apply across them. Explore new screens in any tool; those
artboards are throwaway and are not maintained once a screen ships.

[SPEC.md](../docs/SPEC.md#operator-interface-and-human-requests) owns product
behaviour, [acceptance.md](../docs/acceptance.md#operator-ui-scenarios) owns required
evidence, and GitHub issues own delivery scope. Resolve conflicts in favour of those
contracts.

## Visual direction

A dense workbench for one trusted operator, in dark and light: obsidian or paper
surfaces separated by hairlines, tonal depth instead of shadows in both themes, a
black-and-white accent, and compact rows with
monospaced identifiers. Calm surfaces, clear decisions: the next decision and its
evidence get the space; navigation metadata stays quiet.

State colour supports meaning and never carries it alone. Every state badge pairs a
symbol and a word with its colour. Colour never establishes repair ownership,
delivery or operator attention on its own; running does not imply a repair owner,
and provider closure is never shown as success.

## Themes

The operator offers three theme choices: System (the default), Light and Dark.
System follows `prefers-color-scheme` and tracks live OS changes. The active theme
is the `dark` class on `<html>` (always set for dark, including under System), with
light values on `:root`; `color-scheme` matches so native controls and scrollbars
follow. `web/src/main.tsx` resolves the theme before the first render, because the
operator CSP allows no inline script. The choice is a per-browser preference in
`localStorage` (`cab.theme.v1`; only Light or Dark is stored). It has no server
or cross-device state, applies only to the app, and other open tabs pick it up on
their next load. It is offered in the sidebar account menu (a Theme group of three
radio items) and in the phone drawer's account rows (three pressed-state buttons);
the active choice carries a check as well as its checked or pressed state.

## Tokens

[`web/src/tokens.css`](../web/src/tokens.css) defines the tokens as CSS custom
properties and maps the shadcn names onto them. Keep this table in step with it.

| Token | Dark | Light | Purpose |
| --- | --- | --- | --- |
| `--bg` | `#0A0A0B` | `#FFFFFF` | Page ground, inputs, segmented-control track |
| `--surface` | `#0F0F11` | `#FAFAFA` | Sidebar, panels, lists, cards, sticky bars |
| `--raised` | `#17171A` | `#F4F4F5` | Row hover, secondary buttons, evidence and excerpt blocks |
| `--overlay` | `#202024` | `#ECECF0` | Selection, menus, dialogs, active tab |
| `--line` | `#26262B` | `#E4E4E7` | Hairline separators |
| `--line-strong` | `#2E2E34` | `#D4D4D8` | Control and card borders |
| `--fg` | `#F4F4F5` | `#18181B` | Primary text |
| `--fg-2` | `#A6A6AE` | `#52525B` | Secondary text |
| `--fg-3` | `#8E8E97` | `#60606A` | Muted text (at least 5.5:1 on `--raised` in both themes) |
| `--accent-fill` | `#F4F4F5` | `#18181B` | Primary action fill (shadcn `--primary`) |
| `--primary-foreground` | `#0A0A0B` | `#FAFAFA` | Primary action text (about 17:1) |
| `--accent-edge` | `#E4E4E7` | `#27272A` | Selected-row left edge, selected tab underline |
| `--accent-text` | `#E4E4E7` | `#27272A` | Links, Not started state text, selection marks |
| `--accent-border` | `#E4E4E766` | `#27272A66` | Accent-tinted borders |
| `--accent-soft` | `#E4E4E71F` | `#27272A14` | Not started state fill |
| `--accent-soft-border` | `#E4E4E759` | `#27272A40` | Not started state border |
| `--focus` | `#E4E4E7` | `#18181B` | 2px focus outline with 2px offset |
| `--attn` | `#FBBF24` | `#8A3B0C` | Attention text: questions, approvals, "Next: you" |
| `--attn-soft` | `#FBBF241F` | `#D9770624` | Attention fill |
| `--attn-border` | `#FBBF2459` | `#D9770673` | Attention border |
| `--risk` | `#FB7185` | `#A8123A` | Uncertain execution, interventions, confirmed failures, destructive actions, field errors |
| `--risk-soft` | `#FB71851F` | `#E11D481A` | Risk fill |
| `--risk-border` | `#FB718561` | `#E11D4873` | Risk border |
| `--run` | `#7CC7B2` | `#0B5D73` | Running work; cooler and quieter than `--ok` |
| `--run-soft` | `#7CC7B21F` | `#0891B21F` | Running fill |
| `--run-border` | `#7CC7B259` | `#0891B273` | Running border |
| `--ok` | `#34D399` | `#05664A` | Completed results, recorded answers, confirmed saves |
| `--ok-soft` | `#34D3991F` | `#0596691F` | Completed fill |
| `--ok-border` | `#34D39952` | `#05966973` | Completed border |
| `--idle` | `#A6A6AE` | `#4B4B54` | Waiting, paused, queued, capacity, ready, stopping, stopped, cancelled, provider closed, unknown |
| `--idle-soft` | `#A6A6AE24` | `#71717A1F` | Idle fill |
| `--idle-border` | `#A6A6AE59` | `#71717A73` | Idle border |
| `--menu-shadow` | `0 8px 24px rgba(0, 0, 0, 0.5)` | `0 8px 24px rgba(0, 0, 0, 0.12)` | The one menu and dialog shadow |

State text over its soft fill is at least 4.5:1 on the page ground and on every
surface in both themes; light state text is darker than the dark theme's so amber,
rose, mint and emerald stay legible on a light ground, and run and ok stay apart by
hue as well as by symbol and word.

The cab identity is an amber taxi roof sign. Shared shell and sign-in branding
use the flat 20 × 20px symbol beside a readable cab label; the symbol is decorative.
The desktop top bar adds the compact lockup before its breadcrumb, separated by
a hairline. The navigation drawer carries the same identity. The illuminated
full-word sign belongs to the README hero; the dedicated favicon uses the roof
silhouette and c without illumination. Amber retains its attention meaning in
state badges: identity uses silhouette and label, while states use a bordered
badge with a symbol and a word.

Project identity uses a small square dot per project, coloured from `--accent-text`,
`--fg-2` and `--fg-3`; it is never a state colour.

Code, diff and evidence views take their colours from the tokens in both themes:
added lines mix `--primary`, removed lines mix `--destructive`, and hunk headers,
excerpts and line numbers use `--muted` and `--fg-3`, so they follow the active
theme. Diff colour always pairs with `+`/`−` markers and Before/After labels.

### Typography, spacing and shape

Geist supplies interface text; Geist Mono identifies IDs, hashes, times, paths,
counts and code. Page titles are 18/600 and task titles 20/600; section headings
15/600; task and request titles 14/500; body, rows and controls 13; request prose
14; metadata and badges 12; section labels 11 uppercase with 0.04em tracking in
`--fg-3`; code 12–13 Geist Mono with `white-space: pre` on each code line.
Identifier-heavy provenance (R2 · A-105 · 8d31c4a) is 12px muted metadata below the
plain-language state, never the headline.

| Element | Treatment |
| --- | --- |
| Badges | 20px high, 4px radius, soft fill + border + text in the state colour, symbol + word |
| Buttons, inputs, selects | 30–32px desktop, 6px radius, 10–12px side padding; phone 44px |
| Primary button | `--accent-fill` fill, `--primary-foreground` text, 1px white 12% border; one per view |
| Secondary button | `--raised` fill, `--line-strong` border |
| Destructive button | rose-tinted fill and border with `--risk` text, never solid red |
| Panels, cards, dialogs | 8px radius, 1px `--line` border, `--surface` fill; header row separated by a hairline |
| Evidence blocks, chips | `--raised` fill, 6px radius |
| Keyboard keys | 18px high, 4px radius, `--bg` fill, mono 11px |
| Selection in lists | `--overlay` fill plus a 2px `--accent-edge` left edge; tabs use a 2px underline |
| Menus and dialogs | `--overlay` with `--menu-shadow` |

Spacing follows a 4px rhythm (4, 8, 12, 16, 20, 24, 32). Status icons supplement
visible state words; treat them as decorative when adjacent text conveys the
meaning.

## Layout and responsive composition

Review layouts at desktop 1366 wide (at least 768 high), phone 390 × 844, tablet
1024 × 768 or 800 × 768, and short phone 390 × 480. These are review viewports, not
fixed application dimensions.

- **Shell:** a 232px sidebar (cab mark, installation name, Search work field
  with ⌘K, Overview, Inbox with an amber count, Tasks, the projects list with
  activity meta, a capacity meter and the account menu), a 48px top bar
  (breadcrumb, connection status — Connected, Updates delayed or Disconnected — and
  New task with its key), then the page. Settings, Getting started, Approval and
  delivery forms, the Theme choice and Sign out live in the account menu. Main content uses 20px padding and 12–16px gaps; multi-pane screens
  run panes edge to edge with hairline dividers.
- **Breakpoints:** the production shell uses the navigation drawer through 1120 CSS
  pixels; the browser test checks 1119, 1120 and 1121px as well as 759, 760 and
  800px. Tablet widths show the drawer behind a 44px Open navigation button in the
  top bar. This shell breakpoint does not qualify task-row, Inbox or reading
  layouts by itself. Phone controls accommodate touch, keyboard and safe-area space
  without covering content.

## Shared components

| Component | Use |
| --- | --- |
| Sidebar | Every desktop screen: navigation, projects, capacity and the account menu |
| Top bar | Every desktop screen: breadcrumb, connection status and New task |
| Foundations and controls (`web/src/ui/`) | Buttons, fields, selects, badges, cards, dialogs, sheets and alerts |
| Domain components | Request row, board card, source identity chip, execution blocker, recorded response, structured answers, phone headers, navigation row, column tabs |
| Action feedback | Success line, Details toggle and panel, warning and destructive alerts |
| Compact progress | Task progress across Overview, List, Board and Inbox entry points |
| Review components | Criterion rows and local-feedback context |
| Inspection components | Observation strip, selectable code line, editor row with separate gutter, marker and source |
| Conversation components | Pinned attention card (phone: one-line banner), agent text with raw-text view, tinted operator message, request and result cards, grouped tool row with per-command output, file-change row, delegation sub-conversation, gap marker, composer, Jump to latest |

Rules:

- Project and permitted-assignee fields are selects. Task lists are tables;
  assignments are table rows that disclose their facts. Grouped multi-select
  questions use checkboxes, single-choice questions radios. Labels, descriptions,
  selected values, validation messages and response controls remain explicit.
- Phone screens use one of two headers: top-level (menu, title, count badge, one
  icon or outline action) or detail (back with the parent label, centred title and
  mono subtitle, at most one outline action).
- Use a navigation row for anything that only opens another view. Keep buttons for
  actions, with one primary action per view. Desktop buttons hug their label.
- Stop uses the destructive treatment and confirms first; reversible states show
  their counterpart (for example Restore agent).
- Task lead names and accountability remain visible wherever a task appears.

## Operator refinement brief

Make the next decision obvious, and keep its evidence close:

- **Attention:** show the specific decision/intervention, requester when known,
  reason the operator is needed and available response. Keep relevant evidence
  close. Use consistent meaning across Overview, Inbox, List/Board and task detail.
- **Work views:** distinguish work state, next actor and attention without changing
  the existing board mapping. A running agent alone is insufficient evidence of a
  repair. Show unknown responsibility honestly. Keep readiness, completed work,
  cancellation and provider closure without delivery distinguishable.
- **Task detail:** the Overview is the task's conversation. Pin what is waiting on
  the operator above it, keep outcome and next actor in the header, and put the
  brief, evidence and assignments in the inspector. Delegations read as collapsible
  sub-conversations in place, retaining the task's accountable lead and
  assignment/conversation identities. Use recorded facts and attributed excerpts;
  add no invented summary capability.
- **Composer:** keep project, title and outcome prominent; disclose optional
  context, references, assignee and dependencies with a summary of supplied values.
  Preserve validation, drafts and truthful creation/admission feedback.
- **Readability:** give task meaning and the immediate next step more space than
  repeated navigation metadata. Keep titles distinguishable and supporting text
  readable. Retain semantic state meanings and readable typography.

The UI preserves exact approval material, source ownership, Stop/Resume
limits and command-outcome semantics. It adds no agent/provider selection,
attachments, terminal, browser, runtime or remote-write capabilities. This is a
presentation brief, not a delivery plan.

## Interaction guidance

Apply the exact state and permission rules from SPEC.md. These are presentation
details:

- Retain filters, selected request, scroll anchor, expanded groups and unfinished
  input while updates arrive. Follow new messages only when already at the bottom;
  otherwise provide New updates / Jump to latest.
- After a confirmed Inbox answer or decision, keep a confirmation visible instead
  of automatically selecting the next request. Failed submissions retain input.
- Recommended/preselected question options are not submitted answers. Show pending,
  recorded, failed, stale, cancelled, already answered, offline and unsupported
  interactions distinctly. Unsupported requests remain unresolved without a blind
  retry or conversion to ordinary chat.
- Every question action reads Answer question, in Overview, Inbox, List/Board and
  task detail; the question text carries the specifics.
- Distinguish Message lead, response to a specific question, approval of an exact
  action and Post comment to GitHub. Show destinations and persistence outcomes.
- Preserve source snapshots on failed refresh, showing last successful sync. A
  confirmed comment receipt does not mean the source snapshot was refreshed.
- Present Ready-but-blocked work honestly. No automatic GitHub writes are depicted.
- Keep visible keyboard focus, selection constraints and errors beside the affected
  question. Radio groups move with the arrow keys, Space selects, and a failed
  submission focuses the first invalid field.

### Entry points and return behaviour

- Overview, project/cross-project List and Board share the compact facts and task
  detail. Back restores filters, selection and position; Board also restores its
  column.
- Inbox enters at the relevant request and returns to that queue item, keeping its
  request anchor, queue filters, selected item and position. Task → inspection does
  not answer the request.
- Direct task entry retains project/source context, with the task's project as
  fallback when there is no in-session origin.
- Search is in the shared desktop sidebar and the phone header. Back through a
  journey restores the previous section and reading anchor.
- Existing pending-request access, exact-material approval, Deny and Leave pending
  flow, Execution, Stop and recovery remain reachable from every task view.
  Independent source and execution holds remain independent of approval, checks
  and merge.
- No context-menu, extension or deep-link surface is designed. The one notification
  surface is the opt-in browser notification controlled in Settings → Notifications;
  it opens the Inbox and never changes a task. Native Codex/ChatGPT work is
  outside this design.
