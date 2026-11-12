import {
  escalateApprovalLines,
  unsandboxedGrantLines,
  unsandboxedSupersededLine,
} from "../../src/operator/sandbox-level-copy.js";
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

test("local listening is operator-only through the API and the CLI", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const configure = (enabled: boolean) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: Number(d.project(s.projectId).version),
    localListening: enabled,
  });
  const config = async (token: string) => {
    const r = await s.bearer(
      token,
      `/api/operator/projects/${s.projectId}/configuration`,
    );
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: { localListening?: boolean } }).data;
  };
  const read = await s.issue("read", "listen-ro");
  const write = await s.issue("read-write", "listen-rw");
  assert.equal((await config(read.token)).localListening, false);

  const denied = await s.bearer(read.token, "/api/operator/commands", {
    method: "POST",
    body: configure(true),
  });
  assert.equal(denied.status, 403);
  assert.equal(d.localListening(s.projectId), false);
  const set = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure(true),
  });
  assert.equal(set.status, 200);
  assert.equal((await config(read.token)).localListening, true);
  // The two settings are independent.
  assert.equal(d.commandNetworkAccess(s.projectId), false);

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
  const human = await h.run([
    "project",
    "get",
    s.projectId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Local listening:\s+enabled/);

  const out = join(h.dir, `${randomUUID()}.json`);
  let r = await cli("ro", [
    "project",
    "prepare",
    s.projectId,
    "--local-listening",
    "false",
    "--out",
    out,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(readFileSync(out, "utf8")) as Json;
  assert.deepEqual(doc.preview.changes, [
    { field: "localListening", from: "true", to: "false" },
  ]);
  assert.match(
    JSON.stringify(doc.preview.notes),
    /Claude Code task turns admitted after the change/,
  );
  assert.match(JSON.stringify(doc.preview.notes), /connect to a listening/);
  r = await cli("rw", ["project", "apply", "--file", out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.localListening(s.projectId), false);
});

test("no coordination tool can read or change a project's local listening setting", () => {
  assert.doesNotMatch(
    JSON.stringify(coordinationTools),
    /listen|localBinding/i,
  );
});

test("the sandbox level is strict by default, operator-only and versioned through the API and the CLI", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const configure = (
    fields: Record<string, unknown>,
    expectedVersion?: number,
  ) => ({
    type: "project.configure",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: expectedVersion ?? Number(d.project(s.projectId).version),
    ...fields,
  });
  const config = async (token: string) => {
    const r = await s.bearer(
      token,
      `/api/operator/projects/${s.projectId}/configuration`,
    );
    assert.equal(r.status, 200);
    return ((await r.json()) as { data: { sandbox?: string } }).data;
  };
  const read = await s.issue("read", "skip-ro");
  const write = await s.issue("read-write", "skip-rw");
  assert.equal((await config(read.token)).sandbox, "strict");

  const denied = await s.bearer(read.token, "/api/operator/commands", {
    method: "POST",
    body: configure({ sandbox: "unsandboxed" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(d.sandboxLevel(s.projectId), "strict");

  // The retired boolean is refused, not aliased.
  const retired = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure({ dangerouslySkipSandbox: true }),
  });
  assert.equal(retired.status, 400);
  assert.equal(d.sandboxLevel(s.projectId), "strict");

  // A stale expected version is refused like any other project setting.
  const staleVersion = Number(d.project(s.projectId).version);
  const set = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure({ sandbox: "unsandboxed" }),
  });
  assert.equal(set.status, 200);
  const stale = await s.bearer(write.token, "/api/operator/commands", {
    method: "POST",
    body: configure({ sandbox: "strict" }, staleVersion),
  });
  assert.equal(stale.status, 409);
  assert.equal((await config(read.token)).sandbox, "unsandboxed");
  // The settings are independent.
  assert.equal(d.commandNetworkAccess(s.projectId), false);
  assert.equal(d.localListening(s.projectId), false);

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
  const prepare = (value: string) => {
    const out = join(h.dir, `${randomUUID()}.json`);
    return {
      out,
      run: () =>
        cli("ro", [
          "project",
          "prepare",
          s.projectId,
          "--sandbox",
          value,
          "--out",
          out,
        ]),
    };
  };
  const same = prepare("unsandboxed");
  let r = await same.run();
  assert.equal(r.code, 2, r.err + r.out);
  assert.match(r.err + r.out, /No change/);

  const off = prepare("strict");
  r = await off.run();
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(readFileSync(off.out, "utf8")) as Json;
  assert.deepEqual(doc.preview.changes, [
    { field: "sandbox", from: "unsandboxed", to: "strict" },
  ]);
  r = await cli("rw", ["project", "apply", "--file", off.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.sandboxLevel(s.projectId), "strict");

  // Choosing unsandboxed states both grants and that network access and listening are superseded.
  const on = prepare("unsandboxed");
  r = await on.run();
  assert.equal(r.code, 0, r.err + r.out);
  const notes = JSON.stringify(
    (JSON.parse(readFileSync(on.out, "utf8")) as Json).preview.notes,
  );
  for (const line of [...unsandboxedGrantLines, unsandboxedSupersededLine])
    assert.ok(notes.includes(line), line);

  // Choosing escalate-approval states its Codex grant, that Claude Code stays strict, and its risks.
  const escalate = prepare("escalate-approval");
  r = await escalate.run();
  assert.equal(r.code, 0, r.err + r.out);
  const escalateDoc = JSON.parse(readFileSync(escalate.out, "utf8")) as Json;
  assert.deepEqual(escalateDoc.preview.changes, [
    { field: "sandbox", from: "strict", to: "escalate-approval" },
  ]);
  const escalateNotes = JSON.stringify(escalateDoc.preview.notes);
  for (const line of escalateApprovalLines)
    assert.ok(escalateNotes.includes(line), line);
  assert.equal(escalateNotes.includes(unsandboxedSupersededLine), false);
  r = await cli("rw", ["project", "apply", "--file", escalate.out]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.sandboxLevel(s.projectId), "escalate-approval");
  assert.equal((await config(read.token)).sandbox, "escalate-approval");

  const bad = prepare("bogus");
  r = await bad.run();
  assert.equal(r.code, 2, r.err + r.out);
  assert.match(
    r.err + r.out,
    /--sandbox must be strict, escalate-approval or unsandboxed/,
  );
});

test("no coordination tool can read or change a project's sandbox level", () => {
  assert.doesNotMatch(
    JSON.stringify(coordinationTools),
    /skipSandbox|dangerously|sandbox/i,
  );
});
