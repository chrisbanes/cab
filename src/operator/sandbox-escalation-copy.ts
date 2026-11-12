/**
 * The one wording for a sandbox escalation's recorded evidence (ADR-1034), shared by the task
 * read, the task UI and the CLI.
 */

export const sandboxEscalationOutcomes = [
  "pending",
  "approved",
  "declined",
  "expired",
  "obsolete",
  "not-delivered",
] as const;
export type SandboxEscalationOutcome =
  (typeof sandboxEscalationOutcomes)[number];

/** How an escalation ended, from its recorded decider, decision and delivery. */
export function sandboxEscalationOutcome(record: {
  decider: "operator" | "expiry" | "obsolete" | null;
  decision: "accept" | "decline" | null;
  delivered: boolean | null;
}): SandboxEscalationOutcome {
  if (record.decider === null) return "pending";
  if (record.decider === "obsolete") return "obsolete";
  if (record.delivered === false) return "not-delivered";
  if (record.decider === "expiry") return "expired";
  return record.decision === "accept" ? "approved" : "declined";
}

/** A duration in milliseconds, as an operator reads it. */
export function escalationDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  // Rounded once, so 59 960 ms reads 1 min 0 s, never 60.0 s.
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Shown in place of a command the privacy exclusions withhold. */
export const sandboxEscalationCommandUnavailable = "Command unavailable";

/**
 * Where the command was asked to run: its working directory and workspace state, and whether
 * the command, cwd or reason was cut to fit the approval limit.
 */
export function sandboxEscalationPlace(e: {
  cwd: string | null;
  workspace: Parameters<typeof sandboxEscalationWorkspaceLine>[0];
  truncated: boolean;
}): string {
  return [
    `in ${e.cwd ?? "an unavailable directory"}`,
    sandboxEscalationWorkspaceLine(e.workspace),
    ...(e.truncated ? ["request cut to fit the approval limit"] : []),
  ].join(" · ");
}

/** What happened to the escalation and, once an approved command ran, its exit code and duration. */
export function sandboxEscalationResultLine(e: {
  outcome: SandboxEscalationOutcome;
  decider: "operator" | "expiry" | "obsolete" | null;
  decision: "accept" | "decline" | null;
  exitCode: number | null;
  durationMs: number | null;
  completedAt: number | null;
}): string {
  switch (e.outcome) {
    case "pending":
      return "Waiting for an operator answer";
    case "expired":
      return "Declined after 15 minutes without an answer";
    case "obsolete":
      return "Withdrawn: the request ended before it was answered";
    case "declined":
      return "Declined by the operator";
    case "not-delivered":
      return `${
        e.decider === "expiry"
          ? "Declined after 15 minutes without an answer"
          : `${e.decision === "accept" ? "Approved" : "Declined"} by the operator`
      }; the answer was not delivered`;
    case "approved":
      return e.completedAt === null
        ? "Approved by the operator; no completion recorded"
        : [
            "Approved by the operator",
            e.exitCode === null ? "no exit code" : `exit code ${e.exitCode}`,
            ...(e.durationMs === null
              ? []
              : [escalationDuration(e.durationMs)]),
          ].join(" · ");
  }
}

/** The workspace the command was asked to run in: HEAD, branch and uncommitted changes. */
export function sandboxEscalationWorkspaceLine(
  workspace: {
    head: string | null;
    branch: string | null;
    dirty: boolean | null;
  } | null,
): string {
  if (!workspace || workspace.head === null) return "Workspace state unknown";
  return [
    `HEAD ${workspace.head.slice(0, 12)}`,
    workspace.branch === null ? "detached" : `on ${workspace.branch}`,
    workspace.dirty === null
      ? "changes unknown"
      : workspace.dirty
        ? "uncommitted changes"
        : "no uncommitted changes",
  ].join(" · ");
}
