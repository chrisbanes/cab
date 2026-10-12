import type { z } from "zod";
import type { RecoveryPath } from "../core/recovery-contracts.js";
import {
  type assignmentRecoverySchema,
  recoveryOptionsSchema,
  type recoveryBlockerSchema,
} from "../operator/contracts.js";
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
