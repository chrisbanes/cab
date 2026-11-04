import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { DomainStore } from "../../../src/core/domain.js";
import { DeliveryStore } from "../../../src/core/delivery.js";
import { UnstackStore } from "../../../src/core/unstack.js";
import type { StackV2Authority } from "./stack-authority.js";

/** Snapshot exact original-operation facts together; never infer retirement from an HTTP receipt. */
export function auditPreparedStack(authority: StackV2Authority) {
  authority.current();
  const m = authority.manifest,
    task = m.resource.upperTask;
  const db = new DatabaseSync(
    join(m.authority.host.dataDirectory, "standalone.sqlite"),
    { readOnly: true },
  );
  try {
    db.exec("BEGIN");
    const domain = new DomainStore(db),
      delivery = new DeliveryStore(db),
      unstack = new UnstackStore(db);
    const binding = delivery.delivery(task),
      branch = delivery.taskBranch(task, m.resource.repositoryNodeId);
    const operation = unstack.get(m.resource.operationKey);
    if (
      operation &&
      (operation.identity.taskId !== task ||
        operation.identity.projectId !== m.resource.projectId ||
        operation.identity.pr.nodeId !== m.resource.upperPrId)
    )
      throw Error("v2-audit-original-operation");
    const edge = z
      .object({
        blockerTaskId: z.string(),
        repositoryId: z.string(),
        parentHead: z.string(),
        restackSeq: z.number().int().nonnegative(),
        restack: z.enum(["current", "pending"]),
      })
      .nullable()
      .parse(
        db
          .prepare(
            "SELECT blockerTaskId,repositoryId,parentHead,restackSeq,restack FROM stacked_dependencies WHERE taskId=?",
          )
          .get(task) ?? null,
      );
    const selected = z
      .object({ seq: z.number().int().positive() })
      .nullable()
      .parse(
        db
          .prepare(
            "SELECT seq FROM task_dependency_records WHERE taskId=? AND blockerTaskId=?",
          )
          .get(task, m.resource.lowerTask) ?? null,
      );
    const eventCount = z
      .object({ count: z.number().int().nonnegative() })
      .parse(
        db
          .prepare(
            "SELECT count(*) AS count FROM coordination_external_delivery_notices n JOIN coordination_inbox_events e ON e.eventId=n.eventId AND e.taskId=n.taskId WHERE n.taskId=? AND n.identity=? AND e.eventType='pr-delivery' AND e.recipientAssignmentId=?",
          )
          .get(
            task,
            `unstack-restack:${m.resource.operationKey}`,
            m.authority.runtime.find((scope) => scope.taskId === task)!
              .assignmentId,
          ),
      ).count;
    const active = domain.activeStackedDependency(task);
    const writerHolds = [
      "task_writer_holds",
      "task_writer_ambiguity_holds",
      "task_archival_holds",
    ].reduce(
      (total, table) =>
        total + db.prepare(`SELECT taskId FROM ${table}`).all().length,
      0,
    );
    const unfinished = db
      .prepare(
        "SELECT workId FROM execution_intents WHERE state IN ('submitting','running','held','capacity-waiting')",
      )
      .all().length;
    return {
      taskId: task,
      targetBaseRef: m.resource.base,
      acceptedBaseRef:
        binding?.acceptedBaseRef ?? binding?.observation.baseRef ?? null,
      headSha: binding?.observation.headSha ?? null,
      baseSha: binding?.observation.baseSha ?? null,
      proofs: binding?.rebaseProofs ?? [],
      branch,
      edge,
      selectedSequence: selected?.seq ?? null,
      selectedEdgeActive: active !== null,
      selectedRetired: unstack.retired(task, m.resource.lowerTask),
      eventCount,
      writerHolds,
      unfinished,
      operation: operation
        ? {
            operationId: operation.operationId,
            phase: operation.phase,
            removed: operation.removed,
            newBaseSha: operation.newBaseSha,
            originalSequence: operation.identity.edge.seq,
            originalRestackSequence: operation.identity.edge.restackSeq,
          }
        : null,
    };
  } finally {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}
export function fullUnstackProof(audit: ReturnType<typeof auditPreparedStack>) {
  const original = audit.operation;
  return (
    original?.phase === "confirmed" &&
    original.removed &&
    original.newBaseSha !== null &&
    audit.acceptedBaseRef === audit.targetBaseRef &&
    audit.selectedRetired &&
    !audit.selectedEdgeActive &&
    audit.selectedSequence === original.originalSequence &&
    audit.edge?.restackSeq === original.originalRestackSequence + 1 &&
    audit.eventCount === 1 &&
    audit.edge.parentHead === original.newBaseSha &&
    audit.baseSha === original.newBaseSha
  );
}
