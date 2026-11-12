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
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** What happened to the escalation and, once an approved command ran, its exit code and duration. */
export function sandboxEscalationResultLine(e: {
  outcome: SandboxEscalationOutcome;
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
      return `${e.decision === "accept" ? "Approved" : "Declined"} by the operator; the answer was not delivered`;
    case "approved":
      return e.completedAt === null
        ? "Approved by the operator; the command has not finished"
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
