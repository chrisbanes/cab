import type {
  DiscoveryStatus,
  Workspace,
} from "../../src/operator/contracts.js";
import {
  readinessCheckHref,
  settingsSectionHref,
} from "./settings-sections.js";
import type { ReadinessRead } from "./setup-model.js";

export type RowId = "runtime" | "github" | "project" | "first-task" | "claude";
export type RowStatus =
  | "done"
  | "next"
  | "attention"
  | "not-started"
  | "optional"
  | "checking"
  | "unknown";
export type RowAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "resume"; projectId: string }
  /** Shown but not usable yet; the card keeps it focusable and announces the row's detail. */
  | { kind: "unavailable"; label: string };
export interface ChecklistRow {
  id: RowId;
  title: string;
  detail: string;
  status: RowStatus;
  /** Only the first incomplete required row carries the primary button. */
  primary: boolean;
  action: RowAction;
}

/** The rows that count toward "N of 3 required steps done", in order. */
export const REQUIRED_ROWS = ["runtime", "project", "first-task"] as const;

const passes = (r: ReadinessRead, ids: readonly string[]) =>
  r.state === "ready"
    ? ids.every((id) => r.checks.find((c) => c.id === id)?.status === "pass")
    : null;

/**
 * Frames 143–144: the checklist rows, derived from current reads on every render; no
 * progress is stored. A required row regresses to Needs attention when a later required
 * row is Done or a turn has started.
 */
export function checklistRows(input: {
  workspace: Workspace["data"];
  readiness: ReadinessRead;
  discovery: DiscoveryStatus["data"] | null;
}): ChecklistRow[] {
  const { workspace, readiness, discovery } = input;
  const { turnStarted } = workspace.gettingStarted;
  const profiles = workspace.profiles.filter((p) => !p.revoked),
    leads = new Set(profiles.map((p) => p.id)),
    hasLead = (p: { leadProfileId: string | null }) =>
      p.leadProfileId !== null && leads.has(p.leadProfileId),
    enabledProjects = workspace.projects.filter((p) => !p.paused),
    // Done needs an enabled project whose lead can run; a lead-less project waits for one.
    ready = enabledProjects.find(hasLead),
    leadless = enabledProjects[0],
    paused = workspace.projects.find((p) => p.paused),
    firstTaskProject = ready ?? leadless ?? paused;
  // A runtime row passes when some runtime is enabled and that runtime's own checks pass; a
  // disabled runtime's checks report not-configured, so they never pass.
  const enabledRuntime = passes(readiness, ["runtime-enabled"]);
  const runtime =
    enabledRuntime === null
      ? null
      : enabledRuntime &&
        (passes(readiness, ["codex-executable", "codex-login"]) ||
          passes(readiness, ["claude-executable", "claude-token"]));
  const checks = readiness.state === "ready" ? readiness.checks : [];
  const failing =
    checks.find((c) => c.id === "runtime-enabled" && c.status !== "pass") ??
    checks.find(
      (c) =>
        [
          "codex-executable",
          "codex-login",
          "claude-executable",
          "claude-token",
        ].includes(c.id) && c.status === "fail",
    );
  // Required rows in order; null is not known yet (readiness still loading or unreadable).
  const required: [RowId, boolean | null][] = [
    ["runtime", runtime],
    ["project", Boolean(ready)],
    ["first-task", turnStarted],
  ];
  const firstIncomplete = required.find(([, done]) => done === false)?.[0];
  const status = (id: RowId): RowStatus => {
    const index = required.findIndex(([row]) => row === id),
      done = required[index]?.[1];
    if (done === null)
      return readiness.state === "loading" ? "checking" : "unknown";
    if (done) return "done";
    const regressed =
      turnStarted || required.slice(index + 1).some(([, d]) => d === true);
    return regressed
      ? "attention"
      : id === firstIncomplete
        ? "next"
        : "not-started";
  };
  const row = (
    id: RowId,
    title: string,
    detail: string,
    action: RowAction,
    rowStatus = status(id),
  ): ChecklistRow => ({
    id,
    title,
    detail,
    status: rowStatus,
    primary: id === firstIncomplete,
    action,
  });
  const claude =
    readiness.state === "ready"
      ? readiness.checks.find((c) => c.id === "claude-token")
      : undefined;
  // Found must mean runnable: a `claude` that is on the PATH but fails its probe needs attention.
  const unrunnable =
    readiness.state === "ready"
      ? readiness.checks.find(
          (c) => c.id === "claude-executable" && c.status === "fail",
        )
      : undefined;
  const gh = discovery?.gh;
  const githubDone = Boolean(discovery?.configured && discovery.available);
  return [
    row(
      "runtime",
      "Runtime",
      runtime === null
        ? readiness.state === "loading"
          ? "Checking readiness…"
          : "Readiness couldn't be checked."
        : runtime
          ? "Runtime login readable by the service."
          : (failing?.reason ?? "The service can't use the runtime login."),
      failing?.id === "runtime-enabled"
        ? {
            kind: "link",
            label: "Open runtime settings",
            href: "/app/settings/runtime",
          }
        : {
            kind: "link",
            label: "Open readiness check",
            href: settingsSectionHref("readiness"),
          },
    ),
    row(
      "github",
      "GitHub",
      `${
        githubDone && !(discovery?.source === "gh" && gh?.state === "signed-in")
          ? "Discovery credential is readable."
          : gh?.state === "signed-in"
            ? `Signed in to github.com as @${gh.login}.${
                discovery?.configured
                  ? ""
                  : " Project setup can use this login for discovery."
              }`
            : "No discovery credential."
      } Optional for repository-free projects.`,
      {
        kind: "link",
        label: githubDone ? "Discovery settings" : "Set discovery credential",
        href: settingsSectionHref("github-discovery"),
      },
      githubDone ? "done" : "optional",
    ),
    row(
      "project",
      "Project",
      ready
        ? `${ready.name ?? "Project"} is running.`
        : leadless
          ? `${leadless.name ?? "Project"} has no ${
              leadless.leadProfileId === null
                ? "lead profile"
                : "usable lead profile"
            }. Tasks wait for a lead.`
          : paused
            ? `${paused.name ?? "Project"} is paused. Nothing runs until you resume it.`
            : `No projects yet.${
                profiles[0] ? ` Lead profile ${profiles[0].name} is ready.` : ""
              }`,
      ready
        ? {
            kind: "link",
            label: "Open project",
            href: `/app/projects/${ready.id}`,
          }
        : leadless
          ? {
              kind: "link",
              label: "Choose a lead",
              href: `/app/projects/${leadless.id}/settings`,
            }
          : paused
            ? { kind: "resume", projectId: paused.id }
            : {
                kind: "link",
                label: "Create project",
                href: "/app/settings/projects/new",
              },
    ),
    row(
      "first-task",
      "First task",
      turnStarted
        ? "A task has started a turn."
        : firstTaskProject
          ? "No task has started yet."
          : "Needs a project first.",
      firstTaskProject
        ? {
            kind: "link",
            label: "Create task",
            href: `/app/tasks/new?project=${encodeURIComponent(firstTaskProject.id)}`,
          }
        : { kind: "unavailable", label: "Create task" },
    ),
    unrunnable
      ? row(
          "claude",
          "Claude (optional)",
          unrunnable.reason ?? "Claude Code isn't runnable.",
          {
            kind: "link",
            label: "Open readiness check",
            href: readinessCheckHref("claude-executable"),
          },
          "attention",
        )
      : row(
          "claude",
          "Claude (optional)",
          !claude
            ? readiness.state === "loading"
              ? "Checking readiness…"
              : "Readiness couldn't be checked."
            : claude.status === "pass"
              ? "The Claude token reference is readable."
              : claude.status === "not-configured"
                ? "Not configured."
                : (claude.reason ?? "The Claude token isn't readable."),
          {
            kind: "link",
            label: "Add Claude",
            href: "/app/settings/runtime#add-claude",
          },
          !claude
            ? readiness.state === "loading"
              ? "checking"
              : "unknown"
            : claude.status === "pass"
              ? "done"
              : claude.status === "not-configured"
                ? "optional"
                : "attention",
        ),
  ];
}

/** After the first turn, Home keeps only the rows that need attention, dismissed or not. */
export const homeRows = (
  rows: readonly ChecklistRow[],
  turnStarted: boolean,
) => (turnStarted ? rows.filter((r) => r.status === "attention") : [...rows]);
