import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configure } from "./completed-lead.js";
import type { createOperatorFixture } from "./operator-web.js";
import { seedReviewTask } from "./task-review.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** A Ready lead task whose first turn was refused at admission because the task changed. */
export async function refusedTask(f: Fixture) {
  const task = await seedReviewTask(f, "Refused project", "Refused task");
  const d = f.service.domain();
  const edit = (patch: Record<string, unknown>) =>
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: Number(d.task(task.taskId).version),
      ...patch,
    } as never);
  configure(f, task.projectId, true);
  edit({ ready: true });
  await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
  edit({ outcome: "Changed after the request was queued" });
  await f.service.configureCapacity({ key: randomUUID(), globalLimit: 2 });
  const refused = f.service
    .turnRequests()
    .find((r) => r.taskId === task.taskId && r.state === "held");
  assert.ok(refused, "the first turn was refused");
  return { ...task, workId: refused.workId };
}
