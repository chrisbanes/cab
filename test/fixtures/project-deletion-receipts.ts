import type { DatabaseSync } from "node:sqlite";
import type { DeletionSeedIdentity } from "./project-deletion-rows.js";
import { archivedResumeMessage } from "../../src/standalone/pre-turn-recovery.js";

export const deletionOperatorReceiptScopes = [
  "local-review-send",
  "answer-question",
  "answer-question-form",
  "decide-approval",
  "operator-message",
  "reconcile-result-recipient",
  "answer-runtime-question",
  "task-comment-send",
] as const;
export const deletionPreTurnScopes = [
  "adopt",
  "adopt-no-turn",
  "replace-conversation",
  "recover",
  "recover-bound-turn",
  "recover-no-turn",
] as const;
export function receiptMaterials(i: DeletionSeedIdentity) {
  const hash = "a".repeat(64),
    sha = "a".repeat(40);
  const caller = {
    actor: "operator",
    principal: "installation-operator",
    projectId: i.projectId,
    taskId: i.taskId,
    taskVersion: 1,
    sourceId: i.sourceId,
    sourceRevision: 1,
    sourceDigest: hash,
    sourceNodeId: i.externalId,
    sourceRepositoryId: "R_shared",
    policyVersion: 1,
  };
  const review = {
    reviewId: i.reviewId,
    taskId: i.taskId,
    key: i.uuid("delivery-review"),
    commandHash: hash,
    operationId: i.deliveryId,
    caller,
    action: {
      kind: "issue.comment",
      target: { repositoryId: "R_shared", nodeId: i.externalId, number: 1 },
      body: "Public comment",
    },
    materialHash: hash,
    revision: 1,
    decision: "approved",
    createdAt: 1,
    updatedAt: 1,
  };
  const pr = {
    taskId: i.taskId,
    projectId: i.projectId,
    leadAssignmentId: i.assignmentId,
    registeredWorkId: i.workId,
    revision: 1,
    mode: "reviewable-pr",
    acceptedBaseRef: "main",
    baseChange: null,
    observation: {
      repositoryId: "R_shared",
      nodeId: i.uuid("PR"),
      number: 1,
      baseRef: "main",
      headRef: `cab/${i.taskId}`,
      headSha: sha,
      baseSha: sha,
      state: "CLOSED",
      draft: false,
      merged: false,
      reviewDecision: null,
      checks: [],
      mergeBlockers: [],
      allowedMethods: ["merge"],
      closedIssueNodeIds: [],
    },
    observationDigest: hash,
    observedAt: 1,
    readError: null,
    settlement: null,
  };
  const publication = {
    publicationId: i.publicationId,
    taskId: i.taskId,
    commandHash: hash,
    caller: {
      actor: "operator",
      principal: "installation-operator",
      purpose: "task-publication",
      projectId: i.projectId,
      taskId: i.taskId,
      publicationId: i.publicationId,
      sourceId: i.sourceId,
      selectionId: "fixture",
      repositoryId: "R_shared",
      policyVersion: 1,
    },
    taskVersion: 1,
    target: {
      id: "fixture~R_shared",
      selectionId: "fixture",
      repositoryId: "R_shared",
      repository: "fixture/shared",
      kind: "repository",
      projectNodeId: null,
      enabled: true,
      reasonCode: null,
      labels: [],
      projectFields: [],
      predictedSelected: true,
      predictedReady: false,
    },
    issue: { title: "Public issue", body: "Public body", labels: [] },
    item: null,
    fields: [],
    materialHash: hash,
    revision: 1,
    decision: "approved",
    createdAt: 1,
    updatedAt: 1,
  };
  return { review, pr, publication };
}
export function seedDeletionReceiptVariants(
  db: DatabaseSync,
  i: DeletionSeedIdentity,
) {
  const hash = "a".repeat(64),
    sha = "a".repeat(40),
    materials = receiptMaterials(i);
  for (const scope of deletionOperatorReceiptScopes) {
    const key = i.uuid(scope);
    const result =
      scope === "task-comment-send"
        ? {
            kind: "task-comment",
            key,
            taskId: i.taskId,
            commentId: i.commentId,
            payloadHash: hash,
            createdAt: 1,
            deliveries: [
              {
                assignmentId: i.assignmentId,
                eventId: i.eventId,
                effect: "input",
                assignmentVersion: 1,
                followUpId: null,
              },
            ],
          }
        : scope === "answer-runtime-question"
          ? {
              interactionId: i.interactionId,
              revision: 1,
              recorded: true,
              deliveryState: "confirmed",
            }
          : { eventId: i.eventId };
    db.prepare(
      "INSERT INTO coordination_operator_receipts (scope,commandKey,payloadHash,result) VALUES (?,?,?,?)",
    ).run(scope, key, hash, JSON.stringify(result));
  }
  const processIdentity = {
    processId: "fixture-pid",
    processStartedAt: "fixture-start",
    bootId: "fixture-boot",
  };
  const generation = {
    workId: i.workId,
    workRevision: 1,
    requestSequence: i.requestSequence,
    processIdentity,
  };
  const evidence = {
    frozenSourceRevision: sha,
    frozenHarnessSha256: hash,
    evidenceSha256: hash,
    approvedDecisionSha256: hash,
    reviewReference: "https://example.test/review",
    approvalReference: "https://example.test/approval",
  };
  const receipt = {
    ...generation,
    threadId: i.threadId,
    turnId: i.turnId,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "preserved",
  };
  for (const scope of deletionPreTurnScopes) {
    const key = i.uuid(scope);
    const material =
      scope === "adopt"
        ? {
            ...generation,
            key,
            predecessorWorkId: i.workId,
            predecessorThreadId: i.threadId,
            retainedReason: "Fixture rejection",
            rpcError: {
              code: -32600,
              message: archivedResumeMessage(i.threadId),
            },
            evidence,
            attestation: {
              beforeTurnRejected: true,
              noTurnSubmitted: true,
              independentlyReviewed: true,
            },
          }
        : scope === "adopt-no-turn"
          ? {
              ...generation,
              key,
              kind: "historical-no-turn-submission",
              conversationRevision: 1,
              writerSequence: 1,
              retainedReason: "Fixture no-send",
              evidence: { ...evidence, invocationLedgerSha256: hash },
              attestation: {
                completeSynchronousWriteAheadLedger: true,
                noStartTurnInvocation: true,
                independentlyReviewed: true,
                idleThreadMayExist: true,
              },
            }
          : scope === "replace-conversation"
            ? {
                key,
                assignmentId: i.assignmentId,
                expectedAssignmentVersion: 1,
                expectedConversationRevision: 1,
              }
            : {
                key,
                ...(scope === "recover-bound-turn"
                  ? { assignmentId: i.assignmentId }
                  : {}),
                receipt: {
                  ...receipt,
                  kind:
                    scope === "recover-bound-turn"
                      ? "bound-turn"
                      : scope === "recover-no-turn"
                        ? "no-turn-submission"
                        : "pre-turn-rejection",
                  ...(scope === "recover-bound-turn"
                    ? {}
                    : {
                        threadId: null,
                        turnId: null,
                        witnessId:
                          scope === "recover-no-turn"
                            ? i.noTurnWitnessId
                            : i.witnessId,
                      }),
                },
              };
    const result =
      scope === "adopt" || scope === "adopt-no-turn"
        ? {
            witnessId: scope === "adopt" ? i.witnessId : i.noTurnWitnessId,
            workId: i.workId,
          }
        : scope === "replace-conversation"
          ? { revision: 2 }
          : { id: i.receiptId, workId: i.workId, state: "reconciled" };
    db.prepare(
      "INSERT INTO execution_pre_turn_commands (commandKey,scope,payloadMaterial,result) VALUES (?,?,?,?)",
    ).run(key, scope, JSON.stringify(material), JSON.stringify(result));
  }
  const confirmation = (key: string, reviewId: string) => ({
    key,
    taskId: i.taskId,
    reviewId,
    expectedRevision: 1,
    materialHash: hash,
    decision: "approved",
  });
  db.prepare(
    "INSERT INTO delivery_operator_confirm_receipts VALUES (?,?,?)",
  ).run(
    i.uuid("confirm"),
    JSON.stringify(confirmation(i.uuid("confirm"), i.reviewId)),
    JSON.stringify(materials.review),
  );
  db.prepare("INSERT INTO delivery_settlement_receipts VALUES (?,?,?)").run(
    i.uuid("settle"),
    hash,
    JSON.stringify(materials.pr),
  );
  db.prepare("INSERT INTO task_publication_receipts VALUES (?,?,?)").run(
    i.uuid("publication-confirm"),
    JSON.stringify(
      confirmation(i.uuid("publication-confirm"), i.publicationId),
    ),
    JSON.stringify(materials.publication),
  );
  db.prepare("INSERT INTO drafting_command_receipts VALUES (?,?,?,1)").run(
    i.uuid("draft-receipt"),
    hash,
    JSON.stringify({
      kind: "drafting",
      key: i.uuid("draft-receipt"),
      recorded: true,
      operation: "discard",
      runId: i.draftId,
      state: "expired",
    }),
  );
  db.prepare("INSERT INTO task_review_view_receipts VALUES (?,?)").run(
    i.uuid("view"),
    JSON.stringify({
      taskId: i.taskId,
      sourceId: i.sourceId,
      resultIds: [i.resultId],
    }),
  );
}
