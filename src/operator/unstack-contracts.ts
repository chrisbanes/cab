import { z } from "zod";
const uuid = z.string().uuid();
const revision = z.number().int().positive();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const unstackPhaseSchema = z.enum([
  "prepared",
  "unstack-attempting",
  "unstack-confirmed",
  "retarget-attempting",
  "retarget-confirmed",
  "confirmed",
  "failed",
]);
export const unstackReceiptSchema = z
  .object({
    kind: z.literal("task-unstack"),
    key: uuid,
    taskId: uuid,
    recorded: z.literal(true),
    expectedVersion: revision,
    materialHash: digest,
    phase: unstackPhaseSchema,
    revision,
    reason: z.enum([
      "pending",
      "readback-required",
      "readback-unavailable",
      "authority-changed",
      "identity-changed",
      "unstack-refused",
      "retarget-refused",
      "confirmed",
    ]),
  })
  .strict();
export const cancelReceiptSchema = z
  .object({
    kind: z.literal("task-cancel"),
    key: uuid,
    recorded: z.literal(true),
    taskId: uuid,
    cancellationRequested: z.number().int().nonnegative().safe(),
  })
  .strict();
export const unstackPreviewSchema = z
  .object({
    taskId: uuid,
    expectedVersion: revision,
    materialHash: digest,
    repository: z.string().min(1).max(512),
    selectedPr: revision,
    stackNumber: revision,
    targetBase: z.string().min(1).max(512),
    members: z
      .array(
        z
          .object({
            number: revision,
            state: z.enum(["OPEN", "CLOSED", "MERGED"]),
          })
          .strict(),
      )
      .min(2)
      .max(128),
  })
  .strict();
export const unstackReadSchema = z
  .object({
    data: z
      .object({
        taskId: uuid,
        readOnly: z.boolean(),
        failedBlocker: z.boolean(),
        cancelAvailable: z.boolean(),
        preview: unstackPreviewSchema.nullable(),
        operation: unstackReceiptSchema.nullable(),
        cancelOperation: cancelReceiptSchema.nullable(),
        available: z.boolean(),
        unavailable: z
          .enum(["archived", "unproved", "not-stacked", "pending"])
          .nullable(),
      })
      .strict(),
    observedAt: z.number(),
  })
  .strict();
export type UnstackReceipt = z.output<typeof unstackReceiptSchema>;
export type UnstackRead = z.output<typeof unstackReadSchema>;
