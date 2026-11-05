import { z } from "zod";
import { commandNetworkDisclosure } from "../operator/command-network-copy.js";

export interface PolicyDisclosure {
  lines: string[];
  limits: string[];
}

/** What `taskGitWritableRoots` adds to a task turn, in both harnesses. */
const taskGitDisclosure =
  "In a task repository, Git commands can also write cab's per-project repository's objects/ and reftable/ and the worktree's own worktrees/<name>/ directory. Its root, config, info/ and hooks stay read-only, and the operator's checkout is never written.";

const taskGitLimits = [
  "Tasks of one project share their repository's objects and refs, so an agent can move another task's branches, though not its checked-out commit. Workspaces created before cab-owned repositories have no Git write access.",
  "The repository reads the operator's objects through an alternate, so pruning objects a task's base needs breaks it. git fetch, pull, gc and worktree add fail, because they write the repository root, and Git LFS and submodule metadata are not writable.",
  "cab keeps a project's repositories after the project is deleted; the operator can remove them.",
];

/** The retained Codex disclosure; `executionPolicy` in codex.ts is what it describes. */
export function codexPolicyDisclosure(): PolicyDisclosure {
  return {
    lines: [
      "Default policy: workspace writes with broad host-permitted reads.",
      "Command network access is disabled unless the project enables it. Approval policy is never.",
      taskGitDisclosure,
    ],
    limits: [
      ...taskGitLimits,
      "Stricter isolation, exhaustive ambient access containment, and universal descendant containment are not proved.",
      "Codex runs in cab's own Codex home with the operator's login linked; it loads no user Codex settings, only the skills enabled in the agent settings, and has subagents disabled. cab does not provide an independent execution sandbox.",
      "Codex gets plugin skills only from its agent settings, from local plugin directories or plugins installed in Claude Code or Codex, as skill directories: a plugin's hooks, MCP servers and apps are not loaded, and skills are instructions to the agent, not cab policy.",
      commandNetworkDisclosure,
    ],
  };
}

const claudePolicySchema = z
  .object({
    writableRoots: z.array(z.string().min(1)).min(1).max(16),
    sharedWriteRoots: z.array(z.string().min(1)).max(16),
    network: z.literal("denied"),
    fileToolConfinement: z.literal("hook"),
    limits: z.array(z.string().min(1).max(300)).max(20),
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
      "File-editing tools are confined to the same roots by cab's hook, not by the operating system.",
      taskGitDisclosure,
    ],
    limits: [...policy.limits, ...taskGitLimits],
  };
}
