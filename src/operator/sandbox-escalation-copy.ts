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

/** How a reviewer decision ended (ADR-1034); `obsolete` is a review its turn outlived no longer. */
export const sandboxReviewOutcomes = [
  "reviewing",
  "approved",
  "denied",
  "timed-out",
  "aborted",
  "obsolete",
] as const;
export type SandboxReviewOutcome = (typeof sandboxReviewOutcomes)[number];

/** A review still in progress whose work no longer runs ended with its turn, undecided. */
export function sandboxReviewOutcome(review: {
  status: "inProgress" | "approved" | "denied" | "timedOut" | "aborted";
  running: boolean;
}): SandboxReviewOutcome {
  switch (review.status) {
    case "inProgress":
      return review.running ? "reviewing" : "obsolete";
    case "timedOut":
      return "timed-out";
    default:
      return review.status;
  }
}

/** What happened to the advisory overrule a denial offered. */
export const sandboxOverruleOutcomes = [
  "offered",
  "approved",
  "sent",
  "not-delivered",
  "declined",
  "withdrawn",
] as const;
export type SandboxOverruleOutcome = (typeof sandboxOverruleOutcomes)[number];

export function sandboxOverruleOutcome(overrule: {
  decider: "operator" | "obsolete" | null;
  decision: "accept" | "decline" | null;
  delivered: boolean | null;
}): SandboxOverruleOutcome {
  if (overrule.decider === null) return "offered";
  if (overrule.decider === "obsolete") return "withdrawn";
  if (overrule.decision === "decline") return "declined";
  return overrule.delivered === null
    ? "approved"
    : overrule.delivered
      ? "sent"
      : "not-delivered";
}

const overruleLines: Record<SandboxOverruleOutcome, string> = {
  offered: "overrule offered in the Inbox",
  approved: "overrule approved",
  sent: "overruled by the operator; the retry is reviewed again",
  "not-delivered": "overrule approved but not delivered",
  declined: "overrule declined",
  withdrawn: "overrule withdrawn: the turn ended",
};

/**
 * What the reviewer decided, with its risk level, an approved command's exit code and duration,
 * and a denial's overrule. The rationale is shown on its own.
 */
export function sandboxReviewResultLine(r: {
  outcome: SandboxReviewOutcome;
  riskLevel: "low" | "medium" | "high" | "critical" | null;
  exitCode: number | null;
  durationMs: number | null;
  completedAt: number | null;
  overrule: { outcome: SandboxOverruleOutcome } | null;
}): string {
  const risk = r.riskLevel === null ? [] : [`${r.riskLevel} risk`];
  switch (r.outcome) {
    case "reviewing":
      return "Being reviewed";
    case "obsolete":
      return "Withdrawn: the turn ended before the review completed";
    case "timed-out":
      return "Declined: the review timed out";
    case "aborted":
      return "Declined: the review was aborted";
    case "denied":
      return [
        "Denied by the reviewer",
        ...risk,
        ...(r.overrule ? [overruleLines[r.overrule.outcome]] : []),
      ].join(" · ");
    case "approved":
      return [
        "Approved by the reviewer",
        ...risk,
        ...(r.completedAt === null
          ? ["no completion recorded"]
          : [
              r.exitCode === null ? "no exit code" : `exit code ${r.exitCode}`,
              ...(r.durationMs === null
                ? []
                : [escalationDuration(r.durationMs)]),
            ]),
      ].join(" · ");
  }
}

/** Where a reviewed command was asked to run, and whether its recorded text was cut. */
export function sandboxReviewPlace(r: {
  cwd: string | null;
  workspace: Parameters<typeof sandboxEscalationWorkspaceLine>[0];
  truncated: boolean;
}): string {
  return [
    `in ${r.cwd ?? "an unavailable directory"}`,
    sandboxEscalationWorkspaceLine(r.workspace),
    ...(r.truncated ? ["review cut to its recorded limit"] : []),
  ].join(" · ");
}
