import { z } from "zod";

/** A task's attention codes, in the precedence that names who acts next. */
export const attentionCodes = [
  "execution-uncertain",
  "approval",
  "question",
  "unresolved-result",
  "completion-rejected",
  "lead-review",
] as const;
export type AttentionCode = (typeof attentionCodes)[number];
export const attentionCodeSchema = z.enum(attentionCodes);

/**
 * Who acts next for each code, shared by the List, the Inbox and the task detail. Every code
 * names the operator except `lead-review`: Ensemble commits that fallback to the project lead,
 * or marks it stale, on its next coordination pass.
 */
export const attentionNext: Record<
  AttentionCode,
  { operator: boolean; action: string; reason: string; inboxAction: string }
> = {
  "execution-uncertain": {
    operator: true,
    action: "inspect execution",
    reason: "Execution ownership is uncertain",
    inboxAction: "Inspect execution",
  },
  approval: {
    operator: true,
    action: "review material & decide",
    reason: "Approval needs a decision",
    inboxAction: "Review material & decide",
  },
  question: {
    operator: true,
    action: "answer question",
    reason: "Question needs an answer",
    inboxAction: "Answer question",
  },
  "unresolved-result": {
    operator: true,
    action: "resolve result destination",
    reason: "Result destination needs attention",
    inboxAction: "Inspect execution",
  },
  "completion-rejected": {
    operator: true,
    action: "review rejected completion",
    reason: "Completion requires review",
    inboxAction: "Inspect execution",
  },
  "lead-review": {
    operator: false,
    action: "recording routing fallback",
    reason: "Routing fell back to the project lead",
    inboxAction: "View task",
  },
};

/**
 * The leading code and its "Next:" text. `uncertainColumn` adds `execution-uncertain` for a task
 * in the Uncertain column, the List's uncertainty rule.
 */
export function nextAttention(
  codes: readonly AttentionCode[],
  uncertainColumn = false,
) {
  const code = attentionCodes.find(
    (c) =>
      codes.includes(c) || (c === "execution-uncertain" && uncertainColumn),
  );
  if (!code) return undefined;
  const next = attentionNext[code];
  return {
    code,
    operator: next.operator,
    text: `Next: ${next.operator ? "you" : "Ensemble"} · ${next.action}`,
  };
}

/** The code an Inbox intervention stands for; questions and approvals have their own items. */
export const interventionCode = (codes: readonly AttentionCode[]) =>
  attentionCodes.find(
    (c) => c !== "question" && c !== "approval" && codes.includes(c),
  );
