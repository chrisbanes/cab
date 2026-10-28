import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { seedExecutionDiagnostics } from "../fixtures/execution-diagnostics.js";
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
  assert.equal(detail.health.reasoning, "not-collected");
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
