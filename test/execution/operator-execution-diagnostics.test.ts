import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  executionDetailSchema,
  executionEventsSchema,
} from "../../src/operator/contracts.js";
import { DeletedProjectRedactionStore } from "../../src/core/deleted-project-redaction.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  seedExecutionDiagnostics,
  seedExecutionReasoningSummary,
} from "../fixtures/execution-diagnostics.js";
import { instructionSecret } from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted structurally
type Json = Record<string, any>;

async function setup(
  t: { after(fn: () => unknown): void },
  options: { unchanged?: boolean } = {},
) {
  const s = await startCliService(t);
  const seed = await seedExecutionDiagnostics(s.f, options);
  t.after(seed.cleanup);
  const read = await s.issue("read", "executions-ro");
  const get = async (path: string, status = 200) => {
    const r = await s.bearer(read.token, path);
    assert.equal(r.status, status, path);
    return ((await r.json()) as Json).data as Json;
  };
  return { s, seed, read, get };
}

test("inputs mark instruction segments the thread already held as not sent", async (t) => {
  const { seed, get } = await setup(t, { unchanged: true });
  const inputs = await get(
    `/api/operator/executions/${enc(seed.unchanged)}/inputs?compare=current`,
  );
  const held = inputs.segments.filter((x: Json) =>
    x.name.endsWith("-instructions"),
  );
  assert.equal(held.length, 2);
  for (const segment of held)
    assert.deepEqual(
      [
        segment.sent,
        segment.text,
        segment.state,
        segment.reason,
        segment.revision,
        segment.redacted,
      ],
      [false, null, "available", null, 1, false],
    );
  assert.equal(inputs.reconstructed, null);
  assert.ok(
    inputs.comparison.instructions.every(
      (c: Json) => typeof c.sameContent === "boolean",
    ),
  );
  const sent = await get(
    `/api/operator/executions/${enc(seed.captured)}/inputs`,
  );
  assert.ok(sent.segments.every((x: Json) => x.sent === true));
  const events = await get(
    `/api/operator/executions/${enc(seed.unchanged)}/events?kind=input`,
  );
  assert.ok(!JSON.stringify(events).includes("[redacted]"));
});

const enc = encodeURIComponent;

test("execution list and detail report identity, settings and capture coverage", async (t) => {
  const { s, seed, get } = await setup(t);
  const list = await get(`/api/operator/executions?task=${seed.taskA}`);
  assert.deepEqual(
    list.executions.map((e: Json) => [e.workId, e.capture]),
    [
      [seed.absent, "not-captured"],
      [seed.captured, "captured"],
    ],
  );
  assert.equal(list.nextBefore, null);
  const paged = await get(
    `/api/operator/executions?assignment=${seed.assignmentA}&limit=1`,
  );
  assert.equal(paged.executions.length, 1);
  const next = await get(
    `/api/operator/executions?project=${seed.projectA}&limit=1&before=${paged.nextBefore}`,
  );
  assert.equal(next.executions[0].workId, seed.captured);
  for (const bad of [
    "",
    `?task=${seed.taskA}&project=${seed.projectA}`,
    `?task=${seed.taskA}&task=${seed.taskA}`,
    `?task=${seed.taskA}&limit=201`,
    `?task=${seed.taskA}&other=1`,
    "?task=not-a-uuid",
  ])
    await get(`/api/operator/executions${bad}`, 400);
  await get(`/api/operator/executions?task=${randomUUID()}`, 404);

  const detail = await get(`/api/operator/executions/${enc(seed.captured)}`);
  assert.equal(detail.execution.threadId, "thread-seeded");
  assert.equal(detail.execution.turnId, "turn-seeded");
  assert.doesNotMatch(detail.execution.reason, new RegExp(instructionSecret));
  assert.match(detail.execution.reason, /\[redacted\]/);
  assert.deepEqual(detail.identity, {
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    harness: "codex",
  });
  assert.deepEqual(
    detail.settings.map((e: Json) => [e.name, e.value, e.source]),
    [
      ["harness", "codex", "service-admitted"],
      ["model", "gpt-seeded", "runtime-reported"],
      ["serviceTier", null, "unknown"],
    ],
  );
  assert.equal(detail.health.toolObservation, "incomplete");
  assert.equal(detail.health.reasoning, "not-requested");
  assert.equal(detail.counts.items, 9);
  const absent = await get(`/api/operator/executions/${enc(seed.absent)}`);
  assert.equal(absent.execution.capture, "not-captured");
  assert.equal(absent.identity, null);
  assert.equal(absent.settings, null);
  await get(`/api/operator/executions/${seed.direct}`, 404);
  await get(`/api/operator/executions/unknown-work`, 404);
  await get(`/api/operator/executions/${enc("bad id")}`, 400);
  void s;
});

test("inputs disclose only the execution's own instruction text and compare with current", async (t) => {
  const { s, seed, get } = await setup(t);
  const inputs = await get(
    `/api/operator/executions/${enc(seed.captured)}/inputs?compare=current`,
  );
  assert.equal(inputs.provenance.source, "captured-submission");
  assert.equal(inputs.provenance.effectivePrompt, "not-captured");
  assert.equal(inputs.reconstructed, null);
  const segment = (name: string) =>
    inputs.segments.find((x: Json) => x.name === name);
  const profile = segment("profile-instructions");
  assert.match(profile.text, new RegExp(seed.profileOne));
  assert.equal(profile.revision, 1);
  assert.equal(profile.redacted, true);
  for (const leaked of [instructionSecret, "hunter2", s.f.directory])
    assert.ok(!JSON.stringify(inputs).includes(leaked), leaked);
  assert.doesNotMatch(segment("request").text, new RegExp(seed.profileOne));
  assert.deepEqual(inputs.submitted, { bytes: 10, sha256: "a".repeat(64) });
  const compared = Object.fromEntries(
    inputs.comparison.instructions.map((c: Json) => [c.name, c]),
  );
  assert.deepEqual(compared["profile-instructions"], {
    name: "profile-instructions",
    boundRevision: 1,
    currentRevision: 3,
    sameRevision: false,
    sameContent: false,
  });
  assert.equal(compared["project-instructions"].currentRevision, 2);
  assert.ok(
    inputs.comparison.settings.every((x: Json) => typeof x.same === "boolean"),
  );
  const plain = await get(
    `/api/operator/executions/${enc(seed.captured)}/inputs`,
  );
  assert.equal(plain.comparison, null);
  await get(
    `/api/operator/executions/${enc(seed.captured)}/inputs?compare=bound`,
    400,
  );
  const absent = await get(
    `/api/operator/executions/${enc(seed.absent)}/inputs`,
  );
  assert.equal(absent.provenance.source, "not-captured");
  assert.deepEqual(absent.segments, []);
  assert.deepEqual(absent.reconstructed.provenance, {
    source: "retained-revision-records",
    reconstructed: true,
    submittedPrompt: "not-captured",
  });
  assert.equal(absent.reconstructed.profile.text, seed.profileOne);
});

test("events page, filter, re-redact at read time and expose cursor gaps", async (t) => {
  const { s, seed, get } = await setup(t);
  const base = `/api/operator/executions/${enc(seed.captured)}/events`;
  const all = await get(base);
  assert.equal(all.items.length, 9);
  assert.equal(all.finished, true);
  assert.equal(all.more, false);
  const serialized = JSON.stringify(all);
  for (const leaked of [
    instructionSecret,
    "hunter2",
    seed.profileOne,
    s.f.directory,
  ])
    assert.ok(!serialized.includes(leaked), leaked);
  const runtime = await get(`${base}?kind=runtime`);
  assert.deepEqual(
    runtime.items.map((i: Json) => [i.name, i.severity, i.redacted]),
    [["commandExecution/completed", "warn", true]],
  );
  assert.equal((await get(`${base}?severity=warn`)).items.length, 1);
  const first = await get(`${base}?limit=2`);
  assert.equal(first.items.length, 2);
  assert.equal(first.more, true);
  const rest = await get(`${base}?after=${first.resumeAfter}`);
  assert.equal(rest.items.length, 7);
  assert.equal(rest.items[0].sequence > first.resumeAfter, true);
  await get(`${base}?after=999999`, 409);
  for (const bad of ["?kind=reasoning", "?severity=debug", "?after=-1", "?x=1"])
    await get(`${base}${bad}`, 400);
  // A later prune leaves an explicit gap for a cursor below the pruned range.
  s.f.seedPersistedState((db) => {
    void new ExecutionDiagnosticsStore(db, {
      now: () => Date.now() + 31 * 24 * 3600 * 1000,
    }).prune();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pruned = await get(base);
  assert.equal(pruned.items.length, 0);
  assert.deepEqual(
    pruned.gaps.map((g: Json) => [g.code, g.count]),
    [["expired", 9]],
  );
  const empty = await get(
    `/api/operator/executions/${enc(seed.absent)}/events`,
  );
  assert.equal(empty.capture, "not-captured");
  assert.deepEqual(empty.items, []);
});

test("unavailable exclusions fail closed", async (t) => {
  const s = await startCliService(t);
  const seed = await seedExecutionDiagnostics(s.f);
  t.after(seed.cleanup);
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  (api as unknown as { exclusions: () => Promise<undefined> }).exclusions =
    async () => undefined;
  const events = await api.readExecutionEvents(
    seed.captured,
    new URLSearchParams(),
  );
  assert.ok(
    events.data.items.every(
      (i) => i.state === "omitted" && i.reason === "redaction-unavailable",
    ),
  );
  const inputs = await api.readExecutionInputs(
    seed.captured,
    new URLSearchParams(),
  );
  assert.ok(
    inputs.data.segments.every((x) => x.reason === "redaction-unavailable"),
  );
});

test("execution reads are read-only for tokens and sessions", async (t) => {
  const { s, seed, read } = await setup(t);
  const paths = [
    `/api/operator/executions?task=${seed.taskA}`,
    `/api/operator/executions/${enc(seed.captured)}`,
    `/api/operator/executions/${enc(seed.captured)}/inputs?compare=current`,
    `/api/operator/executions/${enc(seed.captured)}/events`,
  ];
  const before = databaseDigest(s.f);
  for (const path of paths) {
    assert.equal(
      operatorRouteAuthority("GET", path.split("?")[0] ?? ""),
      "read",
    );
    assert.equal((await s.bearer(read.token, path)).status, 200, path);
    assert.equal((await s.sessionGet(path)).status, 200, path);
    assert.equal((await fetch(`${s.origin}${path}`)).status, 401, path);
  }
  assert.equal(databaseDigest(s.f), before);
});

test("both execution health projections use admitted capture and retained summaries behind privacy fences", async (t) => {
  const { s, seed, get } = await setup(t);
  const intentId = randomUUID();
  const binding = {
    workId: seed.captured,
    taskId: seed.taskA,
    assignmentId: seed.assignmentA,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: "thread-seeded",
    turnId: "turn-seeded",
  };
  const write = s.f.seedPersistedState;
  write((db) => {
    db.prepare(`INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval)
      VALUES (?,?,'test',?,'completed',?,?,'chatgpt','workspaceWrite','never')`).run(
      intentId,
      seed.captured,
      s.f.directory,
      binding.threadId,
      binding.turnId,
    );
    db.prepare(`INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,harness)
      VALUES (?,?,?,1,1,1,1,'claude')`).run(
      seed.captured,
      seed.taskA,
      seed.assignmentA,
    );
    db.prepare(
      "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES (?,?,1,1)",
    ).run(seed.captured, seed.assignmentA);
  });
  const check = async (expected: string) => {
    const before = databaseDigest(s.f);
    const detail = await get(`/api/operator/executions/${enc(seed.captured)}`);
    const events = await get(
      `/api/operator/executions/${enc(seed.captured)}/events`,
    );
    assert.equal(detail.health.reasoning, expected);
    assert.equal(events.health.reasoning, expected);
    for (const [schema, data] of [
      [executionDetailSchema, detail],
      [executionEventsSchema, events],
    ] as const) {
      assert.ok(schema.safeParse({ data, observedAt: Date.now() }).success);
      for (const reasoning of ["not-collected", "arbitrary"])
        assert.equal(
          schema.safeParse({
            data: { ...data, health: { ...data.health, reasoning } },
            observedAt: Date.now(),
          }).success,
          false,
        );
    }
    assert.doesNotMatch(
      JSON.stringify([detail, events]),
      /SUMMARY_HEALTH_CANARY|SUMMARY_ERROR_CANARY/,
    );
    assert.equal(detail.health.toolObservation, "incomplete");
    assert.equal(databaseDigest(s.f), before);
  };
  await check("not-requested");
  write((db) => {
    db.prepare(
      "INSERT INTO project_reasoning_summaries(projectId,enabled,generation) VALUES (?,1,0) ON CONFLICT(projectId) DO UPDATE SET enabled=1",
    ).run(seed.projectA);
    db.prepare(
      "INSERT INTO execution_intent_reasoning_summaries(intentId,enabled,captureMode,generation) VALUES (?,1,NULL,0)",
    ).run(intentId);
  });
  await check("not-requested");
  for (const [enabled, mode, expected] of [
    [0, "enhanced", "not-requested"],
    [1, "baseline", "not-requested"],
    [1, "enhanced", "unavailable"],
  ] as const) {
    write((db) =>
      db
        .prepare(
          "UPDATE execution_intent_reasoning_summaries SET enabled=?,captureMode=? WHERE intentId=?",
        )
        .run(enabled, mode, intentId),
    );
    await check(expected);
  }
  write((db) =>
    db
      .prepare(
        "UPDATE task_execution_bindings SET harness='codex' WHERE workId=?",
      )
      .run(seed.captured),
  );
  await check("unavailable");
  write((db) => {
    db.prepare(
      "UPDATE task_execution_bindings SET harness='claude' WHERE workId=?",
    ).run(seed.captured);
    new ConversationHistoryStore(db).recordReasoningSummary(
      binding,
      intentId,
      undefined,
      [],
    );
  });
  await check("unavailable");
  write((db) => {
    db.prepare(
      "DELETE FROM conversation_reasoning_summaries WHERE workId=?",
    ).run(seed.captured);
    new ConversationHistoryStore(db).recordReasoningSummary(
      binding,
      intentId,
      "SUMMARY_HEALTH_CANARY",
      [],
    );
    db.prepare(
      "UPDATE project_reasoning_summaries SET enabled=0 WHERE projectId=?",
    ).run(seed.projectA);
  });
  await check("collected");
  const history = s.f.service.conversationHistoryStore()!;
  const originalRead = history.hasStoredReasoningSummary;
  history.hasStoredReasoningSummary = () => {
    throw new Error("SUMMARY_ERROR_CANARY");
  };
  try {
    await check("unavailable");
  } finally {
    history.hasStoredReasoningSummary = originalRead;
  }
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  (api as unknown as { exclusions: () => Promise<undefined> }).exclusions =
    async () => undefined;
  assert.equal(
    (await api.readExecution(seed.captured)).data.health.reasoning,
    "unavailable",
  );
  assert.equal(
    (await api.readExecutionEvents(seed.captured, new URLSearchParams())).data
      .health.reasoning,
    "unavailable",
  );
  write((db) => {
    db.prepare("DELETE FROM diagnostic_items WHERE workId=?").run(
      seed.captured,
    );
    db.prepare("DELETE FROM diagnostic_executions WHERE workId=?").run(
      seed.captured,
    );
  });
  await check("collected");
  const deletion = {
    type: "project.reasoning.delete",
    projectId: seed.projectA,
    expectedVersion: Number(
      s.f.service.domain().project(seed.projectA).version,
    ),
    confirmed: true,
    key: randomUUID(),
    actor: "operator",
  };
  s.f.service.domain().execute(deletion as never);
  await check("unavailable");
  // A separate SQLite connection observes the erased facts, as after reopening.
  write((db) =>
    assert.equal(
      new ConversationHistoryStore(db).hasStoredReasoningSummary(
        binding,
        intentId,
      ),
      false,
    ),
  );
});

test("summary opt-in enriches only the returned exact settlement and never reads text for quiet or filtered pages", async (t) => {
  const { s, seed, get } = await setup(t);
  const first = seedExecutionReasoningSummary(s.f, seed, {
    text: `FIRST_SUMMARY ${instructionSecret} ${seed.profileOne} token=hunter2 ${s.f.directory}`,
    state: "failed",
  });
  seedExecutionReasoningSummary(s.f, seed, { text: "OTHER_TURN_CANARY" });
  const base = `/api/operator/executions/${first.workId}/events`;
  const service = s.f.service,
    original = service.reasoningSummaryFor.bind(service);
  let reads = 0;
  service.reasoningSummaryFor = (...args) => {
    reads++;
    return original(...args);
  };
  t.after(() => {
    service.reasoningSummaryFor = original;
  });
  const before = databaseDigest(s.f);
  const quiet = await get(base),
    off = await get(`${base}?includeReasoningSummaries=false`);
  assert.deepEqual(off, quiet);
  assert.equal(reads, 0);
  const loud = await get(`${base}?includeReasoningSummaries=true`);
  const summaries = loud.items.filter((i: Json) => i.reasoningSummary);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].name, "execution-settled");
  assert.match(summaries[0].reasoningSummary.text, /FIRST_SUMMARY/);
  for (const canary of [
    instructionSecret,
    seed.profileOne,
    "hunter2",
    s.f.directory,
    "OTHER_TURN_CANARY",
  ])
    assert.ok(!JSON.stringify(loud).includes(canary), canary);
  assert.equal(summaries[0].reasoningSummary.truncated, false);
  assert.deepEqual(
    {
      ...loud,
      items: loud.items.map(({ reasoningSummary: _, ...item }: Json) => item),
    },
    quiet,
  );
  const settled = summaries[0];
  for (const query of [
    "kind=runtime",
    "severity=warn",
    `since=${first.at + 1}`,
    `until=${first.at - 1}`,
    `after=${settled.sequence}`,
    "limit=1",
  ]) {
    const count: number = reads;
    const page = await get(`${base}?includeReasoningSummaries=true&${query}`);
    assert.ok(
      page.items.every((i: Json) => !i.reasoningSummary),
      query,
    );
    assert.equal(reads, count, query);
  }
  for (const query of [
    "kind=service",
    "severity=info",
    `since=${first.at}&until=${first.at}`,
    "limit=2",
  ])
    assert.equal(
      (
        await get(`${base}?includeReasoningSummaries=true&${query}`)
      ).items.filter((i: Json) => i.reasoningSummary).length,
      1,
      query,
    );
  const pages: Json[] = [];
  let after = 0;
  for (;;) {
    const page = await get(
      `${base}?includeReasoningSummaries=true&limit=1&after=${after}`,
    );
    pages.push(...page.items);
    after = page.resumeAfter;
    if (!page.more) break;
  }
  assert.deepEqual(pages, loud.items);
  for (const value of [
    "",
    "1",
    "TRUE",
    "False",
    "true&includeReasoningSummaries=false",
  ])
    await get(`${base}?includeReasoningSummaries=${value}`, 400);
  await get(`${base}?includeReasoningSummaries=true&unknown=1`, 400);
  await get(`${base}?includeReasoningSummaries=true&after=999999`, 409);
  assert.equal(databaseDigest(s.f), before);
});

test("execution summary contracts retain Unicode bounds and reject malformed optional values", async (t) => {
  const { s, seed, get } = await setup(t);
  const { workId } = seedExecutionReasoningSummary(s.f, seed);
  const data = await get(`/api/operator/executions/${workId}/events`);
  const check = (reasoningSummary: unknown) =>
    executionEventsSchema.safeParse({
      data: { ...data, items: [{ ...data.items[0], reasoningSummary }] },
      observedAt: 1,
    }).success;
  assert.equal(check(undefined), true);
  assert.equal(check({ text: "😀".repeat(16000), truncated: false }), true);
  for (const value of [
    null,
    { text: "", truncated: false },
    { text: "x".repeat(16001), truncated: true },
    { text: "😀".repeat(16001), truncated: true },
    { text: "x", truncated: 1 },
    { text: "x", truncated: false, raw: "secret" },
  ])
    assert.equal(check(value), false);
});

test("summary absence follows actual settlement capture, diagnostic limits, failed writes and awaited retention", async (t) => {
  const { s, seed, get } = await setup(t);
  for (const options of [
    { settled: false },
    { captured: false },
    { limits: { executionItems: 1 } },
    { limits: { executionBytes: 1 } },
    { failSettlement: true },
  ]) {
    const x = seedExecutionReasoningSummary(s.f, seed, options);
    assert.ok(s.f.service.reasoningSummaryFor(x.binding, [])?.text);
    const result = await get(
      `/api/operator/executions/${x.workId}/events?includeReasoningSummaries=true`,
    );
    assert.ok(
      result.items.every((i: Json) => !i.reasoningSummary),
      JSON.stringify(options),
    );
    assert.ok(
      !result.items.some((i: Json) => i.name === "execution-settled"),
      JSON.stringify(options),
    );
    if (options.limits)
      assert.ok(
        result.gaps.some(
          (g: Json) =>
            g.code ===
            (options.limits.executionItems ? "item-limit" : "execution-limit"),
        ),
      );
  }
  const omitted = seedExecutionReasoningSummary(s.f, seed, {
    limits: { itemBytes: 1 },
  });
  const omittedPage = await get(
    `/api/operator/executions/${omitted.workId}/events?includeReasoningSummaries=true`,
  );
  const retainedEvent = omittedPage.items.find(
    (i: Json) => i.name === "execution-settled",
  );
  assert.equal(retainedEvent.state, "omitted");
  assert.equal(retainedEvent.reason, "size-limit");
  assert.equal(retainedEvent.reasoningSummary.text, "Retained summary");
  const x = seedExecutionReasoningSummary(s.f, seed);
  await s.f.service.executionDiagnostics()!.prune();
  // A separate real connection lets the awaited prune use an advanced clock without changing service configuration.
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const db = new DatabaseSync(join(s.f.directory, "data", "standalone.sqlite"));
  try {
    await new ExecutionDiagnosticsStore(db, {
      now: () => Date.now() + 31 * 24 * 3600 * 1000,
    }).prune();
  } finally {
    db.close();
  }
  const pruned = await get(
    `/api/operator/executions/${x.workId}/events?includeReasoningSummaries=true`,
  );
  assert.deepEqual(pruned.items, []);
  assert.ok(pruned.gaps.some((g: Json) => g.code === "expired"));
  assert.ok(s.f.service.reasoningSummaryFor(x.binding, [])?.text);
});

test("execution summary attribution rejects mismatched diagnostic identities without hiding ordinary events", async (t) => {
  const { s, seed, get } = await setup(t);
  for (const [field, value] of Object.entries({
    taskId: randomUUID(),
    projectId: randomUUID(),
    assignmentId: randomUUID(),
    assignmentVersion: 99,
    instructionsRevision: 99,
    profileRevision: 99,
    conversationRevision: 99,
    harness: "codex",
    threadId: "wrong-thread",
    turnId: "wrong-turn",
  })) {
    const x = seedExecutionReasoningSummary(s.f, seed);
    s.f.seedPersistedState((db) => {
      db.prepare(
        `UPDATE diagnostic_executions SET ${field}=? WHERE workId=?`,
      ).run(value, x.workId);
    });
    const result = await get(
      `/api/operator/executions/${x.workId}/events?includeReasoningSummaries=true`,
    );
    assert.equal(result.items.length, 3);
    assert.ok(
      result.items.every((i: Json) => !i.reasoningSummary),
      field,
    );
  }
});

test("execution summary reads fence workspace and privacy changes and never revive confirmed erasure", async (t) => {
  const { s, seed, get } = await setup(t);
  const x = seedExecutionReasoningSummary(s.f, seed, {
    text: "PUBLIC_SUMMARY LATE_SECRET",
  });
  const api = new OperatorApi(s.f.service);
  const path = new URLSearchParams({ includeReasoningSummaries: "true" });
  const mutable = api as unknown as {
    exclusions: (...args: unknown[]) => Promise<readonly string[] | undefined>;
  };
  const original = mutable.exclusions.bind(api);
  const service = s.f.service;
  mutable.exclusions = async (...args) => {
    const result = await original(...args);
    return [...(result ?? []), "LATE_SECRET"];
  };
  assert.ok(
    !JSON.stringify(await api.readExecutionEvents(x.workId, path)).includes(
      "LATE_SECRET",
    ),
  );
  mutable.exclusions = async () => undefined;
  assert.ok(
    (await api.readExecutionEvents(x.workId, path)).data.items.every(
      (i) => !i.reasoningSummary,
    ),
  );
  mutable.exclusions = original;
  const visibility = service.taskWorkspaceVisibility.bind(service);
  let calls = 0;
  service.taskWorkspaceVisibility = (id) => `${visibility(id)}:${calls++}`;
  await assert.rejects(api.readExecutionEvents(x.workId, path), {
    status: 503,
  });
  service.taskWorkspaceVisibility = visibility;
  const project = service.domain().project(seed.projectA);
  const deleted = service.domain().execute({
    type: "project.reasoning.delete",
    key: randomUUID(),
    projectId: seed.projectA,
    expectedVersion: Number(project.version),
    confirmed: true,
    actor: "operator",
  } as never);
  assert.ok(deleted);
  const result = await get(
    `/api/operator/executions/${x.workId}/events?includeReasoningSummaries=true`,
  );
  assert.ok(result.items.some((i: Json) => i.name === "execution-settled"));
  assert.ok(result.items.every((i: Json) => !i.reasoningSummary));
  assert.equal(service.reasoningSummaryFor(x.binding, []), undefined);
  await s.restart();
  assert.ok(
    (
      await get(
        `/api/operator/executions/${x.workId}/events?includeReasoningSummaries=true`,
      )
    ).items.every((i: Json) => !i.reasoningSummary),
  );
});

test("opted-in execution reads retry changed project exclusions and refuse credential rotation or changed historical identity", async (t) => {
  const { s, seed } = await setup(t),
    service = s.f.service;
  const x = seedExecutionReasoningSummary(s.f, seed, {
    text: "CURRENT_LATE_CANARY DELETED_LATE_CANARY ROTATED_LATE_CANARY",
  });
  s.f.seedPersistedState((db) => {
    db.exec("BEGIN");
    new DeletedProjectRedactionStore(db).capture([], ["DELETED_LATE_CANARY"]);
    db.exec("COMMIT");
  });
  const api = new OperatorApi(service),
    query = new URLSearchParams({ includeReasoningSummaries: "true" });
  const seam = api as unknown as {
    exclusions: (...args: unknown[]) => Promise<readonly string[] | undefined>;
  };
  const original = seam.exclusions.bind(api);
  let changed = false;
  seam.exclusions = async (...args) => {
    const excluded = await original(...args);
    if (!changed) {
      changed = true;
      service.domain().execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: seed.projectA,
        expectedVersion: Number(
          service.domain().project(seed.projectA).version,
        ),
        instructions: "CURRENT_LATE_CANARY",
      } as never);
    }
    return excluded;
  };
  const result = await api.readExecutionEvents(x.workId, query);
  assert.ok(changed);
  assert.doesNotMatch(
    JSON.stringify(result),
    /CURRENT_LATE_CANARY|DELETED_LATE_CANARY/,
  );
  assert.match(JSON.stringify(result), /ROTATED_LATE_CANARY/);
  const env = "CLI2_SYNTHETIC_ROUTING",
    old = process.env[env];
  changed = false;
  seam.exclusions = async (...args) => {
    const excluded = await original(...args);
    if (!changed) {
      changed = true;
      process.env[env] = "ROTATED_LATE_CANARY";
    }
    return excluded;
  };
  try {
    await assert.rejects(api.readExecutionEvents(x.workId, query), {
      status: 503,
    });
  } finally {
    if (old === undefined) delete process.env[env];
    else process.env[env] = old;
  }
  seam.exclusions = async (...args) => {
    const excluded = await original(...args);
    s.f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE diagnostic_executions SET turnId='changed' WHERE workId=?",
      ).run(x.workId);
    });
    return excluded;
  };
  assert.ok(
    (await api.readExecutionEvents(x.workId, query)).data.items.every(
      (i) => !i.reasoningSummary,
    ),
  );
});
