import { z } from "zod";

/** The nine readiness checks, in the fixed order they are reported. */
export const readinessCheckIds = [
  "runtime-enabled",
  "codex-executable",
  "codex-login",
  "git",
  "github-discovery",
  "claude-executable",
  "claude-token",
  "runtime-harness",
  "data-paths",
] as const;
export type ReadinessCheckId = (typeof readinessCheckIds)[number];

/**
 * One check result. `reason` and `fix` are fixed strings: they never carry a secret value,
 * a token path or a data path. Every non-pass result has exactly one fix line.
 */
export const readinessCheckSchema = z
  .object({
    id: z.enum(readinessCheckIds),
    label: z.string().min(1).max(80),
    status: z.enum(["pass", "fail", "not-configured"]),
    reason: z.string().min(1).max(500).nullable(),
    fix: z.string().min(1).max(300).nullable(),
  })
  .strict()
  .refine(
    (c) =>
      c.status === "pass"
        ? c.reason === null && c.fix === null
        : c.reason !== null && c.fix !== null,
    {
      message: "A pass carries no reason or fix; any other status carries both",
    },
  );
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

const time = z.number().int().nonnegative().safe();

/** `ensemble doctor` and Settings → Readiness read this. */
export const readinessSchema = z
  .object({
    data: z
      .object({
        checks: z
          .array(readinessCheckSchema)
          .length(readinessCheckIds.length)
          .refine((checks) =>
            checks.every((c, i) => c.id === readinessCheckIds[i]),
          ),
      })
      .strict(),
    observedAt: time,
  })
  .strict();
export type ReadinessResult = z.infer<typeof readinessSchema>;

/** The Add Claude panel's live Token readable row: the Claude token check alone. */
export const claudeTokenCheckSchema = z
  .object({
    data: readinessCheckSchema.refine((c) => c.id === "claude-token"),
    observedAt: time,
  })
  .strict();
export type ClaudeTokenCheckResult = z.infer<typeof claudeTokenCheckSchema>;
