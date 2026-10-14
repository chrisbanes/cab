import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

test("diagnostic capture is set through the shared command and read back", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const configure = (mode: string) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: Number(d.project(s.projectId).version),
    diagnosticCapture: mode,
  });
  const config = async (token: string) => {
    const r = await s.bearer(
      token,
      `/api/operator/projects/${s.projectId}/configuration`,
    );
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: { diagnosticCapture?: string } }).data;
  };
  const read = await s.issue("read", "capture-ro");
  const write = await s.issue("read-write", "capture-rw");
  assert.equal((await config(read.token)).diagnosticCapture, "enhanced");

  const denied = await s.bearer(read.token, "/api/operator/commands", {
    method: "POST",
    body: configure("baseline"),
  });
  assert.equal(denied.status, 403);
  assert.equal(d.diagnosticCaptureMode(s.projectId), "enhanced");

  const set = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure("baseline"),
  });
  assert.equal(set.status, 200);
  const receipt = (await set.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "key",
    "kind",
    "recorded",
    "result",
  ]);
  assert.equal((await config(read.token)).diagnosticCapture, "baseline");

  const h = harness(t);
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const get = await h.run(["project", "get", s.projectId]);
  assert.equal(get.code, 0, get.err);
  assert.match(get.out, /Diagnostic capture:\s+baseline/);

  const restored = await s.sessionPost(
    "/api/operator/commands",
    configure("enhanced"),
  );
  assert.equal(restored.status, 200);
  assert.equal(d.diagnosticCaptureMode(s.projectId), "enhanced");
});
