import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainConflictError } from "../../src/core/domain.js";
import { runtimeOperatorRoutes } from "../../src/standalone/operator-runtime.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

test("the retained task page offers Stop only on an open task and keeps Resume", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const routes = runtimeOperatorRoutes(f.service);
  const route = (method: string, path: string) => {
    const found = routes.find((r) => r.method === method && r.path === path);
    assert.ok(found, path);
    return found;
  };
  const page = async (taskId: string) => {
    const result = await route("GET", "/runtime/task/:taskId").handler({
      params: { taskId },
      fields: {},
      csrfToken: "t",
    });
    assert.equal(result.kind, "html");
    return result.kind === "html" ? result.body : "";
  };

  const open = await seedReviewTask(f, "Open project", "Open task");
  const openBody = await page(open.taskId);
  assert.match(openBody, /action="\/runtime\/control\/stop"/);
  assert.match(openBody, /Best-effort Stop/);

  for (const state of ["done", "cancelled"] as const) {
    const a = await seedReviewTask(f, `${state} project`, `${state} task`);
    f.seedPersistedState((db) => {
      db.prepare("UPDATE domain_tasks SET state = ? WHERE id = ?").run(
        state,
        a.taskId,
      );
    });
    const body = await page(a.taskId);
    assert.doesNotMatch(body, /action="\/runtime\/control\/stop"/, state);
    assert.doesNotMatch(body, /Best-effort Stop/, state);
    assert.match(body, /action="\/runtime\/control\/resume"/, state);
    assert.match(body, /Only an open task can be stopped\./, state);
    await assert.rejects(
      async () =>
        route("POST", "/runtime/control/stop").handler({
          params: {},
          fields: { taskId: a.taskId },
          csrfToken: "t",
        }),
      DomainConflictError,
    );

    f.seedPersistedState((db) => {
      db.prepare(
        "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
      ).run(a.taskId);
    });
    const held = await page(a.taskId);
    assert.doesNotMatch(
      held,
      /No unresolved execution hold is reported/,
      state,
    );
    assert.match(held, /action="\/runtime\/control\/resume"/, state);
  }
});
