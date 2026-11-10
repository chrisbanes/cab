import { z } from "zod";
import {
  boundTurnRecoveryBodySchema,
  noTurnRecoveryBodySchema,
  noTurnRecoveryReceiptSchema,
  preTurnRecoveryBodySchema,
  preTurnRecoveryReceiptSchema,
  processIdentitySchema,
  recoveryGenerationSchema,
  recoveryReceiptBaseSchema,
  releaseBodySchema,
  replaceConversationBodySchema,
} from "../core/recovery-contracts.js";
import { RuntimeRequestRejectedError } from "./pre-turn-failure.js";

export { processIdentitySchema };

/**
 * Stored material of the retired operator adoption routes. Their witnesses and command
 * records stay in existing data and are validated against these shapes when read.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryEvidenceSchema = z
  .object({
    frozenSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    frozenHarnessSha256: digest,
    evidenceSha256: digest,
    approvedDecisionSha256: digest,
    reviewReference: z.url().max(2048).startsWith("https://"),
    approvalReference: z.url().max(2048).startsWith("https://"),
  })
  .strict();
export const noTurnEvidenceSchema = recoveryEvidenceSchema
  .extend({ invocationLedgerSha256: digest })
  .strict();
/** The persisted runtime error of an archived resume rejection. */
export const recoveryRpcErrorSchema = z
  .object({ code: z.literal(-32600), message: z.string().max(2000) })
  .strict();
export const preTurnAttestationSchema = z
  .object({
    beforeTurnRejected: z.literal(true),
    noTurnSubmitted: z.literal(true),
    independentlyReviewed: z.literal(true),
  })
  .strict();
export const noTurnAttestationSchema = z
  .object({
    completeSynchronousWriteAheadLedger: z.literal(true),
    noStartTurnInvocation: z.literal(true),
    independentlyReviewed: z.literal(true),
    idleThreadMayExist: z.literal(true),
  })
  .strict();

export const historicalPreTurnAdoptionBodySchema = recoveryGenerationSchema
  .extend({
    predecessorWorkId: z.string().min(1).max(512),
    predecessorThreadId: z.string().min(1).max(512),
    retainedReason: z.string().min(1).max(4000),
    rpcError: recoveryRpcErrorSchema,
    evidence: recoveryEvidenceSchema,
    attestation: preTurnAttestationSchema,
  })
  .strict();
export const historicalNoTurnAdoptionBodySchema = recoveryGenerationSchema
  .extend({
    kind: z.literal("historical-no-turn-submission"),
    /** Both present for a resume of a known completed predecessor; both absent otherwise. */
    predecessorWorkId: z.string().min(1).max(512).optional(),
    predecessorThreadId: z.string().min(1).max(512).optional(),
    conversationRevision: z.number().int().positive(),
    writerSequence: z.number().int().positive().safe(),
    retainedReason: z.string().min(1).max(4000),
    evidence: noTurnEvidenceSchema,
    attestation: noTurnAttestationSchema,
  })
  .strict();

export function archivedResumeMessage(threadId: string): string {
  return `session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`;
}
/** How a pre-turn RPC rejection was held, which historical pre-turn adoption restates. */
export function rejectedRequestHoldReason(error: {
  code: number;
  message: string;
}): string {
  return `Runtime submission or observation uncertain: Error: ${JSON.stringify({ code: error.code, message: error.message })}`;
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
export class ArchivedResumeRejectedError extends RuntimeRequestRejectedError {
  readonly rejection: ArchivedResumeRejection;
  constructor(rejection: ArchivedResumeRejection) {
    super(JSON.stringify(rejection.error));
    this.rejection = archivedResumeRejectionSchema.parse(rejection);
  }
}

const key = z.string().uuid();
export const boundTurnRecoveryCommandSchema = boundTurnRecoveryBodySchema
  .extend({ key })
  .strict();
export type BoundTurnRecoveryCommand = z.infer<
  typeof boundTurnRecoveryCommandSchema
>;
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
  .strict()
  .refine(
    (v) =>
      (v.predecessorWorkId === undefined) ===
      (v.predecessorThreadId === undefined),
    "A predecessor needs both its work and thread",
  );
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
export const releaseCommandSchema = releaseBodySchema.extend({ key }).strict();
export type ReleaseCommand = z.infer<typeof releaseCommandSchema>;
export const releaseResultSchema = z
  .object({
    id: z.string().uuid(),
    workId: z.string().min(1),
    state: z.literal("refused"),
  })
  .strict();
