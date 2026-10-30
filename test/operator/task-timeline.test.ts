import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { taskTimelineSchema } from "../../src/operator/contracts.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { instructionSecret } from "../fixtures/instruction-history.js";
import { seedInstructionHistory } from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted structurally
type Json = Record<string, any>;

// A whole second, so a second-precision record and a millisecond one can tie exactly.
const second = 1_700_000_000;
const t0 = second * 1000;

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f, s.f.directory, 0);
  t.after(seed.cleanup);
  const read = await s.issue("read", "timeline-ro");
  const raw = (path: string) => s.bearer(read.token, path);
  const get = async (path: string, status = 200) => {
    const r = await raw(path);
    assert.equal(
      r.status,
      status,
      `${path} ${status === 200 ? await r.clone().text() : ""}`,
    );
    return ((await r.json()) as Json).data as Json;
  };
  const base = `/api/operator/tasks/${seed.taskA}/timeline`;
  const d = s.f.service.domain();
  const delegated = randomUUID();
  d.execute({
    type: "assignment.create",
    actor: "agent",
    key: randomUUID(),
    projectId: seed.projectA,
    taskId: seed.taskA,
    assignmentId: delegated,
    profileId: seed.profileId,
    brief: "Delegated work",
    resultDestination: "requester",
    requesterAssignmentId: seed.assignmentA,
  });
  const work = "work-timeline-1";
  const binding = {
    workId: work,
    taskId: seed.taskA,
    assignmentId: seed.assignmentA,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread-timeline",
    turnId: "turn-timeline",
  };
  const interactionId = randomUUID();
  const resultId = randomUUID();
  const path = `${s.f.directory}/secret-place`;
  const cwd = `${s.f.directory}/workspace-cwd`;
  let clock = t0;
  s.f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    const history = new ConversationHistoryStore(db, () => clock);
    const diagnostics = new ExecutionDiagnosticsStore(db, { now: () => clock });
    const completed = (itemId: string, text: string) =>
      history.record(
        binding,
        {
          kind: "completed",
          threadId: binding.threadId,
          turnId: binding.turnId,
          itemId,
          text,
        },
        [],
      );
    // The assistant text ties with the second-precision records below.
    completed("first", `Reading ${instructionSecret} token=hunter2`);
    clock = t0 + 5;
    history.record(
      binding,
      {
        kind: "started",
        threadId: binding.threadId,
        turnId: binding.turnId,
        itemId: "streaming",
      },
      [],
    );
    clock = t0 + 10;
    history.omitItem(binding, "too-big", "size-limit");
    clock = t0 + 20;
    history.recordEarlyBufferLimit({ ...binding, turnId: "turn-early" });

    clock = t0 + 1;
    diagnostics.begin({
      workId: work,
      taskId: seed.taskA,
      projectId: seed.projectA,
      assignmentId: seed.assignmentA,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "enhanced",
      eventSource: "supported",
    });
    const item = (
      name: string,
      itemId: string,
      payload: Record<string, unknown>,
      kind: "runtime" | "tool" | "service" | "setting" | "input" = "runtime",
    ) => diagnostics.record(work, kind, name, "info", itemId, payload, []);
    clock = t0 + 30;
    item("commandExecution/started", "cmd-1", {
      phase: "started",
      itemId: "cmd-1",
      itemType: "commandExecution",
      status: "inProgress",
      command: `cat\n  ${path}   ${instructionSecret} token=hunter2`,
      cwd,
      agentId: "agent-secret-id",
    });
    clock = t0 + 40;
    item("commandExecution/completed", "cmd-1", {
      phase: "completed",
      itemId: "cmd-1",
      itemType: "commandExecution",
      status: "completed",
      command: `cat\n  ${path}   ${instructionSecret} token=hunter2`,
      cwd,
      exitCode: 3,
      aggregatedOutput: `out ${path} ${instructionSecret} token=hunter2`,
      agentId: "agent-secret-id",
    });
    clock = t0 + 50;
    item("fileChange/completed", "fc-1", {
      phase: "completed",
      itemId: "fc-1",
      itemType: "fileChange",
      status: "completed",
      path: `${path}/file.ts`,
    });
    clock = t0 + 55;
    item("toolCall/completed", "tc-1", {
      phase: "completed",
      itemId: "tc-1",
      itemType: "toolCall",
      status: "completed",
      tool: "Read",
    });
    clock = t0 + 60;
    item("commandExecution/completed", "cmd-big", {
      phase: "completed",
      itemId: "cmd-big",
      itemType: "commandExecution",
      status: "completed",
      command: "x".repeat(5000),
    });
    clock = t0 + 61;
    for (const type of ["reasoning", "dynamicToolCall", "plan"])
      item(`${type}/completed`, `${type}-1`, {
        phase: "completed",
        itemId: `${type}-1`,
        itemType: type,
        status: "completed",
      });
    item("cab_report_result", "call-1", { arguments: { n: 1 } }, "tool");
    item("warning", "svc-1", { message: "service-row" }, "service");
    item("settings", "set-1", { entries: [] }, "setting");
    item("request", "in-1", { text: "input-row" }, "input");
    db.prepare(
      `INSERT INTO diagnostic_gaps(workId,code,count,bytes,firstAt,lastAt,maxPrunedSequence)
        VALUES (?, 'expired', 3, 10, ?, ?, 2)`,
    ).run(work, t0, t0);

    // A baseline execution of the delegated assignment.
    diagnostics.begin({
      workId: "work-timeline-2",
      taskId: seed.taskA,
      projectId: seed.projectA,
      assignmentId: delegated,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "baseline",
      eventSource: "unsupported",
    });

    db.prepare(
      "INSERT INTO coordination_delegations(assignmentId, taskId, delegatedAt) VALUES (?, ?, ?)",
    ).run(delegated, seed.taskA, t0);
    db.prepare(
      `INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,
        requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,
        conversationRevision,kind,status,prompt,revision,createdAt,updatedAt)
        VALUES (?,?,?,?,1,1,1,'question','open','Which one?',1,?,?)`,
    ).run(interactionId, seed.taskA, seed.assignmentA, work, second, second);
    db.prepare(
      `INSERT INTO coordination_results(resultId,taskId,assignmentId,workId,workRevision,
        assignmentVersion,summary,payloadHash,recipientAssignmentId,destinationDisposition,createdAt)
        VALUES (?,?,?,?,1,1,'All done',?,?,'resolved',?)`,
    ).run(
      resultId,
      seed.taskA,
      delegated,
      "work-timeline-2",
      "a".repeat(64),
      seed.assignmentA,
      second,
    );
    const event = (type: string, payload: object, createdAt: number) =>
      db
        .prepare(
          `INSERT INTO coordination_inbox_events(eventId,taskId,recipientAssignmentId,eventType,payload,createdAt)
            VALUES (?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          seed.taskA,
          seed.assignmentA,
          type,
          JSON.stringify(payload),
          createdAt,
        );
    event("operator-message", { message: "Please continue" }, second);
    event(
      "assignment-follow-up",
      { instructions: "Also check x", requester: "operator" },
      second,
    );
    // Excluded kinds: a routing fallback and a result delivery.
    event(
      "routing-fallback",
      {
        routingOperationId: randomUUID(),
        brief: "b",
        reason: "fallback",
        evidence: "e",
      },
      second,
    );
  });
  const readAll = async (limit: number) => {
    const pages: Json[] = [];
    let before: string | null = null;
    do {
      const page: Json = await get(
        `${base}?limit=${limit}${before ? `&before=${before}` : ""}`,
      );
      pages.unshift(page);
      before = page.olderCursor;
    } while (before);
    return pages.flatMap((p) => p.entries as Json[]);
  };
  return {
    s,
    seed,
    get,
    raw,
    read,
    base,
    readAll,
    delegated,
    interactionId,
    resultId,
    binding,
    path,
    cwd,
    work,
  };
}

const kinds = (entries: Json[]) => entries.map((e) => e.kind);

test("timeline pages concatenate to one total order with strictly increasing keys", async (t) => {
  const { readAll, get, base } = await setup(t);
  const whole = await get(`${base}?limit=100`);
  assert.equal(whole.olderCursor, null);
  const all = whole.entries as Json[];
  assert.ok(all.length > 12);
  taskTimelineSchema.parse({ data: whole, observedAt: 0 });
  for (const limit of [1, 2, 3, 7]) {
    const paged = await readAll(limit);
    assert.deepEqual(
      paged.map((e) => e.key),
      all.map((e) => e.key),
      `limit ${limit}`,
    );
  }
  const ids = all.map((e) => e.entryId);
  assert.equal(new Set(ids).size, ids.length);
  const keys = all.map((e) => e.key as string);
  assert.deepEqual(keys, [...keys].sort(compareKeys));
});

function compareKeys(a: string, b: string): number {
  const [x, y] = [a, b].map((k) => k.split("."));
  for (let i = 0; i < 3; i++) {
    const d = Number(x?.[i]) - Number(y?.[i]);
    if (d) return d;
  }
  return (x?.[3] ?? "") < (y?.[3] ?? "") ? -1 : 1;
}

test("same-instant records order by fixed kind order", async (t) => {
  const { readAll } = await setup(t);
  const tied = (await readAll(100)).filter((e) => e.at === t0);
  assert.deepEqual(kinds(tied), [
    "delegation",
    "assistant",
    "request",
    "result",
    "message",
    "message",
  ]);
  assert.deepEqual(
    tied.map((e) => e.precision),
    ["ms", "ms", "s", "s", "s", "s"],
  );
  // Two records of one kind and second keep the order they were stored in.
  assert.deepEqual(
    tied.filter((e) => e.kind === "message").map((e) => e.messageKind),
    ["operator-message", "follow-up"],
  );
});

test("entries keep their keys when content changes or newer records arrive", async (t) => {
  const ctx = await setup(t);
  const before = await ctx.readAll(100);
  const streaming = before.find((e) => e.lifecycle === "started");
  assert.ok(streaming);
  ctx.s.f.seedPersistedState((db) => {
    const history = new ConversationHistoryStore(db, () => t0 + 100_000);
    history.record(
      ctx.binding,
      {
        kind: "completed",
        threadId: ctx.binding.threadId,
        turnId: ctx.binding.turnId,
        itemId: "streaming",
        text: "Finished now",
      },
      [],
    );
    db.prepare(
      `INSERT INTO coordination_inbox_events(eventId,taskId,recipientAssignmentId,eventType,payload,createdAt)
        VALUES (?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      ctx.seed.taskA,
      ctx.seed.assignmentA,
      "operator-message",
      JSON.stringify({ message: "A later message" }),
      second + 200,
    );
  });
  const after = await ctx.readAll(100);
  assert.equal(after.length, before.length + 1);
  const finished = after.find((e) => e.entryId === streaming.entryId);
  assert.equal(finished?.key, streaming.key);
  assert.equal(finished?.lifecycle, "completed");
  assert.equal(finished?.text, "Finished now");
  assert.deepEqual(
    after.filter((e) => e.entryId !== after.at(-1)?.entryId).map((e) => e.key),
    before.map((e) => e.key),
  );
  assert.equal(after.at(-1)?.text, "A later message");
});

test("only the curated tool projection crosses the boundary", async (t) => {
  const ctx = await setup(t);
  const entries = await ctx.readAll(100);
  const text = JSON.stringify(entries);
  for (const forbidden of [
    ctx.cwd,
    ctx.path,
    ctx.s.f.directory,
    "cwd",
    "severity",
    "agentId",
    "agent-secret-id",
    "service-row",
    "input-row",
    "cab_report_result",
    "reasoning",
    "dynamicToolCall",
    instructionSecret,
    "hunter2",
  ])
    assert.equal(text.includes(forbidden), false, forbidden);
  const tools = entries.filter((e) => e.kind === "tool");
  assert.deepEqual(
    tools.map((e) => [e.tool, e.label]),
    [
      ["command", null],
      ["file-change", null],
      ["other", "Read"],
    ],
  );
  const command = tools[0];
  assert.match(command?.command ?? "", /^cat \[redacted\]/);
  assert.equal(command?.command.includes("\n"), false);
  assert.equal(command?.exitCode, 3);
  assert.equal(command?.status, "completed");
  assert.ok(command?.outputSequence > 0);
  assert.equal(tools[1]?.command, null);
  // A leaf past the command bound is a gap with the reason, never text.
  const big = entries.find(
    (e) => e.kind === "gap" && e.detail.itemId === "cmd-big",
  );
  assert.equal(big?.reason, "size-limit");
  // Every key set is exactly the declared one: the strict schema already rejects extras.
  assert.deepEqual(
    [...new Set(entries.map((e) => e.kind))].sort(),
    [
      "assistant",
      "delegation",
      "gap",
      "message",
      "request",
      "result",
      "tool",
    ].sort(),
  );
});

test("gaps report omitted items, expired and uncaptured tool activity", async (t) => {
  const { readAll, delegated } = await setup(t);
  const gaps = (await readAll(100)).filter((e) => e.kind === "gap");
  const reasons = gaps.map((g) => g.reason).sort();
  assert.deepEqual(reasons, [
    "early-buffer-limit",
    "size-limit",
    "size-limit",
    "tool-activity-expired",
    "tool-activity-not-captured",
  ]);
  const uncaptured = gaps.find(
    (g) => g.reason === "tool-activity-not-captured",
  );
  assert.equal(uncaptured?.assignmentId, delegated);
  assert.equal(uncaptured?.detail.workId, "work-timeline-2");
  assert.equal(uncaptured?.entryId.includes("work-timeline-2"), false);
});

test("delegation entries carry assignment, profile, harness and state", async (t) => {
  const { readAll, delegated, seed } = await setup(t);
  const delegation = (await readAll(100)).find((e) => e.kind === "delegation");
  assert.equal(delegation?.assignmentId, delegated);
  assert.equal(delegation?.requesterAssignmentId, seed.assignmentA);
  assert.equal(delegation?.profileId, seed.profileId);
  assert.equal(delegation?.name, "Shared lead");
  assert.equal(delegation?.runtime.harness, "codex");
  assert.equal(delegation?.state, "pending");
  assert.equal(delegation?.at, t0);
});

test("unavailable redaction yields gaps with no text", async (t) => {
  const ctx = await setup(t);
  const api = new OperatorApi(ctx.s.f.service, [ctx.s.f.directory]);
  (api as unknown as { exclusions: () => Promise<undefined> }).exclusions =
    async () => undefined;
  const { data } = await api.readTaskTimeline(
    ctx.seed.taskA,
    new URLSearchParams("limit=100"),
  );
  const text = JSON.stringify(data.entries);
  assert.equal(text.includes("hunter2"), false);
  assert.equal(text.includes(ctx.path), false);
  const unavailable = data.entries.filter(
    (e) => e.kind === "gap" && e.reason === "redaction-unavailable",
  );
  // The completed assistant item and the two command/file rows that carry text.
  assert.ok(unavailable.length >= 3);
  assert.equal(
    data.entries.some((e) => e.kind === "assistant" && e.text !== null),
    false,
  );
  assert.equal(
    data.entries.some((e) => e.kind === "tool" && e.command !== null),
    false,
  );
  const command = (
    await new OperatorApi(ctx.s.f.service, [
      ctx.s.f.directory,
    ]).readTaskTimeline(ctx.seed.taskA, new URLSearchParams("limit=100"))
  ).data.entries.find((e) => e.kind === "tool" && e.tool === "command");
  assert.ok(command?.kind === "tool" && command.outputSequence);
  const output = await api.readTaskToolOutput(
    ctx.seed.taskA,
    command.outputSequence,
  );
  assert.deepEqual(
    [output.data.state, output.data.reason, output.data.text],
    ["omitted", "redaction-unavailable", null],
  );
});

test("invalid queries are rejected and reads need only the read scope", async (t) => {
  const { raw, base, s } = await setup(t);
  for (const bad of [
    "?before=nope",
    "?before=1.2.3",
    "?before=1.2.3.a.b",
    "?limit=0",
    "?limit=101",
    "?limit=1&limit=2",
    "?x=1",
  ])
    assert.equal((await raw(`${base}${bad}`)).status, 400, bad);
  assert.equal(operatorRouteAuthority("GET", base), "read");
  assert.equal(operatorRouteAuthority("GET", `${base}/output/12`), "read");
  assert.equal(operatorRouteAuthority("POST", base), undefined);
  assert.equal(
    (await raw(`/api/operator/tasks/${randomUUID()}/timeline`)).status,
    404,
  );
  void s;
});

test("tool output is bounded, redacted and limited to the task's own commands", async (t) => {
  const ctx = await setup(t);
  const command = (await ctx.readAll(100)).find((e) => e.kind === "tool");
  assert.ok(command);
  const output = await ctx.get(`${ctx.base}/output/${command.outputSequence}`);
  assert.equal(output.state, "available");
  assert.match(output.text, /^out \[redacted\]/);
  assert.equal(output.text.includes("hunter2"), false);
  assert.equal(output.text.includes(instructionSecret), false);
  assert.equal(output.text.includes(ctx.path), false);
  // A started row, a file change, an unknown sequence and another task's work are all 404.
  const sequences = ctx.s.f.service
    .executionDiagnostics()
    ?.events(ctx.work, {}).items;
  assert.ok(sequences);
  for (const row of sequences.filter(
    (i) => i.name !== "commandExecution/completed",
  ))
    await ctx.get(`${ctx.base}/output/${row.sequence}`, 404);
  await ctx.get(`${ctx.base}/output/999999`, 404);
  await ctx.get(`${ctx.base}/output/${command.outputSequence}?x=1`, 400);
  await ctx.get(
    `/api/operator/tasks/${ctx.seed.taskB}/timeline/output/${command.outputSequence}`,
    404,
  );
  // An oversized stored output is a reasoned omission.
  ctx.s.f.seedPersistedState((db) => {
    new ExecutionDiagnosticsStore(db).record(
      ctx.work,
      "runtime",
      "commandExecution/completed",
      "info",
      "cmd-out-big",
      {
        itemType: "commandExecution",
        command: "ls",
        aggregatedOutput: "y".repeat(50 * 1024),
      },
      [],
    );
  });
  const big = (await ctx.readAll(100)).find(
    (e) => e.kind === "tool" && e.command === "ls",
  );
  const omitted = await ctx.get(`${ctx.base}/output/${big?.outputSequence}`);
  assert.deepEqual(
    [omitted.state, omitted.reason, omitted.text],
    ["omitted", "size-limit", null],
  );
});
