// Pure state for the Instruction proposals settings tab.
import {
  type DraftingRunRead,
  instructionFeedbackLimits,
} from "../../src/operator/contracts.js";

export { instructionFeedbackLimits };
export const instructionNoteLimit = 16_000;
/** The configure `instructions` limit. */
export const instructionTextLimit = 16_000;
export const instructionProposalPollMs = 2000;

export type InstructionRun = DraftingRunRead["data"];

/** How much of the 20-item, 64,000-character selection is used, and whether it can be sent. */
export function selectionSummary(texts: readonly string[]) {
  const characters = texts.reduce((total, text) => total + text.length, 0);
  const over =
    texts.length > instructionFeedbackLimits.items ||
    characters > instructionFeedbackLimits.characters;
  return {
    line: `${texts.length} of ${instructionFeedbackLimits.items} selected · ${characters.toLocaleString("en-GB")} of ${instructionFeedbackLimits.characters.toLocaleString("en-GB")} characters`,
    over,
    sendable: texts.length > 0 && !over,
  };
}

/** Why Accept is unavailable, or null when it can be sent. */
export function acceptBlock(
  run: Pick<
    InstructionRun,
    "state" | "proposalWithheld" | "instructionTarget" | "targetCurrent"
  >,
  finalText: string,
): string | null {
  if (run.state !== "proposed") return "There is no proposal to accept.";
  if (
    run.proposalWithheld ||
    run.instructionTarget?.observedInstructions == null
  )
    return "This proposal holds text that cannot be shown, so it cannot be accepted.";
  if (!run.targetCurrent?.unchanged)
    return "The instructions changed since this proposal was drafted. Redraft to review it against the current text.";
  if (finalText === run.instructionTarget.observedInstructions)
    return "The text is the same as the current instructions.";
  if (finalText.length > instructionTextLimit)
    return "Instructions can be at most 16,000 characters.";
  return null;
}

/** Who saving reaches and when; existing assignments keep their revision. */
export function impactLines(
  run: Pick<InstructionRun, "instructionTarget" | "impact">,
): string[] {
  const target = run.instructionTarget;
  const impact = run.impact;
  if (!target || !impact) return [];
  const assignments =
    impact.openAssignments === 1
      ? "1 open-task assignment uses"
      : `${impact.openAssignments} open-task assignments use`;
  const keep = `${assignments} the current revision and keeps it until you choose Apply current instructions on it.`;
  if (target.kind === "project")
    return [
      "Saving creates this project's next instructions revision. New assignments use it.",
      keep,
    ];
  const count = impact.projects.length;
  return [
    `Saving creates agent ${target.name ?? "(name withheld)"}'s next revision, used by ${count === 1 ? "1 project" : `${count} projects`}: ${impact.projects.map((p) => `${p.name ?? "(name withheld)"} (${p.role === "lead" ? "lead" : "permitted agent"})`).join(", ")}. New assignments in each use it.`,
    keep,
  ];
}

/** How to restore earlier wording with the existing configuration workflow. */
export function restoreLine(kind: "project" | "profile") {
  return `To restore earlier wording, open the ${kind === "project" ? "project" : "agent"}'s instructions in Settings, or run cab ${kind} prepare --restore-revision N.`;
}

/** The one line for an accepted save. */
export function savedLine(revision: number | null) {
  return revision === null
    ? "Saved the instructions."
    : `Saved as instructions revision ${revision}.`;
}

const runStateLabels: Record<InstructionRun["state"], string> = {
  queued: "Waiting for capacity",
  running: "Drafting",
  stopping: "Stopping",
  proposed: "Proposal ready",
  interrupted: "Stopped",
  failed: "Draft failed",
  accepted: "Accepted",
  discarded: "Rejected",
  expired: "Expired",
};
export const runStateLabel = (state: InstructionRun["state"]) =>
  runStateLabels[state];

export const evidenceUseLabel = {
  supports: "Supports",
  conflicts: "Conflicts",
  "not-used": "Not used",
} as const;
