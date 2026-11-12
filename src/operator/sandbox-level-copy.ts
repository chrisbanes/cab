import type { SandboxLevel } from "../core/sandbox-level.js";

/**
 * The one wording for a project's sandbox level (ADR-1034). The server disclosure, the CLI and
 * the web import it, so every surface that shows the effective policy reads the same. Each line
 * stays within the 300-character policy disclosure cap.
 */

export const sandboxLevelLabels: Record<SandboxLevel, string> = {
  strict: "Strict",
  "escalate-approval": "Escalate with approval",
  unsandboxed: "Unsandboxed (dangerous)",
};

/** What the escalate-approval level sends Codex for a task turn. */
export const codexEscalateApprovalLine =
  "A project at the escalate-approval level keeps its Codex task turns sandboxed, with an approval policy that allows only sandbox escalation: a turn can ask to run one command outside the sandbox. Draft, read-only and unbound turns stay strict.";

/** Claude Code has no escalation seam yet, so its task turns stay strict. */
export const claudeEscalateApprovalLine =
  "Claude Code task turns in a project at the escalate-approval level run at the strict level for now; they cannot ask to run a command outside the sandbox.";

/** How an escalation is decided and what an approved one can do. */
export const escalateApprovalRiskLines = [
  "Each escalation waits in the Inbox with its command, working directory, reason and workspace state. Approve runs that one command; decline refuses it. An escalation left unanswered for 15 minutes is declined, and one whose turn ends is withdrawn.",
  "An approved command runs with the service user's full filesystem, process, network and credential access, and untrusted text, including issue and pull request bodies, can shape the request. Processes it starts can outlive the turn; cab does not clean them up.",
];

/** The escalate-approval level for surfaces that show the level rather than one harness. */
export const escalateApprovalLines = [
  codexEscalateApprovalLine,
  claudeEscalateApprovalLine,
  ...escalateApprovalRiskLines,
];

/** The Inbox headline of an escalation approval. */
export const sandboxEscalationHeadline = "Run a command outside the sandbox";

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
      ? "The sandbox level is escalate-approval for this project's Codex task turns; its Claude Code task turns stay strict."
      : "The sandbox level is strict for this project.";

/** `null` is a turn with no recorded admission: not admitted yet, held before admission, or admitted before the level existed. */
export const turnSandboxLevelLine = (level: SandboxLevel | null) =>
  level === null
    ? "No sandbox level admission recorded; the project's level at admission applies."
    : level === "unsandboxed"
      ? "Admitted at the unsandboxed sandbox level."
      : level === "escalate-approval"
        ? "Admitted at the escalate-approval sandbox level."
        : "Admitted at the strict sandbox level.";
