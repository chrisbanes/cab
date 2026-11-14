import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

test("reasoning opt-in validates resulting capture and deletion is confirmed, versioned and repeatable", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const ro = await s.issue("read", "reasoning-read");
  const rw = await s.issue("read-write", "reasoning-write");
  const version = () => Number(d.project(s.projectId).version);
  const configure = (fields: object) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: version(),
    ...fields,
  });
  const post = (body: object, token = rw.token) =>
    s.bearer(token, "/api/operator/commands", { method: "POST", body });
  assert.equal(d.reasoningSummaries(s.projectId), false);
  assert.equal(
    (await post(configure({ reasoningSummaries: true }), ro.token)).status,
    403,
  );
  assert.throws(() =>
    d.execute({
      ...configure({ reasoningSummaries: true }),
      actor: "agent",
    } as never),
  );
  assert.equal(
    (await post(configure({ reasoningSummaries: true }))).status,
    200,
  );
  assert.equal(d.reasoningSummaries(s.projectId), true);
  const before = version();
  assert.equal(
    (
      await post(
        configure({ diagnosticCapture: "baseline", reasoningSummaries: true }),
      )
    ).status,
    400,
  );
  assert.equal(version(), before);
  assert.equal(d.diagnosticCaptureMode(s.projectId), "enhanced");
  assert.equal(d.reasoningSummaries(s.projectId), true);
  assert.equal(
    (await post(configure({ diagnosticCapture: "baseline" }))).status,
    200,
  );
  assert.equal(version(), before + 1);
  assert.equal(d.reasoningSummaries(s.projectId), false);
  assert.equal(
    (await post(configure({ reasoningSummaries: true }))).status,
    400,
  );
  assert.equal(
    (await post(configure({ diagnosticCapture: "enhanced" }))).status,
    200,
  );
  assert.equal(d.reasoningSummaries(s.projectId), false);
  assert.equal(
    (await post(configure({ reasoningSummaries: true }))).status,
    200,
  );

  const db = (s.f.service as unknown as { db: DatabaseSync }).db;
  const otherProject = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: otherProject,
    name: "Other reasoning",
    leadProfileId: null,
  });
  const seed = (projectId: string) =>
    db
      .prepare(`INSERT INTO conversation_reasoning_summaries
    (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,
      conversationRevision,workRevision,threadId,turnId,projectId,intentId,enabled,captureMode,
      generation,text,stored,truncated,createdAt,updatedAt)
    VALUES (?,?,?,1,1,1,1,1,?,?,?,?,1,'enhanced',0,?,1,0,1,1)`)
      .run(
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        projectId,
        randomUUID(),
        `private summary ${projectId}`,
      );
  seed(s.projectId);
  seed(otherProject);
  const stored = (projectId: string) =>
    db
      .prepare(
        "SELECT text,stored FROM conversation_reasoning_summaries WHERE projectId=?",
      )
      .get(projectId);
  const original = stored(s.projectId);
  const deletion = {
    type: "project.reasoning.delete",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: version(),
    confirmed: true,
  };
  assert.equal((await post(deletion, ro.token)).status, 403);
  assert.throws(() => d.execute({ ...deletion, actor: "agent" } as never));
  for (const confirmed of [undefined, false, "true"])
    assert.equal((await post({ ...deletion, confirmed })).status, 400);
  assert.equal(
    (await post({ ...deletion, expectedVersion: version() - 1 })).status,
    409,
  );
  assert.equal(version(), deletion.expectedVersion);
  assert.deepEqual(stored(s.projectId), original);
  const first = await post(deletion);
  assert.equal(first.status, 200);
  assert.deepEqual({ ...stored(s.projectId) }, { text: null, stored: 0 });
  assert.match(String(stored(otherProject)?.text), /private summary/);
  const receipt = await first.json();
  assert.equal(version(), deletion.expectedVersion + 1);
  const replay = await post(deletion);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), receipt);
  assert.equal(version(), deletion.expectedVersion + 1);
  assert.equal(
    (await post({ ...deletion, key: randomUUID(), expectedVersion: version() }))
      .status,
    200,
  );
  assert.equal(d.reasoningSummaries(s.projectId), true);
  assert.equal(
    db
      .prepare(
        "SELECT generation FROM project_reasoning_summaries WHERE projectId=?",
      )
      .get(s.projectId)?.generation,
    2,
  );
  const lookup = await s.bearer(
    ro.token,
    `/api/operator/operations?scope=project:${s.projectId}&key=${deletion.key}&type=project.reasoning.delete`,
  );
  assert.equal(lookup.status, 200);
  assert.match(JSON.stringify(await lookup.json()), /recorded/);
  assert.doesNotMatch(
    JSON.stringify(coordinationTools),
    /reasoningSummaries|project\.reasoning\.delete/,
  );
});

test("project CLI parses reasoning summaries, reports it and previews baseline reset", async (t) => {
  const s = await startCliService(t);
  const token = await s.issue("read-write", "reasoning-cli");
  const h = harness(t);
  assert.equal(
    (
      await h.run([
        "auth",
        "login",
        "--connection",
        "reasoning",
        "--url",
        s.origin,
        "--token-file",
        h.tokenFile(token.token),
      ])
    ).code,
    0,
  );
  const cli = (...args: string[]) =>
    h.run([...args, "--connection", "reasoning"]);
  let r = await cli("project", "get", s.projectId);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Reasoning summaries:\s+disabled/);
  r = await cli("project", "get", s.projectId, "--output", "json");
  assert.equal(JSON.parse(r.out).data.reasoningSummaries, false);
  r = await cli(
    "project",
    "prepare",
    s.projectId,
    "--reasoning-summaries",
    "maybe",
  );
  assert.equal(r.code, 2, r.out + r.err);
  const out = join(h.dir, "reasoning.json");
  r = await cli(
    "project",
    "prepare",
    s.projectId,
    "--reasoning-summaries",
    "true",
    "--out",
    out,
  );
  assert.equal(r.code, 0, r.out + r.err);
  const document = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(document.command.reasoningSummaries, true);
  assert.deepEqual(document.preview.changes, [
    { field: "reasoningSummaries", from: "false", to: "true" },
  ]);
  r = await cli("project", "apply", "--file", out);
  assert.equal(r.code, 0, r.out + r.err);
  r = await cli("project", "get", s.projectId);
  assert.match(r.out, /Reasoning summaries:\s+enabled/);
  r = await cli(
    "project",
    "prepare",
    s.projectId,
    "--diagnostic-capture",
    "baseline",
    "--reasoning-summaries",
    "true",
  );
  assert.equal(r.code, 2, r.out + r.err);
  const baseline = join(h.dir, "baseline.json");
  r = await cli(
    "project",
    "prepare",
    s.projectId,
    "--diagnostic-capture",
    "baseline",
    "--out",
    baseline,
  );
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(
    JSON.parse(readFileSync(baseline, "utf8")).preview.changes.some(
      (c: { field: string; to: string }) =>
        c.field === "reasoningSummaries" && c.to === "false",
    ),
  );
  r = await cli("project", "apply", "--file", baseline);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(s.f.service.domain().reasoningSummaries(s.projectId), false);
});

test("baseline CLI changes omit implicit reasoning on a legacy service but preserve explicit options", async (t) => {
  const s = await startCliService(t);
  const token = await s.issue("read-write", "legacy-reasoning-cli");
  const commands: Record<string, unknown>[] = [];
  const h = harness(t, {
    fetch: async (input, init) => {
      if (
        String(input).endsWith("/api/operator/commands") &&
        init?.method === "POST"
      ) {
        const command = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
        commands.push(command);
        if ("reasoningSummaries" in command)
          return Response.json(
            {
              error: {
                code: "invalid-input",
                message: "Unknown reasoningSummaries field",
              },
            },
            { status: 400 },
          );
      }
      const response = await fetch(input, init);
      if (String(input).endsWith(`/projects/${s.projectId}/configuration`)) {
        const body = (await response.json()) as {
          data: { reasoningSummaries?: boolean };
        };
        delete body.data.reasoningSummaries;
        return Response.json(body, { status: response.status });
      }
      return response;
    },
  });
  const cli = (...args: string[]) => h.run([...args, "--connection", "legacy"]);
  const login = await cli(
    "auth",
    "login",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(token.token),
  );
  assert.equal(login.code, 0, login.err);
  const out = join(h.dir, "legacy-baseline.json");
  const prepared = await cli(
    "project",
    "prepare",
    s.projectId,
    "--diagnostic-capture",
    "baseline",
    "--out",
    out,
  );
  assert.equal(prepared.code, 0, prepared.err);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.equal("reasoningSummaries" in doc.command, false);
  assert.deepEqual(doc.preview.changes, [
    { field: "diagnosticCapture", from: "enhanced", to: "baseline" },
  ]);
  const applied = await cli("project", "apply", "--file", out);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(commands.length, 1);
  assert.equal("reasoningSummaries" in commands[0]!, false);
  assert.equal(
    s.f.service.domain().diagnosticCaptureMode(s.projectId),
    "baseline",
  );
  const explicit = join(h.dir, "explicit-reasoning.json");
  const opted = await cli(
    "project",
    "prepare",
    s.projectId,
    "--reasoning-summaries",
    "false",
    "--out",
    explicit,
  );
  assert.equal(opted.code, 0, opted.err);
  assert.equal(
    JSON.parse(readFileSync(explicit, "utf8")).command.reasoningSummaries,
    false,
  );
});
