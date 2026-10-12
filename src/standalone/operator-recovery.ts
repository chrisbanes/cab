import type { z } from "zod";
import {
  type RecoveryPath,
  recoveryCommandTypes,
} from "../core/recovery-contracts.js";
import {
  type assignmentRecoverySchema,
  type CommandReceipt,
  commandReceiptSchema,
  type OperatorCommand,
  recoveryOptionsSchema,
  type recoveryBlockerSchema,
} from "../operator/contracts.js";
import { RecoveryRejectedError } from "./recovery-types.js";
import type { StandaloneService } from "./service.js";

type Blocker = z.infer<typeof recoveryBlockerSchema>;
type Base = z.infer<typeof assignmentRecoverySchema>;

/**
 * Enriches the assignment recovery read with the exact identity each recovery command
 * binds and advisory eligibility. `exact` returns a string only when redaction leaves it
 * unchanged; anything withheld blocks the paths that would send it.
 */
export function recoveryOptions(
  service: StandaloneService,
  base: Base,
  projectId: string,
  excluded: readonly string[] | undefined,
  exact: (value: unknown) => string | null,
) {
  const { assignment, taskId } = base.data;
  const assignmentId = assignment.assignmentId;
  let withheld = false;
  const keep = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const kept = exact(value);
    if (kept === null) withheld = true;
    return kept;
  };
  const records = base.data.records.map((r) => {
    const material =
      r.workId === null ? undefined : service.recoveryMaterial(r.workId);
    const own = material?.assignmentId === assignmentId ? material : undefined;
    if (r.workId !== null && !own) withheld = true;
    const context = own?.preTurn ?? own?.noTurn;
    const process = context
      ? {
          processId: keep(context.processId),
          processStartedAt: keep(context.processStartedAt),
          bootId: keep(context.bootId),
        }
      : null;
    const predecessor =
      own?.preTurn &&
      own.preTurn.predecessorWorkId !== null &&
      own.preTurn.predecessorThreadId !== null
        ? {
            workId: keep(own.preTurn.predecessorWorkId),
            threadId: keep(own.preTurn.predecessorThreadId),
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
        ? keep(own.intent.reason)
        : null;
    const identityWithheld =
      !own ||
      (context !== undefined && exactProcess === null) ||
      (own.preTurn !== undefined && exactPredecessor === null);
    const witnesses = {
      preTurn: r.preTurnRejection
        ? { id: r.preTurnRejection.id, source: r.preTurnRejection.source }
        : null,
      noTurn: r.noTurnSubmission ? { id: r.noTurnSubmission.id } : null,
    };
    const reconciled = r.receiptRecorded || r.intentState === "reconciled";
    const blockers = (path: RecoveryPath): Blocker[] => {
      const preTurn = path.startsWith("pre-turn");
      const adopt = path.endsWith("adopt");
      const mine = preTurn ? witnesses.preTurn : witnesses.noTurn;
      const other = preTurn ? witnesses.noTurn : witnesses.preTurn;
      const b: Blocker[] = [];
      if (reconciled) b.push("already-reconciled");
      else if (r.intentState !== "held" || (adopt && r.requestState !== "held"))
        b.push("not-held");
      else if (!r.holds.capacity || (!adopt && !r.holds.writer))
        b.push("ownership-released");
      if (!(preTurn ? own?.preTurn : own?.noTurn))
        b.push("context-unavailable");
      if (adopt && mine) b.push("witness-present");
      if (!adopt && !mine) b.push("witness-missing");
      if (other) b.push("other-witness");
      // Adoption must restate the held reason exactly; a withheld or split reason cannot be.
      if (adopt && reason === null) b.push("reason-withheld");
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
      retainedReason: reason,
      writerSequence: numberOrNull(context?.writerSequence),
      conversationRevision: numberOrNull(context?.conversationRevision),
      predecessor: exactPredecessor,
      witnesses,
      receiptRecorded: r.receiptRecorded,
      workspace: r.workspace,
      paths: (
        [
          "pre-turn-adopt",
          "pre-turn-recover",
          "no-turn-adopt",
          "no-turn-recover",
        ] as const
      ).map((path) => {
        const blockedBy = blockers(path);
        return { path, eligible: blockedBy.length === 0, blockedBy };
      }),
    };
  });
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

/** Builds the receipt of a recovery command from the service result, as POST and readback do. */
export function recoveryReceipt(
  type: RecoveryCommand["type"],
  key: string,
  assignmentId: string,
  result: Record<string, unknown>,
): CommandReceipt {
  const path = (Object.keys(recoveryCommandTypes) as RecoveryPath[]).find(
    (p) => recoveryCommandTypes[p] === type,
  );
  const base = { key, recorded: true, assignmentId };
  return commandReceiptSchema.parse(
    path === "conversation-replace"
      ? { ...base, kind: "conversation-replacement", revision: result.revision }
      : path?.endsWith("adopt")
        ? {
            ...base,
            kind: "recovery-adoption",
            path,
            workId: result.workId,
            witnessId: result.witnessId,
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
    case "recovery.pre-turn.adopt": {
      const { type: _t, assignmentId: _a, ...command } = c;
      result = service.adoptHistoricalPreTurnRejection(command);
      break;
    }
    case "recovery.no-turn.adopt": {
      const { type: _t, assignmentId: _a, ...command } = c;
      result = service.adoptHistoricalNoTurnSubmission(command);
      break;
    }
    case "recovery.pre-turn.recover": {
      const { type: _t, assignmentId: _a, ...command } = c;
      result = await service.recoverPreTurnExecution(command);
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

/** Stored command scope of each recovery command type. */
const storedScope: Record<RecoveryCommand["type"], string> = {
  "recovery.pre-turn.adopt": "adopt",
  "recovery.pre-turn.recover": "recover",
  "recovery.no-turn.adopt": "adopt-no-turn",
  "recovery.no-turn.recover": "recover-no-turn",
  "recovery.conversation.replace": "replace-conversation",
};
export const isRecoveryType = (type: string): type is RecoveryCommand["type"] =>
  recoveryTypes.includes(type);

/**
 * Reads back one recovery receipt without any effect: recorded only under its own type and
 * for a work (or replacement) of this assignment. A stored row of another shape throws.
 */
export function readRecoveryOperation(
  service: StandaloneService,
  type: RecoveryCommand["type"],
  key: string,
  assignmentId: string,
): { state: "not-recorded" } | { state: "recorded"; receipt: CommandReceipt } {
  const row = service.preTurnCommandRecord(key);
  if (row?.scope !== storedScope[type]) return { state: "not-recorded" };
  const result = JSON.parse(row.result) as Record<string, unknown>;
  const owner =
    type === "recovery.conversation.replace"
      ? (JSON.parse(row.payloadMaterial) as { assignmentId?: unknown })
          .assignmentId
      : typeof result.workId === "string"
        ? service.recoveryMaterial(result.workId)?.assignmentId
        : undefined;
  if (owner !== assignmentId) return { state: "not-recorded" };
  return {
    state: "recorded",
    receipt: recoveryReceipt(type, key, assignmentId, result),
  };
}
