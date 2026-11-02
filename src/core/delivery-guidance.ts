import type { DeliveryPolicy } from "./delivery.js";
import { isCodeHostGrant, repositoryDeliveryLevel } from "./delivery-levels.js";

const mergeBlockers = "once the PR has no merge blockers";

// Advisory prompt text for the project lead; cab tools still enforce grants.
export function leadDeliveryGuidance(
  policy: Pick<DeliveryPolicy, "mode" | "grants">,
  repositoryIds: readonly string[],
): string {
  const mergeCaveat =
    policy.mode !== "through-merge"
      ? " This project's delivery mode refuses pr.merge, so stop at a green PR."
      : "";
  const line = (repositoryId: string): string => {
    switch (repositoryDeliveryLevel(policy.grants, repositoryId)) {
      case "open-prs":
        return "Open PRs: stop at a green PR, because the operator merges. Do not request pr.merge.";
      case "merge-with-approval":
        return `Merge with my approval: ${mergeBlockers}, request pr.merge, which waits for operator approval.${mergeCaveat}`;
      case "merge-when-ready":
        return `Merge when ready: ${mergeBlockers}, perform pr.merge.${mergeCaveat}`;
      case "not-set-up":
        return "Not set up: no code-host actions are granted for this repository.";
      case "custom": {
        const granted = policy.grants
          .filter((g) => isCodeHostGrant(g) && g.repositoryId === repositoryId)
          .map((g) => `${g.action} (${g.mode})`);
        return `Custom: granted code-host actions are ${granted.join(", ")}.`;
      }
    }
  };
  return [
    "Delivery levels for linked repositories:",
    ...(repositoryIds.length === 0
      ? ["No linked repositories."]
      : repositoryIds.map((id) => `- ${id}: ${line(id)}`)),
    "At every level, ask the operator through cab_ask_question after three unsuccessful repairs of the same failure, or when reviewers give conflicting direction. This is guidance, not enforced; project instructions still apply in addition.",
  ].join("\n");
}
