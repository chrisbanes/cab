import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import type { CoordinationView } from "../../src/standalone/coordination-view.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  runtimeOperatorRoutes,
  selectAssignmentExecution,
} from "../../src/standalone/operator-runtime.js";
import type { RecoveryRecord } from "../../src/standalone/recovery-types.js";
import type { TurnRequest } from "../../src/standalone/scheduler.js";
import type { StandaloneService } from "../../src/standalone/service.js";
import { ExecutionState } from "../../src/standalone/state.js";
import {
  createOperatorFixture,
  seedOperatorRecovery,
} from "../fixtures/operator-web.js";
import { seedCatalog } from "../fixtures/operator-work.js";
import {
  forbid,
  historyRowCounter,
  seedOrphanHistory,
} from "../fixtures/read-guards.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
const fullHistory = ["recoveryView", "turnRequests", "list"];

/** The retired `selectAssignmentExecution` body, over full-history reads. */
function legacySelect(
  assignment: { id?: unknown; version?: unknown },
  api: Pick<StandaloneService, "turnRequests" | "recoveryView" | "list">,
) {
  const id = String(assignment.id);
  const requests = api
    .turnRequests()
    .filter((candidate) => candidate.assignmentId === id);
  const latestRequest = (candidates: TurnRequest[]) =>
    candidates.reduce<TurnRequest | undefined>(
      (latest, candidate) =>
        !latest || candidate.sequence > latest.sequence ? candidate : latest,
      undefined,
    );
  const request =
    latestRequest(
      requests.filter((candidate) => candidate.state === "active"),
    ) ??
    latestRequest(
      requests.filter(
        (candidate) =>
          candidate.assignmentVersion === Number(assignment.version),
      ),
    );
  const requestVersion =
    request?.assignmentVersion ?? Number(assignment.version);
  const recoveryRecords = api
    .recoveryView()
    .filter(
      (candidate) =>
        candidate.binding?.assignmentId === id &&
        candidate.binding.assignmentVersion === requestVersion,
    );
  const record = request
    ? recoveryRecords.find((candidate) => candidate.workId === request.workId)
    : recoveryRecords.reduce<RecoveryRecord | undefined>(
        (latest, candidate) =>
          !latest ||
          candidate.generation.requestSequence >
            latest.generation.requestSequence
            ? candidate
            : latest,
        undefined,
      );
  const intent = request
    ? api.list().find((candidate) => candidate.workId === request.workId)
    : undefined;
  return { request, record, intent };
}

/** Swaps every targeted read for its retired full-history form. */
function useLegacyReads(t: TestContext, service: StandaloneService) {
  const mocks = [
    t.mock.method(
      service,
      "currentTurnRequest",
      (id: string, v: number) =>
        legacySelect({ id, version: v }, service).request,
    ),
    t.mock.method(
      service,
      "recoveryFor",
      (id: string, v: number, workId?: string) =>
        service
          .recoveryView()
          .filter(
            (r) =>
              r.binding?.assignmentId === id &&
              r.binding.assignmentVersion === v &&
              (workId === undefined || r.workId === workId),
          ),
    ),
    t.mock.method(service, "recoveryForTask", (taskId: string, w?: string) =>
      service
        .recoveryView()
        .filter((r) => r.binding?.taskId === taskId || r.workId === w),
    ),
    t.mock.method(service, "turnRequestsForTask", (taskId: string) =>
      service.turnRequests().filter((r) => r.taskId === taskId),
    ),
    t.mock.method(service, "executionForWork", (workId: string) =>
      service.list().find((i) => i.workId === workId),
    ),
    t.mock.method(
      service,
      "taskRetainedRowsExceed",
      (taskId: string, n: number) =>
        service.turnRequests().filter((r) => r.taskId === taskId).length > n ||
        service.recoveryView().filter((r) => r.binding?.taskId === taskId)
          .length > n,
    ),
    t.mock.method(
      ExecutionState.prototype,
      "taskExecutions",
      function (this: ExecutionState, taskId: string) {
        return this.list().flatMap((intent) => {
          const binding = this.taskBinding(intent.workId);
          return binding?.taskId === taskId ? [{ intent, binding }] : [];
        });
      },
    ),
    t.mock.method(
      CoordinationStore.prototype,
      "queuedDeliveriesForTask",
      function (this: CoordinationStore, taskId: string) {
        return this.queuedDeliveries().filter((d) => d.taskId === taskId);
      },
    ),
  ];
  return () => {
    for (const m of mocks) m.mock.restore();
  };
}

/** The service's own task view with its full-history store reads forbidden. */
function guardedView(service: StandaloneService): CoordinationView {
  const view = service.coordinationView() as unknown as Record<string, object>;
  view.state = forbid(view.state as object, ["list", "recoveryView"]);
  view.coordination = forbid(view.coordination as object, ["queuedDeliveries"]);
  return view as unknown as CoordinationView;
}

async function world(f: Fixture) {
  const ids = await seedCatalog(f);
  const d = f.service.domain();
  const lead = (taskId: string) => String(d.assignments(taskId)[0]?.id);
  seedOperatorRecovery(
    f,
    {
      taskId: ids.uncertain.id,
      assignmentId: lead(ids.uncertain.id),
      projectId: ids.projectId,
    },
    5,
  );
  // An assignment whose only request is held, with an unbound recovery identity.
  const idleTask = randomUUID(),
    idleAssignment = randomUUID();
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.projectId,
    taskId: idleTask,
    title: "Held without a binding",
    outcome: "Work",
    ready: false,
    initialAssignment: {
      assignmentId: idleAssignment,
      profileId: ids.profileId,
    },
  });
  const idle = d.assignment(idleAssignment);
  const heldWork = `held-${randomUUID()}`;
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval) VALUES (?,?,'P','/w','held','chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), heldWork);
    db.prepare(
      "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence) VALUES (?,1,1)",
    ).run(heldWork);
    db.prepare(
      "INSERT INTO turn_requests (requestKey,workId,kind,taskId,projectId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,prompt,state) VALUES (?,?,'assignment',?,?,?,?,1,1,'P','held')",
    ).run(
      randomUUID(),
      heldWork,
      String(idle.taskId),
      ids.projectId,
      String(idle.id),
      Number(idle.version),
    );
  });
  return { ids, idle, heldWork };
}

const normal = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, v) => (key === "observedAt" ? undefined : v)),
  );
const page = (body: string) =>
  body.replace(/name="key" value="[0-9a-f-]{36}"/g, 'name="key" value=""');

/** Every read named by the issue, keyed for comparison; failures are outcomes. */
async function readAll(
  api: OperatorApi,
  service: StandaloneService,
  counter?: ReturnType<typeof historyRowCounter>,
) {
  const d = service.domain(),
    out: Record<string, unknown> = {},
    rows: Record<string, number> = {};
  const settle = async (key: string, read: () => Promise<unknown>) => {
    try {
      const [value, count] = counter
        ? await counter.measure(read)
        : [await read(), 0];
      out[key] = normal(value);
      rows[key] = count;
    } catch (error) {
      out[key] = { failed: (error as { message?: string }).message };
    }
  };
  const routes = runtimeOperatorRoutes(service),
    route = (path: string) => {
      const found = routes.find((r) => r.method === "GET" && r.path === path);
      assert.ok(found);
      return found;
    };
  const tasks = d.taskCatalog();
  await settle("taskList", () => api.readTaskListPage());
  await settle("inbox", () => api.readInbox());
  await settle("runtime", () => api.readRuntimeSettings());
  for (const projectId of new Set(tasks.map((x) => x.projectId)))
    await settle(`project:${projectId}`, () => api.readProject(projectId));
  for (const { id } of tasks) {
    await settle(`task:${id}`, () => api.readTask(id));
    await settle(`page:task:${id}`, async () => {
      const r = await route("/runtime/task/:taskId").handler({
        params: { taskId: id },
        fields: {},
        csrfToken: "token",
      });
      return r.kind === "html" ? page(r.body) : r;
    });
    for (const a of d.assignments(id)) {
      const assignmentId = String(a.id);
      await settle(`assignment:${assignmentId}`, () =>
        api.readAssignment(assignmentId),
      );
      await settle(`recovery:${assignmentId}`, () =>
        api.readAssignmentRecovery(assignmentId),
      );
      await settle(`page:assignment:${assignmentId}`, async () => {
        const r = await route("/runtime/assignment/:assignmentId").handler({
          params: { assignmentId },
          fields: {},
          csrfToken: "token",
        });
        return r.kind === "html" ? page(r.body) : r;
      });
    }
  }
  return { out, rows };
}

test("targeted selection and reads equal the retired full-history implementations", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { ids, idle, heldWork } = await world(f);
  const d = f.service.domain();
  for (const { id } of d.taskCatalog())
    for (const a of d.assignments(id))
      assert.deepEqual(
        selectAssignmentExecution(a, f.service),
        legacySelect(a, f.service),
      );
  const unboundSelection = selectAssignmentExecution(idle, f.service);
  assert.equal(unboundSelection.request?.workId, heldWork);
  assert.equal(unboundSelection.record, undefined);

  const api = new OperatorApi(f.service, [f.directory]);
  const targeted = (await readAll(api, f.service)).out;
  const restore = useLegacyReads(t, f.service);
  const legacy = (await readAll(api, f.service)).out;
  restore();
  assert.deepEqual(targeted, legacy);
  // The comparison is not vacuous: holds, recovery and the unbound record are present.
  const recovery = targeted[`recovery:${String(idle.id)}`] as {
    data: { evidenceAvailable: boolean; records: { workId: string }[] };
  };
  assert.equal(recovery.data.evidenceAvailable, true);
  assert.ok(recovery.data.records.some((r) => r.workId === heldWork));
  const uncertain = targeted[`task:${ids.uncertain.id}`] as {
    data: { execution: { holds: Record<string, boolean> } };
  };
  assert.ok(Object.values(uncertain.data.execution.holds).some(Boolean));
});

test("operator reads do not read unrelated history, whatever its size", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { ids } = await world(f);
  const guarded = forbid(f.service, fullHistory);
  const api = new OperatorApi(guarded, [f.directory], () =>
    guardedView(f.service),
  );
  const counter = historyRowCounter(t);
  const measured = async () => {
    const result = await readAll(api, guarded, counter);
    for (const [key, value] of Object.entries(result.out))
      assert.ok(
        !JSON.stringify(value).includes("Full-history read"),
        `${key}: ${JSON.stringify(value)}`,
      );
    return result;
  };
  const size = () =>
    Math.max(f.service.turnRequests().length, f.service.recoveryView().length);
  // Positive control: the counter sees a full-history read grow with orphans.
  const legacyRows = async () => {
    const restore = useLegacyReads(t, f.service);
    try {
      return (await counter.measure(() => api.readRuntimeSettings()))[1];
    } finally {
      restore();
    }
  };
  const legacyBefore = await legacyRows();
  const zero = await measured();
  const room = 120 - size();
  assert.ok(room > 50, `room ${room}`);
  seedOrphanHistory(f, room);
  const legacyAfter = await legacyRows();
  assert.ok(
    legacyAfter >= legacyBefore + room,
    `legacy rows ${legacyBefore} -> ${legacyAfter}`,
  );
  const regimeA = await measured();
  assert.deepEqual(regimeA.out, zero.out);
  for (const [key, rows] of Object.entries(regimeA.rows))
    assert.ok(
      rows <= (zero.rows[key] ?? 0) + 8,
      `${key}: ${rows} history rows, ${zero.rows[key]} before`,
    );

  seedOrphanHistory(f, 300);
  assert.ok(size() > 128);
  const regimeB = await measured();
  for (const [key, rows] of Object.entries(regimeB.rows))
    assert.ok(
      rows <= (regimeA.rows[key] ?? 0),
      `${key}: ${rows} history rows, ${regimeA.rows[key]} before`,
    );
  type Summary = Record<string, unknown> & { id: string; title: unknown };
  const summaries = (out: Record<string, unknown>) =>
    (out.taskList as { data: { tasks: Summary[] } }).data.tasks;
  const pick = (s: Summary) => ({
    id: s.id,
    state: s.state,
    version: s.version,
    ready: s.ready,
    execution: s.execution,
    admission: s.admission,
    attention: s.attention,
  });
  assert.deepEqual(
    summaries(regimeB.out).map(pick),
    summaries(regimeA.out).map(pick),
  );
  // Unrelated rows never withhold a task's prose.
  assert.ok(summaries(regimeA.out).some((s) => s.title !== null));
  assert.deepEqual(
    summaries(regimeB.out).map((s) => s.title),
    summaries(regimeA.out).map((s) => s.title),
  );
  assert.deepEqual(regimeB.out, regimeA.out);
  for (const key of Object.keys(regimeA.out).filter((k) =>
    k.startsWith("page:"),
  ))
    assert.equal(regimeB.out[key], regimeA.out[key], key);

  // Contract spot checks.
  const task = (out: Record<string, unknown>, id: string) =>
    (
      out[`task:${id}`] as {
        data: {
          execution: { state: string; holds: Record<string, boolean> };
          attention: { codes: string[] };
        };
      }
    ).data;
  for (const out of [regimeA.out, regimeB.out]) {
    assert.ok(
      Object.values(task(out, ids.uncertain.id).execution.holds).some(Boolean),
    );
    assert.ok(
      (out.inbox as { data: { items: { kind: string }[] } }).data.items.some(
        (i) => i.kind === "intervention",
      ),
    );
  }
});
