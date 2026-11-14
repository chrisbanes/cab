import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { taskTimelineSchema } from "../../src/operator/contracts.js";
import { normalizePlan } from "../../src/standalone/agent-plan.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { projectTool } from "../../src/standalone/task-timeline.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { instructionSecret } from "../fixtures/instruction-history.js";
import { seedInstructionHistory } from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { DeletedProjectRedactionStore } from "../../src/core/deleted-project-redaction.js";

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
    clock = t0 + 7;
    completed("long", "z".repeat(20_000));
    clock = t0 + 10;
    history.omitItem(binding, "too-big", "size-limit");
    clock = t0 + 20;
    history.recordEarlyBufferLimit({ ...binding, turnId: "turn-early" });
    // Stored with no exclusions, so only the read's redaction protects the step.
    const plan = (done: number, text: string) => {
      const steps = [
        { text: "Read the files", status: done > 0 ? "completed" : "pending" },
        { text, status: done > 1 ? "completed" : "in_progress" },
      ];
      const normalized = normalizePlan(steps);
      assert.ok(normalized);
      return normalized;
    };
    clock = t0 + 30;
    history.recordPlan(binding, plan(1, "Write it"), []);
    clock = t0 + 40;
    history.recordPlan(binding, plan(2, `Check ${instructionSecret}`), []);
    clock = t0 + 50;
    history.recordPlan(
      { ...binding, workId: "work-delegated", assignmentId: delegated },
      plan(0, "Delegated step"),
      [],
    );

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
      observedAt: t0 + 2040,
    });
    clock = t0 + 50;
    item("fileChange/completed", "fc-1", {
      phase: "completed",
      itemId: "fc-1",
      itemType: "fileChange",
      status: "completed",
      path: `${path}/file.ts`,
      paths: [
        "src/a.ts",
        "outside workspace",
        `token=hunter2 ${instructionSecret}`,
      ],
      pathsTruncated: true,
    });
    clock = t0 + 55;
    item("toolCall/completed", "tc-1", {
      phase: "completed",
      itemId: "tc-1",
      itemType: "toolCall",
      status: "completed",
      tool: "Read",
      target: "src/a.ts",
    });
    // Rows from every allowlisted tool, plus defence cases the capture never writes.
    const toolRow = (id: string, itemType: string, extra: object) => {
      clock += 1;
      item(`${itemType}/completed`, id, {
        phase: "completed",
        itemId: id,
        itemType,
        status: "completed",
        ...extra,
      });
    };
    toolRow("tc-grep", "toolCall", { tool: "Grep", target: "g".repeat(200) });
    toolRow("tc-glob", "toolCall", {
      tool: "Glob",
      target: `**/${instructionSecret} token=hunter2`,
    });
    toolRow("tc-agent", "toolCall", { tool: "Agent", target: "explore" });
    toolRow("tc-unknown", "toolCall", { tool: "Skill" });
    toolRow("tc-abs", "toolCall", { tool: "Read", target: "/abs/leak.ts" });
    toolRow("ws-1", "webSearch", { target: "how to x" });
    toolRow("mcp-1", "mcpToolCall", { target: "kb/search" });
    toolRow("fc-abs", "fileChange", {
      paths: ["/abs/leak.ts", "../up.ts", "ok.ts", "ok.ts", "a".repeat(257)],
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
      "INSERT INTO coordination_delegations(assignmentId, delegatedAt) VALUES (?, ?)",
    ).run(delegated, t0);
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

function storedSummary(
  ctx: Awaited<ReturnType<typeof setup>>,
  options: {
    workId?: string;
    text?: string;
    items?: string[];
    omitted?: boolean;
    at?: number;
  } = {},
) {
  const binding = {
    ...ctx.binding,
    workId: options.workId ?? randomUUID(),
    turnId: randomUUID(),
  };
  const intentId = randomUUID();
  ctx.s.f.seedPersistedState((db) => {
    binding.workRevision = Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(workRevision),0)+1 AS revision FROM task_work_revisions WHERE assignmentId=? AND conversationRevision=1",
        )
        .get(binding.assignmentId)!.revision,
    );
    db.prepare(`INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval)
      VALUES (?,?,'fixture',?,'completed',?,?,'chatgpt','workspaceWrite','never')`).run(
      intentId,
      binding.workId,
      ctx.s.f.directory,
      binding.threadId,
      binding.turnId,
    );
    db.prepare(`INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,harness)
      VALUES (?,?,?,1,1,1,1,'claude')`).run(
      binding.workId,
      binding.taskId,
      binding.assignmentId,
    );
    db.prepare(
      `INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES (?,?,1,?)`,
    ).run(binding.workId, binding.assignmentId, binding.workRevision);
    db.prepare(
      `INSERT INTO execution_intent_reasoning_summaries(intentId,enabled,captureMode,generation) VALUES (?,1,'enhanced',0)`,
    ).run(intentId);
    const history = new ConversationHistoryStore(
      db,
      () => options.at ?? t0 + 1,
    );
    for (const [index, text] of (options.items ?? []).entries())
      history.record(
        binding,
        {
          kind: "completed",
          threadId: binding.threadId,
          turnId: binding.turnId,
          itemId: `summary-item-${index}`,
          text,
        },
        [],
      );
    if (options.omitted)
      history.omitItem(binding, "omitted-summary-item", "size-limit");
    history.recordReasoningSummary(
      binding,
      intentId,
      options.text ?? "Bound summary",
      [],
    );
  });
  return { binding, intentId };
}

test("exact-turn summaries anchor once across pages, including summary-only tied keys and omissions", async (t) => {
  const ctx = await setup(t);
  const original = await ctx.readAll(100);
  const first = storedSummary(ctx, {
    text: "FIRST_SUMMARY",
    items: ["first text", "second text"],
  });
  storedSummary(ctx, { text: "SECOND_SUMMARY", items: ["another turn"] });
  storedSummary(ctx, { text: "ONLY_SUMMARY" });
  storedSummary(ctx, { text: "OMITTED_SUMMARY", omitted: true });
  storedSummary(ctx, { text: "😀".repeat(16_001) });
  const digest = databaseDigest(ctx.s.f);
  const whole = await ctx.readAll(100);
  assert.equal(databaseDigest(ctx.s.f), digest);
  const summaries = whole.filter((entry) => entry.reasoningSummary);
  assert.equal(summaries.length, 5);
  assert.equal(
    summaries.find((e) => e.workId === first.binding.workId)?.text,
    "first text",
  );
  assert.equal(
    whole.find((e) => e.text === "second text")?.reasoningSummary,
    undefined,
  );
  assert.equal(
    summaries.find((e) => e.reasoningSummary.text === "ONLY_SUMMARY")?.text,
    null,
  );
  assert.ok(whole.some((e) => e.kind === "gap" && e.reason === "size-limit"));
  const unicode = summaries.find((e) => e.reasoningSummary.truncated);
  assert.equal(unicode?.reasoningSummary.text, "😀".repeat(16_000));
  assert.equal(new Set(summaries.map((e) => e.turnKey)).size, 5);
  for (const limit of [1, 2, 100])
    assert.deepEqual(
      (await ctx.readAll(limit)).map((e) => e.key),
      whole.map((e) => e.key),
      `limit ${limit}`,
    );
  for (const old of original)
    assert.equal(whole.find((e) => e.entryId === old.entryId)?.key, old.key);
  // Stored creation time, not updatedAt or today's conversation, owns fallback identity.
  ctx.s.f.seedPersistedState((db) => {
    db.exec(
      "UPDATE conversation_reasoning_summaries SET updatedAt=updatedAt+999999",
    );
    db.prepare(
      "UPDATE assignment_conversations SET revision=revision+1 WHERE assignmentId=?",
    ).run(ctx.seed.assignmentA);
  });
  assert.deepEqual(
    (await ctx.readAll(100))
      .filter((e) => e.reasoningSummary)
      .map((e) => e.key),
    summaries.map((e) => e.key),
  );
});

test("summary lookup uses bounded indexed task identities rather than scanning installation history", async (t) => {
  const ctx = await setup(t);
  const { binding } = storedSummary(ctx);
  const before = await ctx.get(
    `${ctx.base}?limit=1&reasoningSummaryRevision=unknown`,
  );
  ctx.s.f.seedPersistedState((db) => {
    const prepare = db.prepare.bind(db);
    const queries: string[] = [];
    db.prepare = (sql) => {
      if (
        sql.includes("FROM task_execution_bindings WHERE taskId") ||
        sql.includes("FROM conversation_reasoning_summaries s")
      )
        queries.push(sql);
      return prepare(sql);
    };
    const store = new ConversationHistoryStore(db);
    assert.equal(store.reasoningSummaryTurns(ctx.seed.taskA).length, 1);
    assert.equal(queries.length, 2);
    const plans = queries.flatMap((sql, index) =>
      prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(
          ...(index === 0
            ? [ctx.seed.taskA]
            : [binding.workId, ctx.seed.taskA]),
        )
        .map((row) => String(row.detail)),
    );
    assert.equal(
      plans.some((step) => /SCAN (s|task_execution_bindings)\b/.test(step)),
      false,
      plans.join("\n"),
    );
    assert.ok(
      plans.some(
        (step) =>
          step.includes("SEARCH") &&
          step.includes("task_execution_bindings_task"),
      ),
    );
    assert.ok(
      plans.some(
        (step) =>
          step.includes("SEARCH") &&
          step.includes("sqlite_autoindex_conversation_reasoning_summaries_1"),
      ),
    );
    // More retained work than the existing privacy bound refuses before a summary lookup.
    for (let index = 0; index < 129; index++) {
      const workId = randomUUID();
      prepare(`INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval)
        SELECT ?,?,prompt,workspace,state,NULL,NULL,accountType,sandbox,approval FROM execution_intents WHERE workId=?`).run(
        randomUUID(),
        workId,
        binding.workId,
      );
      prepare(`INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,harness)
        VALUES (?,?,?,1,1,1,1,'claude')`).run(
        workId,
        ctx.seed.taskA,
        ctx.seed.assignmentA,
      );
    }
    queries.length = 0;
    assert.deepEqual(store.reasoningSummaryTurns(ctx.seed.taskA), []);
    assert.equal(
      queries.some((sql) =>
        sql.includes("FROM conversation_reasoning_summaries"),
      ),
      false,
    );
  });
  const refused = await ctx.get(
    `${ctx.base}?limit=1&reasoningSummaryRevision=${before.reasoningSummaryRevision}`,
  );
  assert.notEqual(
    refused.reasoningSummaryRevision,
    before.reasoningSummaryRevision,
  );
  assert.deepEqual(refused.reasoningSummaryAnchors, []);
});

test("summary contracts are optional, strict and bounded by Unicode characters and bytes", async (t) => {
  const ctx = await setup(t);
  storedSummary(ctx, { items: ["plain text"] });
  const whole = await ctx.get(`${ctx.base}?limit=100`);
  const index = whole.entries.findIndex((e: Json) => e.reasoningSummary);
  const check = (reasoningSummary: unknown) =>
    taskTimelineSchema.safeParse({
      data: {
        ...whole,
        entries: [{ ...whole.entries[index], reasoningSummary }],
      },
      observedAt: 1,
    }).success;
  assert.equal(check(undefined), true);
  assert.equal(check({ text: "😀".repeat(16_000), truncated: false }), true);
  for (const invalid of [
    null,
    { text: "", truncated: false },
    { text: "x".repeat(16_001), truncated: true },
    { text: "😀".repeat(16_001), truncated: true },
    { text: "x", truncated: 1 },
    { text: "x", truncated: false, raw: "no" },
  ])
    assert.equal(check(invalid), false);
});

test("summary reads reject every inconsistent binding, admission, ownership and ambiguous provider identity", async (t) => {
  const ctx = await setup(t);
  const { binding, intentId } = storedSummary(ctx, { items: ["ordinary"] });
  const service = ctx.s.f.service;
  assert.equal(service.reasoningSummaryFor(binding, [])?.text, "Bound summary");
  for (const [key, value] of Object.entries(binding)) {
    const changed = {
      ...binding,
      [key]: typeof value === "number" ? value + 1 : `${value}-wrong`,
    };
    assert.equal(service.reasoningSummaryFor(changed, []), undefined, key);
  }
  assert.equal(service.reasoningSummaryFor(binding, undefined), undefined);
  const mutations = [
    ["conversation_reasoning_summaries", "intentId", randomUUID()],
    ["conversation_reasoning_summaries", "projectId", ctx.seed.projectB],
    ["conversation_reasoning_summaries", "text", "x".repeat(16_001)],
    ["conversation_reasoning_summaries", "truncated", 2],
    ["conversation_reasoning_summaries", "generation", 1],
    ["execution_intent_reasoning_summaries", "enabled", 0],
    ["execution_intent_reasoning_summaries", "captureMode", "baseline"],
    ["task_execution_bindings", "harness", "codex"],
  ] as const;
  for (const [table, column, value] of mutations) {
    ctx.s.f.seedPersistedState((db) => {
      db.exec("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF");
      const where =
        table === "execution_intent_reasoning_summaries"
          ? "intentId"
          : "workId";
      const id = where === "intentId" ? intentId : binding.workId;
      const old = db
        .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}=?`)
        .get(id)!.value;
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}=?`).run(
        value,
        id,
      );
      assert.equal(
        service.reasoningSummaryFor(binding, []),
        undefined,
        `${table}.${column}`,
      );
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}=?`).run(
        old!,
        id,
      );
    });
  }
  ctx.s.f.seedPersistedState((db) => {
    db.prepare(`INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval)
      SELECT ?,? ,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval FROM execution_intents WHERE id=?`).run(
      randomUUID(),
      randomUUID(),
      intentId,
    );
  });
  assert.equal(service.reasoningSummaryFor(binding, []), undefined);
  assert.equal(
    (await ctx.readAll(100)).some((e) => e.reasoningSummary),
    false,
  );
});

test("summary projection re-redacts and confirmed erasure invalidates the retained window without changing assistant text", async (t) => {
  const ctx = await setup(t);
  const { binding } = storedSummary(ctx, {
    text: `READ_CANARY ${instructionSecret} ${ctx.s.f.directory} token=hunter2`,
    items: ["ordinary survives"],
  });
  const before = await ctx.get(`${ctx.base}?limit=100`);
  const summary = before.entries.find((e: Json) => e.reasoningSummary)
    .reasoningSummary.text;
  assert.match(summary, /READ_CANARY/);
  assert.doesNotMatch(
    summary,
    new RegExp(`${instructionSecret}|hunter2|${ctx.s.f.directory}`),
  );
  const api = new OperatorApi(ctx.s.f.service, [ctx.s.f.directory]);
  const seam = api as unknown as {
    exclusions: (...args: unknown[]) => Promise<readonly string[] | undefined>;
  };
  const original = seam.exclusions.bind(api);
  seam.exclusions = async () => undefined;
  assert.equal(
    (
      await api.readTaskTimeline(ctx.seed.taskA, new URLSearchParams())
    ).data.entries.some((e) => e.kind === "assistant" && e.reasoningSummary),
    false,
  );
  seam.exclusions = original;
  const deletion = {
    type: "project.reasoning.delete",
    actor: "operator",
    key: randomUUID(),
    projectId: ctx.seed.projectA,
    expectedVersion: Number(
      ctx.s.f.service.domain().project(ctx.seed.projectA).version,
    ),
    confirmed: true,
  };
  let erased = false;
  seam.exclusions = async (...args) => {
    const excluded = await original(...args);
    if (!erased) {
      erased = true;
      ctx.s.f.service.domain().execute(deletion as never);
    }
    return excluded;
  };
  const after = await api.readTaskTimeline(
    ctx.seed.taskA,
    new URLSearchParams(),
  );
  assert.equal(
    after.data.entries.some(
      (e) => e.kind === "assistant" && e.reasoningSummary,
    ),
    false,
  );
  assert.notEqual(after.data.visibilityRevision, before.visibilityRevision);
  const removed = await api.readTaskTimeline(
    ctx.seed.taskA,
    new URLSearchParams({
      limit: "1",
      reasoningSummaryRevision: before.reasoningSummaryRevision,
    }),
  );
  assert.deepEqual(removed.data.reasoningSummaryAnchors, []);
  assert.notEqual(
    removed.data.reasoningSummaryRevision,
    before.reasoningSummaryRevision,
  );
  assert.ok(
    after.data.entries.some(
      (e) => e.kind === "assistant" && e.text === "ordinary survives",
    ),
  );
  ctx.s.f.service.domain().execute(deletion as never);
  assert.equal(ctx.s.f.service.reasoningSummaryFor(binding, []), undefined);
  const fresh = new OperatorApi(ctx.s.f.service, [ctx.s.f.directory]);
  assert.equal(
    (
      await fresh.readTaskTimeline(ctx.seed.taskA, new URLSearchParams())
    ).data.entries.some((e) => e.kind === "assistant" && e.reasoningSummary),
    false,
  );
});

test("summary reads fence late instruction and credential changes and include deleted-project exclusions", async (t) => {
  const ctx = await setup(t);
  const { binding } = storedSummary(ctx, {
    text: "CURRENT_LATE_CANARY DELETED_LATE_CANARY ROTATED_LATE_CANARY",
  });
  ctx.s.f.seedPersistedState((db) => {
    db.exec("BEGIN");
    new DeletedProjectRedactionStore(db).capture([], ["DELETED_LATE_CANARY"]);
    db.exec("COMMIT");
  });
  const api = new OperatorApi(ctx.s.f.service, [ctx.s.f.directory]);
  const seam = api as unknown as {
    exclusions: (...args: unknown[]) => Promise<readonly string[] | undefined>;
  };
  const original = seam.exclusions.bind(api);
  let changed = false;
  const isSummaryRead = (args: unknown[]) =>
    Array.isArray(args[2]) &&
    args[2].some(
      (value: { workId?: string }) => value.workId === binding.workId,
    );
  seam.exclusions = async (...args) => {
    const excluded = await original(...args);
    if (!changed && isSummaryRead(args)) {
      changed = true;
      const domain = ctx.s.f.service.domain();
      domain.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: ctx.seed.projectA,
        expectedVersion: Number(
          ctx.s.f.service.domain().project(ctx.seed.projectA).version,
        ),
        instructions: "CURRENT_LATE_CANARY",
      } as never);
    }
    return excluded;
  };
  const read = await api.readTaskTimeline(
    ctx.seed.taskA,
    new URLSearchParams(),
  );
  assert.equal(changed, true);
  assert.doesNotMatch(
    JSON.stringify(read),
    /CURRENT_LATE_CANARY|DELETED_LATE_CANARY/,
  );
  assert.match(JSON.stringify(read), /ROTATED_LATE_CANARY/);
  const env = "CLI2_SYNTHETIC_ROUTING";
  const old = process.env[env];
  changed = false;
  seam.exclusions = async (...args) => {
    const excluded = await original(...args);
    if (!changed && isSummaryRead(args)) {
      changed = true;
      process.env[env] = "ROTATED_LATE_CANARY";
    }
    return excluded;
  };
  try {
    await assert.rejects(
      api.readTaskTimeline(ctx.seed.taskA, new URLSearchParams()),
      (error: unknown) => (error as { status?: number }).status === 503,
    );
  } finally {
    if (old === undefined) delete process.env[env];
    else process.env[env] = old;
  }
  seam.exclusions = async () => {
    throw new Error("exclusions unavailable");
  };
  await assert.rejects(
    api.readTaskTimeline(ctx.seed.taskA, new URLSearchParams()),
    /exclusions unavailable/,
  );
});

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
  // Captured text past the 16,000-character field limit still reads, as in the history read.
  assert.equal(
    all.find((e) => e.kind === "assistant" && e.text?.startsWith("zzz"))?.text
      .length,
    20_000,
  );
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
    tools.map((e) => [e.tool, e.label, e.target]),
    [
      ["command", null, null],
      ["file-change", null, null],
      ["other", "Read", "src/a.ts"],
      ["other", "Grep", `${"g".repeat(127)}…`],
      ["other", "Glob", "**/[redacted] token=[redacted]"],
      ["other", "Agent", "explore"],
      ["other", "Skill", null],
      ["other", "Read", "outside workspace"],
      ["other", "webSearch", "how to x"],
      ["other", "mcpToolCall", "kb/search"],
      ["file-change", null, null],
    ],
  );
  // A completed row gives the end time; one without observedAt reads as unfinished.
  assert.equal(tools[0]?.endedAt, t0 + 2040);
  assert.equal(tools[2]?.endedAt, null);
  assert.deepEqual(tools[1]?.paths, [
    "src/a.ts",
    "outside workspace",
    "token=[redacted] [redacted]",
  ]);
  assert.equal(tools[1]?.pathsTruncated, true);
  assert.deepEqual(tools[10]?.paths, ["outside workspace", "ok.ts"]);
  assert.equal(tools[10]?.pathsTruncated, true);
  assert.deepEqual(tools[0]?.paths, []);
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
      "plan",
      "request",
      "result",
      "tool",
    ].sort(),
  );
});

test("a tool row captured before durations, paths and targets projects empty values", () => {
  const first = {
    sequence: 1,
    workId: "w",
    kind: "runtime" as const,
    name: "toolCall/completed",
    severity: "info",
    itemId: "t",
    state: "available" as const,
    reason: null,
    payload: { itemType: "toolCall", tool: "Read", status: "completed" },
    payloadBytes: 1,
    originalBytes: 1,
    createdAt: 1,
  };
  const projected = projectTool(first, undefined, []);
  assert.ok(projected.kind === "tool");
  assert.deepEqual(
    [
      projected.endedAt,
      projected.paths,
      projected.pathsTruncated,
      projected.target,
    ],
    [null, [], false, null],
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

test("plan changes are timeline entries and the latest plans are re-redacted", async (t) => {
  const { get, base, readAll, seed, delegated } = await setup(t);
  const whole = await get(`${base}?limit=100`);
  taskTimelineSchema.parse({ data: whole, observedAt: 0 });
  const plans = (whole.entries as Json[]).filter((e) => e.kind === "plan");
  assert.deepEqual(
    plans.map((e) => [e.assignmentId, e.done, e.total, e.at]),
    [
      [seed.assignmentA, 1, 2, t0 + 30],
      [seed.assignmentA, 2, 2, t0 + 40],
      [delegated, 0, 2, t0 + 50],
    ],
  );
  // Change entries carry counts only; steps live in the latest plans.
  assert.ok(plans.every((e) => !("steps" in e)));
  assert.deepEqual(
    (await readAll(1)).filter((e) => e.kind === "plan").map((e) => e.key),
    plans.map((e) => e.key),
  );
  assert.deepEqual(whole.plans, [
    {
      assignmentId: seed.assignmentA,
      updatedAt: t0 + 40,
      done: 2,
      total: 2,
      omittedStepCount: 0,
      steps: [
        { text: "Read the files", status: "done" },
        { text: "Check [redacted]", status: "done" },
      ],
      omissionReason: null,
    },
    {
      assignmentId: delegated,
      updatedAt: t0 + 50,
      done: 0,
      total: 2,
      omittedStepCount: 0,
      steps: [
        { text: "Read the files", status: "pending" },
        { text: "Delegated step", status: "in-progress" },
      ],
      omissionReason: null,
    },
  ]);
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
  assert.ok(data.plans.length > 0);
  for (const plan of data.plans) {
    assert.equal(plan.steps, null);
    assert.equal(plan.omissionReason, "redaction-unavailable");
  }
  assert.equal(JSON.stringify(data.plans).includes(instructionSecret), false);
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

test("collapsing a command's whitespace cannot assemble an excluded value", () => {
  const row = (command: string) => ({
    sequence: 1,
    workId: "w",
    kind: "runtime" as const,
    name: "commandExecution/completed",
    severity: "info",
    itemId: "c",
    state: "available" as const,
    reason: null,
    payload: { itemType: "commandExecution", command, cwd: "/leak" },
    payloadBytes: 1,
    originalBytes: 1,
    createdAt: 1,
  });
  const projected = projectTool(row("run  two\nwords now"), undefined, [
    "two words",
  ]);
  assert.equal(projected.kind, "tool");
  assert.equal(
    projected.kind === "tool" ? projected.command : null,
    "run [redacted] now",
  );
});

test("a target is redacted before it is cut, and coordination tools get none", () => {
  const row = (payload: object) => ({
    sequence: 1,
    workId: "w",
    kind: "runtime" as const,
    name: "toolCall/completed",
    severity: "info",
    itemId: "t",
    state: "available" as const,
    reason: null,
    payload: { itemType: "toolCall", ...payload },
    payloadBytes: 1,
    originalBytes: 1,
    createdAt: 1,
  });
  const target = (payload: object, excluded: string[] = []) => {
    const projected = projectTool(row(payload), undefined, excluded);
    return projected.kind === "tool" ? projected.target : "gap";
  };
  const secret = "s3cretvalue";
  // The secret straddles the cut; cutting first would leave part of it.
  const long = `${"a".repeat(120)}${secret}tail`;
  const cut = target({ tool: "Grep", target: long }, [secret]);
  assert.equal(cut, `${"a".repeat(120)}[redacted]tail`.slice(0, 127) + "…");
  assert.equal(target({ tool: "cab_report_result", target: "x" }), null);
  assert.equal(target({ tool: "mcp__cab__x", target: "x" }), null);
});

test("timeline summary snapshots are content-stable and conditional outside the ordinary page", async (t) => {
  const ctx = await setup(t);
  const first = storedSummary(ctx, {
    text: "snapshot first",
    items: ["old canonical"],
    at: t0 - 100000,
  });
  storedSummary(ctx, { text: "snapshot only", at: t0 - 90000 });
  const cold = await ctx.get(`${ctx.base}?limit=1`);
  assert.match(cold.reasoningSummaryRevision, /^[a-f0-9]{64}$/);
  assert.equal(cold.reasoningSummaryAnchors, undefined);
  const conditional = (revision: string) =>
    ctx.get(`${ctx.base}?limit=1&reasoningSummaryRevision=${revision}`);
  assert.equal(
    (await conditional(cold.reasoningSummaryRevision)).reasoningSummaryAnchors,
    undefined,
  );
  const snapshot = await conditional("unknown");
  assert.equal(
    snapshot.reasoningSummaryRevision,
    cold.reasoningSummaryRevision,
  );
  assert.equal(snapshot.reasoningSummaryAnchors.length, 2);
  assert.equal(
    new Set(snapshot.reasoningSummaryAnchors.map((a: Json) => a.entryId)).size,
    2,
  );
  assert.equal(
    snapshot.reasoningSummaryAnchors.some((a: Json) =>
      cold.entries.some((e: Json) => e.entryId === a.entryId),
    ),
    false,
  );
  let cursor = cold.olderCursor;
  while (cursor) {
    const older = await ctx.get(`${ctx.base}?limit=1&before=${cursor}`);
    assert.equal(older.reasoningSummaryRevision, cold.reasoningSummaryRevision);
    assert.equal(older.reasoningSummaryAnchors, undefined);
    cursor = older.olderCursor;
  }
  const wide = await ctx.get(
    `${ctx.base}?limit=100&reasoningSummaryRevision=unknown`,
  );
  assert.equal(wide.reasoningSummaryRevision, cold.reasoningSummaryRevision);
  assert.equal(wide.reasoningSummaryAnchors.length, 0);
  const union = [
    ...wide.reasoningSummaryAnchors,
    ...wide.entries.filter((e: Json) => e.reasoningSummary),
  ];
  assert.equal(union.length, 2);
  const tuples = union
    .map((entry: Json) => [
      entry.entryId,
      entry.turnKey,
      entry.reasoningSummary.text,
      entry.reasoningSummary.truncated,
    ])
    .sort((a: Json[], b: Json[]) =>
      a[0]! < b[0]!
        ? -1
        : a[0]! > b[0]!
          ? 1
          : a[1]! < b[1]!
            ? -1
            : a[1]! > b[1]!
              ? 1
              : 0,
    );
  assert.equal(
    wide.reasoningSummaryRevision,
    createHash("sha256")
      .update(
        JSON.stringify(["task-reasoning-summaries-v1", ctx.seed.taskA, tuples]),
      )
      .digest("hex"),
  );
  ctx.s.f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE conversation_reasoning_summaries SET updatedAt=updatedAt+12345",
    ).run();
  });
  assert.equal(
    (await conditional(cold.reasoningSummaryRevision)).reasoningSummaryAnchors,
    undefined,
  );
  for (const [column, value] of [
    ["text", "snapshot changed"],
    ["truncated", 1],
  ] as const) {
    const prior = await conditional("unknown");
    ctx.s.f.seedPersistedState((db) =>
      db
        .prepare(
          `UPDATE conversation_reasoning_summaries SET ${column}=? WHERE workId=?`,
        )
        .run(value, first.binding.workId),
    );
    const changed = await conditional(prior.reasoningSummaryRevision);
    assert.notEqual(
      changed.reasoningSummaryRevision,
      prior.reasoningSummaryRevision,
    );
    assert.equal(changed.reasoningSummaryAnchors.length, 2);
  }
  const prior = await conditional("unknown");
  ctx.s.f.seedPersistedState((db) =>
    db.exec("UPDATE conversation_reasoning_summaries SET stored=0,text=NULL"),
  );
  const empty = await conditional(prior.reasoningSummaryRevision);
  assert.deepEqual(empty.reasoningSummaryAnchors, []);
  assert.notEqual(
    empty.reasoningSummaryRevision,
    prior.reasoningSummaryRevision,
  );
  assert.equal(
    (await conditional(empty.reasoningSummaryRevision)).reasoningSummaryAnchors,
    undefined,
  );
  for (const query of [
    "reasoningSummaryRevision=",
    "reasoningSummaryRevision=true",
    "reasoningSummaryRevision=false",
    `reasoningSummaryRevision=${"A".repeat(64)}`,
    "reasoningSummaryRevision=unknown&reasoningSummaryRevision=unknown",
    `before=${cold.olderCursor}&reasoningSummaryRevision=unknown`,
    "reasoningSummaryRevision=unknown&extra=1",
  ])
    await ctx.get(`${ctx.base}?${query}`, 400);
  const envelope = { data: snapshot, observedAt: 1 };
  for (const anchors of [
    [...snapshot.reasoningSummaryAnchors, snapshot.reasoningSummaryAnchors[0]],
    [
      snapshot.reasoningSummaryAnchors[0],
      {
        ...snapshot.reasoningSummaryAnchors[1],
        turnKey: snapshot.reasoningSummaryAnchors[0].turnKey,
      },
    ],
    [{ ...snapshot.reasoningSummaryAnchors[0], extra: true }],
    [
      {
        ...snapshot.reasoningSummaryAnchors[0],
        reasoningSummary: { text: "x".repeat(16001), truncated: false },
      },
    ],
    Array.from({ length: 129 }, (_, n) => ({
      ...snapshot.reasoningSummaryAnchors[0],
      entryId: `anchor-${n}`,
      turnKey: n.toString(16).padStart(64, "0"),
    })),
    [
      {
        ...snapshot.reasoningSummaryAnchors[0],
        entryId: snapshot.entries[0].entryId,
      },
    ],
  ])
    assert.equal(
      taskTimelineSchema.safeParse({
        ...envelope,
        data: { ...snapshot, reasoningSummaryAnchors: anchors },
      }).success,
      false,
    );
});
