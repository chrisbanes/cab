import { z } from "zod";

/**
 * A project's sandbox level (ADR-1034). `strict` keeps the harness sandbox; `escalate-approval`
 * keeps it but lets a Codex task turn ask the operator to run one command outside it;
 * `unsandboxed` runs task turns without it. Separate from domain.ts so the web can import it
 * without node:sqlite.
 */
export const sandboxLevels = [
  "strict",
  "escalate-approval",
  "unsandboxed",
] as const;
export const sandboxLevelSchema = z.enum(sandboxLevels);
export type SandboxLevel = z.infer<typeof sandboxLevelSchema>;

/** The approval action of a sandbox escalation; never a delivery `ActionKind`. */
export const sandboxEscalationAction = "sandbox.escalate";
/** The prompt and Inbox headline of a sandbox escalation approval. */
export const sandboxEscalationHeadline = "Run a command outside the sandbox";
