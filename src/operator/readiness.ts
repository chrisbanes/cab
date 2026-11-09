import { z } from "zod";

/** Stable readiness IDs; claude-token now checks native login and skill-plugins reports native ownership. */
export const readinessCheckIds = [
  "runtime-enabled",
  "codex-executable",
  "codex-login",
  "git",
  "github-discovery",
  "claude-executable",
  "claude-token",
  "runtime-harness",
  "skill-plugins",
  "data-paths",
  "gitlab-credentials",
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

/** `cab doctor` and Settings → Readiness read this. */
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

/** Legacy read route returning the native Claude login check. */
export const claudeTokenCheckSchema = z
  .object({
    data: readinessCheckSchema.refine((c) => c.id === "claude-token"),
    observedAt: time,
  })
  .strict();
export type ClaudeTokenCheckResult = z.infer<typeof claudeTokenCheckSchema>;
