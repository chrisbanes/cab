import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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
  const first = await post(deletion);
  assert.equal(first.status, 200);
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
