import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "../fixtures/instruction-history.js";
import { startCliService } from "../fixtures/operator-cli.js";

type After = { after(fn: () => unknown): void };
// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function setup(t: After, controlPaths?: string[]) {
  const s = await startCliService(t, controlPaths ? { controlPaths } : {});
  const seed = await seedInstructionHistory(s.f, s.f.directory, 60);
  t.after(seed.cleanup);
  const h = harness(t);
  const read = await s.issue("read", "assignment-ro");
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
  const ok = async (args: string[]) => {
    const r = await h.run([...args, "--output", "json"]);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  const api = async (path: string) =>
    ((await (await s.bearer(read.token, path)).json()) as Json).data as Json;
  return { s, seed, h, read, ok, api };
}

const leaks = (s: { f: { directory: string } }, text: string) =>
  [s.f.directory, instructionSecret, "hunter2", "CLI2_SYNTHETIC"].filter((v) =>
    text.includes(v),
  );

test("instruction revisions, bound-versus-current comparison and history browse read-only", async (t) => {
  const { s, seed, h, read, ok, api } = await setup(t);
  const before = databaseDigest(s.f);

  // 1. Revisions and bodies.
  let r = await h.run(["profile", "revisions", seed.profileId]);
  assert.equal(r.code, 0, r.err);
  assert.match(
    r.out,
    /^Reconstructed from retained revision records; not the submitted prompt\./,
  );
  assert.match(r.out, /\n3 +yes/);
  const revisions = await ok(["profile", "revisions", seed.profileId]);
  assert.equal(revisions.data.currentRevision, 3);
  assert.equal(revisions.data.revisions.length, 3);
  r = await h.run([
    "profile",
    "instructions",
    seed.profileId,
    "--revision",
    "1",
  ]);
  assert.match(r.out, /not the submitted prompt/);
  assert.ok(r.out.includes(seed.text.profile[0]!));
  const profile = await ok([
    "profile",
    "instructions",
    seed.profileId,
    "--revision",
    "1",
  ]);
  assert.deepEqual(
    profile.data,
    await api(
      `/api/operator/profiles/${seed.profileId}/instructions?revision=1`,
    ),
  );
  assert.equal(profile.coverage.complete, true);
  const projectCurrent = await ok(["project", "instructions", seed.projectA]);
  const projectOld = await ok([
    "project",
    "instructions",
    seed.projectA,
    "--revision",
    "1",
  ]);
  assert.notEqual(
    projectCurrent.data.selected.text,
    projectOld.data.selected.text,
  );
  assert.equal(projectOld.data.selected.text, seed.text.project[0]);
  // 3. Redaction is shown as a gap, never leaked.
  assert.deepEqual(projectCurrent.coverage.gaps, ["content-redacted"]);
  r = await h.run(["project", "instructions", seed.projectA]);
  assert.match(r.out, /Gap: content-redacted/);
  for (const args of [
    ["profile", "instructions", seed.profileId, "--revision", "0"],
    ["profile", "instructions", "nope"],
  ]) {
    r = await h.run(args);
    assert.equal(r.code, 2, args.join(" "));
  }
  r = await h.run([
    "profile",
    "instructions",
    seed.profileId,
    "--revision",
    "9",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not-found/);

  // 2. Bound versus current.
  r = await h.run(["assignment", "instructions", seed.assignmentA]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Binding: +stale/);
  assert.match(r.out, /profile bound revision 1, current 3: changed/);
  assert.match(r.out, /project bound revision 1, current 2: changed/);
  assert.ok(r.out.includes(seed.text.profile[0]!));
  assert.match(r.out, /Current profile instructions \(revision 3\)/);
  const stale = await ok(["assignment", "instructions", seed.assignmentA]);
  assert.deepEqual(
    stale.data,
    await api(`/api/operator/assignments/${seed.assignmentA}/instructions`),
  );
  assert.equal(stale.data.execution, null);
  r = await h.run(["assignment", "instructions", seed.assignmentB]);
  assert.match(r.out, /Binding: +current/);
  assert.ok(!r.out.includes("Current profile instructions"));

  // 5. Assignment detail.
  r = await h.run(["assignment", "get", seed.assignmentA]);
  assert.equal(r.code, 0, r.err);
  for (const id of [
    seed.assignmentA,
    seed.taskA,
    seed.projectA,
    seed.profileId,
  ])
    assert.ok(r.out.includes(id), id);
  assert.match(
    r.out,
    /Bound: +profile revision 1, project instructions revision 1/,
  );
  assert.match(
    r.out,
    /Current: +profile revision 3, project instructions revision 2/,
  );
  const detail = await ok(["assignment", "get", seed.assignmentA]);
  assert.deepEqual(
    detail.data,
    await api(`/api/operator/assignments/${seed.assignmentA}`),
  );
  r = await h.run(["assignment", "get", randomUUID()]);
  assert.equal(r.code, 2);

  // 4. History pages backwards with an explicit omission gap.
  const first = await ok(["assignment", "history", seed.assignmentA]);
  assert.equal(first.data.items.length, 50);
  assert.equal(first.data.omittedItemCount, 10);
  assert.deepEqual(first.coverage.gaps, [
    "older-history-omitted",
    "more-pages",
  ]);
  assert.match(first.coverage.notes[0], /not a transcript/);
  assert.ok(
    first.data.items.every(
      (i: Json) => !i.text.includes("Profile revision one"),
    ),
  );
  r = await h.run(["assignment", "history", seed.assignmentA]);
  const more = /More: (cab .*)$/m.exec(r.out)?.[1];
  assert.ok(more, r.out);
  const token = first.pagination.nextCursor as string;
  assert.ok(more.includes(token));
  const second = await ok([
    "assignment",
    "history",
    seed.assignmentA,
    "--cursor",
    token,
  ]);
  assert.equal(second.data.items.length, 10);
  assert.equal(second.coverage.complete, true);
  assert.equal(second.pagination.nextCursor, null);
  assert.deepEqual(
    new Set(
      [...first.data.items, ...second.data.items].map((i: Json) => i.itemId),
    ).size,
    60,
  );
  r = await h.run([
    "assignment",
    "history",
    seed.assignmentB,
    "--cursor",
    token,
  ]);
  assert.equal(r.code, 2, "a token from another assignment");

  // 6. Read-only token, no persisted change, nothing leaked.
  assert.equal(databaseDigest(s.f), before);
  for (const output of h.outputs) {
    assert.deepEqual(leaks(s, output), []);
    assert.ok(!output.includes(read.token));
  }

  // Applying the current revisions makes the binding current.
  const assignment = s.f.service.domain().assignment(seed.assignmentA);
  const applied = await s.sessionPost("/api/operator/commands", {
    type: "assignment.apply",
    key: randomUUID(),
    projectId: seed.projectA,
    assignmentId: seed.assignmentA,
    expectedVersion: Number(assignment.version),
  });
  assert.equal(applied.status, 200);
  r = await h.run(["assignment", "instructions", seed.assignmentA]);
  assert.match(r.out, /Binding: +current/);
});

test("instruction views report unavailable redaction and refuse managed or expired use", async (t) => {
  const { s, seed, h } = await setup(
    t,
    // A value past the per-value size bound makes redaction genuinely unavailable.
    ["x".repeat(64 * 1024 + 1)],
  );
  const r = await h.run([
    "profile",
    "instructions",
    seed.profileId,
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.err);
  const out = r.json() as Json;
  assert.equal(out.data.selected.state, "omitted");
  assert.equal(out.data.selected.text, null);
  assert.deepEqual(out.coverage.gaps, [
    "redaction-unavailable",
    "content-unavailable",
  ]);
  const human = await h.run(["assignment", "instructions", seed.assignmentA]);
  assert.match(human.out, /\[omitted: redaction-unavailable\]/);
  assert.match(human.out, /Gap: redaction-unavailable/);
  assert.ok(!human.out.includes(seed.text.profile[0]!));

  const managed = await h.run(["assignment", "get", seed.assignmentA], {
    env: {
      CAB_CLI_CONFIG_DIR: h.configDir,
      CAB_MANAGED_ASSIGNMENT: "1",
    },
  });
  assert.equal(managed.code, 3);
  const fetched = h.fetches.length;
  const revoked = await s.issue("read", "revoked");
  await h.run([
    "auth",
    "login",
    "--connection",
    "revoked",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(revoked.token),
  ]);
  assert.equal(
    (
      await s.sessionPost(
        `/api/operator/credentials/${revoked.credential.id}/revoke`,
        {},
      )
    ).status,
    200,
  );
  const denied = await h.run([
    "assignment",
    "history",
    seed.assignmentA,
    "--connection",
    "revoked",
  ]);
  assert.equal(denied.code, 3);
  assert.ok(h.fetches.length > fetched);
});
