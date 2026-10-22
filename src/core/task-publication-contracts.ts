import { z } from "zod";

/**
 * Why a local task cannot be published to GitHub at all, in the order the server reports them.
 * The first reason that applies wins.
 */
export const publicationReasonCodes = [
  "task-imported",
  "task-not-open",
  "task-started",
  "local-dependencies",
  "publication-unresolved",
  "no-github-source",
  "no-delivery-credential",
] as const;
export type PublicationReasonCode = (typeof publicationReasonCodes)[number];

/** Why one target cannot take the publication, in the order the server reports them. */
export const publicationTargetReasonCodes = [
  "selection-unpredictable",
  "no-create-grant",
  "no-item-grant",
  "no-field-grant",
  "readiness-unsatisfiable",
  "would-become-ready",
] as const;
export type PublicationTargetReasonCode =
  (typeof publicationTargetReasonCodes)[number];

/** Where a publication is in its life; only `sending` holds the task. */
export const publicationStates = [
  "reviewed",
  "approved",
  "sending",
  "converted",
  "abandoned",
  "denied",
  "failed",
] as const;
export type PublicationState = (typeof publicationStates)[number];

/** The delivery reason recorded on a create the operator gave up on without proof it did not land. */
export const publicationAbandonedReason = "publication-abandoned-unproved";

/** The marker an `issue.create` appends to its body, by which a read-back or a link recognises it. */
export const publicationMarker = (operationId: string) =>
  `<!-- ensemble-operation:${operationId} -->`;

export const publicationProjectFieldSchema = z
  .object({
    projectNodeId: z.string().min(1),
    fieldNodeId: z.string().min(1),
    optionNodeId: z.string().min(1),
  })
  .strict();
export type PublicationProjectField = z.output<
  typeof publicationProjectFieldSchema
>;

/** One place a local task can be published, with what publishing there writes and predicts. */
export const publicationTargetSchema = z
  .object({
    /** `<selection id>~<repository id>`; a selection that names no repository ends in `~`. */
    id: z.string().min(1),
    selectionId: z.string().min(1),
    repositoryId: z.string().min(1).nullable(),
    /** The repository's `owner/name`, or its id while no name is known. */
    repository: z.string().min(1),
    kind: z.enum(["repository", "project", "search"]),
    /** The Project node of a `project` selection. */
    projectNodeId: z.string().min(1).nullable(),
    enabled: z.boolean(),
    reasonCode: z.enum(publicationTargetReasonCodes).nullable(),
    /** The readiness labels the issue is created with. */
    labels: z.array(z.string().min(1)),
    /** The readiness Project fields written after the item is added. */
    projectFields: z.array(publicationProjectFieldSchema),
    predictedSelected: z.boolean(),
    predictedReady: z.boolean(),
  })
  .strict();
export type PublicationTarget = z.output<typeof publicationTargetSchema>;
