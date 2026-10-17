/** Pure presentation for the settings routes: headers, index lines, saved lines and holds. */
import {
  selectionCountsText,
  zeroMatchWarning,
} from "../../src/operator/readiness-text.js";
import { sourceCredentialExplanation } from "../../src/operator/source-credential.js";
import { sourceStateSentences } from "../../src/operator/github-reasons.js";
import { clockLabel, codeSentence } from "./presentation.js";
import type { z } from "zod";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  type LucideIcon,
} from "lucide-react";
import type {
  CommandReceipt,
  OperatorCommand,
  sourceObservationSchema,
  Workspace,
} from "../../src/operator/contracts.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import type { SavedRecord } from "./settings-state.js";

export interface Crumb {
  label: string;
  href?: string;
}
export interface SettingsHeader {
  title: string;
  trail: Crumb[];
  shortTitle?: string;
}
export const projectTabs = [
  { id: "general", label: "General" },
  { id: "routing", label: "Routing" },
  { id: "github", label: "GitHub source" },
  { id: "sync", label: "Sync & placement" },
] as const;
export type ProjectTab = (typeof projectTabs)[number]["id"];
export function projectTab(query: string): ProjectTab {
  const tab = new URLSearchParams(query).get("tab");
  return projectTabs.find((t) => t.id === tab)?.id ?? "general";
}

const settings: Crumb = { label: "Settings", href: "/app/settings" };

/** Title and breadcrumb trail of a settings route, or null for other routes. */
export function settingsHeader(
  pathname: string,
  query: string,
  workspace: Workspace | null,
): SettingsHeader | null {
  if (pathname === "/app/settings") return { title: "Settings", trail: [] };
  if (pathname === "/app/settings/projects/new")
    return workspace?.data.projects.length === 0
      ? {
          title: "Set up your first project",
          trail: [
            { label: "Overview", href: "/app" },
            { label: "New project" },
          ],
        }
      : {
          title: "Create project",
          trail: [settings, { label: "Projects" }, { label: "Create project" }],
        };
  if (pathname === "/app/settings/runtime")
    return {
      title: "Runtime capacity and recovery",
      trail: [settings, { label: "Runtime" }],
    };
  if (pathname === "/app/settings/profiles/new")
    return {
      title: "Create profile",
      trail: [settings, { label: "Profiles" }, { label: "Create profile" }],
    };
  if (/^\/app\/assignments\/[^/]+\/recovery$/.test(pathname))
    return {
      title: "Assignment recovery evidence",
      shortTitle: "Recovery",
      trail: [
        settings,
        { label: "Runtime", href: "/app/settings/runtime" },
        { label: "Assignment recovery" },
      ],
    };
  const profile = /^\/app\/profiles\/([^/]+)\/settings$/.exec(pathname)?.[1];
  if (profile) {
    const name =
      workspace?.data.profiles.find((p) => p.id === profile)?.name ?? "Profile";
    return {
      title: `${name} · profile configuration`,
      trail: [settings, { label: "Profiles" }, { label: name }],
    };
  }
  const project = /^\/app\/projects\/([^/]+)\/settings$/.exec(pathname)?.[1];
  if (project) {
    const name =
      workspace?.data.projects.find((p) => p.id === project)?.name ?? "Project";
    const tab = projectTab(query);
    const page = `/app/projects/${project}/settings`;
    return {
      title: `${name} · project configuration`,
      trail: [
        settings,
        { label: "Projects" },
        tab === "general" ? { label: name } : { label: name, href: page },
        ...(tab === "general"
          ? []
          : [{ label: projectTabs.find((t) => t.id === tab)?.label ?? "" }]),
      ],
    };
  }
  return null;
}

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const receiptVersion = (receipt: CommandReceipt) =>
  receipt.kind === "configuration" && "version" in receipt.result
    ? receipt.result.version
    : null;

/** "Saved 10:52" for a save this session recorded at the current version, else nothing: a version is never shown. */
export function savedLine(version: number, saved: SavedRecord | undefined) {
  return saved && receiptVersion(saved.receipt) === version
    ? `Saved ${clock(saved.at)}`
    : null;
}

const tasksNotImported = "Tasks aren't imported until you refresh sources.";

/**
 * The sentence after "Preview and activate selection". It claims only what a confirmed
 * `github.preview` receipt at the loaded source version proves; `null` means say nothing.
 * Once the form has been re-read (`recorded` is false), the read must also show the
 * selection active. `refresh` is true when the line names the next step, so the page
 * offers it.
 */
export function activationLine({
  saved,
  sourceVersion,
  selections,
  recorded,
  name,
}: {
  saved: SavedRecord | undefined;
  sourceVersion: number;
  selections: { id: string | null; active: boolean }[];
  recorded: boolean;
  /** What the operator calls the source with this id (never its S-n id). */
  name: (id: string) => string;
}) {
  const r = saved?.receipt;
  if (
    r?.kind !== "configuration" ||
    r.result.commandType !== "github.preview" ||
    r.result.configVersion !== sourceVersion
  )
    return null;
  const id = r.result.selectionId,
    what = name(id);
  if (!recorded && !selections.some((s) => s.id === id && s.active))
    return {
      line: `Couldn't confirm that ${what} is active. Preview it again.`,
      refresh: false,
    };
  // The receipt records the prior state; one from before it was recorded says nothing.
  const { alreadyActive } = r.result;
  const state =
    alreadyActive === undefined
      ? `${what} is active.`
      : alreadyActive
        ? `${what} was already active.`
        : `Activated ${what}.`;
  return { line: `${state} ${tasksNotImported}`, refresh: true };
}

/** "Ada", "Ada and Eli", "Ada, Eli and Bo". */
export const joinNames = (names: string[]) =>
  names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? "");

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

type Observations = z.infer<typeof sourceObservationSchema>["data"];
type Observation = Observations["projects"][number]["selections"][number];

/** Badge text for one selection's source observation. */
export function observationLabel(o: Observation | undefined) {
  if (!o) return "Not synced";
  if (o.state === "complete")
    return o.lastSuccessfulAt
      ? `Synced ${clockLabel(Date.parse(o.lastSuccessfulAt))}`
      : "Synced";
  if (o.state === "partial") return "Partial";
  if (o.state === "never") return "Not synced";
  return "Sync unknown";
}

/**
 * One sentence for a source's last read: the state, the app's clock label and the counts the
 * read observed. "Not synced yet" when it was never read or has no row; a state the app does
 * not know reads as the unreadable sentence. Never an ISO time or the word "unavailable".
 */
export function sourceStatusLine(
  o: Observation | undefined,
  rule: Observations["projects"][number]["readiness"],
) {
  const lead = codeSentence(
    o?.state ?? "never",
    sourceStateSentences,
    sourceStateSentences.unavailable,
  );
  if (!o || (o.state !== "complete" && o.state !== "partial")) return lead;
  const at = o.state === "complete" ? o.lastSuccessfulAt : o.lastAttemptAt,
    when =
      at && Number.isFinite(Date.parse(at))
        ? ` ${clockLabel(Date.parse(at))}`
        : "",
    counts = o.counts;
  if (!counts) return `${lead}${when}`;
  if (o.state === "partial")
    return `${lead}${when} · ${plural(counts.observed, "issue")} observed so far`;
  const match =
    rule.kind === "none"
      ? ", no readiness rule"
      : rule.kind === "rule" && counts.matching !== null
        ? `, ${counts.matching} match the readiness rule`
        : "";
  return `${lead}${when} · ${plural(counts.observed, "issue")} observed${match}`;
}

/** What a saved source is called: its content, never its S-n id or a Project filter. */
export interface SourceNaming {
  name: string;
  /** The kind in words ("repository issues", "search", "GitHub Project"). */
  kind: string;
  /** The name is saved private text (a search query): show it only in the signed-in view. */
  private: boolean;
}

/**
 * A saved source named by what it reads. A search is its saved query, which only the
 * session-only private read supplies (`query`); until then it is "Saved search". A Project
 * has no stored title, so its name comes from discovery (`projectTitle`) when that lists it.
 */
export function sourceName(
  s: { kind: string; descriptor: string | null },
  extra: { query?: string | undefined; projectTitle?: string | undefined } = {},
): SourceNaming {
  if (s.kind === "repository")
    return {
      name: s.descriptor || "Repository",
      kind: "repository issues",
      private: false,
    };
  if (s.kind === "search")
    return extra.query?.trim()
      ? { name: extra.query, kind: "search", private: true }
      : { name: "Saved search", kind: "search", private: false };
  return {
    name: extra.projectTitle || "GitHub Project",
    kind: "GitHub Project",
    private: false,
  };
}

/** A row heading: the name, then the kind unless the name already says it. */
export const sourceHeading = (n: SourceNaming) =>
  n.name === n.kind ? n.name : `${n.name} · ${n.kind}`;

/** The same naming for a row that is not saved yet, from what is typed so far. */
export function draftSourceName(r: {
  kind?: unknown;
  owner?: unknown;
  name?: unknown;
  query?: unknown;
}): SourceNaming {
  const typed = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (r.kind === "project")
    return { name: "GitHub Project", kind: "GitHub Project", private: false };
  if (r.kind === "search")
    return typed(r.query)
      ? { name: typed(r.query), kind: "search", private: true }
      : { name: "New source", kind: "search", private: false };
  const repository =
    typed(r.owner) && typed(r.name) ? `${typed(r.owner)}/${typed(r.name)}` : "";
  return repository
    ? { name: repository, kind: "repository issues", private: false }
    : { name: "New source", kind: "repository issues", private: false };
}

/** Badge symbol for `observationLabel`: it pairs with the word, never replaces it. */
export function observationSymbol(o: Observation | undefined): LucideIcon {
  if (o?.state === "complete") return CircleCheck;
  if (o?.state === "partial") return CircleDashed;
  if (o && o.state !== "never") return CircleQuestionMark;
  return Circle;
}

export function routingLine(r: ProjectConfigurationData["routing"]) {
  const n = r.candidateProfileIds.length;
  return r.enabled
    ? `Enabled · ${plural(n, "candidate")} · reference ${r.credentialConfigured ? "configured" : "unconfigured"}`
    : `Disabled · ${n ? plural(n, "candidate") : "no candidates"}`;
}

export function repositoryLines(c: ProjectConfigurationData) {
  return c.source.repositories.length
    ? c.source.repositories.map(
        (r) =>
          `${r.repositoryId ?? "Repository unavailable"} · ${r.ref ?? "ref unavailable"} · checkout configured`,
      )
    : ["None · repository-free"];
}

/** One index line: the S-n id, then what the source reads without any private text. */
export function selectionLine(
  s: ProjectConfigurationData["source"]["selections"][number],
) {
  const kind =
    s.kind === "repository"
      ? `${s.descriptor ?? "repository"} issues`
      : s.kind === "project"
        ? "GitHub Project"
        : "search";
  return `${s.id ?? "ID unavailable"} ${kind}${s.active ? "" : " · inactive"}`;
}

export const readinessNextStep =
  "Check the readiness conditions in GitHub source settings.";

/** Phone summary of one project's configuration: what is true now and the next step. */
export function projectStateSummary(
  c: ProjectConfigurationData,
  observations: Observations | null,
  unsettled: Extract<OperatorCommand, { type: "github.place" }>[],
) {
  const lead =
    c.profiles.find((p) => p.id === c.project.leadProfileId)?.name ??
    "Unconfigured";
  const access = c.source.repositories.length
    ? c.source.repositories
        .map((r) => r.repositoryId ?? "unavailable")
        .join(", ")
    : "none";
  const observed = observations?.projects.find(
    (p) => p.projectId === c.project.id,
  );
  const state = [
    `Lead: ${lead} · repository access: ${access}`,
    ...(c.source.selections.length
      ? c.source.selections.map((s) => {
          const o = observed?.selections.find((o) => o.selectionId === s.id);
          return `GitHub ${s.id ?? "selection"} ${s.active ? "active" : "inactive"} · ${observationLabel(o).toLowerCase()}${o?.counts && observed ? ` · ${selectionCountsText(o.counts, observed.readiness)}` : ""}`;
        })
      : ["No GitHub source"]),
    ...c.placements.map(
      (p) =>
        `${p.title ?? "A task"} held: choose its project (${p.choices.map((r) => r.name ?? "unavailable").join(" or ")})`,
    ),
    ...unsettled.map(() => "A placement outcome is unknown"),
  ];
  const next = unsettled.length
    ? "Check what was saved for the unknown placement in Sync & placement."
    : c.placements.length
      ? `Choose the project for ${c.placements[0]?.title ?? "the conflicting task"} in Sync & placement.`
      : c.source.selections.length && c.source.credential?.usable === false
        ? "Set or change the credential in GitHub source settings, then preview this source version."
        : observed?.selections.some((o) =>
              zeroMatchWarning(o.counts, observed.readiness),
            )
          ? readinessNextStep
          : "Nothing needs attention here.";
  return { state, next };
}

export type HoldTone = "warning" | "idle";
/** The five independent holds; absence is never described as a release. */
export function holdPills(h: {
  stop: boolean;
  task: boolean;
  writer: boolean;
  capacity: boolean;
  uncertainty: boolean;
}): { label: string; value: string; tone: HoldTone }[] {
  const pill = (label: string, on: boolean, yes: string, no: string) => ({
    label,
    value: on ? yes : no,
    tone: (on ? "warning" : "idle") as HoldTone,
  });
  return [
    pill("Operator Stop", h.stop, "Active", "Not active"),
    pill("Task hold", h.task, "Active", "Not recorded"),
    pill("Writer ownership", h.writer, "Held", "None reported"),
    pill("Capacity", h.capacity, "Held", "None reported"),
    pill("Uncertainty", h.uncertainty, "Active", "None reported"),
  ];
}

/**
 * Consecutive recovery records that display the same state, newest first as `shown`.
 * Only the work id and generation differ within a run, so nothing visible is hidden;
 * a witness id makes its record unique, so it never joins a run.
 */
export function recoveryRecordRuns<
  R extends { workId: unknown; generation: unknown },
>(records: readonly R[]): { shown: R; older: R[] }[] {
  const runs: { signature: string; items: R[] }[] = [];
  for (const record of records) {
    const { workId: _w, generation: _g, ...state } = record;
    const signature = JSON.stringify(state);
    const last = runs.at(-1);
    if (last?.signature === signature) last.items.push(record);
    else runs.push({ signature, items: [record] });
  }
  return runs.map(({ items }) => ({
    shown: items[items.length - 1] as R,
    older: items.slice(0, -1),
  }));
}

/** Controlled source failures contain no provider output or private reference names. */
export function sourceCredentialCopy(reason: string | null | undefined) {
  switch (reason) {
    case "missing-credential":
    case "invalid-credential-reference":
    case "gh-not-installed":
    case "gh-not-signed-in":
    case "gh-unreadable":
      return sourceCredentialExplanation(reason);
    default:
      return "Source credential status is unavailable. Reload before previewing.";
  }
}
export function sourceCredentialSummary(
  source: ProjectConfigurationData["source"],
) {
  const status = source.credential;
  if (!source.credentialConfigured) return "Unconfigured";
  if (!status) return "Configured · status unavailable";
  const kind = status.source === "gh" ? "GitHub CLI" : "Environment reference";
  return `${kind} · ${status.usable ? "usable" : "unavailable"}`;
}
