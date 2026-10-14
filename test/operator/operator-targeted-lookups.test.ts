import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  DomainNotFoundError,
  type DomainStore,
} from "../../src/core/domain.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import type { StandaloneService } from "../../src/standalone/service.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { forbid } from "../fixtures/read-guards.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
type Lookups = {
  requireTask(id: string): Record<string, unknown>;
  catalog(): unknown[];
};

function world(f: Fixture) {
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Lead",
    instructions: "Lead instructions",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  const task = (taskId = randomUUID()) => {
    const assignmentId = randomUUID();
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title: "Task",
      outcome: "Work",
      ready: false,
      initialAssignment: { assignmentId, profileId },
    });
    return { taskId, assignmentId };
  };
  return { d, profileId, projectId, task };
}

const notFound = (e: unknown) =>
  e instanceof OperatorApiError && e.status === 404 && e.code === "not-found";

/** The retired scan: listed projects, then each project's task list. */
function legacyRequireTask(d: DomainStore, id: string) {
  z.string().uuid().parse(id);
  for (const p of d.projects())
    if (d.tasks(String(p.id)).some((t) => t.id === id)) return d.task(id);
  throw new OperatorApiError(404, "not-found");
}

function outcome(read: () => unknown) {
  try {
    return { value: read() };
  } catch (error) {
    return {
      error: (error as Error).name,
      status: (error as { status?: number }).status,
      code: (error as { code?: string }).code,
    };
  }
}

test("domain lookups throw a typed not-found error with the unchanged message", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { d, projectId } = world(f);
  for (const read of [
    () => d.task(randomUUID()),
    () => d.assignment(randomUUID()),
    () => d.profile(randomUUID()),
    () => d.project(randomUUID()),
    () => d.instructionRevision(projectId, 99),
  ])
    assert.throws(read, (e: unknown) => {
      assert.ok(e instanceof DomainNotFoundError);
      assert.equal(e.name, "DomainNotFoundError");
      assert.equal(e.message, "Unknown domain record");
      return true;
    });
});

test("primary-key task lookup matches the retired project scan, including missing revision and base rows", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const w = world(f),
    visible = w.task(),
    noBase = w.task();
  const other = world(f),
    noRevision = other.task();
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(noBase.taskId);
    db.prepare(
      "DELETE FROM project_instruction_revisions WHERE projectId = ?",
    ).run(other.projectId);
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const lookups = api as unknown as Lookups;
  for (const id of [
    visible.taskId,
    noBase.taskId,
    noRevision.taskId,
    randomUUID(),
    "not-a-uuid",
  ])
    assert.deepEqual(
      outcome(() => lookups.requireTask(id)),
      outcome(() => legacyRequireTask(w.d, id)),
      id,
    );
  assert.ok("value" in outcome(() => lookups.requireTask(visible.taskId)));
  for (const id of [w.projectId, other.projectId, randomUUID()])
    assert.equal(
      w.d.projectListed(id),
      w.d.projects().some((p) => p.id === id),
    );
  // The unlisted project's assignments are 404s through every assignment read.
  for (const read of [
    () => api.readTask(noRevision.taskId),
    () => api.readAssignment(noRevision.assignmentId),
    () => api.readAssignmentInstructions(noRevision.assignmentId),
    () => api.readAssignmentRecovery(noRevision.assignmentId),
  ])
    await assert.rejects(read(), notFound);
});

test("task and assignment lookups do not scan projects or the catalogue", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task } = world(f),
    { taskId, assignmentId } = task();
  const serviceWith = (names: string[]): StandaloneService =>
    new Proxy(f.service, {
      get(object, property) {
        if (property === "domain") return () => forbid(object.domain(), names);
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  const scanFree = new OperatorApi(
    serviceWith(["projects", "tasks", "taskCatalog"]),
    [f.directory],
  ) as unknown as Lookups;
  assert.equal(scanFree.requireTask(taskId).id, taskId);
  assert.throws(() => scanFree.requireTask(randomUUID()), notFound);
  const catalogFree = new OperatorApi(serviceWith(["taskCatalog"]), [
    f.directory,
  ]);
  const recovery = await catalogFree.readAssignmentRecovery(assignmentId);
  assert.equal(recovery.data.taskId, taskId);
});

test("unknown task and assignment ids are 404 over the API and HTTP; malformed ids are 400", async (t) => {
  const s = await startCliService(t);
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  const unknown = randomUUID();
  for (const read of [
    () => api.readTask(unknown),
    () => api.readAssignment(unknown),
    () => api.readAssignmentInstructions(unknown),
    () => api.readAssignmentRecovery(unknown),
  ])
    await assert.rejects(read(), notFound);
  const { token } = await s.issue("read", "lookups");
  for (const path of [
    `/api/operator/tasks/${unknown}`,
    `/api/operator/assignments/${unknown}`,
    `/api/operator/assignments/${unknown}/instructions`,
    `/api/operator/assignments/${unknown}/recovery`,
  ]) {
    const r = await s.bearer(token, path);
    assert.equal(r.status, 404, path);
    const body = (await r.json()) as { error: { code: string } };
    assert.equal(body.error.code, "not-found");
  }
  const malformed = await s.bearer(token, "/api/operator/tasks/not-a-uuid");
  assert.equal(malformed.status, 400);
  assert.equal(
    ((await malformed.json()) as { error: { code: string } }).error.code,
    "invalid-input",
  );
});

test("a failure other than a missing record is not reported as 404", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  world(f);
  const d = f.service.domain();
  t.mock.method(d, "assignment", () => {
    throw Error("disk I/O error");
  });
  const api = new OperatorApi(f.service, [f.directory]);
  await assert.rejects(api.readAssignmentRecovery(randomUUID()), {
    message: "disk I/O error",
  });
});

test("one catalogue guard: 10,000 identities read, 10,001 are unavailable, keyed assignment reads are unaffected", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { projectId, task } = world(f);
  const seed = (from: number, to: number) =>
    f.seedPersistedState((db) => {
      db.exec("BEGIN");
      const base = db.prepare(
          "INSERT INTO tasks(id,projectId,title) VALUES(?,?,?)",
        ),
        domain = db.prepare(
          "INSERT INTO domain_tasks(id,projectId,version,outcome,ready,state,importedBlockers) VALUES(?,?,1,'Work',0,'open','clear')",
        );
      for (let n = from; n <= to; n++) {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
        base.run(id, projectId, "Bounded task");
        domain.run(id, projectId);
      }
      db.exec("COMMIT");
    });
  seed(1, 10000);
  const api = new OperatorApi(f.service, [f.directory]);
  assert.equal((api as unknown as Lookups).catalog().length, 10000);
  assert.ok((await api.readTaskListPage()).data.tasks.length <= 100);
  seed(10001, 10001);
  const unavailable = (e: unknown) =>
    e instanceof OperatorApiError && e.code === "unavailable";
  for (const read of [
    () => api.readTaskListPage(),
    () => api.readComposerOptions(projectId),
    () => api.readInbox(),
  ])
    await assert.rejects(read(), unavailable);
  // A real task sorting after every seeded id was a 404 under the retired scan.
  const late = task(`ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`);
  assert.equal(f.service.domain().taskCatalog().length, 10001);
  const recovery = await api.readAssignmentRecovery(late.assignmentId);
  assert.equal(recovery.data.taskId, late.taskId);
  await assert.rejects(api.readTaskListPage(), unavailable);
});
