import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

/** Drops the reply to a command after the service has received it. */
const loseReply: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (String(input).endsWith("/api/operator/commands"))
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  return response;
};

test("configuration journey through the CLI and the shared service", async (t) => {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  const h = harness(t);
  const tokens: Record<string, string> = {};
  for (const [name, scope] of [
    ["ro", "read"],
    ["rw", "read-write"],
  ] as const) {
    tokens[name] = (await s.issue(scope, `journey-${name}`)).token;
    const login = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(tokens[name] ?? ""),
    ]);
    assert.equal(login.code, 0, login.err);
  }
  const d = () => s.f.service.domain();
  const cli = (
    connection: string,
    args: string[],
    extra: Parameters<typeof h.run>[1] = {},
  ) => h.run([...args, "--connection", connection, "--output", "json"], extra);
  const ok = async (connection: string, args: string[]) => {
    const r = await cli(connection, args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  const text = (name: string, body: string) => {
    const path = join(h.dir, name);
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  };
  const out = () => join(h.dir, `${randomUUID()}.json`);

  // Help offers no runtime or model controls (GitHub sources and delivery are CLI4).
  const help = await h.run(["--help"]);
  assert.doesNotMatch(help.out, /--runtime|--model/i);

  // 1. Prepare read-only, review, apply read-write, read back and compare reads.
  const profileDoc = out();
  let r = await ok("ro", [
    "profile",
    "prepare",
    seed.profileId,
    "--name",
    "Shared lead v2",
    "--instructions-file",
    text("p.md", "Journey profile text"),
    "--out",
    profileDoc,
  ]);
  assert.equal(r.data.document.preview.impact.total, 2);
  r = await ok("rw", ["profile", "apply", "--file", profileDoc]);
  const profileReceipt = r.data.receipt;
  r = await ok("ro", [
    "operation",
    "get",
    profileReceipt.key,
    "--scope",
    `profile:${seed.profileId}`,
    "--type",
    "profile.configure",
  ]);
  assert.deepEqual(r.data.receipt, profileReceipt);
  const bearerRead = (await (
    await s.bearer(
      tokens.ro ?? "",
      `/api/operator/profiles/${seed.profileId}/configuration`,
    )
  ).json()) as Json;
  const sessionRead = (await (
    await s.sessionGet(`/api/operator/profiles/${seed.profileId}/configuration`)
  ).json()) as Json;
  assert.deepEqual(bearerRead.data, sessionRead.data);
  assert.equal(sessionRead.data.profile.name, "Shared lead v2");

  // 2. Shared UI: a browser edit at the pre-edit version conflicts as before.
  const stale = await s.sessionPost("/api/operator/commands", {
    type: "profile.configure",
    key: randomUUID(),
    profileId: seed.profileId,
    expectedVersion: profileReceipt.result.version - 1,
    summary: "Browser",
  });
  assert.equal(stale.status, 409);

  // 3. Create, revoke, unrevoke, restore and adopt.
  const profileId = randomUUID(),
    projectId = randomUUID();
  let doc = out();
  await ok("ro", [
    "profile",
    "prepare-create",
    "--name",
    "Journey",
    "--instructions-file",
    text("j.md", "Journey one"),
    "--id",
    profileId,
    "--out",
    doc,
  ]);
  await ok("rw", ["profile", "apply", "--file", doc]);
  doc = out();
  await ok("ro", [
    "project",
    "prepare-create",
    "--name",
    "Journey project",
    "--lead-profile",
    profileId,
    "--instructions-file",
    text("jp.md", "Project one"),
    "--id",
    projectId,
    "--out",
    doc,
  ]);
  await ok("rw", ["project", "apply", "--file", doc]);
  for (const value of ["true", "false"]) {
    doc = out();
    await ok("ro", [
      "profile",
      "prepare",
      profileId,
      "--revoked",
      value,
      "--out",
      doc,
    ]);
    await ok("rw", ["profile", "apply", "--file", doc]);
  }
  const taskId = randomUUID(),
    assignmentId = randomUUID();
  const task = await s.sessionPost("/api/operator/commands", {
    type: "task.create",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Journey task",
    outcome: "Done",
    ready: false,
    initialAssignment: { assignmentId, profileId },
  });
  assert.equal(task.status, 200);
  doc = out();
  await ok("ro", [
    "profile",
    "prepare",
    profileId,
    "--instructions-file",
    text("j2.md", "Journey two"),
    "--out",
    doc,
  ]);
  await ok("rw", ["profile", "apply", "--file", doc]);
  doc = out();
  await ok("ro", [
    "profile",
    "prepare",
    profileId,
    "--restore-revision",
    "1",
    "--out",
    doc,
  ]);
  r = await ok("rw", ["profile", "apply", "--file", doc]);
  const restoredVersion = r.data.receipt.result.version;
  assert.equal(
    d().profileRevision(profileId, restoredVersion).instructions,
    "Journey one",
  );
  assert.equal(d().profileRevision(profileId, 1).instructions, "Journey one");
  const version = Number(d().assignment(assignmentId).version);
  r = await ok("rw", [
    "assignment",
    "apply-current",
    assignmentId,
    "--expected-version",
    String(version),
  ]);
  assert.equal(r.data.receipt.result.profileRevision, restoredVersion);
  // Stale adoption.
  r = await cli("rw", [
    "assignment",
    "apply-current",
    assignmentId,
    "--expected-version",
    String(version),
    "--request-id",
    randomUUID(),
  ]);
  assert.equal(r.code, 4);

  // 4. Races: a browser edit and a new assignment against prepared documents.
  const racedProject = out();
  await ok("ro", [
    "project",
    "prepare",
    seed.projectA,
    "--instructions-file",
    text("a.md", "Raced project text"),
    "--out",
    racedProject,
  ]);
  const racedProfile = out();
  await ok("ro", [
    "profile",
    "prepare",
    profileId,
    "--summary",
    "Raced",
    "--out",
    racedProfile,
  ]);
  const browser = await s.sessionPost("/api/operator/commands", {
    type: "profile.configure",
    key: randomUUID(),
    profileId,
    expectedVersion: Number(d().profile(profileId).version),
    summary: "Browser wins",
  });
  assert.equal(browser.status, 200);
  const lateAssignment = randomUUID();
  assert.equal(
    (
      await s.sessionPost("/api/operator/commands", {
        type: "task.create",
        key: randomUUID(),
        projectId: seed.projectA,
        taskId: randomUUID(),
        title: "Late",
        outcome: "Late",
        ready: false,
        initialAssignment: {
          assignmentId: lateAssignment,
          profileId: seed.profileId,
        },
      })
    ).status,
    200,
  );
  let before = databaseDigest(s.f);
  r = await cli("rw", ["profile", "apply", "--file", racedProfile]);
  assert.equal(r.code, 4);
  assert.equal(databaseDigest(s.f), before);
  await ok("rw", ["project", "apply", "--file", racedProject]);
  r = await ok("ro", ["assignment", "instructions", lateAssignment]);
  assert.equal(r.data.comparison.boundIsCurrent, false);

  // 5. Tamper, wrong service, read-only denial and an unreadable journal.
  doc = out();
  await ok("ro", [
    "project",
    "prepare",
    projectId,
    "--name",
    "Renamed",
    "--out",
    doc,
  ]);
  const tampered = join(h.dir, "tampered.json");
  const json = JSON.parse(readFileSync(doc, "utf8")) as Json;
  writeFileSync(
    tampered,
    JSON.stringify({ ...json, command: { ...json.command, name: "Other" } }),
    { mode: 0o600 },
  );
  r = await cli("rw", ["project", "apply", "--file", tampered]);
  assert.equal(r.json().error.code, "change-document-invalid");
  const other = await startCliService(t);
  const otherToken = (await other.issue("read-write", "journey-other")).token;
  await h.run([
    "auth",
    "login",
    "--connection",
    "other",
    "--url",
    other.origin,
    "--token-file",
    h.tokenFile(otherToken),
  ]);
  r = await cli("other", ["project", "apply", "--file", doc]);
  assert.equal(r.json().error.code, "wrong-service");
  r = await cli("ro", ["project", "apply", "--file", doc]);
  assert.equal(r.code, 3);
  const journalPath = join(h.configDir, "requests.jsonl");
  chmodSync(journalPath, 0o000);
  before = databaseDigest(s.f);
  r = await cli("rw", ["project", "apply", "--file", doc]);
  chmodSync(journalPath, 0o600);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.json().error.code, "journal-unavailable");
  assert.equal(databaseDigest(s.f), before);

  // 6. Reply loss, a fresh process, a service restart and an identical replay.
  r = await cli("rw", ["project", "apply", "--file", doc], {
    fetch: loseReply,
  });
  assert.equal(r.code, 6, r.out);
  const lost = r.json().error.request;
  assert.deepEqual(
    { scope: lost.scope, type: lost.type },
    { scope: `project:${projectId}`, type: "project.configure" },
  );
  const fresh = harness(t);
  await fresh.run([
    "auth",
    "login",
    "--connection",
    "ro",
    "--url",
    s.origin,
    "--token-file",
    fresh.tokenFile(tokens.ro ?? ""),
  ]);
  const readLost = await fresh.run([
    "operation",
    "get",
    lost.key,
    "--scope",
    lost.scope,
    "--type",
    lost.type,
    "--output",
    "json",
  ]);
  assert.equal(readLost.json().data.state, "recorded");
  const recorded = readLost.json().data.receipt;
  await s.restart();
  r = await ok("rw", ["project", "apply", "--file", doc]);
  assert.deepEqual(r.data.receipt, recorded);
  assert.equal(r.request.key, lost.key);
  assert.equal(d().project(projectId).name, "Renamed");
  assert.equal(Number(d().project(projectId).version), recorded.result.version);

  // 7. One UUID as the key in three scopes selects only each scope's receipt.
  const shared = randomUUID();
  const docs = {
    project: out(),
    profile: out(),
    capacity: out(),
  };
  await ok("ro", [
    "project",
    "prepare",
    projectId,
    "--paused",
    "false",
    "--out",
    docs.project,
  ]);
  await ok("ro", [
    "profile",
    "prepare",
    profileId,
    "--summary",
    "Shared key",
    "--out",
    docs.profile,
  ]);
  await ok("ro", [
    "capacity",
    "prepare",
    "--global-limit",
    "7",
    "--out",
    docs.capacity,
  ]);
  const receipts: Record<string, Json> = {};
  for (const [area, file] of Object.entries(docs))
    receipts[area] = (
      await ok("rw", [area, "apply", "--file", file, "--request-id", shared])
    ).data.receipt;
  for (const [scope, type, area] of [
    [`project:${projectId}`, "project.configure", "project"],
    [`profile:${profileId}`, "profile.configure", "profile"],
    ["system:capacity", "capacity.configure", "capacity"],
  ] as const) {
    r = await ok("ro", [
      "operation",
      "get",
      shared,
      "--scope",
      scope,
      "--type",
      type,
    ]);
    assert.deepEqual(r.data.receipt, receipts[area]);
  }
  r = await ok("ro", [
    "operation",
    "get",
    shared,
    "--scope",
    `project:${seed.projectB}`,
    "--type",
    "project.configure",
  ]);
  assert.deepEqual(r.data, { state: "not-recorded" });
  r = await cli("ro", [
    "operation",
    "get",
    shared,
    "--scope",
    `project:${projectId}`,
    "--type",
    "routing.configure",
  ]);
  assert.equal(r.code, 4);
  const changed = out();
  await ok("ro", [
    "project",
    "prepare",
    projectId,
    "--name",
    "Different",
    "--out",
    changed,
  ]);
  before = databaseDigest(s.f);
  r = await cli("rw", [
    "project",
    "apply",
    "--file",
    changed,
    "--request-id",
    shared,
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(databaseDigest(s.f), before);

  // 8. The browser capacity command without a guard still applies.
  const capacity = await s.sessionPost("/api/operator/commands", {
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 3,
    projectOverrides: {},
  });
  assert.equal(capacity.status, 200);
  assert.equal(d().capacityLimits().globalLimit, 3);

  const journal = readFileSync(journalPath, "utf8");
  assert.ok(!journal.includes(instructionSecret));
  assert.ok(!journal.includes("Journey profile text"));
  for (const output of h.outputs.filter((o) => o.includes('"error"')))
    assert.ok(!output.includes(instructionSecret));
});
