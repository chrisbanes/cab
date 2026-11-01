export const deliveryActionKinds = [
  "issue.comment",
  "issue.labels",
  "issue.edit",
  "issue.create",
  "project.item.add",
  "project.field",
  "issue.status",
  "pr.create",
  "pr.edit",
  "pr.ready",
  "pr.merge",
  "issue.close",
  "pr.thread.reply",
  "pr.thread.resolve",
  "branch.push",
  "branch.force-push",
  "branch.adopt",
] as const;
export type DeliveryAction = DeliveryPolicy["grants"][number]["action"];
export type DeliveryGrant = DeliveryPolicy["grants"][number];
export type DeliveryPolicyValues = Omit<
  DeliveryPolicy,
  "version" | "credentialRef"
>;
export type DeliveryPolicySeed = DeliveryPolicyValues & {
  version: number;
  credentialConfigured: boolean;
};
export type DeliveryPolicyDraft = DeliveryPolicyValues & {
  version: number;
  credentialIntent: "preserve" | "clear" | "set";
  credentialInput?: string;
  grantKeys: string[];
  requiredCheckKeys: string[];
};

export function deliveryPolicyDraft(
  seed: DeliveryPolicySeed,
): DeliveryPolicyDraft {
  const { credentialConfigured: _configured, ...values } = seed;
  return {
    ...structuredClone(values),
    credentialIntent: "preserve",
    grantKeys: values.grants.map((_, index) => `grant-${index}`),
    requiredCheckKeys: values.requiredChecks.map(
      (_, index) => `check-${index}`,
    ),
  };
}

export function addGrantRow(
  draft: DeliveryPolicyDraft,
  grant: DeliveryGrant,
  key: string,
): DeliveryPolicyDraft {
  if (!key || draft.grantKeys.includes(key))
    throw new Error("Grant row key must be new and non-empty.");
  return {
    ...draft,
    grants: [...draft.grants, structuredClone(grant)],
    grantKeys: [...draft.grantKeys, key],
  };
}

export function removeGrantRow(
  draft: DeliveryPolicyDraft,
  key: string,
): DeliveryPolicyDraft {
  const index = draft.grantKeys.indexOf(key);
  if (index < 0) return draft;
  return {
    ...draft,
    grants: draft.grants.filter((_, i) => i !== index),
    grantKeys: draft.grantKeys.filter((_, i) => i !== index),
  };
}

export function addRequiredCheckRow(
  draft: DeliveryPolicyDraft,
  check: DeliveryPolicy["requiredChecks"][number],
  key: string,
): DeliveryPolicyDraft {
  if (!key || draft.requiredCheckKeys.includes(key))
    throw new Error("Required check row key must be new and non-empty.");
  return {
    ...draft,
    requiredChecks: [...draft.requiredChecks, structuredClone(check)],
    requiredCheckKeys: [...draft.requiredCheckKeys, key],
  };
}

/** Produces the unchanged domain policy shape; a credential value exists only for a Set submission. */
export function deliveryPolicySubmission(draft: DeliveryPolicyDraft) {
  const {
    version: _version,
    credentialIntent,
    credentialInput,
    grantKeys: _grantKeys,
    requiredCheckKeys: _requiredCheckKeys,
    ...values
  } = draft;
  if (credentialIntent === "set") {
    if (!credentialInput || !/^env:[A-Z][A-Z0-9_]*$/.test(credentialInput))
      throw new Error("Enter a valid delivery credential reference.");
    return { ...structuredClone(values), credentialRef: credentialInput };
  }
  if (credentialIntent === "clear")
    return { ...structuredClone(values), credentialRef: null };
  return structuredClone(values);
}

export type DeliveryPolicyFieldError = { path: string; message: string };
const identityValid = (value: string) =>
  value.trim().length > 0 && value.trim().length <= 512;
const branchPrefixValid = (value: string) =>
  value.length <= 64 &&
  !value.startsWith("/") &&
  /^[A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes("..") &&
  !value.includes("//") &&
  value.split("/").every((part) => !/^[.-]|\.lock$/.test(part));

/** Indexed field errors for the domain's accepted policy shape and configure-time grant rules. */
export function validateDeliveryPolicyDraft(
  draft: DeliveryPolicyDraft,
): DeliveryPolicyFieldError[] {
  const errors: DeliveryPolicyFieldError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });
  if (draft.grants.length > 256)
    add("grants", "At most 256 grants are allowed.");
  if (draft.requiredChecks.length > 100)
    add("requiredChecks", "At most 100 required checks are allowed.");
  if (
    draft.branchPrefix !== undefined &&
    !branchPrefixValid(draft.branchPrefix)
  )
    add("branchPrefix", "Enter a valid branch prefix.");
  draft.grants.forEach((grant, index) => {
    const at = `grants.${draft.grantKeys[index] ?? index}`;
    if (!identityValid(grant.repositoryId))
      add(`${at}.repositoryId`, "Enter a repository or tracker container ID.");
    if (grant.action === "branch.adopt" && grant.mode !== "approval")
      add(`${at}.mode`, "Branch adoption grants require approval.");
    if (grant.action === "project.field") {
      if (!grant.projectNodeId || !identityValid(grant.projectNodeId))
        add(`${at}.projectNodeId`, "Choose a Project.");
      if (!grant.fieldNodeId || !identityValid(grant.fieldNodeId))
        add(`${at}.fieldNodeId`, "Choose a field.");
      if (!grant.optionNodeIds?.length)
        add(`${at}.optionNodeIds`, "Choose at least one option.");
    }
    if (
      grant.action === "project.item.add" &&
      (!grant.projectNodeId || !identityValid(grant.projectNodeId))
    )
      add(`${at}.projectNodeId`, "Choose a Project.");
    if (grant.action === "issue.status") {
      if (!grant.statusIds?.length)
        add(`${at}.statusIds`, "Choose at least one status.");
      if ((grant.statusIds?.length ?? 0) > 256)
        add(`${at}.statusIds`, "At most 256 statuses are allowed.");
    } else if (grant.statusIds !== undefined)
      add(`${at}.statusIds`, "Only issue status grants can include statuses.");
    for (const [field, ids] of [
      ["optionNodeIds", grant.optionNodeIds],
      ["statusIds", grant.statusIds],
    ] as const)
      ids?.forEach((id, optionIndex) => {
        if (!identityValid(id))
          add(`${at}.${field}.${optionIndex}`, "Enter a valid ID.");
      });
  });
  draft.requiredChecks.forEach((check, index) => {
    const at = `requiredChecks.${draft.requiredCheckKeys[index] ?? index}`;
    if (!identityValid(check.name)) add(`${at}.name`, "Enter a check name.");
    if (
      check.appId !== undefined &&
      (!Number.isInteger(check.appId) || check.appId <= 0)
    )
      add(`${at}.appId`, "Enter a positive integer app ID.");
  });
  if (
    draft.credentialIntent === "set" &&
    (!draft.credentialInput ||
      !/^env:[A-Z][A-Z0-9_]*$/.test(draft.credentialInput))
  )
    add("credentialInput", "Enter a valid delivery credential reference.");
  if (draft.grantKeys.length !== draft.grants.length)
    add("grants", "Grant row keys do not match the grant rows.");
  if (draft.requiredCheckKeys.length !== draft.requiredChecks.length)
    add(
      "requiredChecks",
      "Required check row keys do not match the check rows.",
    );
  if (new Set(draft.grantKeys).size !== draft.grantKeys.length)
    add("grants", "Grant row keys must be unique.");
  if (new Set(draft.requiredCheckKeys).size !== draft.requiredCheckKeys.length)
    add("requiredChecks", "Required check row keys must be unique.");
  return errors;
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

function coveredStatusOptions(
  values: DeliveryPolicyValues,
  coverage: StatusMappingCoverage,
): Set<string> {
  return new Set(
    values.grants.flatMap((grant) => {
      if (
        grant.mode !== "allow" ||
        grant.repositoryId !== coverage.repositoryId
      )
        return [];
      if (coverage.tracker === "jira")
        return grant.action === "issue.status" ? (grant.statusIds ?? []) : [];
      if (grant.action !== "project.field") return [];
      return (grant.optionNodeIds ?? []).map(
        (option) => `${grant.projectNodeId}\0${grant.fieldNodeId}\0${option}`,
      );
    }),
  );
}

function mappingKeys(coverage: StatusMappingCoverage): string[] {
  return coverage.tracker === "jira"
    ? coverage.granted
    : coverage.granted.flatMap((field) =>
        field.optionNodeIds.map(
          (option) => `${field.projectNodeId}\0${field.fieldNodeId}\0${option}`,
        ),
      );
}

/** Reports loss of previously covered mapping options only; newly uncovered options are not removals. */
export function statusMappingCoverageLoss(
  saved: DeliveryPolicyValues,
  proposed: DeliveryPolicyValues,
  coverage: StatusMappingCoverage,
): string[] {
  const savedGrants = coveredStatusOptions(saved, coverage);
  const proposedGrants = coveredStatusOptions(proposed, coverage);
  return mappingKeys(coverage).filter(
    (key) => savedGrants.has(key) && !proposedGrants.has(key),
  );
}

export function deliveryPolicyChangeText(
  before: DeliveryPolicyValues,
  after: DeliveryPolicyValues,
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
  return changes;
}
import type { DeliveryPolicy } from "../../src/core/delivery.js";
