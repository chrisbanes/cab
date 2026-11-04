import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI documents are asserted structurally
type Json = Record<string, any>;

test("the stacking setting and a task's stack facts through the API and the CLI", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const version = () => Number(d.project(s.projectId).version);
  const configure = (stacking: boolean, expectedVersion = version()) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion,
    stacking,
  });
  const read = await s.issue("read", "stack-ro");
  const write = await s.issue("read-write", "stack-rw");
  const get = async (path: string) => {
    const r = await s.bearer(read.token, path);
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: Json }).data;
  };
  const config = () =>
    get(`/api/operator/projects/${s.projectId}/configuration`);
  const task = () => get(`/api/operator/tasks/${s.taskId}`);
  const post = (token: string, body: unknown) =>
    s.bearer(token, "/api/operator/commands", { method: "POST", body });

  assert.equal((await config()).stacking, false, "off by default");
  // The CLI fixture's task depends on a blocker in its project.
  const blocker = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: blocker,
    title: "Blocker",
    outcome: "O",
    blockerTaskIds: [],
  });
  d.execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: s.taskId,
    blockerTaskId: blocker,
    expectedVersion: Number(d.task(s.taskId).version),
  });
  let data = await task();
  assert.equal(data.stack.reason, "stacking-off");
  assert.ok(data.admission.reasons.includes("local-dependency"));

  assert.equal((await post(read.token, configure(true))).status, 403);
  const stale = version();
  const set = await post(write.token, configure(true));
  assert.equal(set.status, 200);
  assert.equal((await config()).stacking, true);
  assert.equal(version(), stale + 1, "the project version moves");
  assert.equal((await post(write.token, configure(false, stale))).status, 409);
  assert.equal(d.stacking(s.projectId), true);

  data = await task();
  assert.deepEqual(data.stack, {
    state: "waiting",
    reason: "blocker-unpublished",
    blockerTaskId: blocker,
    repositoryId: null,
    parentHead: null,
    restack: null,
  });
  assert.ok(data.admission.reasons.includes("stacked-blocker-unpublished"));
  assert.ok(!data.admission.reasons.includes("local-dependency"));
  assert.deepEqual(
    data.waits.find((w: Json) => w.code === "stacked-blocker-unpublished")
      ?.links,
    [{ kind: "task", id: blocker, label: "Blocker" }],
  );

  const h = harness(t);
  for (const [name, token] of [
    ["ro", read.token],
    ["rw", write.token],
  ] as const) {
    const login = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(token),
    ]);
    assert.equal(login.code, 0, login.err);
  }
  const cli = (connection: "ro" | "rw", args: string[]) =>
    h.run([...args, "--connection", connection]);
  const project = await cli("ro", ["project", "get", s.projectId]);
  assert.match(project.out, /Stacking:\s+on/);
  const detail = await cli("ro", ["task", "get", s.taskId]);
  assert.equal(detail.code, 0, detail.err);
  assert.match(
    detail.out,
    /Stack: {3}Will start stacked on its blocker; waiting because its blocker has no open change request at its last push\./,
  );

  const prepare = (extra: string[]) => {
    const out = join(h.dir, `${randomUUID()}.json`);
    return {
      out,
      run: () =>
        cli("ro", [
          "project",
          "prepare",
          s.projectId,
          ...extra,
          "--out",
          out,
          "--output",
          "json",
        ]),
    };
  };
  const bad = prepare(["--stacking", "maybe"]);
  let r = await bad.run();
  assert.equal(r.code, 2, r.err + r.out);
  assert.equal(existsSync(bad.out), false);

  const off = prepare(["--stacking", "false"]);
  r = await off.run();
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(readFileSync(off.out, "utf8")) as Json;
  assert.deepEqual(doc.preview.changes, [
    { field: "stacking", from: "true", to: "false" },
  ]);
  const notes = JSON.stringify(doc.preview.notes);
  assert.match(notes, /unmerged work/);
  assert.match(notes, /merge cannot be undone/);
  assert.match(notes, /dependents that have not started/);
  r = await cli("rw", ["project", "apply", "--file", off.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.stacking(s.projectId), false);
});

test("recorded stack PR facts agree in API detail/list and CLI, including unknown membership", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain(),
    store = s.f.service.delivery();
  const blocker = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: blocker,
    title: "Blocker",
    outcome: "O",
  });
  const head = "a".repeat(40);
  const branch = store.assignTaskBranchWithinTransaction(blocker, "R1");
  const own = store.assignTaskBranchWithinTransaction(s.taskId, "R1");
  s.f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId IN (?,?)",
    ).run(head, blocker, s.taskId);
    db.prepare(
      "INSERT INTO stacked_dependencies(taskId,blockerTaskId,repositoryId,parentHead,restack,recordedAt) VALUES (?,?,?,?, 'current',1)",
    ).run(s.taskId, blocker, "R1", head);
  });
  const caller = {
    projectId: s.projectId,
    taskId: blocker,
    taskVersion: 1,
    assignmentId: randomUUID(),
    assignmentVersion: 1,
    workId: "lower-stack",
    workRevision: 1,
    conversationRevision: 1,
  };
  const observation = {
    repositoryId: "R1",
    nodeId: "P1",
    number: 1,
    baseRef: "main",
    headRef: branch.branch,
    headSha: head,
    baseSha: "b".repeat(40),
    state: "OPEN" as const,
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    mergeBlockers: [],
    allowedMethods: ["squash" as const],
    closedIssueNodeIds: [],
  };
  store.registerPrWithinTransaction(caller, observation, caller.assignmentId);
  const bound = store.registerPrWithinTransaction(
    { ...caller, taskId: s.taskId, workId: "own-stack" },
    {
      ...observation,
      nodeId: "P2",
      number: 2,
      headRef: own.branch,
      baseRef: branch.branch,
      stack: { id: 42, number: 9, position: 2, size: 2 },
    },
    caller.assignmentId,
  );
  const read = await s.issue("read", "stack-facts");
  const get = async (path: string) => {
    const response = await s.bearer(read.token, path);
    assert.equal(response.status, 200);
    return ((await response.json()) as { data: Json }).data;
  };
  const detail = await get(`/api/operator/tasks/${s.taskId}`);
  const list = await get("/api/operator/task-list");
  const row = list.tasks.find((task: Json) => task.id === s.taskId);
  assert.deepEqual(detail.stackDelivery, row.stackDelivery);
  assert.deepEqual(detail.stackDelivery, {
    blockerPr: { repositoryId: "R1", nodeId: "P1", number: 1 },
    membership: { id: 42, number: 9, position: 2, size: 2 },
    membershipKnown: true,
    reason: null,
  });
  const h = harness(t);
  assert.equal(
    (
      await h.run([
        "auth",
        "login",
        "--url",
        s.origin,
        "--token-file",
        h.tokenFile(read.token),
      ])
    ).code,
    0,
  );
  const cli = await h.run(["task", "get", s.taskId]);
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /Blocker PR #1/);
  assert.match(cli.out, /position 2 of 2/);
  store.recordPrReadFailure(s.taskId);
  const unknown = await get(`/api/operator/tasks/${s.taskId}`);
  assert.equal(unknown.stackDelivery.membershipKnown, false);
  assert.deepEqual(unknown.stackDelivery.membership, bound.observation.stack);
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: store.configuration(s.projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "pr.create", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  const operationId = randomUUID();
  const create = store.prepareAction(
    {
      operationId,
      action: {
        kind: "pr.create",
        target: {
          repositoryId: "R1",
          baseRef: branch.branch,
          headRef: own.branch,
          expectedHeadSha: head,
        },
        title: "Dependent",
        body: "",
        draft: false,
      },
    },
    { ...caller, taskId: s.taskId },
    false,
  );
  assert.equal(create.state, "prepared");
  store.prepareStackCreate(
    operationId,
    {
      blockerTaskId: blocker,
      repositoryId: "R1",
      blockerBranch: branch.branch,
      blockerPrNodeId: "P1",
      blockerPrNumber: 1,
      blockerHeadSha: head,
    },
    () => {},
  );
  store.beginAttempt(operationId, {});
  const receipt = { nodeId: "P2", number: 2, headSha: head };
  store.recordStackReceipt(
    operationId,
    {
      blockerTaskId: blocker,
      repositoryId: "R1",
      blockerBranch: branch.branch,
      blockerPrNodeId: "P1",
      blockerPrNumber: 1,
      dependentPrNodeId: "P2",
      dependentPrNumber: 2,
    },
    receipt,
    () => {},
  );
  store.beginStackLink(operationId, () => {}, null);
  store.recordObservation(operationId, {
    state: "confirmed-success",
    reason: "stack-link-refused-plain-chain",
    receipt,
    stack: null,
    stackLinkRefused: true,
    hostReason: "GitHub refused the stack (422)",
  });
  store.observePrWithinTransaction(s.taskId, {
    ...bound.observation,
    stack: null,
  });
  const refused = await get(`/api/operator/tasks/${s.taskId}`);
  const refusedList = await get("/api/operator/task-list");
  assert.deepEqual(
    refused.stackDelivery,
    refusedList.tasks.find((task: Json) => task.id === s.taskId).stackDelivery,
  );
  assert.equal(refused.stackDelivery.membershipKnown, true);
  assert.equal(refused.stackDelivery.membership, null);
  assert.equal(refused.stackDelivery.reason, "GitHub refused the stack (422)");
});

test("stack facts schema preserves explicit unknowns and a bounded plain-chain refusal", async () => {
  const { stackDeliveryFactsSchema, taskListSummarySchema } = await import(
    "../../src/operator/contracts.js"
  );
  const { summary } = await import("../fixtures/task-summary.js");
  const facts = stackDeliveryFactsSchema.parse({
    blockerPr: null,
    membership: null,
    membershipKnown: false,
    reason: null,
  });
  assert.equal(facts.membershipKnown, false);
  assert.equal(
    taskListSummarySchema.parse(summary()).stackDelivery,
    undefined,
    "older service shape stays compatible",
  );
  const refused = {
    ...facts,
    blockerPr: { repositoryId: "R1", nodeId: "P1", number: 1 },
    membershipKnown: true,
    reason: "GitHub refused the stack (422)",
  };
  assert.deepEqual(
    taskListSummarySchema.parse({ ...summary(), stackDelivery: refused })
      .stackDelivery,
    refused,
  );
});
