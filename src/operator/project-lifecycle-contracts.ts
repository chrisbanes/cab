import { z } from "zod";
import { archiveBlockerSchema } from "../core/project-lifecycle.js";
const id = z.string().uuid(),
  text = z.string().max(16000).nullable();
export const projectLifecycleReadSchema = z
  .object({
    archiveEligible: z.boolean(),
    blockers: z.array(
      z
        .object({ kind: archiveBlockerSchema.shape.kind, reason: text })
        .strict(),
    ),
  })
  .strict();
export const projectDeletionCountsSchema = z
  .object({
    tasks: z.number().int().nonnegative(),
    assignments: z.number().int().nonnegative(),
    worktrees: z.number().int().nonnegative(),
  })
  .strict();
export const retainedProjectExternalSchema = z
  .object({
    codeHost: z.enum(["github", "gitlab"]),
    host: text,
    repositoryId: text,
    branch: text,
    changeRequestId: text,
  })
  .strict();
/** Public consequences only: never a binding, path, thread or private cleanup item identity. */
export const projectDeletePreviewDataSchema = z
  .object({
    projectId: id,
    version: z.number().int().positive(),
    name: text,
    archived: z.literal(true),
    counts: projectDeletionCountsSchema,
    worktrees: z.array(
      z
        .object({
          kind: z.enum(["task", "drafting"]),
          dirty: z.enum(["yes", "no", "unknown"]),
          unpushed: z.enum(["yes", "no", "unknown"]),
          inspection: z.enum(["available", "absent", "unsafe", "unavailable"]),
        })
        .strict(),
    ),
    affectedProjects: z.array(z.object({ projectId: id, name: text }).strict()),
    externalRemnants: z.array(retainedProjectExternalSchema),
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    forceDiscard: z.literal(true),
    outsideDiscovery: z.literal("recorded-identities-only"),
  })
  .strict();
export const projectDeletePreviewSchema = z
  .object({
    data: projectDeletePreviewDataSchema,
    observedAt: z.number().int().nonnegative(),
  })
  .strict();
export const projectTombstoneSchema = z
  .object({
    projectId: id,
    name: text,
    deletedAt: z.string().datetime(),
    counts: projectDeletionCountsSchema,
    externalRemnants: z.array(retainedProjectExternalSchema),
    cleanup: z
      .object({
        state: z.enum(["pending", "complete"]),
        pending: z.number().int().nonnegative(),
        complete: z.number().int().nonnegative(),
        reasons: z.array(
          z.enum([
            "not-attempted",
            "unavailable",
            "unsafe",
            "failed",
            "unknown",
          ]),
        ),
      })
      .strict(),
  })
  .strict();
