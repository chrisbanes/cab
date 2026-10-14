import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ConversationHistoryBinding } from "../../src/standalone/conversation-history.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  forbid,
  historyRowCounter,
  seedOrphanHistory,
} from "../fixtures/read-guards.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
type Exclusions = {
  exclusions(
    projectId: string,
    taskId: string,
    bindings?: readonly ConversationHistoryBinding[],
  ): Promise<string[] | undefined>;
};
const title = "Known private title";

/** One task with one admitted turn, as `seed(f, true)` in operator-api.test.ts. */
async function world(f: Fixture) {
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "PRIVATE INSTRUCTIONS",
    capabilities: "coordination",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title,
    outcome: "Outcome",
    ready: false,
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const deadline = Date.now() + 4000;
  while (f.runtime.turns < 1) {
    if (Date.now() > deadline) throw Error("Fixture timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
  const assignment = d.assignments(taskId)[0];
  assert.ok(assignment);
  return { projectId, taskId, assignmentId: String(assignment.id) };
}

async function shownTitle(api: OperatorApi, taskId: string) {
  const { data } = await api.readTask(taskId);
  if (data.task.title === null) assert.equal(data.contentUnavailable, true);
  return data.task.title;
}

for (const kind of ["requests", "recovery"] as const)
  test(`the 128-row ${kind} bound is the task's own, decided by a capped count before any history row`, async (t) => {
    const f = await createOperatorFixture();
    t.after(() => f.close());
    const ids = await world(f);
    const api = new OperatorApi(f.service, [f.directory]);
    const kinds = {
      requests: kind === "requests",
      recovery: kind === "recovery",
    };
    const own = () =>
      kind === "requests"
        ? f.service.turnRequestsForTask(ids.taskId).length
        : f.service.recoveryForTask(ids.taskId).length;
    const all = () =>
      kind === "requests"
        ? f.service.turnRequests().length
        : f.service.recoveryView().length;

    // Unrelated rows, however many, never withhold the task's prose.
    seedOrphanHistory(f, 129, kinds);
    assert.ok(all() > 128);
    assert.equal(await shownTitle(api, ids.taskId), title);
    const scoped = new OperatorApi(
      forbid(f.service, ["recoveryView", "turnRequests", "list"]),
      [f.directory],
    );
    assert.equal(await shownTitle(scoped, ids.taskId), title);

    // The task's own rows: 128 shown, 129 withheld.
    seedOrphanHistory(f, 128 - own(), kinds, ids);
    assert.equal(own(), 128);
    assert.equal(await shownTitle(api, ids.taskId), title);
    seedOrphanHistory(f, 1, kinds, ids);
    assert.equal(own(), 129);
    assert.equal(await shownTitle(api, ids.taskId), null);
    const rowless = new OperatorApi(
      forbid(f.service, [
        "recoveryView",
        "turnRequests",
        "list",
        "recoveryForTask",
        "turnRequestsForTask",
      ]),
      [f.directory],
    );
    assert.equal(await shownTitle(rowless, ids.taskId), null);
    const counter = historyRowCounter(t);
    const [excluded, rows] = await counter.measure(() =>
      (rowless as unknown as Exclusions).exclusions(ids.projectId, ids.taskId),
    );
    assert.equal(excluded, undefined);
    // Only the capped COUNT rows (one or two); slack for idle statements.
    assert.ok(rows >= 1 && rows <= 6, `history rows ${rows}`);
  });

test("task-scoped exclusions still fail closed on uncovered revisions, unknown assignments and local bounds", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await world(f);
  const api = new OperatorApi(f.service, [f.directory]),
    exclusions = (api as unknown as Exclusions).exclusions.bind(api);
  assert.equal(await shownTitle(api, ids.taskId), title);
  const binding = (n: number): ConversationHistoryBinding => ({
    workId: `history-${n}`,
    taskId: ids.taskId,
    assignmentId: ids.assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread",
    turnId: "turn",
  });
  const bindings = (count: number) =>
    Array.from({ length: count }, (_, n) => binding(n));
  assert.ok(await exclusions(ids.projectId, ids.taskId, bindings(400)));
  assert.equal(
    await exclusions(ids.projectId, ids.taskId, bindings(401)),
    undefined,
  );

  const withState = async (
    seed: (db: import("node:sqlite").DatabaseSync) => void,
    undo: (db: import("node:sqlite").DatabaseSync) => void,
  ) => {
    f.seedPersistedState(seed);
    assert.equal(await shownTitle(api, ids.taskId), null);
    f.seedPersistedState(undo);
    assert.equal(await shownTitle(api, ids.taskId), title);
  };
  // An uncovered captured revision.
  await withState(
    (db) =>
      db
        .prepare(
          "UPDATE domain_assignments SET instructionsRevision = 99 WHERE id = ?",
        )
        .run(ids.assignmentId),
    (db) =>
      db
        .prepare(
          "UPDATE domain_assignments SET instructionsRevision = 1 WHERE id = ?",
        )
        .run(ids.assignmentId),
  );
  // A request of the task naming an unknown assignment.
  const stray = `stray-${randomUUID()}`;
  await withState(
    (db) =>
      db
        .prepare(
          "INSERT INTO turn_requests (requestKey,workId,kind,taskId,projectId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,prompt,state) VALUES (?,?,'assignment',?,?,?,1,1,1,'P','completed')",
        )
        .run(randomUUID(), stray, ids.taskId, ids.projectId, randomUUID()),
    (db) => db.prepare("DELETE FROM turn_requests WHERE workId = ?").run(stray),
  );
  // A recovery binding of the task naming an assignment outside it.
  const foreign = `foreign-${randomUUID()}`;
  await withState(
    (db) => {
      db.prepare(
        "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval) VALUES (?,?,'P','/w','completed','chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), foreign);
      db.prepare(
        "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence) VALUES (?,1,1)",
      ).run(foreign);
      db.prepare(
        "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
      ).run(foreign, ids.taskId, randomUUID());
    },
    (db) => {
      for (const table of [
        "task_execution_bindings",
        "execution_recovery_identities",
        "execution_intents",
      ])
        db.prepare(`DELETE FROM ${table} WHERE workId = ?`).run(foreign);
    },
  );
  // More than 128 assignments on the task.
  const copy = (count: number) =>
    f.seedPersistedState((db) => {
      const columns = (
        db.prepare("PRAGMA table_info(domain_assignments)").all() as {
          name: string;
        }[]
      )
        .map((c) => c.name)
        .filter((c) => c !== "id");
      for (let i = 0; i < count; i++)
        db.prepare(
          `INSERT INTO domain_assignments (id, ${columns.join(",")}) SELECT ?, ${columns.join(",")} FROM domain_assignments WHERE id = ?`,
        ).run(randomUUID(), ids.assignmentId);
    });
  copy(127);
  assert.ok(await exclusions(ids.projectId, ids.taskId));
  copy(1);
  assert.equal(await exclusions(ids.projectId, ids.taskId), undefined);
});
