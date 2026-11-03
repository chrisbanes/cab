import type { z } from "zod";
import type {
  deliveryConfigurationSchema,
  statusMappingViewSchema,
} from "../../src/operator/contracts.js";
import { type RepositoryNames, repositoryLabel } from "./presentation.js";
import type { FieldsRead, projectChoices } from "./readiness-discovery.js";
import type { Values } from "./settings-changes.js";
import {
  repositoryDeliveryLevel,
  repositoryLevelActions,
  repositoryLevelGrants,
  type RepositoryDeliveryLevel,
} from "../../src/core/delivery-levels.js";
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
type DeliveryConfiguration = z.infer<typeof deliveryConfigurationSchema>;
/** A linked repository as the server reads it: settings plus live code-host requirements. */
export type RepositoryDeliveryRead = NonNullable<
  DeliveryConfiguration["repositories"]
>[number];
/** The editable part of a repository's delivery settings. */
export type RepositorySetting = Pick<
  RepositoryDeliveryRead,
  "repositoryId" | "mergeMethod" | "additionalChecks"
>;
export type DeliveryPolicyValues = Omit<
  DeliveryConfiguration,
  "version" | "credentialConfigured" | "credential" | "repositories"
> & { repositories?: RepositorySetting[] | undefined };
const repositorySetting = ({
  repositoryId,
  mergeMethod,
  additionalChecks,
}: RepositorySetting): RepositorySetting => ({
  repositoryId,
  mergeMethod,
  additionalChecks,
});
export type DeliveryPolicySeed = DeliveryPolicyValues & {
  version: number;
  credentialConfigured: boolean;
  credential?: unknown;
};
export type DeliveryPolicyDraft = DeliveryPolicyValues & {
  version: number;
  credentialIntent: "preserve" | "clear" | "set";
  credentialInput?: string;
  grantKeys: string[];
  requiredCheckKeys: string[];
};

export type { RepositoryDeliveryLevel };
export type DeliveryLevelView = RepositoryDeliveryLevel | "unavailable";
export function deliveryLevelView(
  grants: DeliveryPolicyValues["grants"],
  repositoryId: string | null,
): DeliveryLevelView {
  if (repositoryId === null || grants.some((row) => "savedRow" in row))
    return "unavailable";
  return repositoryDeliveryLevel(grants as DeliveryGrant[], repositoryId);
}
export type DeliveryLevelResult =
  | { kind: "applied"; draft: DeliveryPolicyDraft }
  | { kind: "unavailable"; message: string }
  | { kind: "invalid"; message: string };

export function applyRepositoryDeliveryLevel(
  draft: DeliveryPolicyDraft,
  repositoryIds: readonly (string | null)[],
  level: Exclude<RepositoryDeliveryLevel, "not-set-up" | "custom">,
): DeliveryLevelResult {
  if (
    repositoryIds.some((id) => id === null) ||
    draft.grants.some((row) => "savedRow" in row)
  )
    return {
      kind: "unavailable",
      message:
        "Complete repository and grant details are required to apply a level.",
    };
  const targets = new Set(repositoryIds as string[]);
  if (!targets.size)
    return {
      kind: "invalid",
      message: "Choose at least one linked repository.",
    };
  const changed = new Set(
    [...targets].filter(
      (id) =>
        repositoryDeliveryLevel(draft.grants as DeliveryGrant[], id) !== level,
    ),
  );
  const grants: DeliveryGrant[] = [];
  const grantKeys: string[] = [];
  draft.grants.forEach((row, index) => {
    const grant = row as DeliveryGrant;
    if (
      changed.has(grant.repositoryId) &&
      (repositoryLevelActions as readonly string[]).includes(grant.action)
    )
      return;
    grants.push(grant);
    grantKeys.push(draft.grantKeys[index]!);
  });
  for (const id of changed) grants.push(...repositoryLevelGrants(id, level));
  if (grants.length > 256)
    return {
      kind: "invalid",
      message:
        "This level would exceed 256 grants. Remove grants or select fewer repositories.",
    };
  const used = new Set(draft.grantKeys);
  for (let index = grantKeys.length; index < grants.length; index++) {
    let key = `level-grant-${index}`;
    while (used.has(key)) key += "-new";
    used.add(key);
    grantKeys.push(key);
  }
  const mode = [...new Set(grants.map((g) => g.repositoryId))].some((id) => {
    const derived = repositoryDeliveryLevel(grants, id);
    return derived === "merge-with-approval" || derived === "merge-when-ready";
  })
    ? "through-merge"
    : "reviewable-pr";
  return {
    kind: "applied",
    draft:
      !changed.size && mode === draft.mode
        ? draft
        : { ...draft, grants, grantKeys, mode },
  };
}

export function deliveryPolicyDraft(
  seed: DeliveryPolicySeed,
): DeliveryPolicyDraft {
  const {
    credentialConfigured: _configured,
    credential: _credential,
    repositories,
    ...values
  } = seed;
  return {
    ...structuredClone(values),
    ...(repositories
      ? { repositories: structuredClone(repositories.map(repositorySetting)) }
      : {}),
    credentialIntent: "preserve",
    grantKeys: values.grants.map((_, index) => `grant-${index}`),
    requiredCheckKeys: values.requiredChecks.map(
      (_, index) => `check-${index}`,
    ),
  };
}

export function addGrantRow(
  draft: DeliveryPolicyDraft,
  grant: DeliveryPolicyValues["grants"][number],
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

const deliveryCredentialPattern = /^(?:env:[A-Z][A-Z0-9_]*|gh:github\.com)$/;

/** Builds JSON input with opaque keep references; credential input exists only for an explicit Set. */
export function deliveryPolicySubmission(draft: DeliveryPolicyDraft) {
  const {
    version: _version,
    credentialIntent,
    credentialInput,
    grantKeys: _grantKeys,
    requiredCheckKeys: _requiredCheckKeys,
    branchPrefixUnavailable: _prefixUnavailable,
    branchPrefix,
    repositories,
    ...policy
  } = draft;
  const keep = <T extends object>(row: T) =>
    ("savedRow" in row
      ? { savedRow: row.savedRow, keep: true }
      : row) as T extends { savedRow: infer S }
      ? { savedRow: S; keep: true }
      : T;
  const values = {
    ...policy,
    ...(branchPrefix === null
      ? { preserveBranchPrefix: true as const }
      : branchPrefix !== undefined
        ? { branchPrefix }
        : {}),
    grants: policy.grants.map(keep),
    // Per-repository settings replace the project-wide list, which then saves empty. With no
    // visible repository there is nothing to move it into, so it is kept as it is.
    requiredChecks: repositories?.length ? [] : policy.requiredChecks.map(keep),
    ...(repositories?.length
      ? {
          repositories: repositories.map((r) => ({
            repositoryId: r.repositoryId,
            ...(r.mergeMethod ? { mergeMethod: r.mergeMethod } : {}),
            requiredChecks: r.additionalChecks.map(keep),
          })),
        }
      : {}),
  };
  if (credentialIntent === "set") {
    if (!credentialInput || !deliveryCredentialPattern.test(credentialInput))
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
    draft.branchPrefix !== null &&
    !branchPrefixValid(draft.branchPrefix)
  )
    add("branchPrefix", "Enter a valid branch prefix.");
  draft.grants.forEach((grant, index) => {
    if ("savedRow" in grant) {
      if (grant.savedRow.version !== draft.version)
        add(
          `grants.${draft.grantKeys[index] ?? index}.savedRow`,
          "This unavailable row belongs to an older version. Remove it or discard changes to load the latest saved rows.",
        );
      return;
    }
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
    for (const field of ["projectNodeId", "fieldNodeId"] as const)
      if (grant[field] !== undefined && !identityValid(grant[field]))
        add(`${at}.${field}`, "Enter a valid ID.");
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
    if ("savedRow" in check) {
      if (check.savedRow.version !== draft.version)
        add(
          `requiredChecks.${draft.requiredCheckKeys[index] ?? index}.savedRow`,
          "This unavailable row belongs to an older version. Remove it or discard changes to load the latest saved rows.",
        );
      return;
    }
    const at = `requiredChecks.${draft.requiredCheckKeys[index] ?? index}`;
    if (!identityValid(check.name)) add(`${at}.name`, "Enter a check name.");
    if (
      check.appId !== undefined &&
      (!Number.isSafeInteger(check.appId) || check.appId <= 0)
    )
      add(`${at}.appId`, "Enter a positive integer app ID.");
  });
  draft.repositories?.forEach((repository, r) => {
    const at = `repositories.${r}`;
    if (repository.additionalChecks.length > 100)
      add(`${at}.requiredChecks`, "At most 100 additional checks are allowed.");
    repository.additionalChecks.forEach((check, index) => {
      const row = `${at}.requiredChecks.${index}`;
      if ("savedRow" in check) {
        if (check.savedRow.version !== draft.version)
          add(
            `${row}.savedRow`,
            "This unavailable row belongs to an older version. Remove it or discard changes to load the latest saved rows.",
          );
        return;
      }
      if (!identityValid(check.name)) add(`${row}.name`, "Enter a check name.");
      if (
        check.appId !== undefined &&
        (!Number.isSafeInteger(check.appId) || check.appId <= 0)
      )
        add(`${row}.appId`, "Enter a positive integer app ID.");
    });
  });
  if (
    draft.credentialIntent === "set" &&
    (!draft.credentialInput ||
      !deliveryCredentialPattern.test(draft.credentialInput))
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
        "savedRow" in grant ||
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
  links?: RepositoryNames,
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
  for (const next of after.repositories ?? []) {
    const prior = before.repositories?.find(
      (r) => r.repositoryId === next.repositoryId,
    );
    if ((prior?.mergeMethod ?? null) !== next.mergeMethod)
      changes.push(
        `Merge method changed for ${repositoryLabel(next.repositoryId, links)}`,
      );
    if (
      JSON.stringify(prior?.additionalChecks ?? []) !==
      JSON.stringify(next.additionalChecks)
    )
      changes.push(
        `Additional required checks changed for ${repositoryLabel(next.repositoryId, links)}`,
      );
  }
  if (after.repositories?.length && before.requiredChecks.length)
    changes.push(
      "Project-wide required checks move into each repository's additional checks",
    );
  return changes;
}
import type { DeliveryPolicy } from "../../src/core/delivery.js";

/** Stable UI keys never enter the submitted policy or indexed API paths. */
export function deliveryFieldErrors(
  draft: DeliveryPolicyDraft,
): Record<string, string> {
  return Object.fromEntries(
    validateDeliveryPolicyDraft(draft).map(({ path, message }) => {
      const parts = path.split(".");
      if (
        parts[0] === "grants" &&
        parts[1] &&
        draft.grantKeys.includes(parts[1])
      )
        parts[1] = String(draft.grantKeys.indexOf(parts[1]));
      if (
        parts[0] === "requiredChecks" &&
        parts[1] &&
        draft.requiredCheckKeys.includes(parts[1])
      )
        parts[1] = String(draft.requiredCheckKeys.indexOf(parts[1]));
      if (path === "credentialInput") parts[0] = "credentialRef";
      return [parts.join("."), message];
    }),
  );
}
export function deliveryEditorValues(seed: DeliveryPolicySeed): Values {
  const draft = deliveryPolicyDraft(seed);
  return {
    expectedVersion: String(seed.version),
    mode: seed.mode,
    prefixMode:
      seed.branchPrefix === null
        ? "preserve"
        : seed.branchPrefix === undefined
          ? "default"
          : "set",
    branchPrefix: seed.branchPrefix ?? "",
    referenceMode: "preserve",
    credentialRef: "",
    grants: JSON.stringify(
      draft.grants.map((row, index) => ({
        ...row,
        rowKey: draft.grantKeys[index],
      })),
    ),
    requiredChecks: JSON.stringify(
      draft.requiredChecks.map((row, index) => ({
        ...checkInput(row),
        rowKey: draft.requiredCheckKeys[index],
      })),
    ),
    ...(draft.repositories
      ? {
          repositories: JSON.stringify(
            draft.repositories.map((r) => ({
              ...r,
              additionalChecks: r.additionalChecks.map((row, index) => ({
                ...checkInput(row),
                rowKey: `${r.repositoryId}-check-${index}`,
              })),
            })),
          ),
        }
      : {}),
  };
}
type CheckValue = DeliveryPolicyValues["requiredChecks"][number];
const checkInput = (row: CheckValue) =>
  !("savedRow" in row) && row.appId !== undefined
    ? { ...row, appId: String(row.appId) }
    : row;
const checkValue = ({ rowKey: _key, ...row }: CheckRow): CheckValue => {
  if ("savedRow" in row) return row;
  const { appId, ...check } = row;
  return {
    ...check,
    ...(appId === undefined
      ? {}
      : { appId: String(appId).trim() === "" ? NaN : Number(appId) }),
  };
};
/** A repository's settings as the editor holds them, with keyed check rows. */
export type RepositoryRow = Omit<RepositorySetting, "additionalChecks"> & {
  additionalChecks: CheckRow[];
};
type Keyed<T> = T & { rowKey: string };
export type GrantRow = Keyed<DeliveryPolicyValues["grants"][number]>;
type VisibleCheck = Extract<
  DeliveryPolicyValues["requiredChecks"][number],
  { name: string }
>;
export type CheckRow = Keyed<
  | Extract<
      DeliveryPolicyValues["requiredChecks"][number],
      { kind: "unavailable" }
    >
  | (Omit<VisibleCheck, "appId"> & { appId?: VisibleCheck["appId"] | string })
>;
export function deliveryRows<T>(value: Values[string] | undefined): T[] {
  return typeof value === "string" ? JSON.parse(value) : [];
}
export function deliveryEditorDraft(values: Values): DeliveryPolicyDraft {
  const grants = deliveryRows<GrantRow>(values.grants);
  const checks = deliveryRows<CheckRow>(values.requiredChecks);
  return {
    version: Number(values.expectedVersion),
    mode: values.mode === "through-merge" ? "through-merge" : "reviewable-pr",
    ...(values.prefixMode === "preserve"
      ? { branchPrefix: null, branchPrefixUnavailable: true as const }
      : values.prefixMode === "set"
        ? { branchPrefix: String(values.branchPrefix ?? "") }
        : {}),
    credentialIntent:
      values.referenceMode === "set" || values.referenceMode === "gh"
        ? "set"
        : values.referenceMode === "clear"
          ? "clear"
          : "preserve",
    ...(values.referenceMode === "set"
      ? { credentialInput: String(values.credentialRef ?? "") }
      : values.referenceMode === "gh"
        ? { credentialInput: "gh:github.com" }
        : {}),
    grantKeys: grants.map((row) => row.rowKey),
    requiredCheckKeys: checks.map((row) => row.rowKey),
    grants: grants.map(({ rowKey: _key, ...row }) => row),
    requiredChecks: checks.map(checkValue),
    ...(values.repositories === undefined
      ? {}
      : {
          repositories: deliveryRows<RepositoryRow>(values.repositories).map(
            (r) => ({
              ...r,
              additionalChecks: r.additionalChecks.map(checkValue),
            }),
          ),
        }),
  };
}

/** Compare only configured mapping targets, independently in each exact tracker container scope. */
export function deliveryMappingCoverageLoss(
  saved: DeliveryPolicyValues,
  proposed: DeliveryPolicyValues,
  view: z.infer<typeof statusMappingViewSchema> | undefined,
): boolean {
  if (view?.availability !== "available" || !view.mapping) return false;
  const mapping = view.mapping;
  const options = Object.values(mapping.events).filter(
    (id): id is string => id !== null,
  );
  return [
    ...new Set(
      saved.grants.flatMap((grant) =>
        "savedRow" in grant ? [] : [grant.repositoryId],
      ),
    ),
  ].some(
    (repositoryId) =>
      statusMappingCoverageLoss(
        saved,
        proposed,
        "tracker" in mapping
          ? { tracker: "jira", repositoryId, granted: options }
          : {
              tracker: "github",
              repositoryId,
              granted: [
                {
                  projectNodeId: mapping.projectNodeId,
                  fieldNodeId: mapping.fieldNodeId,
                  optionNodeIds: options,
                },
              ],
            },
      ).length > 0,
  );
}

/** Distinguish confirmed mapped-target loss from a conservative warning when that view is withheld. */
export function deliveryMappingCoverageWarning(
  saved: DeliveryPolicyValues,
  proposed: DeliveryPolicyValues,
  view: z.infer<typeof statusMappingViewSchema> | undefined,
): string | null {
  if (deliveryMappingCoverageLoss(saved, proposed, view))
    return "Previously allowed mapped status changes lose authority in a saved tracker scope. The status mapping is unchanged.";
  if (view !== undefined) return null;
  const reduced = saved.grants.some((grant) => {
    if ("savedRow" in grant || grant.mode !== "allow") return false;
    let coverage: StatusMappingCoverage;
    if (grant.action === "issue.status")
      coverage = {
        tracker: "jira",
        repositoryId: grant.repositoryId,
        granted: grant.statusIds ?? [],
      };
    else if (
      grant.action === "project.field" &&
      grant.projectNodeId &&
      grant.fieldNodeId
    )
      coverage = {
        tracker: "github",
        repositoryId: grant.repositoryId,
        granted: [
          {
            projectNodeId: grant.projectNodeId,
            fieldNodeId: grant.fieldNodeId,
            optionNodeIds: grant.optionNodeIds ?? [],
          },
        ],
      };
    else return false;
    return statusMappingCoverageLoss(saved, proposed, coverage).length > 0;
  });
  return reduced
    ? "Status-mapping details are unavailable. These changes may remove status-mapping authority. The saved mapping is unchanged."
    : null;
}

/**
 * What a grant row's identity IDs refer to, for the names shown beside the inputs. Only what is
 * known is named: a repository with a verified name, and a Project, field and options a listed
 * discovery read supplies. The values stay IDs.
 */
export function grantIdentityNames(
  row: {
    repositoryId: string;
    projectNodeId?: string | undefined;
    fieldNodeId?: string | undefined;
    optionNodeIds?: readonly string[] | undefined;
  },
  links: RepositoryNames,
  discovery: {
    choices: ReturnType<typeof projectChoices>;
    fieldReads: Record<string, FieldsRead | undefined>;
  },
) {
  const field =
    row.projectNodeId && row.fieldNodeId
      ? discovery.fieldReads[row.projectNodeId]
      : undefined;
  const listed =
    field?.state === "ready"
      ? field.fields.find((f) => f.fieldNodeId === row.fieldNodeId)
      : undefined;
  const options = (row.optionNodeIds ?? []).flatMap((id) => {
    const name = listed?.options.find((o) => o.optionNodeId === id)?.name;
    return name ? [name] : [];
  });
  return {
    repository:
      links.find((l) => l.repositoryId === row.repositoryId)?.name || undefined,
    project:
      discovery.choices.state === "ready"
        ? discovery.choices.projects.find(
            (p) => p.projectNodeId === row.projectNodeId,
          )?.label
        : undefined,
    field: listed?.name,
    options: options.length ? options : undefined,
  };
}
