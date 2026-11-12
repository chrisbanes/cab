import { z } from "zod";

/**
 * A project's sandbox level (ADR-1034). `strict` keeps the harness sandbox; `escalate-approval`
 * keeps it but lets a Codex task turn ask the operator to run one command outside it;
 * `escalate-auto-review` has Codex's reviewer decide each such request instead, with an advisory
 * operator overrule of a denial; `unsandboxed` runs task turns without it. Separate from domain.ts so the web can import it
 * without node:sqlite.
 */
export const sandboxLevels = [
  "strict",
  "escalate-approval",
  "escalate-auto-review",
  "unsandboxed",
] as const;
export const sandboxLevelSchema = z.enum(sandboxLevels);
/** The stored CHECK on a sandbox level column, as the current schema writes it. */
export const sandboxLevelCheck =
  "CHECK(level IN ('strict', 'escalate-approval', 'escalate-auto-review', 'unsandboxed'))";
/** The CHECKs of levels 32 and 33, which migration widens to `sandboxLevelCheck`. */
export const earlierSandboxLevelChecks = [
  "CHECK(level IN ('strict', 'unsandboxed'))",
  "CHECK(level IN ('strict', 'escalate-approval', 'unsandboxed'))",
] as const;
export type SandboxLevel = z.infer<typeof sandboxLevelSchema>;

/** The approval action of a sandbox escalation; never a delivery `ActionKind`. */
export const sandboxEscalationAction = "sandbox.escalate";
/** The prompt and Inbox headline of a sandbox escalation approval. */
export const sandboxEscalationHeadline = "Run a command outside the sandbox";
/** The approval action offering an advisory overrule of a reviewer denial; never a delivery `ActionKind`. */
export const sandboxOverruleAction = "sandbox.overrule";
/** The prompt and Inbox headline of a sandbox overrule approval. */
export const sandboxOverruleHeadline = "Overrule a reviewer denial";

/** A reviewer decision (ADR-1034)'s identity: one review in one runtime generation's thread and turn. */
export const sandboxReviewIdentitySchema = z.object({
  runtimeGeneration: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  reviewId: z.string().min(1),
  targetItemId: z.string().min(1),
});
export type SandboxReviewIdentity = z.infer<typeof sandboxReviewIdentitySchema>;
export const sandboxReviewStatusSchema = z.enum([
  "inProgress",
  "approved",
  "denied",
  "timedOut",
  "aborted",
]);
export const sandboxReviewRiskSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
