import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ExecutionState } from "../../src/standalone/state.js";
import type { TaskListSummary } from "../../src/operator/contracts.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { uniqueProjectName } from "../fixtures/project-names.js";

test("task catalog pages exclude private retained revisions and classify dependency waits separately from attention", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    blocker = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Lead",
    instructions: "PRIVATE REVISION",
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
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Blocker",
    outcome: "Work",
    ready: false,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "PRIVATE REVISION",
    outcome: "Work",
    ready: true,
    blockerTaskIds: [blocker],
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const boundary = api as unknown as {
    readTaskListPage?: (query?: URLSearchParams) => Promise<{
      data: {
        tasks: {
          id: string;
          title: string | null;
          attention: { codes: string[] };
          admission: { reasons: string[] };
        }[];
      };
    }>;
  };
  assert.equal(
    typeof boundary.readTaskListPage,
    "function",
    "task catalog is publicly available",
  );
  await f.service.provisionTask(taskId);
  const page = await boundary.readTaskListPage?.();
  const task = page?.data.tasks.find((x) => x.id === taskId);
  assert.ok(task);
  assert.equal(task.title, "[redacted]");
  assert.deepEqual(task.attention.codes, []);
  assert.ok(task.admission.reasons.includes("local-dependency"));
  assert.ok(!JSON.stringify(page).includes("PRIVATE REVISION"));
});

async function projectFixture(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  paused = true,
) {
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Original lead",
    instructions: "private profile",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: uniqueProjectName(d, "Project"),
    leadProfileId: profileId,
  });
  if (!paused)
    d.execute({
      type: "project.configure",
      key: randomUUID(),
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
  return { projectId, profileId };
}
function createTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  projectId: string,
  title = "Task",
  ready = false,
) {
  const taskId = randomUUID();
  f.service.domain().execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title,
    outcome: "Work",
    ready,
  });
  return taskId;
}
test("task summary retains captured lead after project lead reconfiguration", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f),
    d = f.service.domain(),
    taskId = createTask(f, ids.projectId);
  d.execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.projectId,
    taskId,
    assignmentId: randomUUID(),
    profileId: ids.profileId,
    brief: "Work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const newLead = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: newLead,
    name: "Configured lead",
    instructions: "other private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.projectId,
    expectedVersion: 1,
    leadProfileId: newLead,
  });
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: ids.profileId,
    expectedVersion: 1,
    name: "Renamed lead",
  });
  const unbound = createTask(f, ids.projectId);
  let api = new OperatorApi(f.service, [f.directory]);
  for (let restart = 0; restart < 2; restart++) {
    const tasks = (await api.readTaskListPage()).data.tasks;
    assert.deepEqual(tasks.find((t) => t.id === taskId)?.lead, {
      profileId: ids.profileId,
      name: "Original lead",
    });
    assert.equal(
      tasks.find((t) => t.id === taskId)?.project.leadProfileId,
      newLead,
    );
    assert.deepEqual(tasks.find((t) => t.id === unbound)?.lead, {
      profileId: newLead,
      name: "Configured lead",
    });
    if (!restart) {
      await f.service.stop();
      await f.service.start();
      api = new OperatorApi(f.service, [f.directory]);
    }
  }
});
test("catalog pagination fingerprints ordered identity membership and rejects invalid cursors and queries", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f);
  for (let n = 0; n < 101; n++) createTask(f, ids.projectId, `Task ${n}`);
  const api = new OperatorApi(f.service, [f.directory]),
    first = await api.readTaskListPage();
  assert.equal(first.data.tasks.length, 100);
  assert.ok(first.data.nextCursor);
  const second = await api.readTaskListPage(
    new URLSearchParams({ cursor: first.data.nextCursor }),
  );
  assert.equal(second.data.tasks.length, 1);
  assert.equal(second.data.nextCursor, null);
  assert.equal(first.data.catalogFingerprint, second.data.catalogFingerprint);
  assert.equal(
    new Set([...first.data.tasks, ...second.data.tasks].map((t) => t.id)).size,
    101,
  );
  createTask(f, ids.projectId, "New member");
  assert.notEqual(
    (await api.readTaskListPage()).data.catalogFingerprint,
    first.data.catalogFingerprint,
  );
  for (const query of [
    "limit=101",
    "limit=0",
    "limit=2&limit=3",
    "cursor=invalid",
    `cursor=${randomUUID()}`,
    `project=${ids.projectId}`,
  ])
    await assert.rejects(api.readTaskListPage(new URLSearchParams(query)));
});
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Fixture timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("normal Stop observation stays Work while Stop with actual uncertainty needs attention", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f, false),
    d = f.service.domain();
  const taskId = createTask(f, ids.projectId, "Stopping normally", false);
  await f.service.provisionTask(taskId);
  d.execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => f.runtime.turns === 1);
  const request = f.service
    .turnRequests()
    .find((r) => r.taskId === taskId && r.state === "active");
  assert.ok(request);
  f.seedPersistedState((db) => {
    new ExecutionState(db).stopTask(taskId);
    // A bound active runtime can still be observed during best-effort Stop.
    db.prepare(
      "UPDATE execution_intents SET state='running' WHERE workId=?",
    ).run(request.workId);
    db.prepare("UPDATE turn_requests SET state='active' WHERE workId=?").run(
      request.workId,
    );
  });
  const api = new OperatorApi(f.service, [f.directory]);
  let card = (await api.readTaskListPage()).data.tasks.find(
    (t) => t.id === taskId,
  );
  assert.ok(card);
  assert.equal(card.execution.state, "stopping");
  assert.deepEqual(card.attention.codes, []);
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE execution_intents SET state='held' WHERE workId=?")
      .run(request.workId),
  );
  card = (await api.readTaskListPage()).data.tasks.find((t) => t.id === taskId);
  assert.equal(card?.execution.state, "stopping");
  assert.ok(card?.attention.codes.includes("execution-uncertain"));
});

import { OperatorClient } from "../../web/src/api.js";
import {
  activeFilterCount,
  defaultTaskFilters,
  loadTaskList,
  filterTasks,
  parseTaskFilters,
  taskFiltersUrl,
  type TaskFilters,
  taskColumn,
  taskDetailHref,
  taskReasons,
  reasonLabels,
} from "../../web/src/tasks.js";
import { attentionNext } from "../../src/operator/attention.js";
test("a complete task aggregate rejects changing membership and repeated page cursors", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f);
  for (let n = 0; n < 101; n++) createTask(f, ids.projectId, `Task ${n}`);
  const api = new OperatorApi(f.service, [f.directory]);
  const first = await api.readTaskListPage(),
    second = await api.readTaskListPage(
      new URLSearchParams({ cursor: first.data.nextCursor ?? "" }),
    );
  const scripted = (pages: unknown[]) =>
    new OperatorClient(
      async () =>
        new Response(JSON.stringify(pages.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  const all = await loadTaskList(scripted([first, second]));
  assert.equal(all.tasks.length, 101);
  await assert.rejects(
    loadTaskList(
      scripted([
        first,
        {
          ...second,
          data: { ...second.data, catalogFingerprint: "0".repeat(64) },
        },
      ]),
    ),
    /catalog-changed/,
  );
  await assert.rejects(
    loadTaskList(scripted([first, first])),
    /invalid-catalog-order/,
  );
  await assert.rejects(
    loadTaskList(
      scripted([
        { ...first, data: { ...first.data, nextCursor: randomUUID() } },
      ]),
    ),
    /invalid-catalog-cursor/,
  );
  const filters = parseTaskFilters(
    "?source=local&ready=no&state=Paused&q=Task%201&view=board",
  );
  const filtered = filterTasks(all.tasks, filters);
  assert.equal(filtered.length, 12);
  assert.ok(filtered.every((t) => taskColumn(t) === "Paused"));
  assert.ok(filtered.every((t) => taskDetailHref(t) === `/app/tasks/${t.id}`));
  assert.deepEqual(
    parseTaskFilters("?project=bad&source=bad&state=bad&ready=bad&view=bad"),
    defaultTaskFilters,
  );
  assert.equal(parseTaskFilters("?ready=any").ready, "any");
  assert.equal(parseTaskFilters("?ready=").ready, "yes");
  assert.equal(taskFiltersUrl("/app/tasks", defaultTaskFilters), "/app/tasks");
  assert.equal(
    taskFiltersUrl("/app/tasks", { ...defaultTaskFilters, ready: "any" }),
    "/app/tasks?ready=any",
  );
  const readiness = (ready: TaskFilters["ready"]) =>
    filterTasks(all.tasks, { ...defaultTaskFilters, state: "all", ready });
  assert.ok(readiness("no").every((t) => !t.ready));
  assert.ok(readiness("yes").every((t) => t.ready));
  assert.equal(
    readiness("any").length,
    readiness("yes").length + readiness("no").length,
  );
  const shown = { ...defaultTaskFilters, source: "github", q: "x" } as const;
  assert.equal(activeFilterCount(shown), 2);
  assert.equal(
    activeFilterCount({ ...defaultTaskFilters, project: randomUUID() }),
    1,
  );
  assert.equal(
    activeFilterCount({ ...defaultTaskFilters, project: randomUUID() }, "p"),
    0,
  );
  assert.equal(parseTaskFilters("?state=all").state, "all");
});

test("composer options expose only active permitted profiles and same-project dependencies", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f),
    other = await projectFixture(f),
    d = f.service.domain(),
    worker = randomUUID(),
    revoked = randomUUID();
  for (const profileId of [worker, revoked])
    d.execute({
      type: "profile.create",
      key: randomUUID(),
      actor: "operator",
      profileId,
      name: "Worker",
      instructions: "private worker",
      capabilities: "execute",
    });
  d.execute({
    type: "routing.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "private routing",
    candidateProfileIds: [worker, worker, revoked],
  });
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: revoked,
    expectedVersion: 1,
    revoked: true,
  });
  const own = createTask(f, ids.projectId, "Own blocker"),
    foreign = createTask(f, other.projectId, "Foreign blocker");
  const api = new OperatorApi(f.service, [f.directory]),
    options = await api.readComposerOptions(ids.projectId);
  assert.deepEqual(
    new Set(options.data.profiles.map((p) => p.id)),
    new Set([ids.profileId, worker]),
  );
  assert.equal(options.data.profiles.length, 2);
  assert.deepEqual(
    options.data.dependencies.map((t) => t.id),
    [own],
  );
  assert.ok(!JSON.stringify(options).includes(foreign));
  assert.doesNotMatch(
    JSON.stringify(options),
    /private worker|private routing/,
  );
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: worker,
    expectedVersion: 1,
    revoked: true,
  });
  const taskId = randomUUID();
  await assert.rejects(
    api.execute({
      type: "task.create",
      key: randomUUID(),
      projectId: ids.projectId,
      taskId,
      title: "Rejected stale choice",
      outcome: "Finish",
      ready: true,
      initialAssignment: { assignmentId: randomUUID(), profileId: worker },
    }),
  );
  assert.ok(!d.tasks(ids.projectId).some((t) => t.id === taskId));
});
test("task catalog and options fail explicitly above ten thousand identities rather than truncate", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f);
  f.seedPersistedState((db) => {
    db.exec("BEGIN");
    const base = db.prepare(
        "INSERT INTO tasks(id,projectId,title) VALUES(?,?,?)",
      ),
      domain = db.prepare(
        "INSERT INTO domain_tasks(id,projectId,version,outcome,ready,state,importedBlockers) VALUES(?,?,1,'Work',0,'open','clear')",
      );
    for (let n = 1; n <= 10001; n++) {
      const id = `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      base.run(id, ids.projectId, "Bounded task");
      domain.run(id, ids.projectId);
    }
    db.exec("COMMIT");
  });
  const api = new OperatorApi(f.service, [f.directory]);
  assert.equal(f.service.domain().taskCatalog().length, 10001);
  for (const read of [
    () => api.readTaskListPage(),
    () => api.readComposerOptions(ids.projectId),
  ])
    await assert.rejects(
      read(),
      (e: unknown) =>
        e instanceof Error && "code" in e && e.code === "unavailable",
    );
});
test("task titles stay readable with about 40 projects and repeated profile edits, and retained revisions stay redacted", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f),
    d = f.service.domain(),
    taskId = createTask(f, ids.projectId, "Private-budget title"),
    leaked = createTask(f, ids.projectId, "Mentions retained secret 7");
  for (let n = 0; n < 40; n++) {
    const project = n === 0 ? ids : await projectFixture(f);
    f.seedPersistedState((db) =>
      db
        .prepare(
          "UPDATE project_repository_links SET version=version+1, links=? WHERE projectId=?",
        )
        .run(
          JSON.stringify([
            {
              codeHost: "github",
              host: "github.com",
              repositoryId: `R-${n}`,
              path: `/fixture/linked-${n}`,
              ref: "main",
              gitCommonDirectory: `/fixture/linked-${n}/.git`,
            },
          ]),
          project.projectId,
        ),
    );
  }
  for (let version = 1; version < 129; version++)
    d.execute({
      type: "profile.configure",
      key: randomUUID(),
      actor: "operator",
      profileId: ids.profileId,
      expectedVersion: version,
      instructions: `retained secret ${version}`,
    });
  const api = new OperatorApi(f.service, [f.directory]),
    tasks = (await api.readTaskListPage()).data.tasks,
    task = tasks.find((t) => t.id === taskId);
  assert.ok(task);
  assert.equal(task.title, "Private-budget title");
  assert.notEqual(task.project.name, null);
  assert.notEqual(task.lead?.name, null);
  assert.equal(
    tasks.find((t) => t.id === leaked)?.title,
    "Mentions [redacted]",
  );
  const options = await api.readComposerOptions(ids.projectId);
  assert.notEqual(options.data.profiles[0]?.name, null);
});
test("reads fail with redaction-limit past the installation bound instead of withholding prose", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f),
    d = f.service.domain();
  createTask(f, ids.projectId, "Bounded title");
  for (let version = 1; version <= 360; version++)
    d.execute({
      type: "profile.configure",
      key: randomUUID(),
      actor: "operator",
      profileId: ids.profileId,
      expectedVersion: version,
      instructions: `${"界".repeat(15990)}${version}`,
    });
  const api = new OperatorApi(f.service, [f.directory]);
  for (const read of [
    () => api.readTaskListPage(),
    () => api.readComposerOptions(ids.projectId),
  ])
    await assert.rejects(
      read(),
      (e: unknown) =>
        e instanceof OperatorApiError &&
        e.code === "redaction-limit" &&
        e.status === 503,
    );
});
test("a complete aggregate rejects the maximum-page breach and malformed pages and obeys resource cancellation", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f);
  createTask(f, ids.projectId);
  const page = await new OperatorApi(f.service, [
    f.directory,
  ]).readTaskListPage();
  const template = page.data.tasks[0];
  assert.ok(template);
  let reads = 0;
  const many = new OperatorClient(async () => {
    const id = `a0000000-0000-4000-8000-${String(++reads).padStart(12, "0")}`;
    return new Response(
      JSON.stringify({
        ...page,
        data: { ...page.data, tasks: [{ ...template, id }], nextCursor: id },
      }),
      { status: 200 },
    );
  });
  await assert.rejects(loadTaskList(many), /catalog-too-large/);
  assert.equal(reads, 100);
  const malformed = new OperatorClient(
    async () =>
      new Response(
        JSON.stringify({
          ...page,
          data: {
            ...page.data,
            tasks: [{ ...template, rawProcess: "private" }],
          },
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(loadTaskList(malformed), /invalid-response/);
  const abort = new AbortController();
  abort.abort();
  reads = 0;
  await assert.rejects(
    loadTaskList(many, abort.signal),
    (e) => e instanceof Error && e.name === "AbortError",
  );
  assert.equal(reads, 0);
});
test("Stop without an active execution remains normal Work", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f),
    taskId = createTask(f, ids.projectId, "Stopped draft");
  f.seedPersistedState((db) => new ExecutionState(db).stopTask(taskId));
  const task = (
    await new OperatorApi(f.service, [f.directory]).readTaskListPage()
  ).data.tasks.find((t) => t.id === taskId);
  assert.equal(task?.execution.state, "stopping");
  assert.deepEqual(task?.attention.codes, []);
});

test("catalog and composer options project effective overrides above and below default capacity", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f),
    taskId = createTask(f, ids.projectId),
    d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  assert.equal(d.capacityLimits([ids.projectId]).defaultProjectLimit, 2);
  for (const limit of [10, 1]) {
    d.execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 20,
      projectOverrides: { [ids.projectId]: limit },
    });
    const task = (await api.readTaskListPage()).data.tasks.find(
      (t) => t.id === taskId,
    );
    assert.ok(task);
    assert.equal(task.capacity.projectLimit, limit);
    assert.equal(
      (await api.readComposerOptions(ids.projectId)).data.capacity.projectLimit,
      limit,
    );
  }
});

test("shared task reasons retain all current interventions and deduplicate uncertainty without prospective terminal waits", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await projectFixture(f, false),
    taskId = createTask(f, ids.projectId, "Action", true),
    api = new OperatorApi(f.service, [f.directory]);
  await f.service.provisionTask(taskId);
  const template = (await api.readTaskListPage()).data.tasks.find(
    (t) => t.id === taskId,
  );
  assert.ok(template);
  const codes: typeof template.attention.codes = [
    "question",
    "approval",
    "unresolved-result",
    "completion-rejected",
    "lead-review",
    "execution-uncertain",
  ];
  assert.equal(reasonLabels["admission-blocked"], "Waiting to start");
  for (const label of Object.values(reasonLabels))
    assert.doesNotMatch(label, /admission|receipt|observation|revision/i);
  for (const code of codes) {
    const task: TaskListSummary = {
      ...template,
      attention: { codes: [code], count: 1 },
    };
    assert.ok(
      taskReasons(task).includes(attentionNext[code].reason),
      `current ${code} action is legible`,
    );
  }
  const runtimeUnconfirmed = {
    ...template,
    attention: { codes: [], count: 0 },
    execution: {
      ...template.execution,
      state: "uncertain" as const,
      reasonCodes: ["runtime-unconfirmed" as const],
    },
  };
  assert.ok(
    taskReasons(runtimeUnconfirmed).includes(
      attentionNext["execution-uncertain"].reason,
    ),
  );
  const uncertainStop = {
    ...template,
    attention: { codes: ["execution-uncertain" as const], count: 1 },
    execution: {
      ...template.execution,
      state: "stopping" as const,
      holds: { ...template.execution.holds, stop: true, uncertainty: true },
    },
  };
  assert.equal(
    taskReasons(uncertainStop).filter(
      (r) => r === attentionNext["execution-uncertain"].reason,
    ).length,
    1,
  );
  assert.ok(
    taskReasons(uncertainStop).includes("Stop requested; effects may continue"),
  );
  const normalStop = {
    ...uncertainStop,
    attention: { codes: [], count: 0 },
    execution: {
      ...uncertainStop.execution,
      holds: { ...uncertainStop.execution.holds, uncertainty: false },
    },
  };
  assert.equal(
    taskReasons(normalStop).includes(
      attentionNext["execution-uncertain"].reason,
    ),
    false,
  );
  for (const state of ["done", "cancelled"] as const) {
    const terminal: TaskListSummary = {
      ...uncertainStop,
      state,
      attention: { codes: [...codes], count: codes.length },
      admission: {
        eligible: false,
        reasons: ["task-unready" as const, "local-dependency" as const],
      },
      capacity: {
        ...template.capacity,
        globalUsage: 10,
        globalLimit: 10,
        projectUsage: 10,
        projectLimit: 10,
      },
    };
    for (const code of codes)
      assert.ok(taskReasons(terminal).includes(attentionNext[code].reason));
    assert.equal(
      taskReasons(terminal).some((r) =>
        /Draft: not Ready|dependency|Capacity is full/.test(r),
      ),
      false,
    );
    assert.equal(
      taskReasons(terminal).filter(
        (r) => r === attentionNext["execution-uncertain"].reason,
      ).length,
      1,
    );
  }
});

test("task summaries name an open GitHub blocker by its imported task's title", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    sources = f.service.githubSources();
  const issue = (
    nodeId: string,
    number: number,
    title: string,
    repositoryId = "R-1",
    repositoryName = "acme/atlas",
  ) => ({
    providerInstance: "github.com" as const,
    nodeId,
    repositoryId,
    repositoryName,
    number,
    title,
    body: "Scope",
    state: "open" as const,
    labels: ["ready"],
    projectFields: [],
  });
  /** A project importing `issues` from one repository. */
  const importInto = async (
    repositoryId: string,
    name: string,
    issues: ReturnType<typeof issue>[],
  ) => {
    const { projectId } = await projectFixture(f);
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: null,
      selections: [
        { id: "repo", kind: "repository", repositoryId, owner: "acme", name },
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
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues,
      reason: null,
    });
  };
  const blocked = issue("I-BLOCKED", 1, "Blocked work"),
    imported = issue("I-BLOCKER", 2, "Ship the API"),
    closed = {
      ...issue("I-CLOSED", 3, "Done already"),
      state: "closed" as const,
    },
    elsewhere = issue(
      "I-ELSEWHERE",
      4,
      "Other project work",
      "R-2",
      "acme/other",
    ),
    outside = issue("I-OUTSIDE", 9, "Not imported");
  await importInto("R-1", "atlas", [blocked, imported]);
  // Imported, but by another project: its title stays out of this project's reads.
  await importInto("R-2", "other", [elsewhere]);
  sources.reconcileBlockers("I-BLOCKED", {
    complete: true,
    blockers: [imported, closed, elsewhere, outside],
    reason: null,
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const tasks = (await api.readTaskListPage()).data.tasks;
  const task = tasks.find((t) => t.title === "Blocked work");
  assert.deepEqual(task?.source?.openBlockers, [
    {
      label: "acme/atlas#2",
      task: {
        id: tasks.find((t) => t.title === "Ship the API")?.id,
        title: "Ship the API",
      },
      url: "https://github.com/acme/atlas/issues/2",
    },
    {
      label: "acme/other#4",
      task: null,
      url: "https://github.com/acme/other/issues/4",
    },
    {
      label: "acme/atlas#9",
      task: null,
      url: "https://github.com/acme/atlas/issues/9",
    },
  ]);
});
