import type { DeliveryPolicy } from "./delivery.js";

export const repositoryLevelActions = [
  "branch.push",
  "branch.force-push",
  "pr.create",
  "pr.edit",
  "pr.ready",
  "pr.thread.reply",
  "pr.thread.resolve",
  "pr.merge",
] as const;

export type RepositoryDeliveryLevel =
  | "not-set-up"
  | "custom"
  | "open-prs"
  | "merge-with-approval"
  | "merge-when-ready";

type Grant = DeliveryPolicy["grants"][number];

const levels = {
  "open-prs": [
    ["branch.push", "allow"],
    ["branch.force-push", "approval"],
    ["pr.create", "allow"],
    ["pr.edit", "allow"],
    ["pr.ready", "allow"],
    ["pr.thread.reply", "allow"],
    ["pr.thread.resolve", "allow"],
  ],
  "merge-with-approval": [
    ["branch.push", "allow"],
    ["branch.force-push", "approval"],
    ["pr.create", "allow"],
    ["pr.edit", "allow"],
    ["pr.ready", "allow"],
    ["pr.thread.reply", "allow"],
    ["pr.thread.resolve", "allow"],
    ["pr.merge", "approval"],
  ],
  "merge-when-ready": [
    ["branch.push", "allow"],
    ["branch.force-push", "approval"],
    ["pr.create", "allow"],
    ["pr.edit", "allow"],
    ["pr.ready", "allow"],
    ["pr.thread.reply", "allow"],
    ["pr.thread.resolve", "allow"],
    ["pr.merge", "allow"],
  ],
} as const satisfies Record<
  string,
  readonly (readonly [Grant["action"], Grant["mode"]])[]
>;

export const isCodeHostGrant = (grant: Grant) =>
  !grant.action.startsWith("issue.") && !grant.action.startsWith("project.");

export function repositoryDeliveryLevel(
  grants: readonly Grant[],
  repositoryId: string,
): RepositoryDeliveryLevel {
  const scoped = grants.filter(
    (grant) => isCodeHostGrant(grant) && grant.repositoryId === repositoryId,
  );
  if (scoped.length === 0) return "not-set-up";
  for (const [level, expected] of Object.entries(levels)) {
    const rows = scoped.filter((grant) =>
      repositoryLevelActions.includes(
        grant.action as (typeof repositoryLevelActions)[number],
      ),
    );
    if (
      rows.length === expected.length &&
      rows.every((grant) =>
        Object.keys(grant).every((key) =>
          ["action", "mode", "repositoryId"].includes(key),
        ),
      ) &&
      expected.every(([action, mode]) => {
        const matching = rows.filter((grant) => grant.action === action);
        return matching.length === 1 && matching[0]?.mode === mode;
      })
    )
      return level as RepositoryDeliveryLevel;
  }
  return "custom";
}

export function repositoryLevelGrants(
  repositoryId: string,
  level: Exclude<RepositoryDeliveryLevel, "not-set-up" | "custom">,
): DeliveryPolicy["grants"] {
  return levels[level].map(([action, mode]) => ({
    action,
    mode,
    repositoryId,
  }));
}
