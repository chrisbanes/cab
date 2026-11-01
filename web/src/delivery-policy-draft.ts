import {
  deliveryPolicySchema,
  type DeliveryPolicy,
} from "../../src/core/delivery.js";

export type DeliveryPolicyDraft = Omit<
  DeliveryPolicy,
  "version" | "credentialRef"
> & {
  version: number;
  credentialIntent: "keep" | "clear" | "set";
};

/** Retains policy shape exactly while representing credentials as an intent, never a saved reference. */
export function deliveryPolicyDraft(
  policy: DeliveryPolicy,
): DeliveryPolicyDraft {
  const { version, ...configuration } = policy;
  const { credentialRef, ...values } =
    deliveryPolicySchema.parse(configuration);
  return {
    ...structuredClone(values),
    version,
    credentialIntent: credentialRef === null ? "clear" : "keep",
  };
}

export type StatusMappingCoverage =
  | { tracker: "jira"; repositoryId: string; granted: string[] }
  | {
      tracker: "github";
      repositoryId: string;
      granted: {
        projectNodeId: string;
        fieldNodeId: string;
        optionNodeIds: string[];
      }[];
    };

/** Warns for status mappings not fully covered by allow grants, using the same keys as execution. */
export function statusMappingCoverageWarning(
  draft: DeliveryPolicyDraft,
  coverage: StatusMappingCoverage,
): string | null {
  const mappingGrants = draft.grants.filter(
    (grant) => grant.action === "issue.status" && grant.mode === "allow",
  );
  if (coverage.tracker === "jira") {
    const covered = new Set(
      mappingGrants
        .filter((grant) => grant.repositoryId === coverage.repositoryId)
        .flatMap((grant) => grant.statusIds ?? []),
    );
    return coverage.granted.every((statusId) => covered.has(statusId))
      ? null
      : "Some Jira status mappings are not covered by allow grants.";
  }
  const covered = new Set(
    mappingGrants.flatMap((grant) =>
      (grant.repositoryId === coverage.repositoryId
        ? (grant.optionNodeIds ?? [])
        : []
      ).map(
        (option) =>
          `${grant.repositoryId}\0${grant.projectNodeId}\0${grant.fieldNodeId}\0${option}`,
      ),
    ),
  );
  return coverage.granted.every((grant) =>
    grant.optionNodeIds.every((option) =>
      covered.has(
        `${coverage.repositoryId}\0${grant.projectNodeId}\0${grant.fieldNodeId}\0${option}`,
      ),
    ),
  )
    ? null
    : "Some GitHub status mappings are not covered by allow grants.";
}

/** Human-readable changed fields omit credential references and other hidden material. */
export function deliveryPolicyChangeText(
  before: DeliveryPolicyDraft,
  after: DeliveryPolicyDraft,
): string[] {
  const changes: string[] = [];
  if (before.mode !== after.mode) changes.push("Delivery mode changed");
  if (before.branchPrefix !== after.branchPrefix)
    changes.push("Branch prefix changed");
  if (JSON.stringify(before.grants) !== JSON.stringify(after.grants))
    changes.push("Delivery grants changed");
  if (
    JSON.stringify(before.requiredChecks) !==
    JSON.stringify(after.requiredChecks)
  )
    changes.push("Required checks changed");
  if (before.credentialIntent !== after.credentialIntent)
    changes.push("Credential setting changed");
  return changes;
}
