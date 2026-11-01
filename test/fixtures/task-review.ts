import { randomUUID } from "node:crypto";
import { CoordinationStore } from "../../src/core/coordination.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { ExecutionState } from "../../src/standalone/state.js";
import type { ReviewMetadata } from "../../src/core/task-review.js";
import type { TaskWorkspaceRepositoryInput } from "../../src/standalone/workspaces.js";
import { uniqueProjectName } from "./project-names.js";
import type { createOperatorFixture } from "./operator-web.js";
/** Links (or unlinks) one GitHub repository on the project without running repository verification. */
export function setLinkedRepository(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  projectId: string,
  linked: boolean,
) {
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE project_repository_links SET version=version+1, links=? WHERE projectId=?",
      )
      .run(
        JSON.stringify(
          linked
            ? [
                {
                  codeHost: "github",
                  host: "github.com",
                  repositoryId: "R-LINKED",
                  path: "/fixture/linked",
                  ref: "main",
                  gitCommonDirectory: "/fixture/linked/.git",
                },
              ]
            : [],
        ),
        projectId,
      ),
  );
}
/**
 * Marks a seeded task Ready without waking the scheduler, so its ordinary lead reply is
 * offered (a Draft task offers a draft turn instead). The project must stay paused.
 */
export function markTaskReady(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  taskId: string,
) {
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_tasks SET ready=1, version=version+1 WHERE id=?")
      .run(taskId),
  );
}
/**
 * Marks the seeded lead as having started, so the task's ordinary lead reply is offered
 * (a pending lead on a Draft task offers a draft turn instead).
 */
export function markLeadStarted(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  assignmentId: string,
) {
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='running' WHERE id=?")
      .run(assignmentId),
  );
}
/** Records one result for `producerAssignmentId` as if its work had just reported it. */
export function seedTaskResult(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  taskId: string,
  producerAssignmentId: string,
  summary: string,
  metadata?: Partial<ReviewMetadata>,
) {
  const d = f.service.domain();
  let resultId = "";
  const workId = randomUUID();
  f.seedPersistedState((db) => {
    const c = new CoordinationStore(db, d),
      s = new ExecutionState(db);
    db.prepare(
      "INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval) VALUES(?,?,'fixture','/tmp/fixture','running',?,?,'chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId, workId, workId);
    s.bindTask(workId, {
      taskId,
      assignmentId: producerAssignmentId,
      assignmentVersion: Number(d.assignment(producerAssignmentId).version),
      instructionsRevision: 1,
      profileRevision: 1,
    });
    db.prepare("UPDATE domain_assignments SET state='running' WHERE id=?").run(
      producerAssignmentId,
    );
    const revision = c.results(taskId).length + 1;
    db.prepare(
      "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES(?,?,1,?)",
    ).run(workId, producerAssignmentId, revision);
    f.service
      .taskReview()
      .captureAssignment(
        producerAssignmentId,
        "Fixture work preparation",
        workId,
      );
    const batch = c.bindDeliveryBatch(producerAssignmentId, workId);
    if (batch) c.completeDeliveryBatch(workId);
    resultId = c.recordResult({
      threadId: workId,
      turnId: workId,
      callId: randomUUID(),
      tool: "cab_report_result",
      arguments: { summary, ...(metadata ? { review: metadata } : {}) },
    }).result.resultId;
    db.prepare(
      "UPDATE execution_intents SET state='completed' WHERE workId=?",
    ).run(workId);
    c.recordSuccessfulTerminal(workId);
  });
  return { resultId, workId };
}
/**
 * An imported GitHub task with a lead, and an `issue.comment` grant that `setGrant` can change.
 * `setGrant` sets a delivery credential unless told otherwise, so the grant is postable.
 */
export async function seedImportedCommentTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  mode: "allow" | "approval" | null,
) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    d = f.service.domain(),
    title = "Imported comment task";
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Task lead",
    instructions: "Coordinate",
    capabilities: "review",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Comment project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R-COMMENT",
        owner: "fixture",
        name: "source",
      },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  f.service.githubSources().reconcileSelection(projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I-COMMENT",
        repositoryId: "R-COMMENT",
        repositoryName: "fixture/source",
        number: 7,
        title,
        body: "Supplied GitHub brief",
        state: "open",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  f.service.githubSources().reconcileBlockers("I-COMMENT", {
    complete: true,
    blockers: [],
    reason: null,
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
  });
  const taskId = String(d.tasks(projectId).find((t) => t.title === title)?.id);
  d.ensureLeadAssignment(taskId);
  await f.service.provisionTask(taskId);
  // A unique non-empty value, so the credential is neither unset nor shared with another turn's env.
  const previousCredential = process.env.FIXTURE_COMMENT_DELIVERY_CREDENTIAL;
  process.env.FIXTURE_COMMENT_DELIVERY_CREDENTIAL = `fixture-${randomUUID()}`;
  /** Restores the env var; register it with the test's `after`. */
  const restoreCredential = () => {
    if (previousCredential === undefined)
      delete process.env.FIXTURE_COMMENT_DELIVERY_CREDENTIAL;
    else process.env.FIXTURE_COMMENT_DELIVERY_CREDENTIAL = previousCredential;
  };
  const setGrant = (
    next: "allow" | "approval" | null,
    credentialConfigured = true,
  ) =>
    d.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: f.service.delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: credentialConfigured
        ? "env:FIXTURE_COMMENT_DELIVERY_CREDENTIAL"
        : null,
      grants: next
        ? [{ action: "issue.comment", repositoryId: "R-COMMENT", mode: next }]
        : [],
      requiredChecks: [],
    });
  setGrant(mode);
  return { projectId, taskId, setGrant, restoreCredential };
}
export async function seedReviewTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  name = "Review project",
  title = "Restore command focus",
  body = "- [ ] Restore focus\n- [ ] Retain drafts",
  repositories: TaskWorkspaceRepositoryInput[] = [],
  taskId: string = randomUUID(),
) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    d = f.service.domain();
  const projectName = uniqueProjectName(d, name);
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Task lead",
    instructions: "PRIVATE REVIEW INSTRUCTIONS",
    capabilities: "review",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: projectName,
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title,
    outcome: body,
    ready: false,
  });
  const assignment = d.ensureLeadAssignment(taskId);
  if (!assignment) throw Error("Fixture lead absent");
  await f.service.provisionTask(taskId, repositories);
  const assignmentId = String(assignment.id),
    source = f.service.taskReview().sources(taskId)[0]!;
  const result = (
    summary: string,
    metadata?: Partial<ReviewMetadata>,
    producerAssignmentId = assignmentId,
  ) => seedTaskResult(f, taskId, producerAssignmentId, summary, metadata);
  function delegatedResult(
    summary: string,
    metadata?: Partial<ReviewMetadata>,
  ) {
    const delegateId = randomUUID();
    d.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      assignmentId: delegateId,
      profileId,
      brief: "Produce the scoped delegated review result",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    return {
      ...result(summary, metadata, delegateId),
      assignmentId: delegateId,
    };
  }
  return {
    profileId,
    projectId,
    taskId,
    assignmentId,
    source,
    result,
    delegatedResult,
  };
}

export async function seedRetainedReviewWindow(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  artifacts: ReviewMetadata["artifacts"] = [],
) {
  const a = await seedReviewTask(
    f,
    "Historical evidence",
    "Original retained brief",
    "- [ ] Ancient criterion",
  );
  const old = a.result("Ancient review result", {
    sourceId: a.source.sourceId,
    criteria: [
      {
        criterionId: a.source.criteria[0]!.criterionId,
        outcome: "supported",
        scope: "Ancient literal scope",
        provenance: "Recorded original check",
      },
    ],
    decisions: [
      { text: "Ancient decision evidence", attribution: "Task lead" },
    ],
    artifacts,
  });
  const results = [old];
  for (let i = 1; i <= 270; i++) {
    const d = f.service.domain();
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      taskId: a.taskId,
      expectedVersion: Number(d.task(a.taskId).version),
      outcome: `- [ ] Recent criterion ${i}`,
    });
    const source = f.service.taskReview().sources(a.taskId).at(-1)!;
    results.push(
      a.result(`Recent review result ${i}`, { sourceId: source.sourceId }),
    );
  }
  f.seedPersistedState((db) => {
    const capture = new ConversationHistoryStore(db);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      capture.recordEarlyBufferLimit({
        taskId: a.taskId,
        assignmentId: a.assignmentId,
        workId: r.workId,
        assignmentVersion: 1,
        instructionsRevision: 1,
        profileRevision: 1,
        conversationRevision: 1,
        workRevision: i + 1,
        threadId: r.workId,
        turnId: r.workId,
      });
    }
  });
  return { ...a, old, results };
}
