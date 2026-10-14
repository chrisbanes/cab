import type {
  DiscoveryStatus,
  Workspace,
} from "../../src/operator/contracts.js";
import type { ReadinessRead } from "./setup-model.js";

export type RowId =
  | "runtime"
  | "github"
  | "lead"
  | "project"
  | "first-task"
  | "claude";
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
  | { kind: "gh-login"; login: string };
export interface ChecklistRow {
  id: RowId;
  title: string;
  detail: string;
  status: RowStatus;
  /** Only the first incomplete required row carries the primary button. */
  primary: boolean;
  action: RowAction;
}

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
    enabled = workspace.projects.find((p) => !p.paused),
    paused = workspace.projects.find((p) => p.paused);
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
    ["lead", profiles.length > 0],
    ["project", Boolean(enabled)],
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
            href: "/app/settings",
          },
    ),
    row(
      "github",
      "GitHub",
      `${
        githubDone && !(discovery?.source === "gh" && gh?.state === "signed-in")
          ? "Discovery credential is readable."
          : gh?.state === "signed-in"
            ? `Signed in to github.com as @${gh.login}.`
            : "No discovery credential."
      } Optional for repository-free projects.`,
      !githubDone && !discovery?.configured && gh?.state === "signed-in"
        ? { kind: "gh-login", login: gh.login }
        : {
            kind: "link",
            label: githubDone
              ? "Discovery settings"
              : "Set discovery credential",
            href: "/app/settings",
          },
      githubDone ? "done" : "optional",
    ),
    row(
      "lead",
      "Lead profile",
      profiles.length
        ? `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"}`
        : "No profiles yet.",
      profiles.length
        ? { kind: "link", label: "Open settings", href: "/app/settings" }
        : {
            kind: "link",
            label: "Create in project setup",
            href: "/app/settings/projects/new",
          },
    ),
    row(
      "project",
      "Project",
      enabled
        ? `${enabled.name ?? "Project"} is running.`
        : paused
          ? `${paused.name ?? "Project"} is paused. Nothing runs until you resume it.`
          : "No projects yet.",
      enabled
        ? {
            kind: "link",
            label: "Open project",
            href: `/app/projects/${enabled.id}`,
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
        : enabled || paused
          ? "No task has started yet."
          : "Needs a project first.",
      {
        kind: "link",
        label: "Create task",
        href: `/app/tasks/new${
          (enabled ?? paused)
            ? `?project=${encodeURIComponent((enabled ?? paused)?.id ?? "")}`
            : ""
        }`,
      },
    ),
    unrunnable
      ? row(
          "claude",
          "Claude (optional)",
          unrunnable.reason ?? "Claude Code isn't runnable.",
          {
            kind: "link",
            label: "Open readiness check",
            href: "/app/settings",
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
          { kind: "link", label: "Add Claude", href: "/app/settings/runtime" },
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
