import { z } from "zod";
import {
  type RecoveryPath,
  recoveryCommandTypes,
  replaceConversationBodySchema,
} from "../core/recovery-contracts.js";
import {
  type assignmentRecoverySchema,
  type CommandReceipt,
  commandReceiptSchema,
  type OperatorCommand,
  recoveryOptionsSchema,
  type recoveryBlockerSchema,
} from "../operator/contracts.js";
import {
  boundTurnRecoveryCommandSchema,
  releaseResultSchema,
} from "./pre-turn-recovery.js";
import { RecoveryRejectedError } from "./recovery-types.js";
import type { StandaloneService } from "./service.js";

type Blocker = z.infer<typeof recoveryBlockerSchema>;
type Base = z.infer<typeof assignmentRecoverySchema>;

/**
 * Enriches this assignment's own recovery records (bounded after that filter) with the exact identity each recovery command
 * binds and advisory eligibility. `exact` returns a string only when redaction leaves it
 * unchanged; anything withheld blocks the paths that would send it.
 */
export async function recoveryOptions(
  service: StandaloneService,
  base: Base,
  projectId: string,
  excluded: readonly string[] | undefined,
  exact: (value: unknown) => string | null,
) {
  const { assignment, taskId } = base.data;
  const assignmentId = assignment.assignmentId;
  let withheld = false;
  /** The exact value, or null when redaction changes it or it exceeds what a command accepts. */
  const keep = (value: unknown, max: number) => {
    if (value === null || value === undefined) return null;
    const kept = exact(value);
    if (kept === null || kept.length > max) withheld = true;
    return kept !== null && kept.length <= max ? kept : null;
  };
  const records = await Promise.all(
    base.data.records.map(async (r) => {
      const material =
        r.workId === null ? undefined : service.recoveryMaterial(r.workId);
      const own =
        material?.assignmentId === assignmentId ? material : undefined;
      if (r.workId !== null && !own) withheld = true;
      const context = own?.preTurn ?? own?.noTurn;
      const processSource = context ?? own?.bound?.processIdentity;
      const process = processSource
        ? {
            processId: keep(processSource.processId, 128),
            processStartedAt: keep(processSource.processStartedAt, 128),
            bootId: keep(processSource.bootId, 128),
          }
        : null;
      const predecessor =
        own?.preTurn &&
        own.preTurn.predecessorWorkId !== null &&
        own.preTurn.predecessorThreadId !== null
          ? {
              workId: keep(own.preTurn.predecessorWorkId, 512),
              threadId: keep(own.preTurn.predecessorThreadId, 512),
            }
          : null;
      const exactProcess =
        process?.processId != null &&
        process.processStartedAt != null &&
        process.bootId != null
          ? {
              processId: process.processId,
              processStartedAt: process.processStartedAt,
              bootId: process.bootId,
            }
          : null;
      const exactPredecessor =
        predecessor?.workId != null && predecessor.threadId != null
          ? { workId: predecessor.workId, threadId: predecessor.threadId }
          : null;
      const reason =
        own &&
        own.intent.reason !== null &&
        own.intent.reason === own.request?.reason
          ? keep(own.intent.reason, 4000)
          : null;
      const identityWithheld =
        !own ||
        (context !== undefined && exactProcess === null) ||
        (own.preTurn !== undefined && exactPredecessor === null);
      const threadId = keep(own?.bound?.threadId, 512);
      const turnId = keep(own?.bound?.turnId, 512);
      const boundWithheld =
        !own ||
        (!!own.bound &&
          ((!!own.bound.threadId && threadId === null) ||
            (!!own.bound.turnId && turnId === null) ||
            (!!own.bound.processIdentity && exactProcess === null)));
      const boundBlocked: Blocker[] =
        boundWithheld || excluded === undefined
          ? ["identity-withheld"]
          : !own?.bound
            ? ["context-unavailable"]
            : await service.boundTurnRecoveryEligibility(
                own.bound.workId,
                assignmentId,
              );
      const witnesses = {
        preTurn: r.preTurnRejection
          ? { id: r.preTurnRejection.id, source: r.preTurnRejection.source }
          : null,
        noTurn: r.noTurnSubmission ? { id: r.noTurnSubmission.id } : null,
      };
      const reconciled = r.receiptRecorded || r.intentState === "reconciled";
      const blockers = (path: RecoveryPath): Blocker[] => {
        if (path === "bound-turn-recover") return boundBlocked;
        if (path === "release")
          return !own || r.workId === null
            ? ["identity-withheld"]
            : service.releaseBlockers(r.workId);
        const preTurn = path === "pre-turn-recover";
        const mine = preTurn ? witnesses.preTurn : witnesses.noTurn;
        const other = preTurn ? witnesses.noTurn : witnesses.preTurn;
        const b: Blocker[] = [];
        if (reconciled) b.push("already-reconciled");
        else if (r.intentState !== "held") b.push("not-held");
        else if (!r.holds.capacity || !r.holds.writer)
          b.push("ownership-released");
        if (!(preTurn ? own?.preTurn : own?.noTurn))
          b.push("context-unavailable");
        if (!mine) b.push("witness-missing");
        if (other) b.push("other-witness");
        if (identityWithheld) b.push("identity-withheld");
        return [...new Set(b)];
      };
      return {
        workId: own ? r.workId : null,
        generation: r.generation,
        intentState: r.intentState,
        requestState: r.requestState,
        holds: r.holds,
        observations: r.observations,
        process: exactProcess,
        threadId,
        turnId,
        retainedReason: reason,
        writerSequence: numberOrNull(context?.writerSequence),
        conversationRevision: numberOrNull(context?.conversationRevision),
        predecessor: exactPredecessor,
        witnesses,
        receiptRecorded: r.receiptRecorded,
        workspace: r.workspace,
        paths: await Promise.all(
          (
            [
              "release",
              "pre-turn-recover",
              "no-turn-recover",
              "bound-turn-recover",
            ] as const
          ).map(async (path) => {
            let blockedBy = blockers(path);
            // The recover commands verify the exact process ended; so does this advisory read.
            if (
              blockedBy.length === 0 &&
              r.workId !== null &&
              (path === "pre-turn-recover" || path === "no-turn-recover")
            )
              blockedBy = await service.unboundTurnTerminationBlockers(
                r.workId,
              );
            return { path, eligible: blockedBy.length === 0, blockedBy };
          }),
        ),
      };
    }),
  );
  const facts = service.replacementFacts(assignmentId);
  const replacementBlockers: Blocker[] = [
    ...(service.taskHold(taskId) !== undefined ? (["task-held"] as const) : []),
    ...(facts.unresolvedExecution ? (["unresolved-execution"] as const) : []),
  ];
  return recoveryOptionsSchema.parse({
    data: {
      assignmentId,
      taskId,
      projectId,
      assignmentVersion: assignment.version,
      conversationRevision: facts.conversationRevision,
      held: base.data.held,
      holds: base.data.holds,
      evidenceAvailable: base.data.evidenceAvailable,
      omittedCount: base.data.omittedCount,
      gaps:
        excluded === undefined
          ? ["redaction-unavailable"]
          : withheld
            ? ["content-redacted"]
            : [],
      replacement: {
        eligible: replacementBlockers.length === 0,
        blockedBy: replacementBlockers,
        expectedAssignmentVersion: assignment.version,
        expectedConversationRevision: facts.conversationRevision,
      },
      records,
    },
    observedAt: base.observedAt,
  });
}

const numberOrNull = (value: unknown) =>
  typeof value === "number" ? value : null;

export type RecoveryCommand = Extract<
  OperatorCommand,
  { type: (typeof recoveryCommandTypes)[RecoveryPath] }
>;
const recoveryTypes: readonly string[] = Object.values(recoveryCommandTypes);
export const isRecoveryCommand = (c: OperatorCommand): c is RecoveryCommand =>
  recoveryTypes.includes(c.type);

/** Retired adoption commands: no longer accepted, but their recorded receipts still read back. */
const retiredAdoptionPaths = {
  "recovery.pre-turn.adopt": "pre-turn-adopt",
  "recovery.no-turn.adopt": "no-turn-adopt",
} as const;
type RecoveryReadType =
  | RecoveryCommand["type"]
  | keyof typeof retiredAdoptionPaths;

/** Builds the receipt of a recovery command from the service result, as POST and readback do. */
export function recoveryReceipt(
  type: RecoveryReadType,
  key: string,
  assignmentId: string,
  result: Record<string, unknown>,
): CommandReceipt {
  const base = { key, recorded: true, assignmentId };
  if (type === "recovery.pre-turn.adopt" || type === "recovery.no-turn.adopt")
    return commandReceiptSchema.parse({
      ...base,
      kind: "recovery-adoption",
      path: retiredAdoptionPaths[type],
      workId: result.workId,
      witnessId: result.witnessId,
    });
  const path = (Object.keys(recoveryCommandTypes) as RecoveryPath[]).find(
    (p) => recoveryCommandTypes[p] === type,
  );
  return commandReceiptSchema.parse(
    path === "conversation-replace"
      ? { ...base, kind: "conversation-replacement", revision: result.revision }
      : path === "release"
        ? {
            ...base,
            kind: "recovery-release",
            path,
            workId: result.workId,
            refusalId: result.id,
          }
        : {
            ...base,
            kind: "recovery-resolution",
            path,
            workId: result.workId,
            receiptId: result.id,
            state: result.state,
          },
  );
}

/**
 * Runs one recovery command through the unchanged service method with exactly the inner
 * command the retained session routes pass, so a key replays through either entry point.
 * The caller has checked the assignment exists; a work bound elsewhere is a refusal.
 */
export async function executeRecovery(
  service: StandaloneService,
  c: RecoveryCommand,
): Promise<CommandReceipt> {
  if (c.type === "recovery.conversation.replace") {
    const { type: _type, ...command } = c;
    const result = service.replaceConversationCommand(command);
    return recoveryReceipt(c.type, c.key, c.assignmentId, result);
  }
  const workId = "receipt" in c ? c.receipt.workId : c.workId;
  if (service.recoveryMaterial(workId)?.assignmentId !== c.assignmentId)
    throw new RecoveryRejectedError("Work is not bound to this assignment");
  let result: Record<string, unknown>;
  switch (c.type) {
    case "recovery.release": {
      const { type: _t, ...command } = c;
      result = service.releaseUnboundHold(command);
      break;
    }
    case "recovery.pre-turn.recover": {
      const { type: _t, assignmentId: _a, ...command } = c;
      result = await service.recoverPreTurnExecution(command);
      break;
    }
    case "recovery.bound-turn.recover": {
      const { type: _t, ...command } = c;
      result = await service.recoverBoundTurnExecution(command);
      break;
    }
    case "recovery.no-turn.recover": {
      const { type: _t, assignmentId: _a, ...command } = c;
      result = await service.recoverNoTurnExecution(command);
      break;
    }
  }
  return recoveryReceipt(c.type, c.key, c.assignmentId, result);
}

const adoptionResult = z
  .object({ witnessId: z.string().uuid(), workId: z.string().min(1) })
  .strict();
const resolutionResult = z
  .object({
    id: z.string().uuid(),
    workId: z.string().min(1),
    state: z.literal("reconciled"),
  })
  .strict();
/** The stored result shape of each recovery command type, as the service records it. */
const storedResult: Record<
  RecoveryReadType,
  z.ZodType<Record<string, unknown>>
> = {
  "recovery.release": releaseResultSchema,
  "recovery.pre-turn.adopt": adoptionResult,
  "recovery.pre-turn.recover": resolutionResult,
  "recovery.no-turn.adopt": adoptionResult,
  "recovery.no-turn.recover": resolutionResult,
  "recovery.bound-turn.recover": resolutionResult,
  "recovery.conversation.replace": z
    .object({ revision: z.number().int().positive() })
    .strict(),
};
/** Stored command scope of each recovery command type. */
const storedScope: Record<RecoveryReadType, string> = {
  "recovery.release": "release",
  "recovery.pre-turn.adopt": "adopt",
  "recovery.pre-turn.recover": "recover",
  "recovery.no-turn.adopt": "adopt-no-turn",
  "recovery.no-turn.recover": "recover-no-turn",
  "recovery.bound-turn.recover": "recover-bound-turn",
  "recovery.conversation.replace": "replace-conversation",
};
export const isRecoveryType = (type: string): type is RecoveryReadType =>
  type in storedScope;

/**
 * Reads back one recovery receipt without any effect: recorded only under its own type and
 * for a work (or replacement) of this assignment. A stored row of another shape throws a
 * ZodError (or SyntaxError), which the API reports as a conflict.
 */
export function readRecoveryOperation(
  service: StandaloneService,
  type: RecoveryReadType,
  key: string,
  assignmentId: string,
): { state: "not-recorded" } | { state: "recorded"; receipt: CommandReceipt } {
  const row = service.preTurnCommandRecord(key);
  if (row?.scope !== storedScope[type]) return { state: "not-recorded" };
  // Persisted rows are validated before use; another shape throws and reads as a conflict.
  const result: Record<string, unknown> = storedResult[type].parse(
    JSON.parse(row.result),
  );
  if (type === "recovery.bound-turn.recover") {
    const payload = boundTurnRecoveryCommandSchema
      .extend({ key: z.literal(key) })
      .parse(JSON.parse(row.payloadMaterial));
    if (
      payload.assignmentId !== assignmentId ||
      payload.receipt.workId !== result.workId
    )
      return { state: "not-recorded" };
  }
  const owner =
    type === "recovery.conversation.replace"
      ? replaceConversationBodySchema
          .extend({ key: z.string().uuid() })
          .strict()
          .parse(JSON.parse(row.payloadMaterial)).assignmentId
      : service.recoveryMaterial(String(result.workId))?.assignmentId;
  if (owner !== assignmentId) return { state: "not-recorded" };
  return {
    state: "recorded",
    receipt: recoveryReceipt(type, key, assignmentId, result),
  };
}
