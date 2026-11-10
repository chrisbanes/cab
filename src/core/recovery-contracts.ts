import { z } from "zod";

/**
 * Key-less, structural bodies of the recovery commands. The standalone schemas add the
 * request key; the operator command contract adds its type and assignment.
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
export const recoveryReceiptBaseSchema = z.object({
  workId: z.string().min(1),
  workRevision: z.number().int().positive().nullable(),
  requestSequence: z.number().int().positive(),
  processIdentity: processIdentitySchema,
  termination: z.object({ kind: z.literal("process-exit") }).strict(),
  effects: z.literal("settled"),
  workspace: z.enum(["preserved", "reconciled"]),
});
export const boundTurnRecoveryReceiptSchema = recoveryReceiptBaseSchema
  .extend({
    kind: z.literal("bound-turn"),
    workId: z.string().min(1).max(512),
    workRevision: z.number().int().positive().safe(),
    requestSequence: z.number().int().positive().safe(),
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
  })
  .strict();
export const boundTurnRecoveryBodySchema = z
  .object({
    assignmentId: z.string().uuid(),
    receipt: boundTurnRecoveryReceiptSchema,
  })
  .strict();
export const boundTurnRecoveryBlockers = [
  "bound-identity-missing",
  "pending-effects",
  "known-survivor",
  "callback-pending",
  "termination-live",
  "termination-conflict",
  "termination-unknown",
  "identity-changed",
] as const;
export type BoundTurnRecoveryBlocker =
  | (typeof boundTurnRecoveryBlockers)[number]
  | "not-held"
  | "ownership-released"
  | "context-unavailable"
  | "other-witness"
  | "already-reconciled";

/**
 * Why a held generation cannot be released as never having sent a turn. cab saves the
 * thread binding before it calls `startTurn`, so a null saved thread and turn prove no turn
 * was sent; anything else keeps the hold.
 */
export const releaseBlockers = [
  "already-reconciled",
  "not-held",
  "ownership-released",
  "context-unavailable",
  "thread-bound",
  "turn-bound",
  "witness-present",
  "independent-hold",
  "callback-pending",
  "known-survivor",
] as const;
export type ReleaseBlocker = (typeof releaseBlockers)[number];
/** Binds a release to the generation the operator read. */
export const releaseBodySchema = z
  .object({
    assignmentId: z.string().uuid(),
    workId: z.string().min(1).max(512),
    workRevision: z.number().int().positive().safe(),
    requestSequence: z.number().int().positive().safe(),
  })
  .strict();

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

/** The operator recovery paths, in the order an operator meets them. */
export const recoveryPaths = [
  "release",
  "pre-turn-recover",
  "no-turn-recover",
  "bound-turn-recover",
  "conversation-replace",
] as const;
export type RecoveryPath = (typeof recoveryPaths)[number];
/** Operator command type of each path. */
export const recoveryCommandTypes = {
  release: "recovery.release",
  "pre-turn-recover": "recovery.pre-turn.recover",
  "no-turn-recover": "recovery.no-turn.recover",
  "bound-turn-recover": "recovery.bound-turn.recover",
  "conversation-replace": "recovery.conversation.replace",
} as const satisfies Record<RecoveryPath, string>;

/**
 * What each path needs beyond the identity the service observes: the operator evidence
 * file's fields and its attestations.
 */
export const recoveryRequirements: Record<
  RecoveryPath,
  { evidence: string[]; attestations: string[]; receipt: string[] }
> = {
  release: { evidence: [], attestations: [], receipt: [] },
  "pre-turn-recover": {
    evidence: [],
    attestations: [],
    receipt: ["termination", "effects", "workspace"],
  },
  "no-turn-recover": {
    evidence: [],
    attestations: [],
    receipt: ["termination", "effects", "workspace"],
  },
  "bound-turn-recover": {
    evidence: [],
    attestations: [],
    receipt: ["termination", "effects", "workspace"],
  },
  "conversation-replace": { evidence: [], attestations: [], receipt: [] },
};
