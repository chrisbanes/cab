import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { createOperatorFixture } from "./operator-web.js";
import { until } from "./operator-work.js";
import { startOwnWork } from "./questions.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/**
 * Adds a worker whose result destination is unresolved to a task whose lead is running,
 * completes the lead's turn and has the worker report one result.
 */
export async function reportUnresolvedResult(
  f: Fixture,
  ids: { profileId: string; projectId: string; taskId: string },
) {
  const workerId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    assignmentId: workerId,
    profileId: ids.profileId,
    brief: "Report findings",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET resultRecipientDisposition='unresolved' WHERE id=?",
      )
      .run(workerId),
  );
  const leadTurns = f.runtime.turns;
  f.runtime.complete(leadTurns);
  await until(() => f.runtime.turns >= leadTurns + 1);
  await until(() =>
    f.service
      .turnRequests()
      .some((r) => r.assignmentId === workerId && r.state === "active"),
  );
  const request = f.service
    .turnRequests()
    .find((r) => r.assignmentId === workerId && r.state === "active");
  assert.ok(request);
  const work = f.service
    .list()
    .find((w) => w.workId === request.workId && w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const result = await f.runtime.callTool({
    threadId: work.threadId,
    turnId: work.turnId,
    callId: "result1",
    tool: "cab_report_result",
    arguments: { summary: "Exact retained result <script>still text</script>" },
  });
  assert.equal(result.success, true, result.text);
  return { workerId };
}

/** A task with one result that has no destination, and the worker that reported it. */
export async function seedUnresolvedResult(f: Fixture) {
  const { a } = await startOwnWork(f, "Deliver the result", "Result project");
  const { workerId } = await reportUnresolvedResult(f, a);
  return { ...a, workerId };
}
