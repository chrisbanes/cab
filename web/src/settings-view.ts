/** Pure presentation for the settings routes: headers, index lines, saved lines and holds. */
import type { z } from "zod";
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

/** "General saved 10:52" for a save this session recorded at the current version, else the version. */
export function savedLine(
  label: string,
  version: number,
  saved: SavedRecord | undefined,
) {
  return saved && receiptVersion(saved.receipt) === version
    ? `${label} saved ${clock(saved.at)}`
    : `${label} version ${version}`;
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

type Observations = z.infer<typeof sourceObservationSchema>["data"];
type Observation = Observations["projects"][number]["selections"][number];

/** Badge text for one selection's source observation. */
export function observationLabel(o: Observation | undefined) {
  if (!o) return "Not synced";
  if (o.state === "complete")
    return o.lastSuccessfulAt
      ? `Synced ${clock(Date.parse(o.lastSuccessfulAt))}`
      : "Synced";
  if (o.state === "partial") return "Partial";
  if (o.state === "never") return "Not synced";
  return "Unavailable";
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

export function selectionLine(
  s: ProjectConfigurationData["source"]["selections"][number],
) {
  const kind =
    s.kind === "repository"
      ? (s.descriptor ?? "repository")
      : s.kind === "project"
        ? `GitHub Project ${s.descriptor ?? ""}`.trim()
        : "search · query private";
  return `${s.id ?? "ID unavailable"} ${kind}${s.active ? "" : " · inactive"}`;
}

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
      ? c.source.selections.map(
          (s) =>
            `GitHub ${s.id ?? "selection"} ${s.active ? "active" : "inactive"} · ${observationLabel(observed?.selections.find((o) => o.selectionId === s.id)).toLowerCase()}`,
        )
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
        : "Nothing needs attention here.";
  return { state, next };
}

export type HoldTone = "warning" | "neutral";
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
    tone: (on ? "warning" : "neutral") as HoldTone,
  });
  return [
    pill("Operator Stop", h.stop, "Active", "Not active"),
    pill("Task hold", h.task, "Active", "Not recorded"),
    pill("Writer ownership", h.writer, "Held", "None reported"),
    pill("Capacity", h.capacity, "Held", "None reported"),
    pill("Uncertainty", h.uncertainty, "Active", "None reported"),
  ];
}

/** Controlled source failures contain no provider output or private reference names. */
export function sourceCredentialCopy(reason: string | null | undefined) {
  switch (reason) {
    case "missing-credential":
      return "GitHub source credential required. Choose GitHub CLI or an available service environment variable in GitHub source settings, then preview this source version.";
    case "invalid-credential-reference":
      return "GitHub source credential is invalid. Choose GitHub CLI or an environment variable in GitHub source settings.";
    case "gh-not-installed":
      return "GitHub CLI is not installed on the service host. Install gh or change the credential in GitHub source settings, then retry preview.";
    case "gh-not-signed-in":
      return "GitHub CLI is not signed in. Run gh auth login on the service host or change the credential in GitHub source settings, then retry preview.";
    case "gh-unreadable":
      return "The service cannot read the GitHub CLI login. Check the service's access to gh or change the credential in GitHub source settings, then retry preview.";
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
