import { z } from "zod";
import {
  historicalNoTurnAdoptionBodySchema,
  historicalPreTurnAdoptionBodySchema,
  noTurnRecoveryBodySchema,
  noTurnRecoveryReceiptSchema,
  preTurnRecoveryBodySchema,
  preTurnRecoveryReceiptSchema,
  processIdentitySchema,
  recoveryReceiptBaseSchema,
  recoveryRpcErrorSchema,
  replaceConversationBodySchema,
} from "../core/recovery-contracts.js";

export { processIdentitySchema };

export function archivedResumeMessage(threadId: string): string {
  return `session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`;
}
export const archivedResumeRejectionSchema = z
  .object({
    method: z.literal("thread/resume"),
    requestId: z.number().int().positive().safe(),
    threadId: z.string().min(1).max(512),
    processIdentity: processIdentitySchema,
    error: recoveryRpcErrorSchema,
  })
  .strict()
  .refine(
    (value) => value.error.message === archivedResumeMessage(value.threadId),
    "Not an exact archived resume rejection",
  );
export type ArchivedResumeRejection = z.infer<
  typeof archivedResumeRejectionSchema
>;

/** Produced only from a correlated response to the owned runtime request. */
export class ArchivedResumeRejectedError extends Error {
  readonly rejection: ArchivedResumeRejection;
  constructor(rejection: ArchivedResumeRejection) {
    super(JSON.stringify(rejection.error));
    this.rejection = archivedResumeRejectionSchema.parse(rejection);
  }
}

const key = z.string().uuid();
export const historicalPreTurnAdoptionSchema =
  historicalPreTurnAdoptionBodySchema
    .extend({ key })
    .strict()
    .refine(
      (v) =>
        v.rpcError.message === archivedResumeMessage(v.predecessorThreadId),
      "Not an archived predecessor rejection",
    );
export type HistoricalPreTurnAdoption = z.infer<
  typeof historicalPreTurnAdoptionSchema
>;
export const historicalNoTurnAdoptionSchema = historicalNoTurnAdoptionBodySchema
  .extend({ key })
  .strict();
export type HistoricalNoTurnAdoption = z.infer<
  typeof historicalNoTurnAdoptionSchema
>;

export { noTurnRecoveryReceiptSchema, preTurnRecoveryReceiptSchema };
export const noTurnRecoveryCommandSchema = noTurnRecoveryBodySchema
  .extend({ key })
  .strict();
export type NoTurnRecoveryCommand = z.infer<typeof noTurnRecoveryCommandSchema>;
export const recoveryReceiptSchema = z.union([
  recoveryReceiptBaseSchema
    .extend({
      kind: z.literal("bound-turn").optional(),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
    })
    .strict(),
  preTurnRecoveryReceiptSchema,
  noTurnRecoveryReceiptSchema,
]);
export type RecoveryReceipt = z.infer<typeof recoveryReceiptSchema>;
export const preTurnRecoveryCommandSchema = preTurnRecoveryBodySchema
  .extend({ key })
  .strict();
export type PreTurnRecoveryCommand = z.infer<
  typeof preTurnRecoveryCommandSchema
>;
export const replaceConversationCommandSchema = replaceConversationBodySchema
  .extend({ key })
  .strict();
export type ReplaceConversationCommand = z.infer<
  typeof replaceConversationCommandSchema
>;
