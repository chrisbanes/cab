import { materialDigest } from "../core/delivery.js";
import type { LeftoverExecution } from "../operator/contracts.js";
import type { LeftoverHold } from "./state.js";
import type { RecoveryRecord } from "./recovery-types.js";
import type { TurnRequest } from "./scheduler.js";

/** One leftover on a closed task that keeps it from settling: work or a task hold. */
export type LeftoverItem = LeftoverExecution["items"][number];

export interface ClosedTaskLeftovers {
  taskId: string;
  taskState: "open" | "done" | "cancelled";
  /** Empty for an open task: its execution keeps the open-task rules. */
  items: LeftoverItem[];
  live: boolean;
  /** Why retiring is refused now; absent when it can run. */
  refusal?: NonNullable<LeftoverExecution["refusal"]>;
}

/** One assignment's selected execution, as the operator reads it. */
export interface LeftoverSelection {
  assignmentId: string;
  profile: string;
  /** The current request, or the latest once an apply moved the version. */
  request: TurnRequest | undefined;
  /** The current request is active. */
  active: boolean;
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
  /** Submitting or running, or still held by this process (a callback, a known survivor). */
  running(workId: string): boolean;
  /** Still holds writer admission or capacity. */
  holdsOwnership(workId: string): boolean;
}

const finalOutcomes = new Set(["process-gone", "retired"]);

/** Whether a recorded settlement makes this work's held request history, on any task state. */
export const settledLeftover = (
  settlement: { outcome: string } | undefined,
): boolean => settlement !== undefined && finalOutcomes.has(settlement.outcome);

/** The digest `recovery.retire` binds: the listing exactly as the operator was shown it. */
export const leftoverDigest = (l: ClosedTaskLeftovers) =>
  materialDigest({ taskId: l.taskId, taskState: l.taskState, items: l.items });

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
  if (taskState !== "done" && taskState !== "cancelled")
    return {
      taskId,
      taskState: "open",
      items: [],
      live: false,
      refusal: "task-not-closed",
    };
  const items: LeftoverItem[] = [];
  const seen = new Set<string>();
  const profiles = new Map(selections.map((s) => [s.assignmentId, s.profile]));
  const settlements = new Map<string, { outcome: string } | undefined>();
  const settlement = (workId: string) => {
    if (!settlements.has(workId))
      settlements.set(workId, facts.settlement(workId));
    return settlements.get(workId);
  };
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
  // A present process counts only while the work still holds ownership; once another route
  // frees it, the stale verdict no longer keeps the task Uncertain.
  const liveReason = (workId: string) =>
    facts.running(workId)
      ? "Execution is still running in cab"
      : settlement(workId)?.outcome === "process-present" &&
          facts.holdsOwnership(workId)
        ? "Execution process is still present"
        : undefined;
  for (const s of selections) {
    const workId = s.request?.workId ?? s.record?.workId;
    if (!workId) continue;
    if (s.active && ["running", "submitting"].includes(s.intentState ?? "")) {
      push(workId, s.assignmentId, "live", "Turn is running");
      continue;
    }
    if (settledLeftover(settlement(workId))) continue;
    // The existing proofs first: a request they settle is history whatever this process holds.
    const { request } = s;
    const heldRequest =
      request?.state === "held" &&
      !facts.notStartedWork(request.workId) &&
      !facts.settledDraftRefusal(request.workId) &&
      !facts.reconciled(request.workId);
    const reason = heldRequest
      ? request.reason || "Request is held"
      : s.active
        ? "Turn start was never confirmed"
        : s.record?.holds.writer ||
            s.record?.holds.capacity ||
            s.record?.holds.uncertainty
          ? "Execution still holds writer or capacity"
          : undefined;
    if (!reason) continue;
    const live = liveReason(workId);
    push(workId, s.assignmentId, live ? "live" : "unsettled", live ?? reason);
  }
  for (const work of facts.heldWriterWork()) {
    if (settledLeftover(settlement(work.workId))) continue;
    const live = liveReason(work.workId);
    push(
      work.workId,
      work.assignmentId,
      live ? "live" : "unsettled",
      live ?? "Held execution keeps its writer admission",
    );
  }
  for (const hold of facts.holds()) items.push({ kind: "hold", ...hold });
  const live = items.some((i) => i.kind === "request" && i.status === "live");
  return {
    taskId,
    taskState,
    items,
    live,
    ...(live
      ? { refusal: "live-turn" as const }
      : items.length === 0
        ? { refusal: "nothing-to-retire" as const }
        : {}),
  };
}
