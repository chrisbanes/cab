import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { COVERAGE_GAPS } from "../../src/cli/browse.js";
import { browseCommands, writeCommands } from "../../src/cli/commands.js";
import { harness } from "../fixtures/cli-harness.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { seedOwnApproval, seedOwnQuestion } from "../fixtures/questions.js";
import { captureNativeResult } from "../fixtures/retained-evidence.js";

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
  "execution list",
  "execution get",
  "execution inputs",
  "logs",
  "doctor",
  "inbox list",
  "question get",
  "approval get",
  "project sources",
  "delivery get",
  "recovery get",
  "runtime list",
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
  "task create",
  "task configure",
  "task add-dependency",
  "task remove-dependency",
  "task message",
  "task follow-up",
  "question answer",
  "approval decide",
  "task stop",
  "task resume",
  "project prepare-source",
  "project preview-source",
  "project place-task",
  "delivery refresh",
  "delivery review-comment",
  "delivery confirm-comment",
  "delivery send-comment",
  "recovery prepare",
  "recovery submit",
  "runtime enable",
  "runtime disable",
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
  const help = await h.run(["--help", "--all"]);
  assert.equal(help.code, 0);
  assert.match(
    help.out,
    /task create, task message, task follow-up, question answer and\napproval decide cannot be undone/,
  );
  assert.match(help.out, /Reverse pairs: task stop\/resume/);
  assert.match(
    help.out,
    /Adoption, recovery and\nconversation replacement cannot be undone/,
  );
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
    "execution.read",
    "diagnostics.read",
    "task.write",
    "attention.read",
    "attention.write",
    "source.write",
    "delivery.write",
    "recovery.read",
    "recovery.write",
  ]);

  const { taskId, projectId, profileId, assignmentId } = native.seeded;
  const args: Record<string, string[]> = {
    "project list": [],
    "profile list": [],
    "project get": [projectId],
    "project sources": [projectId],
    "delivery get": [taskId],
    "recovery get": [assignmentId],
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
  const listed = await h.run([
    "execution",
    "list",
    "--task",
    taskId,
    "--output",
    "json",
  ]);
  const workId = String(listed.json().data.executions[0]?.workId);
  args["execution list"] = ["--task", taskId];
  args["execution get"] = [workId];
  args["execution inputs"] = [workId, "--compare-current"];
  args.logs = ["--execution", workId];
  args.doctor = [];
  const question = await seedOwnQuestion(s.f);
  const approval = await seedOwnApproval(s.f);
  args["inbox list"] = [];
  args["question get"] = [question.taskId, question.interactionId];
  args["approval get"] = [approval.taskId, approval.interactionId];
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
