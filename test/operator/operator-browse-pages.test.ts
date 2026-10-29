import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { cliCapabilities } from "../../src/operator/contracts.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { seedReviewTask } from "../fixtures/task-review.js";

type Json = Record<string, unknown> & { data: Record<string, unknown> };

test("browse pages filter, page and reject stale cursors without changing UI defaults", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  const read = await s.issue("read");
  const get = async (path: string) => {
    try {
      const r = await s.bearer(read.token, path);
      return { status: r.status, body: (await r.json()) as Json };
    } catch (cause) {
      throw new Error(`Browse bearer GET ${path.split("?")[0]} failed`, {
        cause,
      });
    }
  };
  const session = async (path: string) => {
    try {
      return (await (await s.sessionGet(path)).json()) as Json;
    } catch (cause) {
      throw new Error(`Browse session GET ${path.split("?")[0]} failed`, {
        cause,
      });
    }
  };

  // 1. Task list filters over two projects with open, done and cancelled tasks.
  const review = await seedReviewTask(s.f, "Beta");
  const create = (projectId: string, title: string) => {
    const taskId = randomUUID();
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title,
      outcome: title,
      ready: false,
    });
    return taskId;
  };
  const finish = (projectId: string, taskId: string, state: string) =>
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(d.task(taskId).version),
      state: state as "done",
    });
  const done = create(review.projectId, "Done task");
  finish(review.projectId, done, "done");
  const cancelled = create(s.projectId, "Cancelled task");
  finish(s.projectId, cancelled, "cancelled");
  const ids = (body: Json) =>
    (body.data.tasks as { id: string }[]).map((x) => x.id).sort();
  let r = await get(`/api/operator/task-list?projectId=${review.projectId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.body), [review.taskId, done].sort());
  r = await get("/api/operator/task-list?state=done");
  assert.deepEqual(ids(r.body), [done]);
  r = await get(
    `/api/operator/task-list?state=open&projectId=${review.projectId}`,
  );
  assert.deepEqual(ids(r.body), [review.taskId]);
  assert.equal(
    r.body.data.catalogFingerprint,
    createHash("sha256")
      .update(JSON.stringify([[review.taskId, review.projectId]]))
      .digest("hex"),
  );
  r = await get(`/api/operator/task-list?projectId=${randomUUID()}`);
  assert.equal(r.status, 404);
  const all = d.taskCatalog();
  r = await get("/api/operator/task-list");
  assert.equal((r.body.data.tasks as unknown[]).length, all.length);
  assert.equal(
    r.body.data.catalogFingerprint,
    createHash("sha256")
      .update(JSON.stringify(all.map((x) => [x.id, x.projectId])))
      .digest("hex"),
  );
  for (const query of ["limit=101", "limit=0", "project=x", "cursor=bad"])
    assert.equal((await get(`/api/operator/task-list?${query}`)).status, 400);
  r = await get(`/api/operator/task-list?cursor=${randomUUID()}`);
  assert.equal(r.status, 409);
  assert.equal(
    (r.body as unknown as { error: { code: string } }).error.code,
    "conflict",
  );

  // 2. Search: a valid cursor pages; an unknown one is a conflict.
  for (let i = 0; i < 3; i++) create(s.projectId, `Searchable ${i}`);
  r = await get(
    "/api/operator/search?query=Searchable&historical=true&limit=1",
  );
  assert.equal(r.status, 200);
  const cursor = r.body.data.nextCursor as string;
  assert.ok(cursor);
  r = await get(
    `/api/operator/search?query=Searchable&historical=true&limit=1&cursor=${cursor}`,
  );
  assert.equal(r.status, 200);
  assert.equal((r.body.data.matches as unknown[]).length, 1);
  r = await get(
    `/api/operator/search?query=Searchable&historical=true&cursor=${randomUUID()}`,
  );
  assert.equal(r.status, 409);

  // 3. History: an explicit limit pages; no limit keeps the 200 default.
  const work = review.result("History owner");
  const binding = {
    workId: work.workId,
    taskId: review.taskId,
    assignmentId: review.assignmentId,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: work.workId,
    turnId: work.workId,
  };
  s.f.seedPersistedState((db) => {
    const store = new ConversationHistoryStore(db);
    for (let i = 0; i < 60; i++)
      store.record(
        binding,
        {
          kind: "completed",
          threadId: work.workId,
          turnId: work.workId,
          itemId: `item-${i}`,
          text: `Item ${i} PRIVATE REVIEW INSTRUCTIONS`,
        },
        [],
      );
  });
  const history = `/api/operator/assignments/${review.assignmentId}/history`;
  r = await get(`${history}?limit=50`);
  assert.equal(r.status, 200);
  const items = r.body.data.items as { sequence: number; text: string }[];
  assert.equal(items.length, 50);
  assert.equal(r.body.data.omittedItemCount, 10);
  assert.ok(items.every((i) => !i.text.includes("PRIVATE REVIEW")));
  r = await get(`${history}?limit=50&beforeSequence=${items[0]?.sequence}`);
  assert.equal((r.body.data.items as unknown[]).length, 10);
  assert.equal(r.body.data.omittedItemCount, 0);
  r = await get(history);
  assert.equal((r.body.data.items as unknown[]).length, 60);
  assert.deepEqual(r.body.data, (await session(history)).data);
  for (const limit of ["0", "201", "x"])
    assert.equal((await get(`${history}?limit=${limit}`)).status, 400);

  // 4. Results and messages page in readTask order with identical projections.
  // Yield between synchronous writes: on a slow CI disk an unbroken loop blocks
  // past the server's 6s keep-alive window, and the next fetch reuses a socket
  // the server then resets (ECONNRESET).
  for (let i = 1; i < 120; i++) {
    review.result(`Result ${i} PRIVATE REVIEW INSTRUCTIONS`);
    await setImmediate();
  }
  const task = await api.readTask(review.taskId);
  assert.equal(task.data.results.length, 120);
  const results = `/api/operator/tasks/${review.taskId}/results`;
  const pages: unknown[][] = [];
  let next: string | null = null;
  do {
    r = await get(`${results}${next ? `?cursor=${next}` : ""}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.total, 120);
    pages.push(r.body.data.results as unknown[]);
    next = r.body.data.nextCursor as string | null;
  } while (next);
  assert.deepEqual(
    pages.map((p) => p.length),
    [50, 50, 20],
  );
  assert.deepEqual(pages.flat(), task.data.results);
  assert.ok(!JSON.stringify(pages).includes("PRIVATE REVIEW"));
  const one = task.data.results[7]!;
  r = await get(`${results}?resultId=${one.resultId}`);
  assert.deepEqual(r.body.data.results, [one]);
  assert.equal((await get(`${results}?resultId=${randomUUID()}`)).status, 404);
  assert.equal(
    (await get(`${results}?resultId=${one.resultId}&cursor=${one.resultId}`))
      .status,
    400,
  );
  assert.equal((await get(`${results}?limit=201`)).status, 400);
  const other = await seedReviewTask(s.f, "Other");
  const foreign = other.result("Foreign").resultId;
  assert.equal((await get(`${results}?cursor=${foreign}`)).status, 409);
  assert.deepEqual(
    (await get(`${results}?limit=200`)).body.data,
    (await session(`${results}?limit=200`)).data,
  );

  for (let i = 0; i < 60; i++) {
    const response = await s.sessionPost("/api/operator/commands", {
      type: "message",
      key: randomUUID(),
      taskId: review.taskId,
      recipientAssignmentId: review.assignmentId,
      expectedAssignmentVersion: Number(
        d.assignment(review.assignmentId).version,
      ),
      message: `Message ${i}`,
    });
    assert.equal(response.status, 200);
  }
  const messages = `/api/operator/tasks/${review.taskId}/messages`;
  const allMessages = (await api.readTask(review.taskId)).data.messages;
  r = await get(`${messages}?limit=40`);
  assert.equal(r.body.data.total, allMessages.length);
  assert.deepEqual(r.body.data.messages, allMessages.slice(0, 40));
  r = await get(`${messages}?limit=40&cursor=${r.body.data.nextCursor}`);
  assert.deepEqual(r.body.data.messages, allMessages.slice(40, 80));
  assert.ok(allMessages.length >= 60);
  assert.equal(
    r.body.data.nextCursor,
    allMessages.length > 80 ? allMessages[79]?.eventId : null,
  );
  assert.equal((await get(`${messages}?resultId=${one.resultId}`)).status, 400);
  assert.equal((await get(`${messages}?cursor=${randomUUID()}`)).status, 409);

  // 5. Bearer reads equal session reads, persist nothing and advertise T1 capabilities.
  const before = databaseDigest(s.f);
  for (const path of [
    `/api/operator/task-list?projectId=${review.projectId}&state=open`,
    `${history}?limit=50`,
    `${results}?limit=10`,
    `${messages}?limit=10`,
    "/api/operator/search?query=Searchable&historical=true",
  ]) {
    const bearer = await get(path);
    assert.equal(bearer.status, 200, path);
    const viaSession = await session(path);
    if (path.includes("/history"))
      assert.deepEqual(bearer.body.data.items, viaSession.data.items);
    else assert.deepEqual(bearer.body.data, viaSession.data, path);
  }
  assert.equal(databaseDigest(s.f), before);
  r = await get("/api/operator/cli");
  assert.deepEqual((r.body.capabilities as string[]).slice(0, 6), [
    "cli.identity",
    "task.read",
    "workspace.read",
    "task.list",
    "task.search",
    "task.records",
  ]);
  assert.deepEqual(r.body.capabilities, [...cliCapabilities]);
});
