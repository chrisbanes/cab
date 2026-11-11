import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { createOperatorFixture } from "./operator-web.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { seedReviewTask } from "./task-review.js";
import { mixedForm } from "./question-data.js";
import type { QuestionForm } from "../../src/core/question-forms.js";
import type { TaskWorkspaceRepositoryInput } from "../../src/standalone/workspaces.js";
import { until } from "./until.js";
export { until };
type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
/** A configured task whose lead has a running turn; the caller decides how that turn ends. */
export async function startOwnWork(
  f: Fixture,
  title: string,
  projectName: string,
  repositories: TaskWorkspaceRepositoryInput[] = [],
) {
  const a = await seedReviewTask(
      f,
      projectName,
      title,
      undefined,
      repositories,
    ),
    d = f.service.domain();
  const priorTurns = f.runtime.turns;
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    expectedVersion: 1,
    paused: false,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => f.runtime.turns === priorTurns + 1);
  const work = f.service
    .list()
    .find(
      (w) =>
        w.state === "running" &&
        f.service
          .turnRequests()
          .some((r) => r.taskId === a.taskId && r.workId === w.workId),
    );
  assert.ok(work?.threadId && work.turnId);
  return { a, d, work, priorTurns };
}
/** Pauses the project and completes the turn, leaving the request open for the operator. */
export async function finishOwnWork(
  f: Fixture,
  { a, d, work, priorTurns }: Awaited<ReturnType<typeof startOwnWork>>,
) {
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    expectedVersion: 2,
    paused: true,
  });
  f.runtime.complete(priorTurns + 1);
  await until(() =>
    f.service
      .list()
      .some((w) => w.workId === work.workId && w.state === "completed"),
  );
}
export async function seedOwnQuestion(
  f: Fixture,
  form: QuestionForm = mixedForm,
  title = "Choose full form",
  projectName = "Question project",
  repositories: TaskWorkspaceRepositoryInput[] = [],
) {
  return {
    ...(await seedQuestionCall(f, { form }, title, projectName, repositories)),
    form,
  };
}
export function seedPlainQuestion(
  f: Fixture,
  question: string,
  title = "Plain question",
  projectName = "Question project",
  context?: string,
) {
  return seedQuestionCall(
    f,
    context ? { question, context } : { question },
    title,
    projectName,
    [],
  );
}
async function seedQuestionCall(
  f: Fixture,
  args: { form: QuestionForm } | { question: string; context?: string },
  title: string,
  projectName: string,
  repositories: TaskWorkspaceRepositoryInput[],
) {
  const started = await startOwnWork(f, title, projectName, repositories),
    { a, work } = started;
  const call = await f.runtime.callTool({
    threadId: work.threadId!,
    turnId: work.turnId!,
    callId: randomUUID(),
    tool: "cab_ask_question",
    arguments: args,
  });
  assert.equal(call.success, true, call.text);
  const q = f.service.coordinationView().readTask(a.taskId).questions[0]!;
  await finishOwnWork(f, started);
  return { ...a, interactionId: q.interactionId, workId: work.workId };
}
/** An open approval request for an exact action and target; the decision control is not in the app. */
export async function seedOwnApproval(
  f: Fixture,
  title = "Approve exact action",
  projectName = "Approval project",
  request = {
    action: "Create a pull request. No merge or deployment.",
    target: "acme/atlas · main ← command-menu",
  },
) {
  const started = await startOwnWork(f, title, projectName),
    { a, work } = started;
  const call = await f.runtime.callTool({
    threadId: work.threadId!,
    turnId: work.turnId!,
    callId: randomUUID(),
    tool: "cab_request_approval",
    arguments: { ...request, material: { scope: "fixture" } },
  });
  assert.equal(call.success, true, call.text);
  const approval = f.service.coordinationView().readTask(a.taskId)
    .approvals[0]!;
  await finishOwnWork(f, started);
  return { ...a, interactionId: approval.interactionId, request };
}
/** A task whose running work is held with unknown ownership: the Inbox lists an intervention. */
export async function seedOwnIntervention(
  f: Fixture,
  title = "Restore webhook delivery",
  projectName = "Relay",
) {
  const { a, work } = await startOwnWork(f, title, projectName);
  const intent = f.service.list().find((w) => w.workId === work.workId)!;
  f.seedPersistedState((db) =>
    new ExecutionState(db).hold(intent.id, "Fixture ownership unknown"),
  );
  f.service.reconcileInbox();
  return { ...a, workId: work.workId };
}

/** A historical completion rejection for testing its privacy-safe operator projection. */
export function seedInteractionRejection(
  f: Fixture,
  request: { taskId: string; interactionId: string },
) {
  const view = f.service.coordinationView().readTask(request.taskId);
  const interaction = [...view.questions, ...view.approvals].find(
    (i) => i.interactionId === request.interactionId,
  )!;
  assert.ok(interaction);
  const requestId = randomUUID();
  f.seedPersistedState((db) =>
    db
      .prepare(`INSERT INTO coordination_completion_requests
    (requestId,taskId,leadAssignmentId,leadWorkId,leadWorkRevision,taskVersion,reviewedResultIds,status,rejectionReasons,revision)
    VALUES (?,?,?,?,?,?,?,'rejected',?,1)`)
      .run(
        requestId,
        request.taskId,
        interaction.requestingAssignmentId,
        interaction.requestingWorkId,
        interaction.requestingWorkRevision,
        Number(f.service.domain().task(request.taskId).version),
        "[]",
        JSON.stringify({
          reasons: ["open-interaction", "current-results-not-fully-reviewed"],
          blockingInteractionIds: [request.interactionId],
        }),
      ),
  );
  return requestId;
}
