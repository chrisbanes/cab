import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harness } from "./fixtures/cli-harness.js";
import { databaseDigest } from "./fixtures/database-digest.js";
import { seedInstructionHistory } from "./fixtures/instruction-history.js";
import { startCliService } from "./fixtures/operator-cli.js";
import { captureNativeResult } from "./fixtures/retained-evidence.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;
type After = { after(fn: () => unknown): void };

async function setup(t: After) {
  const s = await startCliService(t);
  const seed = await seedInstructionHistory(s.f);
  t.after(seed.cleanup);
  const h = harness(t);
  for (const [name, scope] of [
    ["ro", "read"],
    ["rw", "read-write"],
  ] as const) {
    const issued = await s.issue(scope, `adopt-${name}`);
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
  const cli = (
    connection: "ro" | "rw",
    args: string[],
    extra: Parameters<typeof h.run>[1] = {},
  ) => h.run([...args, "--connection", connection, "--output", "json"], extra);
  return { s, seed, h, cli, d: s.f.service.domain() };
}

test("adoption rebinds the next turn to current revisions, version-checked", async (t) => {
  const { s, seed, h, cli, d } = await setup(t);
  const version = () => Number(d.assignment(seed.assignmentA).version);
  const v = version();
  let r = await cli("rw", [
    "assignment",
    "apply-current",
    seed.assignmentA,
    "--expected-version",
    String(v),
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const receipt = r.json().data.receipt;
  assert.equal(receipt.kind, "domain");
  assert.equal(receipt.result.version, v + 1);
  assert.equal(
    receipt.result.profileRevision,
    Number(d.profile(seed.profileId).version),
  );
  assert.equal(
    receipt.result.instructionsRevision,
    Number(d.project(seed.projectA).instructionsRevision),
  );
  assert.deepEqual(r.json().request.scope, `project:${seed.projectA}`);
  r = await cli("ro", ["assignment", "instructions", seed.assignmentA]);
  assert.equal(r.json().data.comparison.boundIsCurrent, true);
  const human = await h.run([
    "assignment",
    "apply-current",
    seed.assignmentA,
    "--expected-version",
    String(v),
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /active turn is not rewritten/);
  assert.equal(version(), v + 1, "the journal key replays once");

  // Stale expected version, up front or made stale between read and send.
  const before = databaseDigest(s.f);
  r = await cli("rw", [
    "assignment",
    "apply-current",
    seed.assignmentA,
    "--expected-version",
    String(v),
    "--request-id",
    randomUUID(),
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(databaseDigest(s.f), before);
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: seed.profileId,
    expectedVersion: Number(d.profile(seed.profileId).version),
    summary: "Newer",
  });
  const current = version();
  r = await cli(
    "rw",
    [
      "assignment",
      "apply-current",
      seed.assignmentA,
      "--expected-version",
      String(current),
    ],
    {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith(`/assignments/${seed.assignmentA}`)) {
          const competing = await s.sessionPost("/api/operator/commands", {
            type: "assignment.apply",
            key: randomUUID(),
            projectId: seed.projectA,
            assignmentId: seed.assignmentA,
            expectedVersion: current,
          });
          assert.equal(competing.status, 200);
        }
        return response;
      },
    },
  );
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  assert.equal(version(), current + 1);

  // Denials and usage errors.
  const count = h.fetches.length;
  r = await cli("rw", ["assignment", "apply-current", seed.assignmentA]);
  assert.equal(r.code, 2);
  r = await cli("rw", [
    "assignment",
    "apply-current",
    seed.assignmentA,
    "--expected-version",
    "1",
    "--out",
    "x",
  ]);
  assert.equal(r.code, 2);
  assert.equal(h.fetches.length, count);
  r = await cli("rw", [
    "assignment",
    "apply-current",
    randomUUID(),
    "--expected-version",
    "1",
  ]);
  assert.equal(r.code, 2);
  const unchanged = databaseDigest(s.f);
  r = await cli("ro", [
    "assignment",
    "apply-current",
    seed.assignmentB,
    "--expected-version",
    String(d.assignment(seed.assignmentB).version),
  ]);
  assert.equal(r.code, 3);
  assert.equal(databaseDigest(s.f), unchanged);
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: seed.profileId,
    expectedVersion: Number(d.profile(seed.profileId).version),
    revoked: true,
  });
  r = await cli("rw", [
    "assignment",
    "apply-current",
    seed.assignmentB,
    "--expected-version",
    String(d.assignment(seed.assignmentB).version),
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "policy-denied");
});

test("a lost reply is reconciled with operation get and replays once", async (t) => {
  const { cli, d, s } = await setup(t);
  const native = await captureNativeResult(s.f);
  const { assignmentId, projectId, profileId } = native.seeded;
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId,
    expectedVersion: Number(d.profile(profileId).version),
    instructions: "Newer profile text",
  });
  const v = Number(d.assignment(assignmentId).version);
  const recordedExecution = (
    await cli("ro", ["assignment", "instructions", assignmentId])
  ).json().data.execution as Json;
  assert.ok(recordedExecution, "the fixture records an execution request");
  const args = [
    "assignment",
    "apply-current",
    assignmentId,
    "--expected-version",
    String(v),
  ];
  let r = await cli("rw", args, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/api/operator/commands"))
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return response;
    },
  });
  assert.equal(r.code, 6, r.out);
  const error = r.json().error;
  assert.equal(error.outcome, "unknown");
  assert.equal(error.retryable, true);
  assert.equal(error.request.scope, `project:${projectId}`);
  assert.equal(error.request.type, "assignment.apply");
  r = await cli("ro", [
    "operation",
    "get",
    error.request.key,
    "--scope",
    `project:${projectId}`,
    "--type",
    "assignment.apply",
  ]);
  assert.equal(r.json().data.state, "recorded");
  const recorded = r.json().data.receipt;
  r = await cli("rw", args);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json().data.receipt, recorded);
  r = await cli("rw", [...args, "--request-id", error.request.key]);
  assert.deepEqual(r.json().data.receipt, recorded);
  assert.equal(Number(d.assignment(assignmentId).version), v + 1);
  r = await cli("ro", ["assignment", "instructions", assignmentId]);
  // The recorded request keeps its revisions; it no longer matches the binding.
  const execution = r.json().data.execution as Json | null;
  assert.notEqual(execution?.matchesBound, true);
  if (execution)
    assert.deepEqual(
      [execution.profileRevision, execution.instructionsRevision],
      [
        recordedExecution.profileRevision,
        recordedExecution.instructionsRevision,
      ],
    );
  assert.equal(r.json().data.comparison.boundIsCurrent, true);
});
