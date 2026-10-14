import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
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

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI documents are asserted structurally
type Json = Record<string, any>;

async function cliSetup(t: Parameters<typeof startCliService>[0]) {
  const s = await startCliService(t);
  const h = harness(t);
  for (const [name, scope] of [
    ["ro", "read"],
    ["rw", "read-write"],
  ] as const) {
    const issued = await s.issue(scope, `capture-cli-${name}`);
    const login = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(issued.token),
    ]);
    assert.equal(login.code, 0, login.err);
  }
  const d = s.f.service.domain();
  const cli = (connection: "ro" | "rw", args: string[]) =>
    h.run([...args, "--connection", connection, "--output", "json"]);
  const prepare = (extra: string[]) => {
    const out = join(h.dir, `${randomUUID()}.json`);
    return {
      out,
      run: () =>
        cli("ro", ["project", "prepare", s.projectId, ...extra, "--out", out]),
    };
  };
  const document = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as Json;
  return { s, h, d, cli, prepare, document };
}

test("project prepare and apply change the diagnostic capture mode once", async (t) => {
  const { s, d, cli, prepare, document } = await cliSetup(t);
  const mode = () => d.diagnosticCaptureMode(s.projectId);

  const baseline = prepare(["--diagnostic-capture", "baseline"]);
  const before = databaseDigest(s.f);
  let r = await baseline.run();
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(databaseDigest(s.f), before);
  assert.equal(statSync(baseline.out).mode & 0o777, 0o600);
  const doc = document(baseline.out);
  assert.equal(doc.kind, "project.configure");
  assert.deepEqual(Object.keys(doc.command).sort(), [
    "diagnosticCapture",
    "expectedVersion",
    "projectId",
    "type",
  ]);
  assert.deepEqual(doc.preview.changes, [
    { field: "diagnosticCapture", from: "enhanced", to: "baseline" },
  ]);

  r = await cli("ro", ["project", "apply", "--file", baseline.out]);
  assert.equal(r.code, 3, r.err + r.out);
  assert.equal(mode(), "enhanced");

  r = await cli("rw", ["project", "apply", "--file", baseline.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(Object.keys(r.json().data.receipt).sort(), [
    "key",
    "kind",
    "recorded",
    "result",
  ]);
  assert.equal(mode(), "baseline");
  const version = Number(d.project(s.projectId).version);
  const show = await cli("ro", ["project", "get", s.projectId]);
  assert.equal(show.json().data.diagnosticCapture, "baseline");

  const replay = await cli("rw", ["project", "apply", "--file", baseline.out]);
  assert.equal(replay.code, 0, replay.err + replay.out);
  assert.equal(Number(d.project(s.projectId).version), version);

  // The same mode is no change.
  const same = prepare(["--diagnostic-capture", "baseline"]);
  r = await same.run();
  assert.equal(r.code, 2);
  assert.match(r.err + r.out, /No change/);
  assert.equal(existsSync(same.out), false);

  // Omitting the option leaves the mode alone.
  const rename = prepare(["--name", "Renamed for capture"]);
  r = await rename.run();
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal("diagnosticCapture" in document(rename.out).command, false);
  r = await cli("rw", ["project", "apply", "--file", rename.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(mode(), "baseline");

  const enhanced = prepare(["--diagnostic-capture", "enhanced"]);
  r = await enhanced.run();
  assert.equal(r.code, 0, r.err + r.out);
  r = await cli("rw", ["project", "apply", "--file", enhanced.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(mode(), "enhanced");
});

test("project apply refuses a capture change prepared against an older version", async (t) => {
  const { s, d, cli, prepare } = await cliSetup(t);
  const stale = prepare(["--diagnostic-capture", "baseline"]);
  assert.equal((await stale.run()).code, 0);
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: Number(d.project(s.projectId).version),
    name: "Renamed elsewhere",
  } as never);
  const r = await cli("rw", ["project", "apply", "--file", stale.out]);
  assert.equal(r.code, 4, r.err + r.out);
  assert.equal(d.diagnosticCaptureMode(s.projectId), "enhanced");
});

test("project prepare rejects invalid capture modes and other commands reject the flag", async (t) => {
  const { s, d, h, cli, prepare } = await cliSetup(t);
  const before = databaseDigest(s.f);
  for (const value of ["off", ""]) {
    const bad = prepare(["--diagnostic-capture", value]);
    const r = await bad.run();
    assert.equal(r.code, 2, r.err + r.out);
    assert.equal(existsSync(bad.out), false);
  }
  const create = join(h.dir, "create.json");
  const r = await cli("ro", [
    "project",
    "prepare-create",
    "--name",
    "X",
    "--diagnostic-capture",
    "baseline",
    "--out",
    create,
  ]);
  assert.equal(r.code, 2, r.err + r.out);
  assert.equal(existsSync(create), false);
  assert.equal(databaseDigest(s.f), before);
  assert.equal(d.diagnosticCaptureMode(s.projectId), "enhanced");
});
