import { TaskReviewStore } from "./task-review.js";
import {
  issueBodyLimit,
  issueCurrentBodyLimit,
  issueTitleLimit,
} from "./issue-text-limits.js";
import { DomainConflictError, DomainPolicyError } from "./domain-errors.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { githubIssueTracker } from "./github-source-contracts.js";
import {
  itemIs,
  itemKey,
  sameItem,
  type SourceTracker,
} from "./source-storage.js";
import { transaction, type Database } from "./store.js";
import { StatusMappingStore } from "./status-mapping.js";
import {
  isInFlightEvent,
  isJiraMapping,
  statusMappingEvents,
} from "./status-mapping-contracts.js";
import {
  evaluateReadiness,
  projectFieldsSchema,
  readinessSchema,
} from "./github-source-contracts.js";

const identity = z.string().trim().min(1).max(512);
export const actionKinds = [
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
/** Whether an action writes to the project's issue tracker; every other kind writes to its code host. */
export const isIssueTrackerAction = (kind: (typeof actionKinds)[number]) =>
  kind.startsWith("issue.") || kind.startsWith("project.");
export const defaultBranchPrefix = "cab/";
/** Git's all-zero id, recorded as the outside head when the remote branch is absent. */
export const absentBranchHead = "0".repeat(40);
const branchPrefixMax = 64;
/** Ref-safety of a name, or of its leading part, which may end mid-segment (`team-`); no length rule. */
function refSafe(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    name.split("/").every((s) => !/^[.-]|\.lock$/.test(s))
  );
}
/** A project's branch prefix: ref-safe and at most 64 characters. */
export function validBranchPrefix(prefix: string): boolean {
  // A leading slash would give every generated name an empty first segment.
  return (
    prefix.length <= branchPrefixMax &&
    !prefix.startsWith("/") &&
    refSafe(prefix)
  );
}
const titleStartsWith = (title: string, key: string) =>
  title.startsWith(key) && !/[A-Za-z0-9_-]/.test(title.charAt(key.length));
const closingKeyword =
  /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?)\b/i;
// No trailing boundary: GitLab links `ABC-7x` as ABC-7.
const jiraKeyShaped = /\b[A-Z][A-Z0-9_]*-\d+/;
/**
 * Whether a line has a closing keyword (GitLab's default set) followed by something shaped like a
 * Jira key. It errs toward refusal: any key on the line counts, even one the keyword is not next to.
 */
function closesJiraIssue(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const keyword = closingKeyword.exec(line);
    return !!keyword && jiraKeyShaped.test(line.slice(keyword.index));
  });
}
/** A complete, cab-assigned task branch name. */
export function safeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 160 &&
    refSafe(name) &&
    !/[./-]$/.test(name) &&
    !name.startsWith("/")
  );
}
export const deliveryPolicySchema = z
  .object({
    mode: z.enum(["reviewable-pr", "through-merge"]),
    credentialRef: z
      .string()
      .regex(/^env:[A-Z][A-Z0-9_]*$/)
      .nullable(),
    /** Absent on policies persisted before publication existed; `defaultBranchPrefix` then applies. */
    branchPrefix: z.string().refine(validBranchPrefix).optional(),
    grants: z
      .array(
        z
          .object({
            action: z.enum(actionKinds),
            // The issue-tracker container for an issue-tracker action (a GitHub repository node ID), else the repository.
            repositoryId: identity,
            mode: z.enum(["allow", "approval"]),
            projectNodeId: identity.optional(),
            fieldNodeId: identity.optional(),
            optionNodeIds: z.array(identity).optional(),
            /** The Jira statuses an `issue.status` grant covers. */
            statusIds: z.array(identity).optional(),
          })
          .strict()
          .refine(
            (g) => g.action !== "branch.adopt" || g.mode === "approval",
            "branch.adopt is only grantable with approval",
          ),
      )
      .max(256),
    requiredChecks: z
      .array(
        z
          .object({
            name: identity,
            appId: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type DeliveryPolicy = z.output<typeof deliveryPolicySchema> & {
  version: number;
};

const targetSchema = z
  .object({
    repositoryId: identity,
    number: z.number().int().positive(),
    nodeId: identity,
  })
  .strict();
const prTargetSchema = targetSchema
  .extend({
    baseRef: identity,
    headRef: identity,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
const branchTargetSchema = z.object({ repositoryId: identity }).strict();
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
/**
 * What a recovery from an outside change names: the task branch, the outside head (git's all-zero id
 * for a deleted branch) and the commit cab last pushed. The approval binds all three.
 */
const recoveryMaterial = {
  branch: identity,
  outsideHeadSha: commitSha,
  lastPushedSha: commitSha.nullable(),
};
const threadTargetSchema = targetSchema
  .extend({ threadNodeId: identity })
  .strict();
const textFields = {
  title: z.string().trim().min(1).max(issueTitleLimit).optional(),
  body: z.string().max(issueBodyLimit).optional(),
};
const edits = z
  .object(textFields)
  .strict()
  .refine(
    (v) => v.title !== undefined || v.body !== undefined,
    "Edit requires title or body",
  );
/** Actions only the operator's task publication may take; agents and the service never can. */
const publicationKinds: readonly string[] = [
  "issue.create",
  "project.item.add",
];
export const externalActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("issue.comment"),
      target: targetSchema,
      body: z.string().min(1).max(64000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.labels"),
      target: targetSchema,
      add: z.array(identity).max(100),
      remove: z.array(identity).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.edit"),
      target: targetSchema,
      fields: edits,
      // The text an operator edit replaces; the provider refuses if GitHub no longer shows it.
      expected: z
        .object({
          title: z.string().max(issueTitleLimit),
          body: z.string().max(issueCurrentBodyLimit),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.create"),
      target: branchTargetSchema,
      title: z.string().trim().min(1).max(issueTitleLimit),
      body: z.string().max(issueBodyLimit),
      labels: z.array(identity).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project.item.add"),
      target: targetSchema,
      projectNodeId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("project.field"),
      target: targetSchema,
      projectNodeId: identity,
      itemNodeId: identity,
      fieldNodeId: identity,
      optionNodeId: identity,
      // The Status the item must still show: the provider refuses the write otherwise (`null` is no value).
      expected: z
        .object({ optionNodeId: identity.nullable() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.status"),
      // `repositoryId` is the Jira project id, `nodeId` the issue id.
      target: targetSchema,
      statusId: identity,
      // The status the issue must still show: the provider skips the write otherwise (`null` is no value).
      expected: z.object({ statusId: identity.nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr.create"),
      target: z
        .object({
          repositoryId: identity,
          baseRef: identity,
          headRef: identity,
          expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
        })
        .strict(),
      title: z.string().min(1).max(512),
      body: z.string().max(64000),
      draft: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr.edit"),
      target: prTargetSchema,
      fields: edits,
    })
    .strict(),
  z.object({ kind: z.literal("pr.ready"), target: prTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("pr.merge"),
      target: prTargetSchema,
      method: z.enum(["merge", "squash", "rebase"]),
      reviewedResultIds: z.array(z.string().uuid()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue.close"),
      target: targetSchema,
      reviewedResultIds: z.array(z.string().uuid()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr.thread.reply"),
      target: threadTargetSchema,
      body: z.string().min(1).max(64000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pr.thread.resolve"),
      target: threadTargetSchema,
      expectedLatestCommentNodeId: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("branch.push"),
      target: branchTargetSchema,
      commitSha,
    })
    .strict(),
  z
    .object({
      kind: z.literal("branch.force-push"),
      target: branchTargetSchema,
      commitSha,
      // Present only to overwrite an outside head: all of it or none.
      branch: recoveryMaterial.branch.optional(),
      outsideHeadSha: recoveryMaterial.outsideHeadSha.optional(),
      lastPushedSha: recoveryMaterial.lastPushedSha.optional(),
    })
    .strict()
    .refine(
      (v) =>
        [v.branch, v.outsideHeadSha, v.lastPushedSha].every(
          (m) => m === undefined,
        ) ||
        [v.branch, v.outsideHeadSha, v.lastPushedSha].every(
          (m) => m !== undefined,
        ),
      "Recovery material needs branch, outsideHeadSha and lastPushedSha together",
    ),
  z
    .object({
      kind: z.literal("branch.adopt"),
      target: branchTargetSchema,
      ...recoveryMaterial,
    })
    .strict(),
]);
export const externalActionArgumentsSchema = z
  .object({
    operationId: z.string().uuid(),
    action: externalActionSchema,
    operatorReviewId: z.string().uuid().optional(),
    approval: z
      .object({
        interactionId: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ExternalAction = z.output<typeof externalActionSchema>;
export type ExternalActionArguments = z.output<
  typeof externalActionArgumentsSchema
>;
export const runtimeDeliveryCallerSchema = z
  .object({
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    taskVersion: z.number().int().positive(),
    assignmentId: z.string().uuid(),
    assignmentVersion: z.number().int().positive(),
    workId: identity,
    workRevision: z.number().int().positive(),
    conversationRevision: z.number().int().positive(),
  })
  .strict();
export type RuntimeDeliveryCaller = z.output<
  typeof runtimeDeliveryCallerSchema
>;
export const operatorDeliveryCallerSchema = z
  .object({
    actor: z.literal("operator"),
    principal: z.literal("installation-operator"),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    taskVersion: z.number().int().positive(),
    sourceId: z.string().uuid(),
    sourceRevision: z.number().int().positive(),
    sourceDigest: z.string().length(64),
    sourceNodeId: identity,
    sourceRepositoryId: identity,
    policyVersion: z.number().int().positive(),
  })
  .strict();
export type OperatorDeliveryCaller = z.output<
  typeof operatorDeliveryCallerSchema
>;
/** The service writing a mapped Project Status or Jira status for one event; it may submit only that `project.field` or `issue.status`. */
export const serviceDeliveryCallerSchema = z
  .object({
    actor: z.literal("service"),
    purpose: z.literal("status-mapping"),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    mappingVersion: z.number().int().positive(),
    event: z.enum(statusMappingEvents),
  })
  .strict();
export type ServiceDeliveryCaller = z.output<
  typeof serviceDeliveryCallerSchema
>;
/**
 * The operator publishing a local task: it has no imported issue to bind to, so it names the
 * publication, the target selection and the repository instead.
 */
export const operatorPublicationCallerSchema = z
  .object({
    actor: z.literal("operator"),
    principal: z.literal("installation-operator"),
    purpose: z.literal("task-publication"),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    publicationId: z.string().uuid(),
    sourceId: z.string().uuid(),
    selectionId: identity,
    repositoryId: identity,
    policyVersion: z.number().int().positive(),
  })
  .strict();
export type OperatorPublicationCaller = z.output<
  typeof operatorPublicationCallerSchema
>;
// The first branch explicitly preserves the historical persisted runtime shape and its material hash;
// later branches are strict, so each persisted record still parses as the branch it always did.
const bindingSchema = z.union([
  runtimeDeliveryCallerSchema,
  operatorDeliveryCallerSchema,
  serviceDeliveryCallerSchema,
  operatorPublicationCallerSchema,
]);
export type DeliveryCaller = z.output<typeof bindingSchema>;
/** The operator acting on a task's bound issue; a publication caller has its own guard. */
export function isOperatorDeliveryCaller(
  caller: DeliveryCaller,
): caller is OperatorDeliveryCaller {
  return (
    "actor" in caller && caller.actor === "operator" && !("purpose" in caller)
  );
}
export function isOperatorPublicationCaller(
  caller: DeliveryCaller,
): caller is OperatorPublicationCaller {
  return (
    "actor" in caller &&
    caller.actor === "operator" &&
    "purpose" in caller &&
    caller.purpose === "task-publication"
  );
}
export function isServiceDeliveryCaller(
  caller: DeliveryCaller,
): caller is ServiceDeliveryCaller {
  return "actor" in caller && caller.actor === "service";
}
/** The agent callers: those with an assignment, work and conversation behind them. */
export function isRuntimeDeliveryCaller(
  caller: DeliveryCaller,
): caller is RuntimeDeliveryCaller {
  return !("actor" in caller);
}
/** The two actions an operator may take on the bound issue: a comment, or an edit that names what it replaces. */
export function isOperatorAction(
  action: ExternalAction,
): action is Extract<ExternalAction, { kind: "issue.comment" | "issue.edit" }> {
  return (
    action.kind === "issue.comment" ||
    (action.kind === "issue.edit" && action.expected !== undefined)
  );
}
/** A recovery from an outside change: an overwrite naming the outside head, or an adoption of it. */
export function isRecoveryAction(action: ExternalAction): action is
  | Extract<ExternalAction, { kind: "branch.adopt" }>
  | (Extract<ExternalAction, { kind: "branch.force-push" }> & {
      branch: string;
      outsideHeadSha: string;
      lastPushedSha: string | null;
    }) {
  return (
    action.kind === "branch.adopt" ||
    (action.kind === "branch.force-push" && action.outsideHeadSha !== undefined)
  );
}
export const operatorCommentReviewSchema = z
  .object({
    reviewId: z.string().uuid(),
    taskId: z.string().uuid(),
    key: z.string().uuid(),
    commandHash: z.string().length(64),
    operationId: z.string().uuid(),
    caller: operatorDeliveryCallerSchema,
    action: externalActionSchema,
    materialHash: z.string().length(64),
    revision: z.number().int().positive(),
    decision: z.enum(["pending", "approved", "denied"]),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()
  .refine((r) => isOperatorAction(r.action));
export type OperatorCommentReview = z.output<
  typeof operatorCommentReviewSchema
>;
export const actionObservationSchema = z
  .object({
    state: z.enum(["uncertain", "confirmed-success", "confirmed-failure"]),
    reason: identity.nullable(),
    receipt: z
      .object({
        nodeId: identity,
        /** The branch a publication receipt or outside-change failure names. */
        ref: identity.optional(),
        /** Worktree entries a publication left unpushed. */
        uncommittedEntries: z.number().int().nonnegative().optional(),
        number: z.number().int().positive().optional(),
        headSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        merged: z.boolean().optional(),
        issueClosed: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    retryable: z.boolean().optional(),
    /** Git reported the push done; a readback that does not show it yet leaves the outcome unproved. */
    pushed: z.boolean().optional(),
    /** The attempt was ambiguous, so its commit may have landed even though a later read showed another head. */
    ambiguous: z.boolean().optional(),
    /** Git rejected this attempt's update, so it provably did not land even though the outcome is unproved. */
    rejected: z.boolean().optional(),
    /** A head cab did not push, seen alongside this outcome. */
    outsideHeadSha: commitSha.optional(),
    /** The branch was deleted by another writer after cab's push. */
    outsideDeleted: z.boolean().optional(),
    /** Epoch ms before which a retryable failure is not re-attempted. */
    resumeAt: z.number().int().positive().optional(),
  })
  .strict();
export type ProviderActionObservation = z.output<
  typeof actionObservationSchema
>;
export const prObservationSchema = z
  .object({
    repositoryId: identity,
    nodeId: identity,
    number: z.number().int().positive(),
    baseRef: identity,
    headRef: identity,
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    draft: z.boolean(),
    merged: z.boolean(),
    reviewDecision: z
      .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
      .nullable(),
    checks: z.array(
      z
        .object({
          name: identity,
          appId: z.number().int().nullable(),
          sha: z.string(),
          status: z.enum(["success", "pending", "failure"]),
          nodeId: identity.optional(),
          updatedAt: identity.optional(),
        })
        .strict(),
    ),
    feedback: z
      .array(
        z
          .object({
            kind: z.enum(["comment", "review", "review-comment"]),
            nodeId: identity,
            author: identity,
            updatedAt: identity,
            state: identity,
            body: z.string().max(2000),
            commitSha: z.string().nullable(),
          })
          .strict(),
      )
      .optional(),
    /** Absent on observations persisted before thread actions existed. */
    reviewThreads: z
      .array(
        z
          .object({
            nodeId: identity,
            isResolved: z.boolean(),
            firstCommentNodeId: identity.nullable(),
            latestCommentNodeId: identity.nullable(),
          })
          .strict(),
      )
      .optional(),
    mergeBlockers: z.array(identity),
    closedIssueNodeIds: z.array(identity).default([]),
    allowedMethods: z.array(z.enum(["merge", "squash", "rebase"])),
  })
  .strict();
export type PrDeliveryObservation = z.output<typeof prObservationSchema>;
export const registerPrArgumentsSchema = z
  .object({
    repositoryId: identity,
    prNumber: z.number().int().positive(),
    expectedPrNodeId: identity,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
export const handbackSettlementSchema = registerPrArgumentsSchema
  .extend({
    actor: z.literal("operator"),
    key: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedTaskVersion: z.number().int().positive(),
    expectedDeliveryRevision: z.number().int().positive(),
    expectedPolicyVersion: z.number().int().positive(),
    decision: z.enum(["accepted", "closed"]),
  })
  .strict();
export type HandbackSettlement = z.output<typeof handbackSettlementSchema>;
/** A settlement refused because its target or material is no longer current. */
export class HandbackSettlementRefusedError extends DomainConflictError {}
const prBindingSchema = z
  .object({
    taskId: z.string().uuid(),
    projectId: z.string().uuid(),
    leadAssignmentId: z.string().uuid(),
    registeredWorkId: identity,
    revision: z.number().int().positive(),
    mode: z.enum(["reviewable-pr", "through-merge"]),
    observation: prObservationSchema,
    observationDigest: z.string().length(64),
    observedAt: z.number(),
    readError: identity.nullable(),
    settlement: z
      .object({
        key: z.string().uuid(),
        decision: z.enum(["accepted", "closed"]),
        headSha: z.string().length(40),
        taskVersion: z.number().int().positive(),
        policyVersion: z.number().int().positive(),
        createdAt: z.number(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PrDeliveryBinding = z.output<typeof prBindingSchema>;
export type TaskDeliveryView = ReturnType<DeliveryStore["publicTask"]>;
const actionRecordSchema = z
  .object({
    operationId: z.string().uuid(),
    request: externalActionArgumentsSchema,
    binding: bindingSchema,
    policyVersion: z.number().int().positive(),
    state: z.enum([
      "prepared",
      "attempting",
      "uncertain",
      "confirmed-success",
      "confirmed-failure",
      "denied",
    ]),
    attempts: z.number().int().nonnegative(),
    beforeState: z.record(z.string(), z.json()).nullable(),
    observation: actionObservationSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type DeliveryActionRecord = z.output<typeof actionRecordSchema>;
const taskBranchSchema = z
  .object({
    repositoryId: identity,
    branch: identity,
    lastPushedSha: commitSha.nullable(),
    outsideHeadSha: commitSha.nullable(),
    assignedAt: z.number(),
  })
  .strict();
export type TaskBranch = z.output<typeof taskBranchSchema>;

export function canonicalMaterial(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalMaterial).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalMaterial(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function materialDigest(value: unknown): string {
  return createHash("sha256").update(canonicalMaterial(value)).digest("hex");
}

/** On closure, only the Status cab last wrote or saw while the task was Ready may be expected. */
function closureExpectedHolds(
  state: { observedAt: number | null; observedOptionNodeId: string | null },
  expected: { optionNodeId: string | null } | undefined,
): boolean {
  return (
    state.observedAt !== null &&
    expected !== undefined &&
    expected.optionNodeId === state.observedOptionNodeId
  );
}

/** Methods suffixed WithinTransaction compose with existing SQLite command transactions. */
export class DeliveryStore {
  constructor(private readonly db: Database) {}
  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_operator_comment_reviews(reviewId TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,operationId TEXT NOT NULL UNIQUE,taskId TEXT NOT NULL REFERENCES domain_tasks(id),recordJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_operator_confirm_receipts(key TEXT PRIMARY KEY,material TEXT NOT NULL,recordJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_policies (
      projectId TEXT PRIMARY KEY REFERENCES domain_projects(id), version INTEGER NOT NULL,
      policyJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_actions (
      operationId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      materialHash TEXT NOT NULL, recordJson TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS delivery_actions_task ON delivery_actions(taskId);
    CREATE TABLE IF NOT EXISTS delivery_pr_bindings (taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id), recordJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_observations (taskId TEXT NOT NULL REFERENCES domain_tasks(id), digest TEXT NOT NULL, observationJson TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(taskId,digest));
    CREATE TABLE IF NOT EXISTS delivery_approval_bindings (interactionId TEXT PRIMARY KEY REFERENCES coordination_interactions(interactionId),taskId TEXT NOT NULL,assignmentId TEXT NOT NULL,taskVersion INTEGER NOT NULL,assignmentVersion INTEGER NOT NULL,conversationRevision INTEGER NOT NULL,workRevision INTEGER NOT NULL,policyVersion INTEGER NOT NULL,materialHash TEXT NOT NULL,operationId TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS delivery_waiting_work (workId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES domain_tasks(id),assignmentId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_settlement_receipts (commandKey TEXT PRIMARY KEY,payloadHash TEXT NOT NULL,recordJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_task_branches (
      taskId TEXT NOT NULL REFERENCES domain_tasks(id), repositoryId TEXT NOT NULL, branch TEXT NOT NULL,
      lastPushedSha TEXT, outsideHeadSha TEXT, assignedAt INTEGER NOT NULL,
      PRIMARY KEY(taskId,repositoryId), UNIQUE(repositoryId,branch));
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      operationId TEXT NOT NULL REFERENCES delivery_actions(operationId), attempt INTEGER NOT NULL,
      beforeJson TEXT NOT NULL, observationJson TEXT, PRIMARY KEY(operationId,attempt));
    `);
  }
  transaction<T>(run: () => T): T {
    return transaction(this.db, run);
  }
  private save(record: DeliveryActionRecord): void {
    this.db
      .prepare("UPDATE delivery_actions SET recordJson=? WHERE operationId=?")
      .run(
        canonicalMaterial(actionRecordSchema.parse(record)),
        record.operationId,
      );
  }
  action(operationId: string): DeliveryActionRecord {
    const row = this.db
      .prepare("SELECT recordJson FROM delivery_actions WHERE operationId=?")
      .get(operationId) as { recordJson: string } | undefined;
    if (!row) throw new Error("Unknown delivery action");
    try {
      return actionRecordSchema.parse(JSON.parse(row.recordJson));
    } catch {
      throw new Error("Invalid persisted delivery action");
    }
  }
  actions(taskId?: string): DeliveryActionRecord[] {
    const rows = (
      taskId
        ? this.db
            .prepare(
              "SELECT operationId FROM delivery_actions WHERE taskId=? ORDER BY rowid",
            )
            .all(taskId)
        : this.db
            .prepare("SELECT operationId FROM delivery_actions ORDER BY rowid")
            .all()
    ) as { operationId: string }[];
    return rows.map((row) => this.action(row.operationId));
  }
  /**
   * What holds the task's work: unresolved agent and operator actions. A status-mapping write
   * reflects the board and is independent of the work, so it never holds admission, completion,
   * edits or agent actions; `serviceActionBlockers` serializes it against itself.
   */
  actionBlockers(taskId: string, exceptOperationId?: string): string[] {
    return this.unresolvedReasons(
      taskId,
      (record) => !isServiceDeliveryCaller(record.binding),
      exceptOperationId,
    );
  }
  /**
   * Status-mapping writes still in flight: they serialize the task's next status write. An
   * `uncertain` one does not: it waits for a readback that a human move can make impossible,
   * and the next write's re-read of the Status already refuses to overwrite a moved card.
   */
  serviceActionBlockers(taskId: string): string[] {
    return this.unresolvedReasons(
      taskId,
      (record) => isServiceDeliveryCaller(record.binding),
      undefined,
      ["prepared", "attempting"],
    );
  }
  hasAction(operationId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM delivery_actions WHERE operationId=?")
        .get(operationId) !== undefined
    );
  }
  /**
   * The task's newest status write that sent something. A later record that sent nothing (denied,
   * or refused before any attempt) wrote nothing and does not supersede an earlier one.
   */
  latestSentServiceOperation(taskId: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT operationId FROM delivery_actions WHERE taskId=? AND json_extract(recordJson,'$.binding.actor')='service' AND json_extract(recordJson,'$.state')<>'denied' AND NOT (json_extract(recordJson,'$.state')='confirmed-failure' AND json_extract(recordJson,'$.attempts')=0) ORDER BY rowid DESC LIMIT 1",
        )
        .get(taskId) as { operationId: string } | undefined
    )?.operationId;
  }
  private unresolvedReasons(
    taskId: string,
    include: (record: DeliveryActionRecord) => boolean,
    exceptOperationId?: string,
    states: readonly string[] = ["prepared", "attempting", "uncertain"],
  ): string[] {
    return [
      ...new Set(
        this.actions(taskId)
          .filter(
            (record) =>
              include(record) &&
              record.operationId !== exceptOperationId &&
              states.includes(record.state),
          )
          .map((record) => `external-action-${record.state}`),
      ),
    ];
  }
  authorize(
    request: ExternalActionArguments,
    binding: DeliveryCaller,
    approved: boolean,
    policyVersion?: number,
  ): void {
    const policy = this.configuration(binding.projectId);
    if (isOperatorDeliveryCaller(binding)) {
      this.validateOperatorCaller(binding);
      if (
        !isOperatorAction(request.action) ||
        request.approval ||
        request.action.target.nodeId !== binding.sourceNodeId ||
        request.action.target.repositoryId !== binding.sourceRepositoryId ||
        request.action.target.number !==
          Number(
            (
              this.db
                .prepare(
                  "SELECT number AS issueNumber FROM external_items WHERE taskId = ? AND externalId = ?",
                )
                .get(binding.taskId, binding.sourceNodeId) as
                | { issueNumber: number }
                | undefined
            )?.issueNumber,
          )
      )
        throw Error("Operator caller only permits the bound issue.comment");
      if (
        request.operatorReviewId &&
        !this.operatorApprovalCurrent(request, binding)
      )
        approved = false;
      if (
        request.action.kind === "issue.edit" ||
        policy.grants.some(
          (g) =>
            g.action === "issue.comment" &&
            g.repositoryId === binding.sourceRepositoryId &&
            g.mode === "approval",
        )
      )
        approved = this.operatorApprovalCurrent(request, binding);
    } else if (request.operatorReviewId)
      throw Error("Runtime caller cannot use an operator confirmation");
    if (
      request.action.kind === "issue.status" &&
      !isServiceDeliveryCaller(binding)
    )
      throw new DomainPolicyError(
        "forbidden",
        "Only the status mapping may write an issue status",
      );
    if (isServiceDeliveryCaller(binding)) {
      this.validateServiceCaller(request, binding);
      // The service cannot obtain an approval, so an approval-mode grant fails closed.
      approved = false;
    }
    if (isOperatorPublicationCaller(binding))
      this.validatePublicationCaller(request, binding);
    else if (publicationKinds.includes(request.action.kind))
      // Agents and the service can never create an issue or add a Project item.
      throw new DomainPolicyError(
        "forbidden",
        "Only the operator's task publication may use this action",
      );
    if (policyVersion !== undefined && policy.version !== policyVersion)
      throw new Error("Delivery policy changed");
    const action = request.action;
    const grant = policy.grants.find(
      (g) =>
        // The service cannot obtain an approval, so only an `allow` grant can cover it.
        (!isServiceDeliveryCaller(binding) || g.mode === "allow") &&
        g.action === action.kind &&
        g.repositoryId === action.target.repositoryId &&
        (action.kind === "project.item.add"
          ? g.projectNodeId === action.projectNodeId
          : action.kind === "issue.status"
            ? g.statusIds?.includes(action.statusId)
            : action.kind !== "project.field" ||
              (g.projectNodeId === action.projectNodeId &&
                g.fieldNodeId === action.fieldNodeId &&
                g.optionNodeIds?.includes(action.optionNodeId))),
    );
    if (!grant)
      throw new DomainPolicyError(
        "forbidden",
        "External action denied by project policy",
      );
    this.assertJiraChangeRequestText(action, binding);
    if (
      (grant.mode === "approval" ||
        action.kind === "issue.edit" ||
        action.kind === "pr.edit" ||
        // The confirmed publication review is the approval in either grant mode.
        isOperatorPublicationCaller(binding) ||
        // A recovery is never covered by an `allow` grant.
        isRecoveryAction(action)) &&
      !approved
    )
      throw new Error("Exact material approval required");
    if (isRecoveryAction(action)) {
      const branch = this.taskBranch(
        binding.taskId,
        action.target.repositoryId,
      );
      // Re-run after the provider's last await, so a record that moved since approval refuses.
      if (
        branch?.branch !== action.branch ||
        branch.outsideHeadSha !== action.outsideHeadSha ||
        branch.lastPushedSha !== action.lastPushedSha
      )
        throw new Error("Recovery material is not the recorded outside change");
      if (
        action.kind === "branch.adopt" &&
        action.outsideHeadSha === absentBranchHead
      )
        throw new Error("A deleted branch cannot be adopted");
    }
    if (action.kind === "pr.merge" && policy.mode !== "through-merge")
      throw new Error("Project delivery mode forbids merge");
    if ("headRef" in action.target) {
      const branch = this.taskBranch(
        binding.taskId,
        action.target.repositoryId,
      );
      if (
        action.kind === "pr.create" &&
        branch?.branch !== action.target.headRef
      )
        throw new Error("PR head is not the task's assigned branch");
      // A PR from the task branch may only be acted on at the commit cab last pushed there.
      if (
        branch?.branch === action.target.headRef &&
        (branch.lastPushedSha === null ||
          branch.outsideHeadSha !== null ||
          action.target.expectedHeadSha !== branch.lastPushedSha)
      )
        throw new Error("PR head is not the task branch's last cab push");
    }
    if (
      action.kind === "pr.thread.reply" ||
      action.kind === "pr.thread.resolve"
    ) {
      const observed = this.delivery(binding.taskId)?.observation;
      if (
        !observed ||
        observed.repositoryId !== action.target.repositoryId ||
        observed.nodeId !== action.target.nodeId ||
        observed.number !== action.target.number ||
        !observed.reviewThreads?.some(
          (t) => t.nodeId === action.target.threadNodeId,
        )
      )
        throw new Error("Review thread is not on the task's bound PR");
    }
    const source = this.db
      .prepare("SELECT readiness FROM project_task_sources WHERE projectId=?")
      .get(binding.projectId) as { readiness: string } | undefined;
    if (source) {
      const readiness = readinessSchema
        .nullable()
        .parse(JSON.parse(source.readiness));
      // No readiness rule protects no label or field.
      const exempt = readiness
        ? this.readinessWriteExempt(binding, action, readiness)
        : true;
      const readinessLabels = new Set(
        (readiness?.conditions ?? []).flatMap((c) =>
          c.kind === "label" ? [c.name.toLowerCase()] : [],
        ),
      );
      if (
        !exempt &&
        ((action.kind === "issue.labels" &&
          [...action.add, ...action.remove].some((l) =>
            readinessLabels.has(l.toLowerCase()),
          )) ||
          (action.kind === "issue.create" &&
            action.labels.some((l) => readinessLabels.has(l.toLowerCase()))))
      )
        throw new Error("Agent cannot change readiness labels");
      if (
        !exempt &&
        action.kind === "project.field" &&
        readiness?.conditions.some(
          (c) =>
            c.kind === "project-field" &&
            c.projectNodeId === action.projectNodeId &&
            c.fieldNodeId === action.fieldNodeId,
        )
      )
        throw new Error("Agent cannot change readiness fields");
    }
  }
  /**
   * Whether a caller is named to write the readiness labels or fields of `action` (ADR-1017). The
   * service status-mapping caller, bounded by `validateServiceCaller`, may write a Project field. The
   * operator publishing a task that is Ready may set exactly the readiness label or option the rule
   * names; for a Draft task nothing is exempt, so no publication can make it Ready. Every other
   * caller, including the operator on a bound issue, keeps the refusal.
   */
  private readinessWriteExempt(
    binding: DeliveryCaller,
    action: ExternalAction,
    readiness: z.output<typeof readinessSchema>,
  ): boolean {
    if (isServiceDeliveryCaller(binding))
      return action.kind === "project.field" || action.kind === "issue.status";
    if (!isOperatorPublicationCaller(binding)) return false;
    const ready = this.db
      .prepare("SELECT ready FROM domain_tasks WHERE id=?")
      .get(binding.taskId) as { ready: number } | undefined;
    if (ready?.ready !== 1) return false;
    if (action.kind === "project.field")
      return readiness.conditions.some(
        (c) =>
          c.kind === "project-field" &&
          c.projectNodeId === action.projectNodeId &&
          c.fieldNodeId === action.fieldNodeId &&
          c.operator === "in" &&
          c.optionNodeIds[0] === action.optionNodeId,
      );
    if (action.kind === "issue.create")
      return action.labels.every((l) =>
        readiness.conditions.some(
          (c) =>
            c.kind === "label" &&
            c.operator === "has" &&
            c.name.toLowerCase() === l.toLowerCase(),
        ),
      );
    return false;
  }
  /**
   * A publication names its recorded repository and, after the create, only the issue it created.
   * The create is the publication's own operation on the task's current text, and the task must still
   * be an open local task. The review's approval binds the remaining material.
   */
  private validatePublicationCaller(
    request: ExternalActionArguments,
    caller: OperatorPublicationCaller,
  ): void {
    const action = request.action,
      refusal = (message: string) =>
        new DomainPolicyError("forbidden", message);
    if (
      request.approval ||
      request.operatorReviewId ||
      !(
        publicationKinds.includes(action.kind) ||
        action.kind === "project.field"
      )
    )
      throw refusal(
        "Publication caller only permits issue.create, project.item.add and project.field",
      );
    if (action.target.repositoryId !== caller.repositoryId)
      throw refusal("Publication names another repository");
    const task = this.db
      .prepare(
        "SELECT t.projectId,t.state,t.outcome,b.title,(SELECT 1 FROM imported_tasks i WHERE i.taskId=t.id) AS imported FROM domain_tasks t JOIN tasks b ON b.id=t.id WHERE t.id=?",
      )
      .get(caller.taskId) as
      | {
          projectId: string;
          state: string;
          outcome: string;
          title: string;
          imported: number | null;
        }
      | undefined;
    if (
      !task ||
      task.projectId !== caller.projectId ||
      task.state !== "open" ||
      task.imported ||
      this.configuration(caller.projectId).version !== caller.policyVersion
    )
      throw new DomainConflictError("Operator publication authority changed");
    if (action.kind === "issue.create") {
      if (
        request.operationId !== caller.publicationId ||
        action.title !== task.title ||
        action.body !== task.outcome ||
        new TaskReviewStore(this.db).sources(caller.taskId).at(-1)?.sourceId !==
          caller.sourceId
      )
        throw new DomainConflictError("Operator publication material changed");
      return;
    }
    if (action.kind !== "project.item.add" && action.kind !== "project.field")
      throw refusal("Publication caller cannot take this action");
    const receipt = this.action(caller.publicationId);
    if (
      receipt.request.action.kind !== "issue.create" ||
      receipt.state !== "confirmed-success" ||
      receipt.observation?.receipt?.nodeId !== action.target.nodeId ||
      receipt.observation?.receipt?.number !== action.target.number
    )
      throw refusal("Publication names an issue it did not create");
  }
  /**
   * A status-mapping write names the mapping's exact Project, field and option (GitHub) or target
   * status (Jira) for the event, on the item of a Ready imported task. In-flight events must leave
   * the task Ready; no write can make a non-Ready task Ready: only a Ready task qualifies, or Done
   * for a done task whose issue is closed, and then never a status the readiness rule accepts.
   */
  private validateServiceCaller(
    request: ExternalActionArguments,
    caller: ServiceDeliveryCaller,
  ): void {
    const action = request.action,
      refusal = () =>
        new DomainPolicyError(
          "forbidden",
          "Status mapping caller only permits its mapped project.field or issue.status",
        );
    if (
      (action.kind !== "project.field" && action.kind !== "issue.status") ||
      request.approval ||
      request.operatorReviewId
    )
      throw refusal();
    const statuses = new StatusMappingStore(this.db);
    const { version, mapping } = statuses.current(caller.projectId);
    // A task first seen done was not worked on under the mapping: never written, Ready or not.
    if (caller.event === "done" && !statuses.taskState(caller.taskId).watched)
      throw refusal();
    if (
      !mapping ||
      version !== caller.mappingVersion ||
      (action.kind === "issue.status"
        ? !isJiraMapping(mapping) ||
          action.statusId !== mapping.events[caller.event]
        : isJiraMapping(mapping) ||
          action.optionNodeId !== mapping.events[caller.event] ||
          action.projectNodeId !== mapping.projectNodeId ||
          action.fieldNodeId !== mapping.fieldNodeId)
    )
      throw refusal();
    const task = this.db
      .prepare(
        `SELECT t.projectId, t.ready, t.state, e.provider, e.instance, e.externalId AS nodeId, e.containerId AS repositoryId, e.number AS issueNumber, e.labels, e.observedState, e.observedFields
        FROM domain_tasks t JOIN external_items e ON e.taskId = t.id WHERE t.id = ?`,
      )
      .get(caller.taskId) as
      | {
          projectId: string;
          ready: number;
          state: string;
          provider: string;
          instance: string;
          nodeId: string;
          repositoryId: string;
          issueNumber: number;
          labels: string;
          observedState: string;
          observedFields: string | null;
        }
      | undefined;
    const membership = task
      ? this.db
          .prepare(
            `SELECT selectionId, itemId AS itemNodeId, fields AS projectFields FROM source_memberships WHERE projectId = ? AND ${itemIs()}`,
          )
          .all(task.projectId, ...itemKey(task.nodeId, task))
      : [];
    const items = z
      .array(
        z.object({
          selectionId: z.string(),
          itemNodeId: z.string().nullable(),
          projectFields: z.string(),
        }),
      )
      .parse(membership);
    if (
      !task ||
      task.projectId !== caller.projectId ||
      task.state === "cancelled" ||
      (task.provider === "jira") !== isJiraMapping(mapping) ||
      task.nodeId !== action.target.nodeId ||
      task.repositoryId !== action.target.repositoryId ||
      task.issueNumber !== action.target.number
    )
      throw refusal();
    // A Jira issue has no Project item: a current membership in any selection of the source qualifies.
    if (action.kind === "issue.status") {
      if (!items.length) throw refusal();
    } else {
      const mapped = items.find(
        (m) => !isJiraMapping(mapping) && m.selectionId === mapping.selectionId,
      );
      if (!mapped?.itemNodeId || mapped.itemNodeId !== action.itemNodeId)
        throw refusal();
    }
    const row = this.db
      .prepare("SELECT readiness FROM project_task_sources WHERE projectId=?")
      .get(caller.projectId) as { readiness: string };
    const labels = z.array(z.string()).parse(JSON.parse(task.labels));
    const fields = items
      .flatMap((m) => projectFieldsSchema.parse(JSON.parse(m.projectFields)))
      .filter(
        (f) =>
          action.kind === "project.field" &&
          !(
            f.projectNodeId === action.projectNodeId &&
            f.fieldNodeId === action.fieldNodeId
          ),
      );
    // The stored facts with only the target Status substituted.
    const keepsReady = () =>
      evaluateReadiness(
        readinessSchema.nullable().parse(JSON.parse(row.readiness)),
        action.kind === "issue.status"
          ? {
              labels,
              fields: [],
              status: action.statusId,
              selectFields: z
                .array(z.object({ fieldId: z.string(), optionId: z.string() }))
                .parse(JSON.parse(task.observedFields ?? "[]")),
            }
          : {
              labels,
              fields: [
                ...fields,
                {
                  projectNodeId: action.projectNodeId,
                  fieldNodeId: action.fieldNodeId,
                  optionNodeId: action.optionNodeId,
                },
              ],
            },
      ).satisfied;
    if (task.ready !== 1) {
      // Done on closure: a done task whose issue is observed closed is not Ready and a closed issue
      // cannot be, so Done may still be written, but never an option the rule would accept.
      if (
        caller.event !== "done" ||
        task.state !== "done" ||
        task.observedState !== "closed" ||
        // Skip-if-changed: the Status sent as expected must be the one cab last wrote or saw.
        !closureExpectedHolds(
          statuses.taskState(caller.taskId),
          action.kind === "issue.status"
            ? { optionNodeId: action.expected.statusId }
            : action.expected,
        ) ||
        keepsReady()
      )
        throw refusal();
      return;
    }
    if (isInFlightEvent(caller.event) && !keepsReady())
      throw new DomainPolicyError(
        "forbidden",
        "Status mapping write would remove the task's readiness",
      );
  }
  validateOperatorCaller(input: OperatorDeliveryCaller): void {
    const caller = operatorDeliveryCallerSchema.parse(input),
      policy = this.configuration(caller.projectId),
      source = new TaskReviewStore(this.db).sources(caller.taskId).at(-1),
      row = this.db
        .prepare(
          `SELECT task.projectId,task.version,imported.externalId AS nodeId,imported.containerId AS repositoryId,review.observedDigest FROM domain_tasks task JOIN imported_tasks imported ON imported.taskId=task.id JOIN source_reviews review ON ${sameItem("review", "imported")} WHERE task.id=?`,
        )
        .get(caller.taskId) as
        | {
            projectId: string;
            version: number;
            nodeId: string;
            repositoryId: string;
            observedDigest: string;
          }
        | undefined;
    if (
      !row ||
      row.projectId !== caller.projectId ||
      row.version !== caller.taskVersion ||
      row.nodeId !== caller.sourceNodeId ||
      row.repositoryId !== caller.sourceRepositoryId ||
      row.observedDigest !== caller.sourceDigest ||
      source?.sourceId !== caller.sourceId ||
      source.revision !== caller.sourceRevision ||
      policy.version !== caller.policyVersion
    )
      throw new DomainConflictError("Operator delivery authority changed");
  }
  operatorReview(id: string): OperatorCommentReview | undefined {
    const row = this.db
      .prepare(
        "SELECT recordJson FROM delivery_operator_comment_reviews WHERE reviewId=? OR key=?",
      )
      .get(id, id) as { recordJson: string } | undefined;
    return row
      ? operatorCommentReviewSchema.parse(JSON.parse(row.recordJson))
      : undefined;
  }
  reviewOperatorComment(
    command: {
      key: string;
      taskId: string;
      operationId: string;
      expectedTaskVersion: number;
      body: string;
    },
    caller: OperatorDeliveryCaller,
    action: ExternalAction,
  ): OperatorCommentReview {
    return this.reviewOperatorAction(
      command,
      caller,
      action,
      action.kind === "issue.comment" && action.body === command.body,
    );
  }
  /** An edit is reviewable only against the text the synced copy shows now. */
  reviewOperatorEdit(
    command: {
      key: string;
      taskId: string;
      operationId: string;
      expectedTaskVersion: number;
      title: string;
      body: string;
      /** The text the draft started from. */
      expected: { title: string; body: string };
    },
    caller: OperatorDeliveryCaller,
    action: ExternalAction,
  ): OperatorCommentReview {
    return this.reviewOperatorAction(
      command,
      caller,
      action,
      action.kind === "issue.edit" &&
        action.expected?.title === command.expected.title &&
        action.expected.body === command.expected.body &&
        action.fields.title === command.title &&
        action.fields.body === command.body,
      (edit) => {
        const synced = this.db
          .prepare(
            "SELECT observedTitle, observedBody FROM external_items WHERE taskId = ? AND externalId = ?",
          )
          .get(caller.taskId, caller.sourceNodeId) as
          | { observedTitle: string; observedBody: string }
          | undefined;
        if (
          edit.kind !== "issue.edit" ||
          synced?.observedTitle !== edit.expected?.title ||
          synced?.observedBody !== edit.expected?.body
        )
          throw new DomainConflictError(
            "The issue changed after the draft started",
          );
      },
    );
  }
  private reviewOperatorAction(
    command: {
      key: string;
      taskId: string;
      operationId: string;
      expectedTaskVersion: number;
    },
    caller: OperatorDeliveryCaller,
    action: ExternalAction,
    materialMatches: boolean,
    guard?: (action: ExternalAction) => void,
  ): OperatorCommentReview {
    const prior = this.operatorReview(command.key),
      commandHash = materialDigest(command);
    if (prior) {
      if (prior.commandHash !== commandHash)
        throw new DomainConflictError(
          "Operator review key reused with different material",
        );
      return prior;
    }
    this.validateOperatorCaller(caller);
    if (
      !materialMatches ||
      !isOperatorAction(action) ||
      action.target.nodeId !== caller.sourceNodeId ||
      action.target.repositoryId !== caller.sourceRepositoryId ||
      action.target.number !==
        Number(
          (
            this.db
              .prepare(
                "SELECT number AS issueNumber FROM external_items WHERE taskId = ? AND externalId = ?",
              )
              .get(caller.taskId, caller.sourceNodeId) as
              | { issueNumber: number }
              | undefined
          )?.issueNumber,
        ) ||
      caller.taskVersion !== command.expectedTaskVersion ||
      caller.taskId !== command.taskId
    )
      throw new DomainConflictError("Operator review material mismatch");
    guard?.(action);
    const record = operatorCommentReviewSchema.parse({
      reviewId: command.key,
      key: command.key,
      taskId: command.taskId,
      commandHash,
      operationId: command.operationId,
      caller,
      action,
      materialHash: materialDigest({
        operationId: command.operationId,
        caller,
        action,
      }),
      revision: 1,
      decision: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.db
      .prepare(
        "INSERT INTO delivery_operator_comment_reviews VALUES(?,?,?,?,?)",
      )
      .run(
        record.reviewId,
        record.key,
        record.operationId,
        record.taskId,
        canonicalMaterial(record),
      );
    return record;
  }
  confirmOperatorComment(
    command: {
      key: string;
      taskId: string;
      reviewId: string;
      expectedRevision: number;
      materialHash: string;
      decision: "approved" | "denied";
    },
    authorize: () => void,
  ): OperatorCommentReview {
    return this.transaction(() => {
      const material = canonicalMaterial(command),
        prior = this.db
          .prepare(
            "SELECT material,recordJson FROM delivery_operator_confirm_receipts WHERE key=?",
          )
          .get(command.key) as
          | { material: string; recordJson: string }
          | undefined;
      if (prior) {
        if (prior.material !== material)
          throw new DomainConflictError(
            "Operator confirmation key reused with different material",
          );
        return operatorCommentReviewSchema.parse(JSON.parse(prior.recordJson));
      }
      const record = this.operatorReview(command.reviewId);
      if (
        !record ||
        record.taskId !== command.taskId ||
        record.revision !== command.expectedRevision ||
        record.materialHash !== command.materialHash ||
        record.decision !== "pending"
      )
        throw new DomainConflictError(
          "Operator confirmation revision/material mismatch",
        );
      if (command.decision === "approved") {
        authorize();
        this.validateOperatorCaller(record.caller);
        const policy = this.configuration(record.caller.projectId);
        if (
          !policy.grants.some(
            (g) =>
              g.action === record.action.kind &&
              g.repositoryId === record.caller.sourceRepositoryId,
          )
        )
          throw new DomainPolicyError(
            "forbidden",
            "External action denied by project policy",
          );
      }
      const saved = {
        ...record,
        revision: record.revision + 1,
        decision: command.decision,
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          "UPDATE delivery_operator_comment_reviews SET recordJson=? WHERE reviewId=?",
        )
        .run(canonicalMaterial(saved), saved.reviewId);
      this.db
        .prepare("INSERT INTO delivery_operator_confirm_receipts VALUES(?,?,?)")
        .run(command.key, material, canonicalMaterial(saved));
      return saved;
    });
  }
  operatorApprovalCurrent(
    request: ExternalActionArguments,
    caller: OperatorDeliveryCaller,
  ): boolean {
    if (!request.operatorReviewId) return false;
    const record = this.operatorReview(request.operatorReviewId);
    return Boolean(
      record &&
        record.decision === "approved" &&
        record.operationId === request.operationId &&
        record.taskId === caller.taskId &&
        record.materialHash ===
          materialDigest({
            operationId: request.operationId,
            caller,
            action: request.action,
          }),
    );
  }
  recordApprovalContextWithinTransaction(
    interactionId: string,
    caller: RuntimeDeliveryCaller,
    action: ExternalAction,
  ): void {
    this.db
      .prepare(
        "INSERT INTO delivery_approval_bindings VALUES (?,?,?,?,?,?,?,?,?,NULL)",
      )
      .run(
        interactionId,
        caller.taskId,
        caller.assignmentId,
        caller.taskVersion,
        caller.assignmentVersion,
        caller.conversationRevision,
        caller.workRevision,
        this.configuration(caller.projectId).version,
        materialDigest(action),
      );
  }
  approvalCurrent(
    interactionId: string,
    caller: RuntimeDeliveryCaller,
    action: ExternalAction,
    operationId: string,
  ): boolean {
    const row = this.db
      .prepare("SELECT * FROM delivery_approval_bindings WHERE interactionId=?")
      .get(interactionId) as
      | {
          taskId: string;
          assignmentId: string;
          taskVersion: number;
          assignmentVersion: number;
          conversationRevision: number;
          workRevision: number;
          policyVersion: number;
          materialHash: string;
          operationId: string | null;
        }
      | undefined;
    return Boolean(
      row &&
        row.taskId === caller.taskId &&
        row.assignmentId === caller.assignmentId &&
        row.taskVersion === caller.taskVersion &&
        row.assignmentVersion === caller.assignmentVersion &&
        row.conversationRevision === caller.conversationRevision &&
        row.workRevision <= caller.workRevision &&
        row.policyVersion === this.configuration(caller.projectId).version &&
        row.materialHash === materialDigest(action) &&
        (!row.operationId || row.operationId === operationId),
    );
  }
  prepareAction(
    input: unknown,
    caller: DeliveryCaller,
    approved: boolean,
    admission: () => void = () => {},
  ): DeliveryActionRecord {
    const request = externalActionArgumentsSchema.parse(input),
      binding = bindingSchema.parse(caller);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT materialHash FROM delivery_actions WHERE operationId=?",
        )
        .get(request.operationId) as { materialHash: string } | undefined;
      const hash = materialDigest({ request, binding });
      if (prior) {
        if (prior.materialHash !== hash)
          throw new DomainConflictError(
            "Operation key used with different material or caller",
          );
        return this.action(request.operationId);
      }
      let denied = false;
      try {
        admission();
        this.authorize(request, binding, approved);
        if (
          (isServiceDeliveryCaller(binding)
            ? this.serviceActionBlockers(binding.taskId)
            : this.actionBlockers(binding.taskId)
          ).length
        )
          throw new Error("Task has unresolved external action");
        if (approved && request.approval && isRuntimeDeliveryCaller(binding)) {
          if (
            !this.approvalCurrent(
              request.approval.interactionId,
              binding,
              request.action,
              request.operationId,
            )
          )
            throw new Error("Approval is stale or bound to another operation");
          this.db
            .prepare(
              "UPDATE delivery_approval_bindings SET operationId=? WHERE interactionId=? AND (operationId IS NULL OR operationId=?)",
            )
            .run(
              request.operationId,
              request.approval.interactionId,
              request.operationId,
            );
        }
      } catch {
        denied = true;
      }
      if (!denied && request.action.kind.startsWith("branch."))
        this.assignTaskBranchWithinTransaction(
          binding.taskId,
          request.action.target.repositoryId,
        );
      const now = Date.now();
      const record: DeliveryActionRecord = {
        operationId: request.operationId,
        request,
        binding,
        policyVersion: this.configuration(binding.projectId).version,
        state: denied ? "denied" : "prepared",
        attempts: 0,
        beforeState: null,
        observation: denied
          ? {
              state: "confirmed-failure",
              reason: "delivery-authority-denied",
              receipt: null,
            }
          : null,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare("INSERT INTO delivery_actions VALUES (?,?,?,?)")
        .run(
          request.operationId,
          binding.taskId,
          hash,
          canonicalMaterial(record),
        );
      return record;
    });
  }
  beginAttempt(
    operationId: string,
    beforeState: Record<string, z.output<ReturnType<typeof z.json>>>,
    validate: () => void = () => {},
  ): DeliveryActionRecord {
    return this.transaction(() => {
      validate();
      const record = this.action(operationId);
      if (
        record.state !== "prepared" &&
        !(
          record.state === "confirmed-failure" &&
          record.observation?.retryable &&
          record.attempts < 3
        )
      )
        throw new Error(
          "Effect cannot be replayed without confirmed no-effect failure",
        );
      record.state = "attempting";
      record.attempts++;
      record.beforeState = beforeState;
      record.updatedAt = Date.now();
      record.observation = null;
      this.db
        .prepare("INSERT INTO delivery_attempts VALUES (?,?,?,NULL)")
        .run(operationId, record.attempts, canonicalMaterial(beforeState));
      this.save(record);
      return record;
    });
  }
  /** `within` runs in the same transaction, e.g. to wake the lead with the recorded outcome. */
  recordObservation(
    operationId: string,
    input: ProviderActionObservation,
    within?: (record: DeliveryActionRecord) => void,
  ): DeliveryActionRecord {
    const observation = actionObservationSchema.parse(input);
    return this.transaction(() => {
      const record = this.action(operationId);
      if (record.state === "confirmed-success") return record;
      const previous = record.state;
      record.state = observation.state;
      record.observation = observation;
      record.updatedAt = Date.now();
      this.save(record);
      // A failure before a retry's attempt began (a refused preflight) must not overwrite the
      // earlier attempt's row, which says whether that attempt may have landed.
      if (previous === "attempting" || previous === "uncertain")
        this.db
          .prepare(
            "UPDATE delivery_attempts SET observationJson=? WHERE operationId=? AND attempt=?",
          )
          .run(canonicalMaterial(observation), operationId, record.attempts);
      const action = record.request.action;
      if (action.kind.startsWith("branch.")) {
        const taskId = record.binding.taskId,
          repositoryId = action.target.repositoryId,
          owned = observation.state === "confirmed-success",
          // A branch found absent is held like an outside head, as git's all-zero id.
          outside =
            observation.outsideHeadSha ??
            (observation.outsideDeleted
              ? absentBranchHead
              : observation.reason === "branch-outside-change"
                ? (observation.receipt?.headSha ?? absentBranchHead)
                : undefined);
        if (owned && observation.receipt?.headSha)
          this.db
            .prepare(
              "UPDATE delivery_task_branches SET lastPushedSha=?,outsideHeadSha=? WHERE taskId=? AND repositoryId=?",
            )
            .run(
              observation.receipt.headSha,
              outside ?? null,
              taskId,
              repositoryId,
            );
        else if (outside)
          this.db
            .prepare(
              "UPDATE delivery_task_branches SET outsideHeadSha=? WHERE taskId=? AND repositoryId=?",
            )
            .run(outside, taskId, repositoryId);
        if (
          outside ||
          observation.outsideDeleted ||
          observation.reason === "branch-outside-change"
        )
          this.clearSettlementOnBranch(taskId, repositoryId);
      }
      if (
        isServiceDeliveryCaller(record.binding) &&
        observation.state === "confirmed-success" &&
        (record.request.action.kind === "project.field" ||
          record.request.action.kind === "issue.status") &&
        // A late proof of an older write must not replace what a newer one wrote, and a write of a
        // mapping since cleared or rebound must not recreate the state that was forgotten with it.
        record.binding.mappingVersion ===
          new StatusMappingStore(this.db).current(record.binding.projectId)
            .version &&
        this.latestSentServiceOperation(record.binding.taskId) === operationId
      )
        new StatusMappingStore(this.db).observed(
          record.binding.taskId,
          record.request.action.kind === "issue.status"
            ? record.request.action.statusId
            : record.request.action.optionNodeId,
        );
      within?.(record);
      return record;
    });
  }
  /** An outside change on the PR's task branch invalidates any handback settlement at once. */
  private clearSettlementOnBranch(taskId: string, repositoryId: string): void {
    const binding = this.delivery(taskId),
      branch = this.taskBranch(taskId, repositoryId);
    if (
      binding?.settlement &&
      branch &&
      binding.observation.repositoryId === repositoryId &&
      binding.observation.headRef === branch.branch
    ) {
      binding.settlement = null;
      binding.revision++;
      this.saveDelivery(binding);
    }
  }
  /**
   * Whether any earlier attempt of the operation may have pushed its commit: one that was never
   * settled, ended unproved, was reported pushed by Git, or was concluded not applied from a read.
   * A push that never started or was definitively rejected did not land.
   */
  mayHaveLanded(operationId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT observationJson FROM delivery_attempts WHERE operationId=?",
        )
        .all(operationId) as { observationJson: string | null }[]
    ).some((row) => {
      if (row.observationJson === null) return true;
      const o = actionObservationSchema.parse(JSON.parse(row.observationJson));
      return (
        (o.state === "uncertain" && o.rejected !== true) ||
        o.pushed === true ||
        o.ambiguous === true ||
        o.reason === "branch-push-not-applied"
      );
    });
  }
  /** The branch head cab last pushed as of the operation's first attempt, or undefined before any. */
  firstAttemptLastPushed(operationId: string): string | null | undefined {
    const row = this.db
      .prepare(
        "SELECT beforeJson FROM delivery_attempts WHERE operationId=? AND attempt=1",
      )
      .get(operationId) as { beforeJson: string } | undefined;
    if (!row) return undefined;
    const before = z
      .object({ lastPushedSha: commitSha.nullable().optional() })
      .passthrough()
      .parse(JSON.parse(row.beforeJson));
    return before.lastPushedSha ?? null;
  }
  taskBranch(taskId: string, repositoryId: string): TaskBranch | null {
    const row = this.db
      .prepare(
        "SELECT repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt FROM delivery_task_branches WHERE taskId=? AND repositoryId=?",
      )
      .get(taskId, repositoryId);
    return row ? taskBranchSchema.parse(row) : null;
  }
  /**
   * The `owner/name` of a repository as the provider verified it for the task's latest begun branch
   * action there, which exists whenever cab pushed or adopted; null before any.
   */
  verifiedRepositoryName(taskId: string, repositoryId: string): string | null {
    for (const a of this.actions(taskId).reverse()) {
      const path = a.beforeState?.repositoryPath;
      const found =
        a.request.action.kind.startsWith("branch.") &&
        a.request.action.target.repositoryId === repositoryId &&
        typeof path === "string"
          ? /^\/repos\/([^/]+\/[^/]+)$/.exec(path)
          : null;
      if (found?.[1]) return found[1];
    }
    return null;
  }
  taskBranches(taskId: string): TaskBranch[] {
    return this.db
      .prepare(
        "SELECT repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt FROM delivery_task_branches WHERE taskId=? ORDER BY assignedAt,repositoryId",
      )
      .all(taskId)
      .map((row) => taskBranchSchema.parse(row));
  }
  /**
   * A change request for a task imported from Jira starts its title with the issue key, so the code
   * host links it; and in a Jira project its text never carries a closing keyword for a Jira issue,
   * which would make the host close the issue and cab could not prove the closure as its own.
   */
  private assertJiraChangeRequestText(
    action: ExternalAction,
    binding: DeliveryCaller,
  ): void {
    if (action.kind !== "pr.create" && action.kind !== "pr.edit") return;
    const title =
      action.kind === "pr.create" ? action.title : action.fields.title;
    const body = action.kind === "pr.create" ? action.body : action.fields.body;
    const key = this.jiraKey(binding.taskId);
    const tracker = (
      this.db
        .prepare("SELECT provider FROM project_task_sources WHERE projectId=?")
        .get(binding.projectId) as { provider: string } | undefined
    )?.provider;
    if (key && title !== undefined && !titleStartsWith(title, key))
      throw new DomainPolicyError(
        "forbidden",
        `The change request title must start with the Jira issue key ${key}`,
      );
    if (
      tracker === "jira" &&
      [title, body].some((text) => text !== undefined && closesJiraIssue(text))
    )
      throw new DomainPolicyError(
        "forbidden",
        "Change request text must not close a Jira issue with a keyword such as Closes or Fixes; cab closes Jira issues itself",
      );
  }
  /** The issue tracker of the task's imported item; GitHub for a local task. */
  private trackerOf(taskId: string): SourceTracker {
    return (
      (this.db
        .prepare("SELECT provider, instance FROM external_items WHERE taskId=?")
        .get(taskId) as SourceTracker | undefined) ?? githubIssueTracker
    );
  }
  /** The Jira key of a task imported from Jira (`ABC-7`), else null. */
  private jiraKey(taskId: string): string | null {
    const item = this.db
      .prepare(
        "SELECT containerName, number FROM external_items WHERE taskId=? AND provider='jira'",
      )
      .get(taskId) as { containerName: string; number: number } | undefined;
    return item ? `${item.containerName}-${item.number}` : null;
  }
  /**
   * Assigns the task's one branch per repository on first use: `<prefix><task id hex>-<title slug>`
   * (`<prefix><Jira key>-<task id hex>-<title slug>` for a task imported from Jira, so the code host
   * links it), with the id part lengthened on a collision. Later title or prefix changes never rename it.
   */
  assignTaskBranchWithinTransaction(
    taskId: string,
    repositoryId: string,
  ): TaskBranch {
    const existing = this.taskBranch(taskId, repositoryId);
    if (existing) return existing;
    const task = z
        .object({ projectId: z.string(), title: z.string() })
        .parse(
          this.db
            .prepare("SELECT projectId,title FROM tasks WHERE id=?")
            .get(taskId),
        ),
      prefix =
        this.configuration(task.projectId).branchPrefix ?? defaultBranchPrefix,
      slug =
        task.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40)
          .replace(/-$/, "") || "task",
      hex = taskId.replaceAll("-", ""),
      key = this.jiraKey(taskId);
    for (const length of [8, 12, 16, 32]) {
      const branch = `${prefix}${key ? `${key}-` : ""}${hex.slice(0, length)}-${slug}`;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM delivery_task_branches WHERE repositoryId=? AND branch=?",
          )
          .get(repositoryId, branch)
      )
        continue;
      if (!safeBranchName(branch)) throw new Error("Task branch name invalid");
      this.db
        .prepare(
          "INSERT INTO delivery_task_branches VALUES (?,?,?,NULL,NULL,?)",
        )
        .run(taskId, repositoryId, branch, Date.now());
      const assigned = this.taskBranch(taskId, repositoryId);
      if (assigned) return assigned;
    }
    throw new Error("Task branch could not be assigned");
  }
  /**
   * Commits cab pushed, or may have pushed (an attempt that may have landed), for the repository,
   * and the outside head a confirmed recovery replaced or adopted: a PR that still shows it is lagging
   * behind the recovery, not an outside change.
   */
  private pushedShas(taskId: string, repositoryId: string): Set<string> {
    return new Set(
      this.actions(taskId).flatMap((a) => {
        const action = a.request.action;
        if (
          !action.kind.startsWith("branch.") ||
          action.target.repositoryId !== repositoryId
        )
          return [];
        const settled = a.state === "confirmed-success";
        return [
          ...((settled || this.mayHaveLanded(a.operationId)) &&
          "commitSha" in action
            ? [action.commitSha]
            : []),
          ...(settled && isRecoveryAction(action)
            ? [action.outsideHeadSha]
            : []),
        ];
      }),
    );
  }
  delivery(taskId: string): PrDeliveryBinding | null {
    const row = this.db
      .prepare("SELECT recordJson FROM delivery_pr_bindings WHERE taskId=?")
      .get(taskId) as { recordJson: string } | undefined;
    if (!row) return null;
    try {
      return prBindingSchema.parse(JSON.parse(row.recordJson));
    } catch {
      throw new Error("Invalid persisted PR delivery");
    }
  }
  deliveries(): PrDeliveryBinding[] {
    return (
      this.db
        .prepare("SELECT taskId FROM delivery_pr_bindings ORDER BY rowid")
        .all() as { taskId: string }[]
    ).map((row) => {
      const binding = this.delivery(row.taskId);
      if (!binding) throw new Error("PR delivery disappeared");
      return binding;
    });
  }
  private saveDelivery(binding: PrDeliveryBinding): void {
    this.db
      .prepare(
        "INSERT INTO delivery_pr_bindings VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET recordJson=excluded.recordJson",
      )
      .run(binding.taskId, canonicalMaterial(prBindingSchema.parse(binding)));
  }
  registerPrWithinTransaction(
    caller: RuntimeDeliveryCaller,
    observation: PrDeliveryObservation,
    leadAssignmentId: string,
  ): PrDeliveryBinding {
    const current = this.delivery(caller.taskId),
      policy = this.configuration(caller.projectId);
    this.db
      .prepare("INSERT OR IGNORE INTO delivery_waiting_work VALUES (?,?,?)")
      .run(caller.workId, caller.taskId, leadAssignmentId);
    if (current) {
      if (
        current.observation.nodeId !== observation.nodeId ||
        current.observation.repositoryId !== observation.repositoryId
      )
        throw new Error("Task already has another PR delivery");
      return this.observePrWithinTransaction(caller.taskId, observation)
        .binding;
    }
    const binding: PrDeliveryBinding = {
      taskId: caller.taskId,
      projectId: caller.projectId,
      leadAssignmentId,
      registeredWorkId: caller.workId,
      revision: 1,
      mode: policy.mode,
      observation,
      observationDigest: materialDigest(observation),
      observedAt: Date.now(),
      readError: null,
      settlement: null,
    };
    this.saveDelivery(binding);
    this.db
      .prepare("INSERT OR IGNORE INTO delivery_observations VALUES (?,?,?,?)")
      .run(
        caller.taskId,
        binding.observationDigest,
        canonicalMaterial(observation),
        Date.now(),
      );
    return binding;
  }
  observePrWithinTransaction(
    taskId: string,
    input: PrDeliveryObservation,
  ): {
    binding: PrDeliveryBinding;
    changed: boolean;
    firstSeen: boolean;
    /** Newly recorded: the PR's head is on the task branch but is no commit cab pushed. */
    outsideHead: boolean;
  } {
    const observation = prObservationSchema.parse(input),
      binding = this.delivery(taskId);
    if (!binding) throw new Error("Unknown PR delivery");
    if (
      observation.nodeId !== binding.observation.nodeId ||
      observation.repositoryId !== binding.observation.repositoryId ||
      observation.number !== binding.observation.number
    )
      throw new Error("PR observation identity changed");
    const digest = materialDigest(observation),
      changed = digest !== binding.observationDigest;
    const firstSeen = !this.db
      .prepare(
        "SELECT 1 FROM delivery_observations WHERE taskId=? AND digest=?",
      )
      .get(taskId, digest);
    if (changed || binding.readError) binding.revision++;
    if (
      observation.headSha !== binding.observation.headSha ||
      observation.state !== binding.observation.state ||
      observation.draft !== binding.observation.draft
    )
      binding.settlement = null;
    binding.observation = observation;
    binding.observationDigest = digest;
    binding.observedAt = Date.now();
    binding.readError = null;
    this.saveDelivery(binding);
    this.db
      .prepare("INSERT OR IGNORE INTO delivery_observations VALUES (?,?,?,?)")
      .run(taskId, digest, canonicalMaterial(observation), Date.now());
    const outsideHead = this.outsideHeadWithinTransaction(taskId, observation);
    return { binding, changed, firstSeen, outsideHead };
  }
  /**
   * Records a PR head on the task branch that cab did not push; true when newly recorded. A head
   * back at the last push clears an earlier record. A lagging head showing an earlier push is not outside.
   */
  outsideHeadWithinTransaction(
    taskId: string,
    observation: PrDeliveryObservation,
  ): boolean {
    const branch = this.taskBranch(taskId, observation.repositoryId);
    if (!branch || branch.branch !== observation.headRef) return false;
    // A PR keeps its head commit after the branch is deleted: only a ref read proves the branch is back.
    if (branch.outsideHeadSha === absentBranchHead) return false;
    if (observation.headSha === branch.lastPushedSha) {
      if (branch.outsideHeadSha !== null)
        this.db
          .prepare(
            "UPDATE delivery_task_branches SET outsideHeadSha=NULL WHERE taskId=? AND repositoryId=?",
          )
          .run(taskId, observation.repositoryId);
      return false;
    }
    if (
      branch.outsideHeadSha === observation.headSha ||
      this.pushedShas(taskId, observation.repositoryId).has(observation.headSha)
    )
      return false;
    this.db
      .prepare(
        "UPDATE delivery_task_branches SET outsideHeadSha=? WHERE taskId=? AND repositoryId=?",
      )
      .run(observation.headSha, taskId, observation.repositoryId);
    return true;
  }
  /** The remote branch was read back at the commit cab last pushed: any outside record is obsolete. */
  clearOutsideHead(taskId: string, repositoryId: string): void {
    this.db
      .prepare(
        "UPDATE delivery_task_branches SET outsideHeadSha=NULL WHERE taskId=? AND repositoryId=?",
      )
      .run(taskId, repositoryId);
  }
  /**
   * Any task branch, in any repository and with or without a PR, that records an outside head holds
   * completion. The bound PR's own branch also holds when its head is not cab's last push, and
   * a closed PR's own branch never holds, because GitHub may delete it and nothing clears that.
   */
  private branchHold(
    taskId: string,
    binding: PrDeliveryBinding | null,
  ): boolean {
    const observation = binding?.observation;
    return this.taskBranches(taskId).some((branch) =>
      observation &&
      branch.repositoryId === observation.repositoryId &&
      branch.branch === observation.headRef
        ? observation.state !== "CLOSED" &&
          (branch.outsideHeadSha !== null ||
            branch.lastPushedSha !== observation.headSha)
        : branch.outsideHeadSha !== null,
    );
  }
  recordPrReadFailure(taskId: string): void {
    this.transaction(() => {
      const binding = this.delivery(taskId);
      if (!binding) return;
      if (binding.readError !== "provider-read-unavailable") binding.revision++;
      binding.readError = "provider-read-unavailable";
      this.saveDelivery(binding);
    });
  }
  settlementReceipt(command: HandbackSettlement): PrDeliveryBinding | null {
    const row = this.db
      .prepare(
        "SELECT payloadHash,recordJson FROM delivery_settlement_receipts WHERE commandKey=?",
      )
      .get(command.key) as
      | { payloadHash: string; recordJson: string }
      | undefined;
    if (!row) return null;
    if (row.payloadHash !== materialDigest(command))
      throw new HandbackSettlementRefusedError(
        "Settlement key has different material",
      );
    return prBindingSchema.parse(JSON.parse(row.recordJson));
  }
  settleHandbackWithinTransaction(
    command: HandbackSettlement,
  ): PrDeliveryBinding {
    const binding = this.delivery(command.taskId);
    if (!binding)
      throw new HandbackSettlementRefusedError("Unknown PR delivery");
    // Closing the outcome does not accept the branch's content, so it stays possible on a closed PR.
    if (
      command.decision === "accepted" &&
      this.branchHold(command.taskId, binding)
    )
      throw new HandbackSettlementRefusedError(
        "Task branch changed outside cab",
      );
    if (
      binding.mode !== "reviewable-pr" ||
      binding.revision !== command.expectedDeliveryRevision ||
      binding.observation.headSha !== command.expectedHeadSha ||
      binding.readError ||
      this.configuration(binding.projectId).version !==
        command.expectedPolicyVersion
    )
      throw new HandbackSettlementRefusedError("Handback material changed");
    if (
      command.decision === "accepted" &&
      (binding.observation.draft || binding.observation.state === "CLOSED")
    )
      throw new HandbackSettlementRefusedError("PR is not reviewable");
    binding.revision++;
    binding.settlement = {
      key: command.key,
      decision: command.decision,
      headSha: command.expectedHeadSha,
      taskVersion: command.expectedTaskVersion,
      policyVersion: command.expectedPolicyVersion,
      createdAt: Date.now(),
    };
    this.saveDelivery(binding);
    this.db
      .prepare("INSERT INTO delivery_settlement_receipts VALUES (?,?,?)")
      .run(command.key, materialDigest(command), canonicalMaterial(binding));
    return binding;
  }
  completionBlockers(
    taskId: string,
    taskVersion?: number,
    exceptOperationId?: string,
  ): string[] {
    const reasons = this.actionBlockers(taskId, exceptOperationId),
      binding = this.delivery(taskId);
    if (!binding)
      return this.branchHold(taskId, null)
        ? [...reasons, "task-branch-outside-change"]
        : reasons;
    if (binding.readError) reasons.push("delivery-provider-read-unavailable");
    const policy = this.configuration(binding.projectId);
    if (binding.mode !== policy.mode) reasons.push("delivery-mode-changed");
    if (binding.observation.merged) return reasons;
    if (this.branchHold(taskId, binding))
      reasons.push("task-branch-outside-change");
    if (binding.mode === "through-merge")
      reasons.push("pr-not-confirmed-merged");
    else if (
      !binding.settlement ||
      binding.settlement.headSha !== binding.observation.headSha ||
      binding.settlement.policyVersion !== policy.version ||
      (taskVersion !== undefined &&
        binding.settlement.taskVersion !== taskVersion)
    )
      reasons.push("reviewable-pr-awaiting-current-settlement");
    return [...new Set(reasons)];
  }
  publicTask(taskId: string) {
    const task = this.db
      .prepare("SELECT projectId,version FROM domain_tasks WHERE id=?")
      .get(taskId) as { projectId: string; version: number } | undefined;
    if (!task) throw new Error("Unknown task");
    const configuration = this.publicConfiguration(task.projectId);
    const sourceRow = this.db
      .prepare(
        "SELECT externalId AS nodeId,containerId AS repositoryId,number AS issueNumber,observedState,labels FROM external_items WHERE taskId=?",
      )
      .get(taskId);
    const issue = sourceRow
      ? z
          .object({
            nodeId: identity,
            repositoryId: identity,
            issueNumber: z.number().int().positive(),
            observedState: z.enum(["open", "closed"]),
            labels: z.string(),
          })
          .parse(sourceRow)
      : null;
    const projectFields = issue
      ? this.db
          .prepare(
            `SELECT fields AS projectFields FROM source_memberships WHERE projectId=? AND ${itemIs()}`,
          )
          .all(task.projectId, ...itemKey(issue.nodeId))
          .flatMap((row) =>
            z
              .array(
                z
                  .object({
                    projectNodeId: identity,
                    fieldNodeId: identity,
                    optionNodeId: identity,
                  })
                  .strict(),
              )
              .parse(
                JSON.parse(
                  z.object({ projectFields: z.string() }).parse(row)
                    .projectFields,
                ),
              ),
          )
      : [];
    return {
      issueObservation: issue
        ? {
            ...issue,
            labels: z.array(identity).parse(JSON.parse(issue.labels)),
          }
        : null,
      projectFieldObservations: projectFields,
      policyVersion: configuration.version,
      mode: configuration.mode,
      binding: this.delivery(taskId),
      branches: this.taskBranches(taskId),
      blockers: this.completionBlockers(taskId, task.version),
      actions: this.actions(taskId).map((a) => ({
        operationId: a.operationId,
        kind: a.request.action.kind,
        caller: isServiceDeliveryCaller(a.binding)
          ? ("service" as const)
          : isOperatorDeliveryCaller(a.binding) ||
              isOperatorPublicationCaller(a.binding)
            ? ("operator" as const)
            : ("agent" as const),
        event: isServiceDeliveryCaller(a.binding) ? a.binding.event : null,
        target: a.request.action.target,
        state: a.state,
        attempts: a.attempts,
        reason: a.observation?.reason ?? null,
        receipt: a.observation?.receipt ?? null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    };
  }
  ownsConfirmedClosure(taskId: string, nodeId: string): boolean {
    return !!this.ownClosureOperation(taskId, nodeId);
  }
  /** The latest confirmed operation that closed the issue, unless a reopen superseded it. */
  ownClosureOperation(
    taskId: string,
    nodeId: string,
  ): DeliveryActionRecord | undefined {
    const superseded = new Set(
      (
        this.db
          .prepare(
            `SELECT operationId FROM source_closure_supersessions WHERE ${itemIs()}`,
          )
          .all(...itemKey(nodeId, this.trackerOf(taskId))) as {
          operationId: string;
        }[]
      ).map((row) => row.operationId),
    );
    const binding = this.delivery(taskId);
    // Any recorded observation counts: a reopened issue leaves the merged PR's closed list.
    const mergedClosure = (prNodeId: string) =>
      binding?.observation.nodeId === prNodeId &&
      !!this.db
        .prepare(
          `SELECT 1 FROM delivery_observations WHERE taskId = ?
            AND json_extract(observationJson, '$.nodeId') = ?
            AND json_extract(observationJson, '$.merged') = 1
            AND EXISTS (SELECT 1 FROM json_each(observationJson, '$.closedIssueNodeIds') WHERE value = ?)`,
        )
        .get(taskId, prNodeId, nodeId);
    return this.actions(taskId)
      .filter(
        (a) =>
          a.state === "confirmed-success" &&
          !superseded.has(a.operationId) &&
          ((a.request.action.kind === "issue.close" &&
            a.request.action.target.nodeId === nodeId &&
            a.observation?.receipt?.issueClosed === true &&
            a.beforeState?.state === "open") ||
            (a.request.action.kind === "pr.merge" &&
              a.observation?.receipt?.merged === true &&
              mergedClosure(a.request.action.target.nodeId))),
      )
      .at(-1);
  }
  hasWaitingPr(workId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM delivery_waiting_work WHERE workId=?")
        .get(workId),
    );
  }
  configuration(projectId: string): DeliveryPolicy {
    const row = this.db
      .prepare(
        "SELECT version, policyJson FROM delivery_policies WHERE projectId = ?",
      )
      .get(z.string().uuid().parse(projectId)) as
      | { version: number; policyJson: string }
      | undefined;
    if (!row)
      return {
        version: 1,
        mode: "reviewable-pr",
        credentialRef: null,
        grants: [],
        requiredChecks: [],
      };
    try {
      return {
        ...deliveryPolicySchema.parse(JSON.parse(row.policyJson)),
        version: z.number().int().positive().parse(row.version),
      };
    } catch {
      throw new Error("Invalid persisted delivery policy");
    }
  }
  publicConfiguration(projectId: string) {
    const { credentialRef, ...policy } = this.configuration(projectId);
    return { ...policy, credentialConfigured: credentialRef !== null };
  }
  configureWithinTransaction(
    projectId: string,
    expectedVersion: number,
    input: unknown,
  ) {
    const current = this.configuration(projectId);
    if (current.version !== expectedVersion)
      throw new Error("Version conflict: delivery policy changed");
    const policy = deliveryPolicySchema.parse(input);
    for (const grant of policy.grants) {
      if (
        grant.action === "project.field" &&
        (!grant.projectNodeId ||
          !grant.fieldNodeId ||
          !grant.optionNodeIds?.length)
      )
        throw new Error("Project field grant requires exact field and options");
      if (grant.action === "project.item.add" && !grant.projectNodeId)
        throw new Error("Project item grant requires an exact Project");
      if (
        grant.action === "issue.status"
          ? !grant.statusIds?.length
          : grant.statusIds
      )
        throw new Error(
          "Only an issue.status grant takes statusIds, and it requires some",
        );
    }
    this.db
      .prepare(
        "INSERT INTO delivery_policies VALUES (?, ?, ?) ON CONFLICT(projectId) DO UPDATE SET version=excluded.version, policyJson=excluded.policyJson",
      )
      .run(projectId, current.version + 1, canonicalMaterial(policy));
    return this.publicConfiguration(projectId);
  }
}
