import type { SandboxLevel } from "../core/sandbox-level.js";

/**
 * The one wording for a project's sandbox level (ADR-1034). The server disclosure, the CLI and
 * the web import it, so every surface that shows the effective policy reads the same. Each line
 * stays within the 300-character policy disclosure cap.
 */

export const sandboxLevelLabels: Record<SandboxLevel, string> = {
  strict: "Strict",
  "escalate-approval": "Escalate with approval",
  "escalate-auto-review": "Escalate with reviewer",
  unsandboxed: "Unsandboxed (dangerous)",
};

/** What the escalate-approval level sends Codex for a task turn. */
export const codexEscalateApprovalLine =
  "A project at the escalate-approval level keeps its Codex task turns sandboxed, with an approval policy that allows only sandbox escalation: a turn can ask to run one command outside the sandbox. Draft, read-only and unbound turns stay strict.";

/** What the escalate-approval level sends Claude Code for a task turn (#1682 T1, branch B). */
export const claudeEscalateApprovalLine =
  "A project at the escalate-approval level runs its Claude Code task turns sandboxed in auto permission mode: cab's hook holds each Bash call that asks to leave the sandbox for the operator. Claude's classifier can still refuse an approved call. Draft, read-only and unbound turns stay strict.";

/** Why Claude Code escalate turns run without the subprocess environment scrub (#1682 T4). */
export const claudeEscalateScrubLine =
  "At the escalate levels, Claude Code task turns run without the subprocess environment scrub, because Claude Code does not start in auto mode with it set. Sandboxed Bash can then read the service's environment, with cab's and Claude's credentials removed.";

/** The Bash timeout ceiling of Claude Code task turns that can leave the sandbox (#1678). */
export const claudeBashTimeoutLine =
  "At the escalate and unsandboxed levels, a Claude Code Bash command can ask for up to 60 minutes. A command that times out is moved to the background and keeps running, so the timeout does not bound it.";

/** How an escalation is decided and what an approved one can do. */
export const escalateApprovalRiskLines = [
  "Each escalation waits in the Inbox with its command, working directory, reason and workspace state. Approve runs that one command; decline refuses it. An escalation left unanswered for 15 minutes is declined, and one whose turn ends is withdrawn.",
  "An approved command runs with the service user's full filesystem, process, network and credential access, and untrusted text, including issue and pull request bodies, can shape the request. Processes it starts can outlive the turn; cab does not clean them up.",
];

/** The escalate-approval level for surfaces that show the level rather than one harness. */
export const escalateApprovalLines = [
  codexEscalateApprovalLine,
  claudeEscalateApprovalLine,
  claudeEscalateScrubLine,
  claudeBashTimeoutLine,
  ...escalateApprovalRiskLines,
];

/** What the escalate-auto-review level sends Codex for a task turn. */
export const codexEscalateAutoReviewLine =
  "A project at the escalate-auto-review level keeps its Codex task turns sandboxed, with an approval policy that allows only sandbox escalation, and reviewer auto_review decides each request instead of the operator. Draft, read-only and unbound turns stay strict.";

/** What the escalate-auto-review level sends Claude Code for a task turn. */
export const claudeEscalateAutoReviewLine =
  "A project at the escalate-auto-review level runs its Claude Code task turns sandboxed in auto permission mode: cab's hook refuses calls outside its tool policy, and Claude's classifier decides each Bash call that asks to leave the sandbox. Draft, read-only and unbound turns stay strict.";

/** What cab can observe of Claude's classifier decisions (#1678, #1682 T1). */
export const claudeAutoReviewEvidenceLine =
  "For Claude Code, cab records a classifier approval once the call has run without asking, and a denial, with Claude Code's reason, when Claude Code reports one. Neither has a risk level or overrule. A call left undecided waits in the Inbox. A live denial and an undecided call are untested.";

/** What any review costs and covers, in either harness. */
export const autoReviewCostLine =
  "Each review is an extra model call on the operator's account, and the reviewer's or classifier's availability depends on the account and model. It judges the requested command only: it does not contain agent-written code, and an approved command runs with the service user's full access.";

/** What a reviewer decision costs and covers, and Codex's advisory overrule of a denial. */
export const escalateAutoReviewRiskLines = [
  autoReviewCostLine,
  "Codex records each decision with its risk level and rationale. A Codex denial offers an advisory overrule in the Inbox while its turn runs: the agent is told the exact action is approved, and its retry is reviewed again. The overrule is not yet proven against a live denial.",
  "A request that still reaches cab waits in the Inbox as at the escalate-approval level. Processes an approved command starts can outlive the turn; cab does not clean them up.",
];

/** The escalate-auto-review level for surfaces that show the level rather than one harness. */
export const escalateAutoReviewLines = [
  codexEscalateAutoReviewLine,
  claudeEscalateAutoReviewLine,
  claudeAutoReviewEvidenceLine,
  claudeEscalateScrubLine,
  claudeBashTimeoutLine,
  ...escalateAutoReviewRiskLines,
];

/** What the unsandboxed level sends Codex for a task turn. */
export const codexUnsandboxedLine =
  "A project at the unsandboxed level runs its Codex task turns with sandbox policy dangerFullAccess; the approval policy stays never. Draft, read-only and unbound turns stay strict.";

/** What the unsandboxed level sends Claude Code for a task turn. */
export const claudeUnsandboxedLine =
  "A project at the unsandboxed level runs its Claude Code task turns with Claude Code's sandbox disabled. Draft, read-only and unbound turns stay strict.";

/** The threat model, in two lines so each fits the disclosure cap. */
export const unsandboxedRiskLines = [
  "An unsandboxed turn has the service user's full filesystem, process, network and credential access, and untrusted text, including issue and pull request bodies, can drive it. Claude Code's edit-tool confinement still applies but is not a boundary.",
  "Processes it starts, such as emulators and browsers, can outlive the turn; cab does not clean them up. The Claude subprocess environment scrub and per-task temporary directory confinement no longer hold, and the Seatbelt self-test does not gate an unsandboxed turn. Only macOS is qualified.",
];

/** Both harnesses' grants, for surfaces that show the level rather than one harness. */
export const unsandboxedGrantLines = [
  codexUnsandboxedLine,
  claudeUnsandboxedLine,
];

/** The risks as one paragraph, for the CLI and the confirmation dialog. */
export const unsandboxedRisk = unsandboxedRiskLines.join(" ");

/** Saves apply to later admissions only. */
export const sandboxLevelAppliesNote =
  "Applies to task turns admitted after the change; running turns keep their policy.";

/** Network access and local listening are covered by the grant while the level is unsandboxed. */
export const unsandboxedSupersededLine =
  "Superseded while the sandbox level is unsandboxed: an unsandboxed command can use the network and listen on ports. The stored value is kept and applies again when the level is strict.";

export const projectSandboxLevelLine = (level: SandboxLevel) =>
  level === "unsandboxed"
    ? "The sandbox level is unsandboxed for this project's task turns in both harnesses."
    : level === "escalate-approval"
      ? "The sandbox level is escalate-approval for this project's task turns in both harnesses."
      : level === "escalate-auto-review"
        ? "The sandbox level is escalate-auto-review for this project's task turns in both harnesses."
        : "The sandbox level is strict for this project.";

/** `null` is a turn with no recorded admission: not admitted yet, held before admission, or admitted before the level existed. */
export const turnSandboxLevelLine = (level: SandboxLevel | null) =>
  level === null
    ? "No sandbox level admission recorded; the project's level at admission applies."
    : level === "unsandboxed"
      ? "Admitted at the unsandboxed sandbox level."
      : level === "escalate-approval"
        ? "Admitted at the escalate-approval sandbox level."
        : level === "escalate-auto-review"
          ? "Admitted at the escalate-auto-review sandbox level."
          : "Admitted at the strict sandbox level.";
