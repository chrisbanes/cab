import { z } from "zod";

/** The curated agent plan record (ADR-1025); the caps are this record's. */
export const planStepStatus = z.enum(["pending", "in-progress", "done"]);
export type PlanStepStatus = z.infer<typeof planStepStatus>;
export const maxPlanSteps = 50;
export const maxPlanStepBytes = 1024;
/** A longer payload is rejected whole rather than counted. */
const maxAcceptedPlanSteps = 1000;

export const planStepSchema = z
  .object({ text: z.string().nullable(), status: planStepStatus })
  .strict();
export type PlanStep = z.infer<typeof planStepSchema>;

export interface NormalizedPlan {
  /** Agent-authored text, not yet redacted. */
  steps: PlanStep[];
  omittedStepCount: number;
  done: number;
  total: number;
}

/** Codex reports `inProgress`, Claude `in_progress`; both report `pending` and `completed`. */
const runtimeStatus = z
  .enum(["pending", "inProgress", "in_progress", "completed"])
  .transform(
    (status): PlanStepStatus =>
      status === "completed"
        ? "done"
        : status === "pending"
          ? "pending"
          : "in-progress",
  );
const inputSchema = z
  .array(z.object({ text: z.string(), status: runtimeStatus }))
  .max(maxAcceptedPlanSteps);

/**
 * Bounds a runtime's plan: at most `maxPlanSteps` steps are kept, and an oversized step
 * keeps only its status (never truncated, so no partial secret survives). Undefined
 * for an invalid or oversized payload.
 */
export function normalizePlan(steps: unknown): NormalizedPlan | undefined {
  const parsed = inputSchema.safeParse(steps);
  if (!parsed.success) return undefined;
  const all = parsed.data;
  return {
    steps: all.slice(0, maxPlanSteps).map(({ text, status }) => ({
      text: Buffer.byteLength(text, "utf8") > maxPlanStepBytes ? null : text,
      status,
    })),
    omittedStepCount: Math.max(0, all.length - maxPlanSteps),
    done: all.filter((step) => step.status === "done").length,
    total: all.length,
  };
}
