import { materialDigest } from "../../src/core/delivery.js";
import {
  unstackIdentitySchema,
  unstackRecordSchema,
  type UnstackRecord,
} from "../../src/core/unstack.js";

/** Strict task-owned material, distinct across populated project-deletion graphs. */
export function unstackFixtureRecord(
  i: {
    projectId: string;
    taskId: string;
    blockerTaskId: string;
    operationId: string;
    seq: number;
  },
  phase: UnstackRecord["phase"] = "confirmed",
): UnstackRecord {
  const identity = unstackIdentitySchema.parse({
    projectId: i.projectId,
    taskId: i.taskId,
    projectVersion: 1,
    taskVersion: 1,
    policyVersion: 1,
    deliveryRevision: 1,
    authorityDigest: "a".repeat(64),
    repositoryId: `R-${i.projectId}`,
    repositoryPath: `/repos/fixture/private-${i.projectId}`,
    pr: {
      nodeId: `PR-${i.taskId}`,
      number: 2,
      headRef: `upper-${i.taskId}`,
      headSha: "b".repeat(40),
      baseRef: `lower-${i.blockerTaskId}`,
    },
    targetBaseRef: `main-${i.projectId}`,
    edge: {
      blockerTaskId: i.blockerTaskId,
      repositoryId: `R-${i.projectId}`,
      parentHead: "a".repeat(40),
      settledHead: "a".repeat(40),
      restack: "current",
      restackFromSha: null,
      restackSeq: 0,
      recordedAt: 1,
      seq: i.seq,
    },
    stack: {
      id: 10,
      number: 1,
      baseRef: `main-${i.projectId}`,
      members: [
        {
          nodeId: `PR-${i.blockerTaskId}`,
          number: 1,
          headRef: `lower-${i.blockerTaskId}`,
          headSha: "a".repeat(40),
          state: "CLOSED",
        },
        {
          nodeId: `PR-${i.taskId}`,
          number: 2,
          headRef: `upper-${i.taskId}`,
          headSha: "b".repeat(40),
          state: "OPEN",
        },
      ],
    },
  });
  const command = {
    key: i.operationId,
    taskId: i.taskId,
    expectedVersion: 1,
    materialHash: materialDigest(identity),
  };
  return unstackRecordSchema.parse({
    operationId: i.operationId,
    command,
    identity,
    phase,
    revision: 1,
    reason:
      phase === "confirmed"
        ? "confirmed"
        : phase === "failed"
          ? "unstack-refused"
          : "pending",
    removed: !["prepared", "unstack-attempting", "failed"].includes(phase),
    retargetRejected: false,
    newBaseSha: ["retarget-confirmed", "confirmed"].includes(phase)
      ? "c".repeat(40)
      : null,
    noEffect: phase === "failed" ? "unstack-422" : null,
    createdAt: 1,
    updatedAt: 1,
  });
}
export function unstackFixtureRow(r: UnstackRecord) {
  return {
    operationId: r.operationId,
    taskId: r.identity.taskId,
    projectId: r.identity.projectId,
    blockerTaskId: r.identity.edge.blockerTaskId,
    edgeSequence: r.identity.edge.seq,
    payloadHash: materialDigest(r.command),
    phase: r.phase,
    revision: r.revision,
    recordJson: JSON.stringify(r),
  };
}
