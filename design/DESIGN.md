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

A dense dark workbench for one trusted operator: obsidian surfaces separated by
hairlines, tonal depth instead of shadows, one indigo accent, and compact rows with
monospaced identifiers. Calm surfaces, clear decisions: the next decision and its
evidence get the space; navigation metadata stays quiet.

State colour supports meaning and never carries it alone. Every state badge pairs a
symbol and a word with its colour. Colour never establishes repair ownership,
delivery or operator attention on its own; running does not imply a repair owner,
and provider closure is never shown as success.

The UI is dark only; a user-facing theme switch is not designed.

## Tokens

[`web/src/tokens.css`](../web/src/tokens.css) defines the tokens as CSS custom
properties and maps the shadcn names onto them. Keep this table in step with it.

| Token | Value | Purpose |
| --- | --- | --- |
| `--bg` | `#090A0F` | Page ground, inputs, segmented-control track |
| `--surface` | `#0D0F17` | Sidebar, panels, lists, cards, sticky bars |
| `--raised` | `#151824` | Row hover, secondary buttons, evidence and excerpt blocks |
| `--overlay` | `#1E2235` | Selection, menus, dialogs, active tab |
| `--line`, `--line-strong` | `#23283B`, `#2A3047` | Hairline separators; control and card borders |
| `--fg`, `--fg-2`, `--fg-3` | `#F1F5F9`, `#A6B0C3`, `#8390A6` | Primary, secondary and muted text (muted is at least 5.4:1 on `--raised`) |
| `--accent-fill` (shadcn `--primary`) | `#4F46E5` | Primary action fill, white text (6.3:1) |
| `--accent-edge` | `#6366F1` | Selected-row left edge |
| `--accent-text` | `#A5B4FC` | Links, running state text, selection marks |
| `--focus` | `#818CF8` | 2px focus outline with 2px offset |
| `--attn`, `--attn-soft`, `--attn-border` | `#FBBF24`, amber 12%, amber 35% | Attention: questions, approvals, "Next: you" |
| `--risk`, `--risk-soft`, `--risk-border` | `#FB7185`, rose 12%, rose 38% | Uncertain execution, interventions, confirmed failures, destructive actions, field errors |
| `--ok`, `--ok-soft`, `--ok-border` | `#34D399`, emerald 12%, emerald 32% | Completed results, recorded answers, confirmed saves |
| `--idle`, `--idle-soft`, `--idle-border` | `#A6B0C3`, slate 14%, slate 35% | Waiting, paused, queued, capacity, ready, stopping, stopped, cancelled, provider closed, unknown |

The cab identity is an amber taxi roof sign. Shared shell and sign-in branding
use the flat 20 × 20px symbol beside a readable cab label; the symbol is decorative.
The desktop top bar adds the compact lockup before its breadcrumb, separated by
a hairline. The navigation drawer carries the same identity. The illuminated
full-word sign belongs to the README hero; the dedicated favicon uses the roof
silhouette and c without illumination. Amber retains its attention meaning in
state badges: identity uses silhouette and label, while states use a bordered
badge with a symbol and a word.

Project identity uses a small square dot per project (Atlas indigo, Relay teal,
Fieldnotes violet); it is never a state colour.

Code, diff and evidence views use local values: editor ground `#0B0D14`; hunk header
indigo 10% with `#A5B4FC` text; added lines emerald 12% with `#6EE7B7`; removed lines
rose 12% with `#FDA4AF` (20% when selected, with a 2px `--focus` inset edge); line
numbers `#7C879B`. Diff colour always pairs with `+`/`−` markers and Before/After
labels.

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
| Primary button | `--accent-fill` fill, white text, 1px white 12% border; one per view |
| Secondary button | `--raised` fill, `--line-strong` border |
| Destructive button | rose-tinted fill and border with `--risk` text, never solid red |
| Panels, cards, dialogs | 8px radius, 1px `--line` border, `--surface` fill; header row separated by a hairline |
| Evidence blocks, chips | `--raised` fill, 6px radius |
| Keyboard keys | 18px high, 4px radius, `--bg` fill, mono 11px |
| Selection in lists | `--overlay` fill plus a 2px `--accent-edge` left edge; tabs use a 2px underline |
| Menus and dialogs | `--overlay` with one shadow, `0 8px 24px rgba(0,0,0,0.5)` |

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
  delivery forms and Sign out live in the account menu. Main content uses 20px padding and 12–16px gaps; multi-pane screens
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

Rules:

- Project and permitted-assignee fields are selects. Task lists are tables;
  assignments are table rows that disclose their history. Grouped multi-select
  questions use checkboxes, single-choice questions radios. Labels, descriptions,
  selected values, validation messages and response controls remain explicit.
- Phone screens use one of two headers: top-level (menu, title, count badge, one
  icon or outline action) or detail (back with the parent label, centred title and
  mono subtitle, at most one outline action).
- Use a navigation row for anything that only opens another view. Keep buttons for
  actions, with one primary action per view. Desktop buttons hug their label.
- Stop uses the destructive treatment and confirms first; reversible states show
  their counterpart (for example Restore profile).
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
- **Task detail:** prioritise outcome, current situation/next actor, unresolved
  decisions and evidence. Disclose assignments and captured history underneath,
  retaining the task's accountable lead and assignment/conversation identities.
  Use recorded facts and attributed excerpts; add no invented summary capability.
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
