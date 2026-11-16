import { materialDigest } from "../core/delivery.js";
import type { LeftoverHold } from "./state.js";
import type { RecoveryRecord } from "./recovery-types.js";
import type { TurnRequest } from "./scheduler.js";

/** One leftover on a closed task that keeps it from settling: work or a task hold. */
export type LeftoverItem =
  | {
      kind: "request";
      workId: string;
      assignmentId: string;
      profile: string;
      /** `live`: a running turn or a process still present. */
      status: "live" | "unsettled";
      reason: string;
    }
  | ({ kind: "hold" } & LeftoverHold);

export interface ClosedTaskLeftovers {
  taskId: string;
  taskState: "open" | "done" | "cancelled";
  /** Empty for an open task: its execution keeps the open-task rules. */
  items: LeftoverItem[];
  live: boolean;
  unsettled: boolean;
  digest: string;
}

/** One assignment's selected execution, as the operator reads it. */
export interface LeftoverSelection {
  assignmentId: string;
  profile: string;
  request: TurnRequest | undefined;
  /** The current request, which can be missing once an apply moved the version. */
  current: TurnRequest | undefined;
  record: RecoveryRecord | undefined;
  intentState: string | undefined;
}

export interface LeftoverFacts {
  notStartedWork(workId: string): boolean;
  settledDraftRefusal(workId: string): boolean;
  reconciled(workId: string): boolean;
  settlement(workId: string): { outcome: string } | undefined;
  heldWriterWork(): Array<{ workId: string; assignmentId: string }>;
  holds(): LeftoverHold[];
}

const finalOutcomes = new Set(["process-gone", "retired"]);

/** Whether a recorded settlement makes this work's held request history, on any task state. */
export const settledLeftover = (
  settlement: { outcome: string } | undefined,
): boolean => settlement !== undefined && finalOutcomes.has(settlement.outcome);

/**
 * A done or cancelled task's leftovers: work still live, work not proved settled, and every
 * task hold other than Stop. The same rules the open-task execution read uses decide what is
 * outstanding; a recorded exit check or retirement settles work.
 */
export function closedTaskLeftovers(
  taskId: string,
  taskState: string,
  selections: readonly LeftoverSelection[],
  facts: LeftoverFacts,
): ClosedTaskLeftovers {
  const state =
    taskState === "done" || taskState === "cancelled" ? taskState : "open";
  const items: LeftoverItem[] = [];
  if (state !== "open") {
    const seen = new Set<string>();
    const profiles = new Map(
      selections.map((s) => [s.assignmentId, s.profile]),
    );
    const push = (
      workId: string,
      assignmentId: string,
      status: "live" | "unsettled",
      reason: string,
    ) => {
      if (seen.has(workId)) return;
      seen.add(workId);
      items.push({
        kind: "request",
        workId,
        assignmentId,
        profile: profiles.get(assignmentId) ?? "retained execution ownership",
        status,
        reason,
      });
    };
    for (const s of selections) {
      const workId = s.request?.workId ?? s.record?.workId;
      if (!workId) continue;
      const confirmed =
        s.current?.state === "active" &&
        ["running", "submitting"].includes(s.intentState ?? "");
      if (confirmed) {
        push(workId, s.assignmentId, "live", "Turn is running");
        continue;
      }
      const settlement = facts.settlement(workId);
      if (settledLeftover(settlement)) continue;
      if (settlement?.outcome === "process-present") {
        push(
          workId,
          s.assignmentId,
          "live",
          "Execution process is still present",
        );
        continue;
      }
      const request = s.request;
      const heldRequest =
        request?.state === "held" &&
        !facts.notStartedWork(request.workId) &&
        !facts.settledDraftRefusal(request.workId) &&
        !facts.reconciled(request.workId);
      const reason = heldRequest
        ? request.reason || "Request is held"
        : s.current?.state === "active"
          ? "Turn start was never confirmed"
          : s.record?.holds.writer ||
              s.record?.holds.capacity ||
              s.record?.holds.uncertainty
            ? "Execution still holds writer or capacity"
            : undefined;
      if (reason) push(workId, s.assignmentId, "unsettled", reason);
    }
    for (const work of facts.heldWriterWork())
      if (!settledLeftover(facts.settlement(work.workId)))
        push(
          work.workId,
          work.assignmentId,
          "unsettled",
          "Held execution keeps its writer admission",
        );
    for (const hold of facts.holds()) items.push({ kind: "hold", ...hold });
  }
  return {
    taskId,
    taskState: state,
    items,
    live: items.some((i) => i.kind === "request" && i.status === "live"),
    unsettled: items.some((i) => i.kind === "hold" || i.status === "unsettled"),
    digest: materialDigest({ taskId, taskState: state, items }),
  };
}
