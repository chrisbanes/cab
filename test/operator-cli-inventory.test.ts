import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { COVERAGE_GAPS } from "../src/cli/browse.js";
import { browseCommands, writeCommands } from "../src/cli/commands.js";
import { harness } from "./fixtures/cli-harness.js";
import { databaseDigest } from "./fixtures/database-digest.js";
import { startCliService } from "./fixtures/operator-cli.js";
import { captureNativeResult } from "./fixtures/retained-evidence.js";

/** The documented CLI2 browse inventory (docs/development.md#operator-cli). */
const documented = [
  "project list",
  "profile list",
  "project get",
  "profile get",
  "task list",
  "task search",
  "task messages",
  "project instructions",
  "profile instructions",
  "project revisions",
  "profile revisions",
  "assignment get",
  "assignment history",
  "assignment instructions",
  "result list",
  "result get",
  "result evidence",
  "artifact get",
  "capacity get",
];

/** The documented CLI3 configuration, adoption and receipt commands. */
const documentedWrites = [
  "profile prepare",
  "profile prepare-create",
  "profile apply",
  "project prepare",
  "project prepare-create",
  "project prepare-routing",
  "project apply",
  "capacity prepare",
  "capacity apply",
  "assignment apply-current",
  "operation get",
];

test("every documented browse command runs read-only with a coverage envelope", async (t) => {
  assert.deepEqual([...browseCommands.keys()].sort(), [...documented].sort());
  assert.deepEqual(
    [...writeCommands.keys()].sort(),
    [...documentedWrites].sort(),
  );
  const s = await startCliService(t);
  const native = await captureNativeResult(s.f, { withArtifact: true });
  const h = harness(t);
  const help = await h.run(["--help"]);
  assert.equal(help.code, 0);
  for (const command of [...browseCommands.values(), ...writeCommands.values()])
    assert.ok(help.out.includes(command.usage), command.usage);

  const read = await s.issue("read", "inventory");
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
  const identity = await (
    await s.bearer(read.token, "/api/operator/cli")
  ).json();
  assert.deepEqual((identity as { capabilities: string[] }).capabilities, [
    "cli.identity",
    "task.read",
    "workspace.read",
    "task.list",
    "task.search",
    "task.records",
    "assignment.read",
    "instructions.read",
    "result.read",
    "artifact.read",
    "configuration.write",
    "operation.read",
    "capacity.read",
    "configuration.impact",
  ]);

  const { taskId, projectId, profileId, assignmentId } = native.seeded;
  const args: Record<string, string[]> = {
    "project list": [],
    "profile list": [],
    "project get": [projectId],
    "profile get": [profileId],
    "task list": [],
    "task search": ["evidence", "--historical"],
    "task messages": [taskId],
    "project instructions": [projectId],
    "profile instructions": [profileId, "--revision", "1"],
    "project revisions": [projectId],
    "profile revisions": [profileId],
    "assignment get": [assignmentId],
    "assignment history": [assignmentId],
    "assignment instructions": [assignmentId],
    "result list": [taskId],
    "result get": [taskId, native.resultId],
    "result evidence": [taskId, native.resultId, native.textItem.itemId],
    "capacity get": [],
    "artifact get": [
      taskId,
      native.artifactId!,
      "--out",
      join(h.dir, "artifact.png"),
    ],
  };
  const before = databaseDigest(s.f);
  for (const key of documented) {
    const r = await h.run([
      ...key.split(" "),
      ...(args[key] ?? []),
      "--output",
      "json",
    ]);
    assert.equal(r.code, 0, `${key}: ${r.err}${r.out}`);
    const envelope = r.json();
    assert.equal(envelope.schema, "ensemble.cli/v1", key);
    assert.equal(typeof envelope.coverage.observedAt, "number", key);
    assert.equal(
      envelope.coverage.complete,
      envelope.coverage.gaps.length === 0,
      key,
    );
    for (const gap of envelope.coverage.gaps)
      assert.ok((COVERAGE_GAPS as readonly string[]).includes(gap), gap);
  }
  assert.equal(databaseDigest(s.f), before);
});
