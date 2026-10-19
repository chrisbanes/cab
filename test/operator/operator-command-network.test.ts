import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coordinationTools } from "../../src/standalone/coordination-tools.js";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI documents are asserted structurally
type Json = Record<string, any>;

test("command network access is operator-only through the API and the CLI", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const configure = (enabled: boolean) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: Number(d.project(s.projectId).version),
    commandNetworkAccess: enabled,
  });
  const config = async (token: string) => {
    const r = await s.bearer(
      token,
      `/api/operator/projects/${s.projectId}/configuration`,
    );
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: { commandNetworkAccess?: boolean } })
      .data;
  };
  const read = await s.issue("read", "network-ro");
  const write = await s.issue("read-write", "network-rw");
  assert.equal((await config(read.token)).commandNetworkAccess, false);

  const denied = await s.bearer(read.token, "/api/operator/commands", {
    method: "POST",
    body: configure(true),
  });
  assert.equal(denied.status, 403);
  assert.equal(d.commandNetworkAccess(s.projectId), false);

  const set = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure(true),
  });
  assert.equal(set.status, 200);
  assert.deepEqual(Object.keys((await set.json()) as object).sort(), [
    "key",
    "kind",
    "recorded",
    "result",
  ]);
  assert.equal((await config(read.token)).commandNetworkAccess, true);

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
    h.run([...args, "--connection", connection, "--output", "json"]);
  const prepare = (extra: string[]) => {
    const out = join(h.dir, `${randomUUID()}.json`);
    return {
      out,
      run: () =>
        cli("ro", ["project", "prepare", s.projectId, ...extra, "--out", out]),
    };
  };

  const human = await h.run([
    "project",
    "get",
    s.projectId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Command network access:\s+enabled/);
  assert.match(
    human.out,
    /reach whatever credentials and logins the host exposes/,
  );

  // The current value is no change; omitting the flag leaves it alone.
  const same = prepare(["--command-network-access", "true"]);
  let r = await same.run();
  assert.equal(r.code, 2, r.err + r.out);
  assert.match(r.err + r.out, /No change/);
  assert.equal(existsSync(same.out), false);

  const off = prepare(["--command-network-access", "false"]);
  r = await off.run();
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(readFileSync(off.out, "utf8")) as Json;
  assert.deepEqual(doc.preview.changes, [
    { field: "commandNetworkAccess", from: "true", to: "false" },
  ]);
  assert.match(
    JSON.stringify(doc.preview.notes),
    /turns admitted after the change; running turns keep their policy/,
  );
  assert.match(JSON.stringify(doc.preview.notes), /credentials and logins/);
  r = await cli("ro", ["project", "apply", "--file", off.out]);
  assert.equal(r.code, 3, r.err + r.out);
  assert.equal(d.commandNetworkAccess(s.projectId), true);
  r = await cli("rw", ["project", "apply", "--file", off.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.commandNetworkAccess(s.projectId), false);

  const bad = prepare(["--command-network-access", "maybe"]);
  r = await bad.run();
  assert.equal(r.code, 2, r.err + r.out);
  assert.equal(existsSync(bad.out), false);

  const rename = prepare(["--name", "Renamed for network"]);
  assert.equal((await rename.run()).code, 0);
  assert.equal(
    "commandNetworkAccess" in
      (JSON.parse(readFileSync(rename.out, "utf8")) as Json).command,
    false,
  );
});

test("no coordination tool can read or change a project's command network setting", () => {
  assert.doesNotMatch(JSON.stringify(coordinationTools), /network/i);
});
