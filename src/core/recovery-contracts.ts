import { z } from "zod";

/**
 * Key-less, structural bodies of the evidence-bearing recovery commands. The standalone
 * schemas add the request key (and the runtime-specific rejection check); the operator
 * command contract adds its type and assignment. Attestations are operator assertions.
 */
export const processIdentitySchema = z
  .object({
    processId: z.string().min(1).max(128),
    processStartedAt: z.string().min(1).max(128),
    bootId: z.string().min(1).max(128),
  })
  .strict();

export const recoveryGenerationSchema = z.object({
  workId: z.string().min(1).max(512),
  workRevision: z.number().int().positive(),
  requestSequence: z.number().int().positive().safe(),
  processIdentity: processIdentitySchema,
});
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
/** The persisted runtime error a pre-turn adoption asserts. */
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
    conversationRevision: z.number().int().positive(),
    writerSequence: z.number().int().positive().safe(),
    retainedReason: z.string().min(1).max(4000),
    evidence: noTurnEvidenceSchema,
    attestation: noTurnAttestationSchema,
  })
  .strict();

export const recoveryReceiptBaseSchema = z.object({
  workId: z.string().min(1),
  workRevision: z.number().int().positive().nullable(),
  requestSequence: z.number().int().positive(),
  processIdentity: processIdentitySchema,
  termination: z.object({ kind: z.literal("process-exit") }).strict(),
  effects: z.literal("settled"),
  workspace: z.enum(["preserved", "reconciled"]),
});
export const preTurnRecoveryReceiptSchema = recoveryReceiptBaseSchema
  .extend({
    kind: z.literal("pre-turn-rejection"),
    witnessId: z.string().uuid(),
    workRevision: z.number().int().positive(),
    threadId: z.null(),
    turnId: z.null(),
  })
  .strict();
export const noTurnRecoveryReceiptSchema = preTurnRecoveryReceiptSchema
  .extend({ kind: z.literal("no-turn-submission") })
  .strict();
export const preTurnRecoveryBodySchema = z
  .object({ receipt: preTurnRecoveryReceiptSchema })
  .strict();
export const noTurnRecoveryBodySchema = z
  .object({ receipt: noTurnRecoveryReceiptSchema })
  .strict();
export const replaceConversationBodySchema = z
  .object({
    assignmentId: z.string().uuid(),
    expectedAssignmentVersion: z.number().int().positive(),
    expectedConversationRevision: z.number().int().positive(),
  })
  .strict();

/** The five operator recovery paths, in the order an operator meets them. */
export const recoveryPaths = [
  "pre-turn-adopt",
  "pre-turn-recover",
  "no-turn-adopt",
  "no-turn-recover",
  "conversation-replace",
] as const;
export type RecoveryPath = (typeof recoveryPaths)[number];
/** Operator command type of each path. */
export const recoveryCommandTypes = {
  "pre-turn-adopt": "recovery.pre-turn.adopt",
  "pre-turn-recover": "recovery.pre-turn.recover",
  "no-turn-adopt": "recovery.no-turn.adopt",
  "no-turn-recover": "recovery.no-turn.recover",
  "conversation-replace": "recovery.conversation.replace",
} as const satisfies Record<RecoveryPath, string>;

/**
 * What each path needs beyond the identity the service observes: the operator evidence
 * file's fields and its attestations. Derived from the schemas so help, output and
 * validation cannot drift.
 */
export const recoveryRequirements: Record<
  RecoveryPath,
  { evidence: string[]; attestations: string[]; receipt: string[] }
> = {
  "pre-turn-adopt": {
    evidence: [
      "rpcError",
      ...Object.keys(recoveryEvidenceSchema.shape).map((k) => `evidence.${k}`),
    ],
    attestations: Object.keys(preTurnAttestationSchema.shape),
    receipt: [],
  },
  "pre-turn-recover": {
    evidence: [],
    attestations: [],
    receipt: ["termination", "effects", "workspace"],
  },
  "no-turn-adopt": {
    evidence: Object.keys(noTurnEvidenceSchema.shape).map(
      (k) => `evidence.${k}`,
    ),
    attestations: Object.keys(noTurnAttestationSchema.shape),
    receipt: [],
  },
  "no-turn-recover": {
    evidence: [],
    attestations: [],
    receipt: ["termination", "effects", "workspace"],
  },
  "conversation-replace": { evidence: [], attestations: [], receipt: [] },
};
