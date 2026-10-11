import { z } from "zod";

export interface PolicyDisclosure {
  lines: string[];
  limits: string[];
}

/** The retained Codex disclosure; `executionPolicy` in codex.ts is what it describes. */
export function codexPolicyDisclosure(): PolicyDisclosure {
  return {
    lines: [
      "Default policy: workspace writes with broad host-permitted reads.",
      "Command network access is disabled. Approval policy is never.",
    ],
    limits: [
      "Stricter isolation, exhaustive ambient access containment, and universal descendant containment are not proved.",
      "Codex runs with the operator's existing runtime login; Ensemble does not provide an independent execution sandbox.",
    ],
  };
}

const claudePolicySchema = z
  .object({
    writableRoots: z.array(z.string().min(1)).min(1).max(16),
    sharedWriteRoots: z.array(z.string().min(1)).max(16),
    network: z.literal("denied"),
    fileToolConfinement: z.literal("hook"),
    limits: z.array(z.string().min(1).max(300)).max(12),
  })
  .strict();

/**
 * Maps `ClaudeRuntime.effectivePolicy(workspace)` to disclosure text. Raw roots are
 * named by category only, so no private data-directory path is rendered.
 */
export function claudePolicyDisclosure(
  input: unknown,
  workspace: string,
): PolicyDisclosure {
  const policy = claudePolicySchema.parse(input);
  const extra = policy.writableRoots.filter((root) => root !== workspace);
  const roots = [
    ...(policy.writableRoots.includes(workspace) ? ["the task workspace"] : []),
    ...(extra.length ? ["a per-task temporary directory"] : []),
  ];
  return {
    lines: [
      `Commands run in Claude Code's sandbox and can write only ${roots.join(" and ")}, with broad host-permitted reads.`,
      ...(policy.sharedWriteRoots.length
        ? [
            "A shared sandbox temporary directory is also writable; it is shared across tasks, not isolated per task.",
          ]
        : []),
      "Command network access is denied. There are no interactive approvals.",
      "File-editing tools are confined to the same roots by Ensemble's hook, not by the operating system.",
    ],
    limits: policy.limits,
  };
}
