import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { createOperatorFixture } from "./operator-web.js";
import { databaseOf, startedOf } from "./service-internals.js";

/** Disposable service whose project is paused and contains only settled historical work. */
export async function archivedProjectFixture(t: TestContext, archive = true) {
  const fixture = await createOperatorFixture();
  t.after(() => fixture.close());
  const service = fixture.service,
    domain = service.domain(),
    db = databaseOf(service),
    components = startedOf(service);
  const projectId = randomUUID(),
    taskId = randomUUID(),
    workId = randomUUID(),
    profileId = randomUUID(),
    assignmentId = randomUUID(),
    blockerTaskId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Fixture profile",
    instructions: "Private",
    capabilities: "Coordination",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Archive fixture",
    leadProfileId: null,
    candidateProfileIds: [profileId],
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Preserved",
    outcome: "Open",
    ready: false,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: blockerTaskId,
    title: "Blocker history",
    outcome: "Open",
    ready: false,
  });
  domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Settled",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  db.prepare("UPDATE domain_assignments SET state='completed' WHERE id=?").run(
    assignmentId,
  );
  components.schedulerStore.ensure({
    requestKey: randomUUID(),
    workId,
    kind: "direct",
    taskId,
    projectId,
    assignmentId: null,
    taskVersion: 1,
    assignmentVersion: null,
    instructionsRevision: null,
    profileRevision: null,
    prompt: "Historical",
    workspace: null,
    previousWorkId: null,
  });
  const intent = components.state.create(
    workId,
    "Historical",
    fixture.directory,
  );
  // Seed terminal history without starting a runtime turn.
  db.prepare(
    "UPDATE execution_intents SET state='completed' WHERE workId=?",
  ).run(workId);
  db.prepare("UPDATE turn_requests SET state='completed' WHERE workId=?").run(
    workId,
  );
  const freeze = () =>
    domain.execute({
      type: "project.archive",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
    });
  const restore = () =>
    domain.execute({
      type: "project.restore",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
    });
  if (archive) freeze();
  const snapshot = () =>
    JSON.stringify([
      domain.project(projectId),
      domain.task(taskId),
      domain.assignment(assignmentId),
      components.schedulerStore.find(workId),
      components.state.byWorkId(workId),
      ...[
        "coordination_task_comments",
        "task_workspace_bindings",
        "status_mapping_task_state",
        "task_review_sources",
        "conversation_history_items",
        "drafting_runs",
        "delivery_actions",
        "coordination_interactions",
        "coordination_results",
        "coordination_completion_requests",
        "coordination_unresolved_result_destinations",
        "task_review_viewed",
        "execution_stop_targets",
      ].map((table) =>
        db.prepare(`SELECT * FROM ${table} WHERE taskId=?`).all(taskId),
      ),
    ]);
  return {
    fixture,
    service,
    domain,
    db,
    components,
    projectId,
    taskId,
    workId,
    profileId,
    assignmentId,
    blockerTaskId,
    intent,
    freeze,
    restore,
    snapshot,
  };
}
