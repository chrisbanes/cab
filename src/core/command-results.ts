import { z } from "zod";
import { canonicalMaterial, deliveryPolicySchema } from "./delivery.js";
import type { DomainCommand } from "./domain.js";
import { linkedRepositorySchema } from "./github-source.js";
import { githubConfigurationSchema } from "./github-source-contracts.js";

const id = z.string().uuid();
const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();
const sqliteFlag = z.union([z.literal(0), z.literal(1)]);

export const projectCommandResultSchema = z
  .object({
    id,
    name: z.string(),
    version: positiveInteger,
    paused: sqliteFlag,
    leadProfileId: id.nullable(),
    instructionsRevision: positiveInteger,
    instructions: z.string(),
  })
  .strict();

export const taskCommandResultSchema = z
  .object({
    id,
    projectId: id,
    version: positiveInteger,
    outcome: z.string(),
    ready: sqliteFlag,
    state: z.enum(["open", "done", "cancelled"]),
    importedBlockers: z.enum(["clear", "blocked", "unknown"]),
    title: z.string(),
  })
  .strict();

export const profileCommandResultSchema = z
  .object({
    id,
    version: positiveInteger,
    name: z.string(),
    summary: z.string(),
    instructions: z.string(),
    capabilities: z.string(),
    revoked: sqliteFlag,
  })
  .strict();

export const assignmentCommandResultSchema = z
  .object({
    id,
    taskId: id,
    projectId: id,
    version: positiveInteger,
    profileId: id,
    profileRevision: positiveInteger,
    instructionsRevision: positiveInteger,
    brief: z.string(),
    resultDestination: z.string(),
    requesterAssignmentId: id.nullable(),
    resultRecipientAssignmentId: id.nullable(),
    resultRecipientDisposition: z.enum(["resolved", "unresolved"]),
    state: z.enum(["pending", "running", "completed", "held"]),
  })
  .strict();

const legacyProfileCommandResultSchema = profileCommandResultSchema
  .extend({ summary: z.string().optional() })
  .strict();
const legacyAssignmentCommandResultSchema = assignmentCommandResultSchema
  .extend({
    resultRecipientAssignmentId: id.nullable().optional(),
    resultRecipientDisposition: z.enum(["resolved", "unresolved"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Object.hasOwn(value, "resultRecipientAssignmentId") !==
      Object.hasOwn(value, "resultRecipientDisposition")
    )
      context.addIssue({
        code: "custom",
        message: "Assignment recipient fields must be present together",
      });
  });

const candidateProfileIdsJson = z.string().superRefine((value, context) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid candidate profile JSON",
    });
    return;
  }
  const result = z.array(id).safeParse(parsed);
  if (!result.success)
    context.addIssue({
      code: "custom",
      message: "Invalid candidate profile IDs",
    });
});

export const routingCommandResultSchema = z
  .object({
    projectId: id,
    version: positiveInteger,
    enabled: sqliteFlag,
    guidance: z.string(),
    credentialAvailable: sqliteFlag,
    candidateProfileIds: candidateProfileIdsJson,
  })
  .strict();

export const deliveryCommandResultSchema = deliveryPolicySchema
  .omit({ credentialRef: true })
  .extend({ version: positiveInteger, credentialConfigured: z.boolean() })
  .strict();

export const githubConfigurationCommandResultSchema = githubConfigurationSchema
  .extend({
    version: positiveInteger,
    repositories: z
      .array(linkedRepositorySchema)
      .max(20)
      .refine(
        (values) =>
          new Set(values.map((value) => value.repositoryId)).size ===
          values.length,
        "Repository IDs must be unique",
      ),
  })
  .strict();

export const githubActivationCommandResultSchema = z
  .object({
    projectId: id,
    selectionId: z.string().trim().min(1).max(512),
    configVersion: positiveInteger,
    active: z.literal(true),
  })
  .strict();

const numericRecord = z.record(id, positiveInteger);
const usageRecord = z.record(id, nonnegativeInteger);
export const capacityCommandResultSchema = z
  .object({
    globalLimit: positiveInteger,
    defaultProjectLimit: z.literal(2),
    projectOverrides: numericRecord,
    currentUsage: z
      .object({ global: nonnegativeInteger, projects: usageRecord })
      .strict(),
    effectiveProjectLimits: numericRecord,
  })
  .strict();

export const credentialStatusCommandResultSchema = z
  .object({ configured: z.boolean() })
  .strict();

export interface DomainCommandResultMap {
  "delivery.configure": z.output<typeof deliveryCommandResultSchema>;
  "project.create": z.output<typeof projectCommandResultSchema>;
  "project.configure": z.output<typeof projectCommandResultSchema>;
  "task.create": z.output<typeof taskCommandResultSchema>;
  "task.configure": z.output<typeof taskCommandResultSchema>;
  "profile.create": z.output<typeof legacyProfileCommandResultSchema>;
  "profile.configure": z.output<typeof legacyProfileCommandResultSchema>;
  "routing.configure": z.output<typeof routingCommandResultSchema>;
  "github.configure": z.output<typeof githubConfigurationCommandResultSchema>;
  "github.activate": z.output<typeof githubActivationCommandResultSchema>;
  "github.place": z.output<typeof taskCommandResultSchema>;
  "source.review": z.output<typeof taskCommandResultSchema>;
  "assignment.create": z.output<typeof legacyAssignmentCommandResultSchema>;
  "assignment.apply": z.output<typeof legacyAssignmentCommandResultSchema>;
  "dependency.add": z.output<typeof taskCommandResultSchema>;
  "dependency.remove": z.output<typeof taskCommandResultSchema>;
  "imported-blockers.set": z.output<typeof taskCommandResultSchema>;
  "capacity.configure": z.output<typeof capacityCommandResultSchema>;
  "discovery.configure": z.output<typeof credentialStatusCommandResultSchema>;
  "claude-token.configure": z.output<
    typeof credentialStatusCommandResultSchema
  >;
}

type DomainCommandType = DomainCommand["type"];

export type DomainCommandOutcome = {
  [K in DomainCommandType]: { type: K; result: DomainCommandResultMap[K] };
}[DomainCommandType];

export class CommandResultValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandResultValidationError";
  }
}

function parseUnchanged<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    const parsed = schema.parse(value);
    if (canonicalMaterial(parsed) !== canonicalMaterial(value))
      throw new CommandResultValidationError(
        "Command result schema changed validated material",
      );
    return parsed;
  } catch (error) {
    if (error instanceof CommandResultValidationError) throw error;
    throw new CommandResultValidationError(
      "Command result failed runtime validation",
      { cause: error },
    );
  }
}

export function parseLinkedRepositoryResult(value: unknown) {
  return parseUnchanged(linkedRepositorySchema, value);
}

/** Validate an untrusted apply, receipt, or provider result without changing its shape. */
export function parseDomainCommandOutcome<K extends DomainCommandType>(
  type: K,
  value: unknown,
): Extract<DomainCommandOutcome, { type: K }>;
export function parseDomainCommandOutcome(
  type: DomainCommandType,
  value: unknown,
): DomainCommandOutcome {
  return parseCommandOutcome(type, value, false);
}

/** Validate a newly applied result with the current required result shape. */
export function parseFreshDomainCommandOutcome<K extends DomainCommandType>(
  type: K,
  value: unknown,
): Extract<DomainCommandOutcome, { type: K }>;
export function parseFreshDomainCommandOutcome(
  type: DomainCommandType,
  value: unknown,
): DomainCommandOutcome {
  return parseCommandOutcome(type, value, true);
}

function parseCommandOutcome(
  type: DomainCommandType,
  value: unknown,
  fresh: boolean,
): DomainCommandOutcome {
  switch (type) {
    case "delivery.configure":
      return {
        type,
        result: parseUnchanged(deliveryCommandResultSchema, value),
      };
    case "project.create":
    case "project.configure":
      return {
        type,
        result: parseUnchanged(projectCommandResultSchema, value),
      };
    case "task.create":
    case "task.configure":
    case "github.place":
    case "source.review":
    case "dependency.add":
    case "dependency.remove":
    case "imported-blockers.set":
      return { type, result: parseUnchanged(taskCommandResultSchema, value) };
    case "profile.create":
    case "profile.configure":
      return {
        type,
        result: parseUnchanged(
          fresh ? profileCommandResultSchema : legacyProfileCommandResultSchema,
          value,
        ),
      };
    case "routing.configure":
      return {
        type,
        result: parseUnchanged(routingCommandResultSchema, value),
      };
    case "github.configure":
      return {
        type,
        result: parseUnchanged(githubConfigurationCommandResultSchema, value),
      };
    case "github.activate":
      return {
        type,
        result: parseUnchanged(githubActivationCommandResultSchema, value),
      };
    case "assignment.create":
    case "assignment.apply":
      return {
        type,
        result: parseUnchanged(
          fresh
            ? assignmentCommandResultSchema
            : legacyAssignmentCommandResultSchema,
          value,
        ),
      };
    case "capacity.configure":
      return {
        type,
        result: parseUnchanged(capacityCommandResultSchema, value),
      };
    case "discovery.configure":
    case "claude-token.configure":
      return {
        type,
        result: parseUnchanged(credentialStatusCommandResultSchema, value),
      };
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
