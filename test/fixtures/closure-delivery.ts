import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** PR #7 in R_1 as the code host reports it in `state`. */
export const prObservation = (state: "OPEN" | "CLOSED" | "MERGED") => ({
  repositoryId: "R_1",
  nodeId: "PR_7",
  number: 7,
  baseRef: "main",
  headRef: "task",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  state,
  draft: false,
  merged: state === "MERGED",
  reviewDecision: null,
  checks: [],
  mergeBlockers: [],
  allowedMethods: ["merge"],
});

/** A schema-valid bound PR #7 last observed in `state`, replacing any earlier binding. */
export function seedPrBinding(
  db: DatabaseSync,
  {
    taskId,
    projectId,
    state,
    readError = null,
  }: {
    taskId: string;
    projectId: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    /** The latest read failed; `state` is the last successful observation. */
    readError?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO delivery_pr_bindings VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET recordJson=excluded.recordJson",
  ).run(
    taskId,
    JSON.stringify({
      taskId,
      projectId,
      leadAssignmentId: randomUUID(),
      registeredWorkId: "work",
      revision: 1,
      mode: "reviewable-pr",
      observation: prObservation(state),
      observationDigest: "c".repeat(64),
      observedAt: 1,
      readError,
      settlement: null,
    }),
  );
}

/** A schema-valid agent `issue.status` action in `state`, replacing one with the same ID. */
export function seedDeliveryAction(
  db: DatabaseSync,
  {
    taskId,
    projectId,
    state,
    operationId = randomUUID(),
  }: {
    taskId: string;
    projectId: string;
    state: "uncertain" | "confirmed-success";
    operationId?: string | undefined;
  },
): string {
  db.prepare(
    "INSERT INTO delivery_actions (operationId,taskId,materialHash,recordJson) VALUES (?,?,'fixture',?) ON CONFLICT(operationId) DO UPDATE SET recordJson=excluded.recordJson",
  ).run(
    operationId,
    taskId,
    JSON.stringify({
      operationId,
      binding: {
        projectId,
        taskId,
        assignmentId: randomUUID(),
        workId: "work",
        workRevision: 1,
        taskVersion: 1,
        assignmentVersion: 1,
        conversationRevision: 1,
      },
      policyVersion: 1,
      state,
      attempts: 1,
      request: {
        operationId,
        action: {
          kind: "issue.status",
          target: { repositoryId: "P_1", nodeId: "I_1", number: 1 },
          statusId: "done",
          expected: { statusId: "open" },
        },
      },
      beforeState: null,
      observation: null,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return operationId;
}
