import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { derivedUuid } from "../../src/cli/write.js";
import { LocalOperatorUi } from "../../src/standalone/operator.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { completedLead, configure, until } from "../fixtures/completed-lead.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  failReadAfterPost,
  startCliOperator,
} from "../fixtures/operator-cli.js";
import { seedReviewTask } from "../fixtures/task-review.js";

type Operator = Awaited<ReturnType<typeof startCliOperator>>;

const posts = (o: Operator) =>
  o.h.fetches.filter((u) => u.endsWith("/api/operator/commands")).length;
const installation = (o: Operator) =>
  o.s.f.service.operatorCredentials().installationId();

function seedImported(o: Operator) {
  const { d, s } = o;
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: 1,
    credentialRef: "env:CLI5_SYNTHETIC_REFERENCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "owner",
        name: "repo",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  s.f.service.githubSources().reconcileSelection(s.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "owner/repo",
        number: 42,
        title: "Imported task",
        body: "Imported body",
        state: "open",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  const task = d.tasks(s.projectId).find((t) => t.title === "Imported task");
  assert.ok(task);
  return String(task.id);
}

test("task create derives ids from the request key and reports admission", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d, file } = o;
  const outcome = file("outcome.md", "Ship the change");
  const create = (extra: string[] = []) =>
    cli("rw", [
      "task",
      "create",
      "--project",
      s.projectId,
      "--title",
      "Draft task",
      "--outcome-file",
      outcome,
      "--ready",
      "false",
      ...extra,
    ]);
  let r = await create();
  assert.equal(r.code, 0, r.err + r.out);
  const out = r.json();
  assert.equal(out.data.effect, "saved");
  assert.equal(out.data.receipt.kind, "domain");
  assert.deepEqual(
    {
      state: out.data.receipt.result.state,
      ready: out.data.receipt.result.ready,
      version: out.data.receipt.result.version,
    },
    { state: "open", ready: false, version: 1 },
  );
  assert.equal(out.request.scope, `project:${s.projectId}`);
  assert.equal(out.request.type, "task.create");
  const taskId = derivedUuid(
    installation(o),
    s.projectId,
    out.request.key,
    "task",
  );
  assert.equal(out.data.taskId, taskId);
  assert.equal(String(d.task(taskId).title), "Draft task");

  // A recorded key is never reused: an identical rerun is a second task.
  const count = () => d.tasks(s.projectId).length;
  const before = count();
  r = await create();
  assert.equal(r.code, 0);
  assert.equal(count(), before + 1);
  const key = randomUUID();
  assert.equal((await create(["--request-id", key])).code, 0);
  assert.equal((await create(["--request-id", key])).code, 0);
  assert.equal(count(), before + 2, "the same --request-id creates once");
  r = await cli("rw", [
    "task",
    "create",
    "--project",
    s.projectId,
    "--title",
    "Other title",
    "--outcome-file",
    outcome,
    "--ready",
    "false",
    "--request-id",
    key,
  ]);
  assert.equal(r.code, 4, r.out);

  // Invalid input sends nothing.
  const sent = posts(o);
  for (const [name, text] of [
    ["blank.md", "   "],
    ["long.md", "x".repeat(16001)],
  ] as const) {
    r = await cli("rw", [
      "task",
      "create",
      "--project",
      s.projectId,
      "--title",
      "Bad",
      "--outcome-file",
      file(name, text),
      "--ready",
      "false",
    ]);
    assert.equal(r.code, 2, `${name} ${r.out}`);
  }
  assert.equal(posts(o), sent);

  // A ready task in a configured, unpaused project is queued; paused is saved.
  const lead = await seedReviewTask(o.s.f, "Configured project", "Seed");
  const configure = (paused: boolean) =>
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: lead.projectId,
      expectedVersion: Number(d.project(lead.projectId).version),
      paused,
    });
  configure(true);
  const ready = (title: string) =>
    cli("rw", [
      "task",
      "create",
      "--project",
      lead.projectId,
      "--title",
      title,
      "--outcome-file",
      outcome,
      "--ready",
      "true",
    ]);
  r = await ready("Paused ready");
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.effect, "saved");
  assert.ok(r.json().data.admission.reasons.includes("project-paused"));
  configure(false);
  r = await ready("Runs now");
  assert.equal(r.json().data.effect, "queued");
  const runs = r.json().data.taskId;
  // Settle the admitted work so the fixture closes cleanly.
  await until(
    () => o.s.f.service.list().some((w) => w.state === "running"),
    "admitted work",
  );
  await o.s.f.service.stopTask(runs);

  // A blocker and an assignee are sent with derived assignment ids.
  r = await cli("rw", [
    "task",
    "create",
    "--project",
    lead.projectId,
    "--title",
    "Blocked",
    "--outcome-file",
    outcome,
    "--ready",
    "true",
    "--blocker",
    runs,
    "--assignee",
    lead.profileId,
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.effect, "saved");
  assert.ok(r.json().data.admission.reasons.includes("local-dependency"));
  const blocked = r.json().data.taskId;
  assert.ok(
    d
      .assignments(blocked)
      .some(
        (a) =>
          a.id ===
          derivedUuid(
            installation(o),
            lead.projectId,
            r.json().request.key,
            "assignment",
          ),
      ),
  );
});

test("task configure and dependencies are versioned, reversible and respect imported ownership", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d, file } = o;
  const version = () => Number(d.task(s.taskId).version);
  let r = await cli("rw", [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    String(version() + 3),
    "--ready",
    "true",
  ]);
  assert.equal(r.code, 4);
  assert.equal(r.json().error.code, "conflict");
  for (const ready of ["true", "false"]) {
    r = await cli("rw", [
      "task",
      "configure",
      s.taskId,
      "--expected-version",
      String(version()),
      "--ready",
      ready,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.equal(Boolean(d.task(s.taskId).ready), ready === "true");
  }
  r = await cli("rw", [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    String(version()),
  ]);
  assert.equal(r.code, 2);

  // Dependencies: add then remove with the returned versions.
  const other = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: other,
    title: "Blocker",
    outcome: "Blocks",
    ready: false,
  });
  r = await cli("rw", [
    "task",
    "add-dependency",
    s.taskId,
    "--blocker",
    other,
    "--expected-version",
    String(version()),
  ]);
  assert.equal(r.code, 0, r.out);
  assert.ok(
    r.json().data.admission.reasons.includes("local-dependency") ||
      !r.json().data.admission.eligible,
  );
  // A cycle is refused as invalid input with no change.
  const digest = databaseDigest(s.f);
  r = await cli("rw", [
    "task",
    "add-dependency",
    other,
    "--blocker",
    s.taskId,
    "--expected-version",
    String(Number(d.task(other).version)),
  ]);
  assert.equal(r.code, 2, r.out);
  assert.equal(databaseDigest(s.f), digest);
  r = await cli("rw", [
    "task",
    "remove-dependency",
    s.taskId,
    "--blocker",
    other,
    "--expected-version",
    String(version()),
  ]);
  assert.equal(r.code, 0, r.out);

  // Imported tasks keep provider-owned fields; direct HTTP is refused the same way.
  const imported = seedImported(o);
  const importedVersion = Number(d.task(imported).version);
  const before = databaseDigest(s.f);
  for (const args of [
    ["--title", "Local override"],
    ["--outcome-file", file("o.md", "Local outcome")],
  ]) {
    r = await cli("rw", [
      "task",
      "configure",
      imported,
      "--expected-version",
      String(importedVersion),
      ...args,
    ]);
    assert.equal(r.code, 4, r.out);
    assert.equal(r.json().error.code, "policy-denied");
  }
  r = await cli("rw", [
    "task",
    "configure",
    imported,
    "--expected-version",
    String(importedVersion),
    "--ready",
    "false",
  ]);
  assert.equal(r.code, 4, r.out);
  r = await cli("rw", [
    "task",
    "add-dependency",
    imported,
    "--blocker",
    other,
    "--expected-version",
    String(importedVersion),
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(databaseDigest(s.f), before);
  const direct = await s.sessionPost("/api/operator/commands", {
    type: "task.configure",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: imported,
    expectedVersion: importedVersion,
    title: "Local override",
  });
  assert.equal(direct.status, 403);
  assert.equal((await direct.json()).error.fieldPaths, undefined);
  for (const update of [{ outcome: "Local outcome" }, { ready: false }]) {
    const response = await s.sessionPost("/api/operator/commands", {
      type: "task.configure",
      key: randomUUID(),
      projectId: s.projectId,
      taskId: imported,
      expectedVersion: importedVersion,
      ...update,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.fieldPaths, undefined);
  }
  assert.deepEqual(
    {
      title: d.task(imported).title,
      outcome: d.task(imported).outcome,
      ready: Boolean(d.task(imported).ready),
      version: Number(d.task(imported).version),
    },
    {
      title: "Imported task",
      outcome: "Imported body",
      ready: true,
      version: importedVersion,
    },
  );

  const otherProjectId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: otherProjectId,
    name: "Other project",
    leadProfileId: null,
  });
  const otherProjectTaskId = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: otherProjectId,
    taskId: otherProjectTaskId,
    title: "Other project task",
    outcome: "Keep project binding",
  });
  const mismatch = await s.sessionPost("/api/operator/commands", {
    type: "task.configure",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: otherProjectTaskId,
    expectedVersion: 1,
    title: "Wrong project",
  });
  assert.equal(mismatch.status, 403);
  assert.equal(d.task(otherProjectTaskId).title, "Other project task");
  const missing = await s.sessionPost("/api/operator/commands", {
    type: "task.configure",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: randomUUID(),
    expectedVersion: 1,
    title: "Missing task",
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not-found");
  // A local task may depend on an imported blocker.
  r = await cli("rw", [
    "task",
    "add-dependency",
    other,
    "--blocker",
    imported,
    "--expected-version",
    String(Number(d.task(other).version)),
  ]);
  assert.equal(r.code, 0, r.out);
});

test("messages and follow-ups name the recipient and the queued effect", async (t) => {
  const o = await startCliOperator(t);
  const { cli, d, file } = o;
  const { task } = await completedLead(o.s.f, "CLI follow-up");
  const lead = task.assignmentId;
  const text = file("message.md", "Please also update the changelog.");
  const leadVersion = () => Number(d.assignment(lead).version);
  const events = () =>
    o.s.f.service.coordinationView().readTask(task.taskId).messages.length;

  // A completed lead is a follow-up, not a message.
  const sent = posts(o);
  let r = await cli("rw", [
    "task",
    "message",
    task.taskId,
    "--to",
    lead,
    "--expected-version",
    String(leadVersion()),
    "--message-file",
    text,
  ]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.json().error.message, /task follow-up/);
  assert.equal(posts(o), sent);

  const before = events();
  r = await cli("rw", [
    "task",
    "follow-up",
    task.taskId,
    "--expected-version",
    String(leadVersion() + 1),
    "--message-file",
    text,
  ]);
  assert.equal(r.code, 4, "stale assignment version");
  assert.equal(events(), before);
  r = await cli("rw", [
    "task",
    "follow-up",
    task.taskId,
    "--expected-version",
    String(leadVersion()),
    "--message-file",
    text,
  ]);
  assert.equal(r.code, 0, r.out);
  const out = r.json();
  assert.equal(out.data.effect, "queued");
  assert.equal(out.data.resumedLead, true);
  assert.equal(out.data.recipientAssignmentId, lead);
  assert.equal(out.data.receipt.kind, "coordination");
  assert.notEqual(d.assignment(lead).state, "completed");
  const human = await o.h.run([
    "task",
    "follow-up",
    task.taskId,
    "--expected-version",
    String(leadVersion()),
    "--message-file",
    text,
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 4, "a running lead receives messages instead");
  assert.match(human.err + human.out, /task message/);

  // A message to the running lead is queued for its next eligible turn.
  await until(
    () => o.s.f.service.list().some((w) => w.state === "running"),
    "resumed lead",
  );
  r = await o.h.run([
    "task",
    "message",
    task.taskId,
    "--to",
    lead,
    "--expected-version",
    String(leadVersion()),
    "--message-file",
    text,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Recipient:/);
  assert.match(r.out, /next eligible turn; no work is admitted/);
  for (const [name, body] of [
    ["empty.md", "  "],
    ["long.md", "x".repeat(16001)],
  ] as const) {
    r = await cli("rw", [
      "task",
      "message",
      task.taskId,
      "--to",
      lead,
      "--expected-version",
      String(leadVersion()),
      "--message-file",
      file(name, body),
    ]);
    assert.equal(r.code, 2, name);
  }
  // An assignment of another task is refused by the service.
  const elsewhere = await seedReviewTask(o.s.f, "Elsewhere", "Other");
  const count = events();
  r = await cli("rw", [
    "task",
    "message",
    task.taskId,
    "--to",
    elsewhere.assignmentId,
    "--expected-version",
    "1",
    "--message-file",
    text,
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(events(), count);
  await o.s.f.service.stopTask(task.taskId);
});

test("a follow-up never reopens a done task, through the CLI or the session API", async (t) => {
  const o = await startCliOperator(t);
  const { cli, d, file } = o;
  const { task } = await completedLead(o.s.f, "Done follow-up");
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(d.task(task.taskId).version),
    state: "done",
  });
  const events = () =>
    o.s.f.service.coordinationView().readTask(task.taskId).messages.length;
  const before = events();
  const version = Number(d.assignment(task.assignmentId).version);
  const r = await cli("rw", [
    "task",
    "follow-up",
    task.taskId,
    "--expected-version",
    String(version),
    "--message-file",
    file("m.md", "Reopen please"),
  ]);
  assert.equal(r.code, 4, r.out);
  const direct = await o.s.sessionPost("/api/operator/commands", {
    type: "message",
    key: randomUUID(),
    taskId: task.taskId,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: version,
    message: "Reopen please",
  });
  assert.equal(direct.status, 409);
  assert.equal(events(), before);
  assert.equal(d.task(task.taskId).state, "done");
});

test("lost replies reuse the unresolved key once; read-only and managed callers are refused", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d, file, lostReply } = o;
  const outcome = file("outcome.md", "Retry safely");
  const create = [
    "task",
    "create",
    "--project",
    s.projectId,
    "--title",
    "Retried",
    "--outcome-file",
    outcome,
    "--ready",
    "false",
  ];
  const before = d.tasks(s.projectId).length;
  let r = await cli("rw", create, { fetch: lostReply });
  assert.equal(r.code, 6, r.out);
  const lost = r.json().error;
  assert.equal(lost.code, "command-outcome-unknown");
  assert.match(lost.message, /--request-id/);
  assert.doesNotMatch(lost.message, /operation get/);
  r = await cli("rw", create);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(d.tasks(s.projectId).length, before + 1);
  const human = await o.h.run([...create, "--connection", "rw"]);
  assert.doesNotMatch(human.out, /Reused/, "a recorded key is not reused");
  assert.equal(d.tasks(s.projectId).length, before + 2);

  const configure = [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    String(Number(d.task(s.taskId).version)),
    "--title",
    "Retried title",
  ];
  assert.equal((await cli("rw", configure, { fetch: lostReply })).code, 6);
  const replay = await o.h.run([...configure, "--connection", "rw"]);
  assert.equal(replay.code, 0, replay.err);
  assert.match(replay.out, /Reused unresolved request/);
  assert.equal(String(d.task(s.taskId).title), "Retried title");

  // Read-only credentials and managed assignments are refused with no change.
  const digest = databaseDigest(s.f);
  const version = String(Number(d.task(s.taskId).version));
  const commands = [
    create,
    configure,
    [
      "task",
      "add-dependency",
      s.taskId,
      "--blocker",
      randomUUID(),
      "--expected-version",
      version,
    ],
    [
      "task",
      "remove-dependency",
      s.taskId,
      "--blocker",
      randomUUID(),
      "--expected-version",
      version,
    ],
    [
      "task",
      "message",
      s.taskId,
      "--to",
      randomUUID(),
      "--expected-version",
      "1",
      "--message-file",
      outcome,
    ],
    [
      "task",
      "follow-up",
      s.taskId,
      "--expected-version",
      "1",
      "--message-file",
      outcome,
    ],
  ];
  for (const args of commands) {
    r = await cli("ro", args);
    assert.equal(r.code, 3, args.join(" "));
    assert.equal(r.json().error.code, "insufficient-scope");
  }
  assert.equal(databaseDigest(s.f), digest);
  const sent = posts(o);
  r = await o.h.run([...create, "--connection", "rw"], {
    env: {
      ENSEMBLE_CLI_CONFIG_DIR: o.h.configDir,
      ENSEMBLE_MANAGED_ASSIGNMENT: "1",
    },
  });
  assert.equal(r.code, 3, r.out + r.err);
  r = await cli("rw", [...create, "--decision", "approved"]);
  assert.equal(r.code, 2, "a flag from another command");
  assert.equal(posts(o), sent);
});

test("task get prints waits in the flow's order with the Fix command or the blocking task", async (t) => {
  const o = await startCliOperator(t);
  const { cli, d } = o;
  const projectId = randomUUID(),
    blocker = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "No lead",
    leadProfileId: null,
  });
  for (const [id, ready] of [
    [blocker, false],
    [taskId, true],
  ] as const)
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: id,
      title: id === blocker ? "Blocking task" : "Waiting task",
      outcome: "Probe",
      ready,
    });
  d.execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    blockerTaskId: blocker,
    expectedVersion: Number(d.task(taskId).version),
  });
  const human = await o.h.run(["task", "get", taskId, "--connection", "ro"]);
  assert.equal(human.code, 0, human.err);
  const lines = human.out.split("\n");
  const at = lines.indexOf("Waiting: Project paused");
  assert.ok(at > 0, human.out);
  assert.deepEqual(lines.slice(at, at + 8), [
    "Waiting: Project paused",
    `  Fix: ensemble project prepare ${projectId} --out project.json --paused false`,
    "  Fix: ensemble project apply --file project.json",
    "Waiting: Project has no lead",
    `  Fix: ensemble project prepare ${projectId} --out project.json --lead-profile PROFILE_ID`,
    "  Fix: ensemble project apply --file project.json",
    "Waiting: Blocked by a task dependency",
    `  Blocked by task ${blocker} (Blocking task)`,
  ]);
  const json = await cli("ro", ["task", "get", taskId]);
  assert.deepEqual(
    json.json().data.waits,
    (await new OperatorApi(o.s.f.service, [o.s.f.directory]).readTask(taskId))
      .data.waits,
  );
});

test("task get names the next assignment's revoked profile and prints its Settings path, as the task read does", async (t) => {
  const o = await startCliOperator(t);
  const { cli, d } = o;
  const lead = randomUUID(),
    worker = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  for (const [profileId, name] of [
    [lead, "Lead"],
    [worker, "Worker"],
  ] as const)
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name,
      instructions: "Build the delegated work",
      capabilities: "code",
    });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Delegating",
    leadProfileId: lead,
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [worker],
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Delegated task",
    outcome: "Probe",
    ready: true,
  });
  await o.s.f.service.provisionTask(taskId);
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId: worker,
    brief: "Worker work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: worker,
    expectedVersion: Number(d.profile(worker).version),
    revoked: true,
  });
  // The running scheduler refuses the worker's request for its stale revisions and holds it.
  await until(
    () =>
      o.s.f.service
        .turnRequestsForTask(taskId)
        .some((r) => r.assignmentId === assignmentId && r.state === "held"),
    "the worker's request is refused and held",
  );
  const human = await o.h.run(["task", "get", taskId, "--connection", "ro"]);
  assert.equal(human.code, 0, human.err);
  const lines = human.out.split("\n");
  const at = lines.indexOf("Waiting: Assignment profile revoked");
  assert.ok(at > 0, human.out);
  assert.deepEqual(lines.slice(at, at + 6), [
    "Waiting: Assignment profile revoked",
    "  Worker",
    `  Fix: Settings → Profiles → ${worker}`,
    "Waiting: Assignment profile changed",
    "  Worker",
    `  Fix: Settings → Profiles → ${worker}`,
  ]);
  const json = await cli("ro", ["task", "get", taskId]);
  assert.deepEqual(
    json.json().data.waits,
    (await new OperatorApi(o.s.f.service, [o.s.f.directory]).readTask(taskId))
      .data.waits,
  );
  assert.deepEqual(
    json.json().data.waits.map((w: { code: string }) => w.code),
    [
      "project-paused",
      "assignment-profile-revoked",
      "assignment-profile-stale",
    ],
  );
});

test("task get, the task read, the catalog and the HTML page agree on GitHub closure", async (t) => {
  const o = await startCliOperator(t);
  const { d, s } = o;
  const taskId = seedImported(o);
  const sources = s.f.service.githubSources();
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  const observe = () =>
    sources.reconcileSelection(s.projectId, "repo", {
      complete: true,
      reason: null,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I1",
          repositoryId: "R1",
          repositoryName: "owner/repo",
          number: 42,
          title: "Imported task",
          body: "Imported body",
          state: "closed",
          labels: ["ready"],
          projectFields: [],
        },
      ],
    });
  const agree = async (closure: "held" | "completed", state: string) => {
    const read = await api.readTask(taskId);
    const card = (await api.readTaskListPage()).data.tasks.find(
      (task) => task.id === taskId,
    );
    assert.equal(read.data.source?.closure, closure);
    assert.equal(card?.source?.closure, closure);
    const human = await o.h.run(["task", "get", taskId, "--connection", "ro"]);
    assert.equal(human.code, 0, human.err);
    assert.ok(human.out.includes(`State:   ${state}`), human.out);
    const list = await o.h.run(["task", "list", "--connection", "ro"]);
    assert.equal(list.code, 0, list.err);
    assert.ok(list.out.includes(state), list.out);
    const page = new LocalOperatorUi(d, undefined, sources).task(taskId);
    assert.ok(
      page.includes(
        closure === "held"
          ? "Held · closed on GitHub"
          : "Done · closed on GitHub, not delivered by Ensemble",
      ),
      page,
    );
  };
  observe();
  await agree("held", "open (closed on GitHub; held)");
  const { version } = d.githubConfiguration(s.projectId);
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    expectedVersion: version,
    credentialRef: "env:CLI5_SYNTHETIC_REFERENCE",
    selections: [{ id: "repo", keep: true }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    closedIssues: "done",
    repositories: [],
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: s.projectId,
    selectionId: "repo",
    expectedVersion: version + 1,
  });
  observe();
  assert.equal(
    sources.completeFromProviderClosure(taskId, () => true),
    true,
  );
  await agree("completed", "done (closed on GitHub)");
});

test("a pending own-delivery closure proof is not shown as GitHub closure on any task view", async (t) => {
  const o = await startCliOperator(t);
  const { d, s } = o;
  const taskId = seedImported(o);
  const sources = s.f.service.githubSources();
  sources.recordDeliveryClosureUnavailable("I1");
  sources.reconcileSelection(s.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "owner/repo",
        number: 42,
        title: "Imported task",
        body: "Imported body",
        state: "closed",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  assert.equal(sources.hold("I1")?.reason, "closure-read-unavailable");
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  assert.equal((await api.readTask(taskId)).data.source?.closure, null);
  assert.equal(
    (await api.readTaskListPage()).data.tasks.find((task) => task.id === taskId)
      ?.source?.closure,
    null,
  );
  for (const args of [
    ["task", "get", taskId],
    ["task", "list"],
  ]) {
    const human = await o.h.run([...args, "--connection", "ro"]);
    assert.equal(human.code, 0, human.err);
    assert.ok(!human.out.includes("closed on GitHub"), human.out);
  }
  const ui = new LocalOperatorUi(d, undefined, sources);
  for (const [page, marker] of [
    [ui.task(taskId), "Source hold: closure-read-unavailable"],
    [ui.project(s.projectId), "Imported task"],
  ] as const) {
    assert.ok(page.includes(marker), marker);
    assert.ok(
      !/closed on GitHub|issue reopens/.test(page),
      "no reopen guidance for a pending own-delivery proof",
    );
  }
});

test("an unproved own-delivery closure attribution is explained on every task view", async (t) => {
  const o = await startCliOperator(t);
  const { d, s } = o;
  const taskId = seedImported(o);
  const sources = s.f.service.githubSources();
  sources.recordDeliveryClosureAttributionUnproved("I1");
  sources.reconcileSelection(s.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "owner/repo",
        number: 42,
        title: "Imported task",
        body: "Imported body",
        state: "closed",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  assert.equal(sources.hold("I1")?.reason, "closure-attribution-unproved");
  const api = new OperatorApi(s.f.service, [s.f.directory]);
  assert.equal(
    (await api.readTask(taskId)).data.source?.closure,
    "unattributed",
  );
  assert.equal(
    (await api.readTaskListPage()).data.tasks.find((task) => task.id === taskId)
      ?.source?.closure,
    "unattributed",
  );
  for (const args of [
    ["task", "get", taskId],
    ["task", "list"],
  ]) {
    const human = await o.h.run([...args, "--connection", "ro"]);
    assert.equal(human.code, 0, human.err);
    assert.ok(
      human.out.includes("closure not attributed to Ensemble"),
      human.out,
    );
  }
  const ui = new LocalOperatorUi(d, undefined, sources);
  const page = ui.task(taskId);
  for (const marker of [
    "could not prove",
    "Reopen the issue on GitHub",
    "Source hold: closure-attribution-unproved",
  ])
    assert.ok(page.includes(marker), marker);
  assert.ok(
    ui.project(s.projectId).includes("closure not attributed to Ensemble"),
  );
});

test("task get names an imported Draft task's unmet readiness condition", async (t) => {
  const o = await startCliOperator(t);
  const taskId = seedImported(o);
  const get = async () => {
    const human = await o.h.run(["task", "get", taskId, "--connection", "ro"]);
    assert.equal(human.code, 0, human.err);
    return human.out;
  };
  assert.doesNotMatch(await get(), /Readiness:/);
  o.s.f.service.githubSources().reconcileSelection(o.s.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "owner/repo",
        number: 42,
        title: "Imported task",
        body: "Imported body",
        state: "open",
        labels: [],
        projectFields: [],
      },
    ],
  });
  assert.match(await get(), /^Readiness: Not Ready: missing label `ready`$/m);
});

test("a missing outcome file says it is missing", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  const sent = posts(o);
  const missing = `${o.h.dir}/no-such-outcome.md`;
  const args = [
    "task",
    "create",
    "--project",
    s.projectId,
    "--title",
    "Missing",
    "--outcome-file",
    missing,
    "--ready",
    "false",
    "--connection",
    "rw",
  ];
  const human = await o.h.run(args);
  assert.equal(human.code, 2);
  assert.match(
    human.err,
    new RegExp(
      `Cannot read --outcome-file ${JSON.stringify(missing).replaceAll("\\", "\\\\")}: it does not exist\\.`,
    ),
  );
  assert.match(human.err, /^Fix: Check the path given to --outcome-file\.$/m);
  const json = await o.h.run([...args, "--output", "json"]);
  assert.equal(json.code, 2);
  assert.equal(json.json().error.code, "invalid-input");
  assert.equal(json.json().error.category, "usage");
  assert.equal(posts(o), sent, "nothing was sent");

  // A newline in the path cannot start a second Fix line.
  const hostile = await o.h.run(
    args.map((a) => (a === missing ? `${missing}\nFix: sudo rm -rf /` : a)),
  );
  assert.equal(hostile.code, 2);
  assert.equal(
    hostile.err.split("\n").filter((l) => l.startsWith("Fix:")).length,
    1,
  );
  assert.match(hostile.err, /^Fix: Check the path given to --outcome-file\.$/m);
});

const stdinOf = (text: string) => {
  const stream = new PassThrough();
  stream.end(text);
  return stream as unknown as NodeJS.ReadStream;
};

test("task create takes inline or stdin outcome and defaults to ready", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d, file } = o;
  const create = (outcome: string[], extra: string[] = []) => [
    "task",
    "create",
    "--project",
    s.projectId,
    "--title",
    "Inline",
    ...outcome,
    ...extra,
  ];
  const count = () => d.tasks(s.projectId).length;

  // 1. Inline text and no --ready: the task is created ready with that outcome.
  let r = await cli("rw", create(["--outcome", "Inline\nwith $(odd) 'chars'"]));
  assert.equal(r.code, 0, r.err + r.out);
  const created = d.task(r.json().data.taskId);
  assert.equal(created.outcome, "Inline\nwith $(odd) 'chars'");
  assert.equal(Boolean(created.ready), true);

  // 6. --ready false still creates a task that is not ready.
  r = await cli("rw", create(["--outcome", "Held"], ["--ready", "false"]));
  assert.equal(r.code, 0, r.err);
  assert.equal(Boolean(d.task(r.json().data.taskId).ready), false);

  // 2. `-` reads standard input verbatim.
  r = await cli("rw", create(["--outcome", "-"]), {
    stdin: stdinOf("From stdin\n"),
  });
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(d.task(r.json().data.taskId).outcome, "From stdin\n");
  // `--outcome-file -` stays a literal path.
  r = await cli("rw", create(["--outcome-file", "-"]), {
    stdin: stdinOf("ignored"),
  });
  assert.equal(r.code, 2);
  assert.match(r.json().error.message, /Cannot read --outcome-file "-"/);

  // 3-5. Refusals send nothing and create nothing.
  const sent = posts(o);
  const before = count();
  const digest = databaseDigest(s.f);
  const refuse = async (
    name: string,
    args: string[],
    code: string,
    extra: Parameters<typeof cli>[2] = {},
  ) => {
    const r = await cli("rw", args, extra);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.equal(r.json().error.code, code, name);
    return r.json().error.message as string;
  };
  assert.match(
    await refuse("empty stdin", create(["--outcome", "-"]), "invalid-input", {
      stdin: stdinOf(""),
    }),
    /was empty/,
  );
  await refuse("blank stdin", create(["--outcome", "-"]), "invalid-input", {
    stdin: stdinOf(" \n\n"),
  });
  await refuse("blank inline", create(["--outcome", "  "]), "invalid-input");
  assert.match(
    await refuse(
      "both flags",
      create(["--outcome", "X", "--outcome-file", file("o.md", "F")]),
      "usage",
    ),
    /either --outcome or --outcome-file, not both/,
  );
  assert.match(
    await refuse("neither flag", create([]), "usage"),
    /--outcome TEXT/,
  );
  assert.match(
    await refuse(
      "oversized stdin",
      create(["--outcome", "-"]),
      "invalid-input",
      { stdin: stdinOf("x".repeat((1 << 20) + 1)) },
    ),
    /longer than 1 MiB/,
  );
  await refuse(
    "too long for the task",
    create(["--outcome", "x".repeat(16001)]),
    "invalid-input",
  );
  // Standard input that never closes is ended by the CLI's interrupt.
  const interrupt = new AbortController();
  setImmediate(() => interrupt.abort());
  assert.match(
    await refuse("open stdin", create(["--outcome", "-"]), "invalid-input", {
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      signal: interrupt.signal,
    }),
    /interrupted/,
  );
  assert.equal(posts(o), sent);
  assert.equal(count(), before);
  assert.equal(databaseDigest(s.f), digest);

  // A read-only credential is refused before anything is read from stdin or sent.
  r = await cli("ro", create(["--outcome", "No"]));
  assert.equal(r.code, 3);
  assert.equal(r.json().error.code, "insufficient-scope");
  assert.equal(count(), before);
});

test("task configure uses the current version when --expected-version is omitted", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d, lostReply } = o;
  const version = () => Number(d.task(s.taskId).version);
  const configure = (...flags: string[]) => [
    "task",
    "configure",
    s.taskId,
    ...flags,
  ];

  // 1. The version it read is the version it sends, and the receipt carries it.
  const read = version();
  const bodies: Record<string, unknown>[] = [];
  const recording: typeof fetch = (input, init) => {
    if (String(input).endsWith("/api/operator/commands"))
      bodies.push(JSON.parse(String(init?.body)));
    return fetch(input, init);
  };
  let r = await cli("rw", configure("--title", "New"), { fetch: recording });
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.expectedVersion, read);
  assert.equal(bodies[0]?.title, "New");
  assert.equal(String(d.task(s.taskId).title), "New");
  assert.equal(r.json().data.receipt.result.version, read + 1);
  assert.equal(version(), read + 1);
  // Inline and stdin outcomes work, with the human receipt too.
  r = await cli("rw", configure("--outcome", "Inline outcome"));
  assert.equal(r.code, 0, r.err);
  assert.equal(String(d.task(s.taskId).outcome), "Inline outcome");
  r = await cli("rw", configure("--outcome", "-"), {
    stdin: stdinOf("Piped outcome\n"),
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(String(d.task(s.taskId).outcome), "Piped outcome\n");
  const human = await o.h.run([
    ...configure("--title", "Human"),
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.equal(String(d.task(s.taskId).title), "Human");

  // 2. An edit between the read and the send is a stale version: exit 4, theirs stands.
  let raced = false;
  const racing: typeof fetch = (input, init) => {
    if (!raced && String(input).endsWith("/api/operator/commands")) {
      raced = true;
      d.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: s.projectId,
        taskId: s.taskId,
        expectedVersion: version(),
        title: "Theirs",
      });
    }
    return fetch(input, init);
  };
  const theirs = version() + 1;
  r = await cli("rw", configure("--title", "Mine"), { fetch: racing });
  assert.equal(raced, true);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  assert.equal(String(d.task(s.taskId).title), "Theirs");
  assert.equal(version(), theirs);

  // 3. A lost reply is an unknown outcome; the same arguments again are a new
  // request at the new version, and the old request id cannot apply it twice.
  const before = version();
  r = await cli("rw", configure("--title", "Lost"), { fetch: lostReply });
  assert.equal(r.code, 6, r.out);
  const lost = r.json().error.request.key as string;
  assert.equal(String(d.task(s.taskId).title), "Lost");
  assert.equal(version(), before + 1);
  r = await cli("rw", configure("--title", "Lost"));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.reusedRequest, false);
  assert.equal(String(d.task(s.taskId).title), "Lost");
  const settled = version();
  r = await cli("rw", configure("--title", "Lost", "--request-id", lost));
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  assert.equal(version(), settled, "nothing applied twice");

  // 4. A read-only credential is refused with nothing changed.
  const digest = databaseDigest(s.f);
  r = await cli("ro", configure("--title", "Nope"));
  assert.equal(r.code, 3);
  assert.equal(r.json().error.code, "insufficient-scope");
  assert.equal(databaseDigest(s.f), digest);

  // 5. An explicit stale version still exits 4, and both flags together are refused.
  r = await cli("rw", configure("--title", "Stale", "--expected-version", "1"));
  assert.equal(r.code, 4);
  assert.equal(String(d.task(s.taskId).title), "Lost");
  r = await cli("rw", configure("--outcome", "A", "--outcome-file", "x.md"));
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "usage");
  r = await cli("rw", configure());
  assert.equal(r.code, 2);
  assert.match(r.json().error.message, /--outcome/);
  assert.equal(String(d.task(s.taskId).title), "Lost");
});

const journalLines = (o: Operator) =>
  readFileSync(join(o.h.configDir, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const jsonOf = (r: { out: string }) => JSON.parse(r.out);
const fixOf = (err: string) => err.match(/^Fix: (.*)$/m)?.[1] ?? "";
test("a stale expected version names the current version and the read command", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s } = o;
  let r = await cli("rw", [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    "1",
    "--title",
    "Second title",
  ]);
  assert.equal(r.code, 0, r.out);
  const current = Number(r.json().data.receipt.result.version);
  assert.ok(current >= 2);
  const digest = databaseDigest(s.f);

  const args = [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    String(current - 1),
    "--title",
    "Stale title",
    "--connection",
    "rw",
  ];
  const human = await o.h.run(args);
  assert.equal(human.code, 4);
  assert.match(
    human.err,
    new RegExp(
      `Task ${s.taskId} is at version ${current}, not ${current - 1}\\.`,
    ),
  );
  assert.match(fixOf(human.err), new RegExp(`ensemble task get ${s.taskId}`));
  assert.match(
    fixOf(human.err),
    new RegExp(`--expected-version ${current}\\b`),
  );
  assert.equal(
    human.err.split("\n").filter((l) => l.startsWith("Fix:")).length,
    1,
  );

  const json = await o.h.run([...args, "--output", "json"]);
  assert.equal(json.code, 4);
  const error = jsonOf(json).error;
  assert.equal(error.code, "conflict");
  assert.equal(error.category, "conflict");
  assert.equal(error.outcome, "not-applied");
  assert.ok(!("fix" in error));
  assert.deepEqual(error.request, {
    service: installation(o),
    scope: `project:${s.projectId}`,
    type: "task.configure",
    key: error.request.key,
  });
  const lines = journalLines(o).filter((l) => l.key === error.request.key);
  assert.deepEqual(
    lines.map((l) => l.state),
    ["sending", "rejected"],
  );
  assert.equal(databaseDigest(s.f), digest, "the task is unchanged");
  r = await cli("rw", ["task", "get", s.taskId]);
  assert.equal(r.json().data.task.title, "Second title");
});

test("a conflict whose re-read fails still names the read command", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  const args = [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    "99",
    "--title",
    "Stale title",
    "--connection",
    "rw",
  ];
  const human = await o.h.run(args, { fetch: failReadAfterPost() });
  assert.equal(human.code, 4);
  assert.doesNotMatch(human.err, /is at version/);
  assert.match(fixOf(human.err), new RegExp(`ensemble task get ${s.taskId}`));

  const json = await o.h.run([...args, "--output", "json"], {
    fetch: failReadAfterPost(),
  });
  assert.equal(json.code, 4);
  const error = jsonOf(json).error;
  assert.equal(error.code, "conflict");
  assert.equal(error.outcome, "not-applied");
  assert.equal(error.request.type, "task.configure");
  assert.equal(
    journalLines(o).findLast((l) => l.key === error.request.key).state,
    "rejected",
  );
});

test("a reused request id with other material is not reported as a stale version", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s } = o;
  const key = randomUUID();
  let r = await cli("rw", [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    "1",
    "--title",
    "First title",
    "--request-id",
    key,
  ]);
  assert.equal(r.code, 0, r.out);
  const current = Number(r.json().data.receipt.result.version);
  r = await o.h.run([
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    String(current),
    "--title",
    "Other title",
    "--request-id",
    key,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.err, /not \d+\./);
  assert.match(fixOf(r.err), new RegExp(`ensemble task get ${s.taskId}`));
  assert.match(fixOf(r.err), /new one/);
  assert.equal(
    (await cli("rw", ["task", "get", s.taskId])).json().data.task.title,
    "First title",
  );
});

test("task message with a stale assignment version names the assignment version", async (t) => {
  const o = await startCliOperator(t);
  const { d, file } = o;
  const { task } = await completedLead(o.s.f, "Stale assignment");
  const lead = task.assignmentId;
  const text = file("message.md", "Hello lead");
  const version = Number(d.assignment(lead).version);
  const r = await o.h.run([
    "task",
    "follow-up",
    task.taskId,
    "--expected-version",
    String(version + 1),
    "--message-file",
    text,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 4);
  assert.match(
    r.err,
    new RegExp(
      `Assignment ${lead} \\(completed\\) is at version ${version}, not ${version + 1}\\.`,
    ),
  );
  assert.match(fixOf(r.err), new RegExp(`ensemble assignment get ${lead}`));
  assert.match(fixOf(r.err), new RegExp(`--expected-version ${version}\\b`));
  assert.equal(d.assignment(lead).state, "completed");
});

test("task message to an assignment outside the task is denied with the reason", async (t) => {
  const o = await startCliOperator(t);
  const { cli, file } = o;
  const here = await seedReviewTask(o.s.f, "Here", "This task");
  const elsewhere = await seedReviewTask(o.s.f, "Elsewhere", "Other");
  const text = file("message.md", "Hello");
  const send = (taskId: string, to: string, extra: string[] = []) => [
    "task",
    "message",
    taskId,
    "--to",
    to,
    "--expected-version",
    "1",
    "--message-file",
    text,
    ...extra,
  ];
  // The local gate refuses before anything is sent.
  const sent = posts(o);
  const local = await o.h.run(
    send(here.taskId, elsewhere.assignmentId, ["--connection", "rw"]),
  );
  assert.equal(local.code, 4);
  assert.match(
    local.err,
    new RegExp(
      `Assignment ${elsewhere.assignmentId} is not an assignment of task ${here.taskId}\\.`,
    ),
  );
  assert.match(
    fixOf(local.err),
    new RegExp(`ensemble task get ${here.taskId} --output json`),
  );
  assert.equal(posts(o), sent);
  const json = await cli("rw", send(here.taskId, elsewhere.assignmentId));
  assert.equal(json.code, 4);
  assert.equal(json.json().error.code, "policy-denied");
  assert.equal(json.json().error.category, "conflict");
  assert.equal(posts(o), sent);

  // A service denial (a reused key skips the gate) gets the same reason.
  const denied: typeof fetch = async (input, init) =>
    String(input).endsWith("/api/operator/commands")
      ? Response.json(
          {
            error: {
              code: "forbidden",
              message: "Message recipient is not in this task",
            },
          },
          { status: 403 },
        )
      : fetch(input, init);
  const service = await cli("rw", send(here.taskId, here.assignmentId), {
    fetch: denied,
  });
  assert.equal(service.code, 4, service.out);
  const error = service.json().error;
  assert.equal(error.code, "policy-denied");
  assert.equal(error.outcome, "not-applied");
  assert.match(error.message, /is not an assignment of task/);
  assert.equal(error.request.type, "message");
  assert.equal(
    journalLines(o).findLast((l) => l.key === error.request.key).state,
    "rejected",
  );
});

test("follow-up on a task without a lead names the fix", async (t) => {
  const o = await startCliOperator(t);
  const { s, file } = o;
  const sent = posts(o);
  const r = await o.h.run([
    "task",
    "follow-up",
    s.taskId,
    "--expected-version",
    "1",
    "--message-file",
    file("message.md", "Hello"),
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 4);
  assert.match(r.err, /This task has no project lead\. \(conflict\)/);
  assert.equal(
    fixOf(r.err),
    `Choose a project lead with 'ensemble project prepare ${s.projectId} --out project.json --lead-profile PROFILE_ID', then 'ensemble project apply --file project.json' ('ensemble profile list' shows profile IDs).`,
  );
  assert.equal(posts(o), sent);
});

/** The `Waiting:` blocks of a task view: each wait and its indented detail, Fix, blocker and recovery lines. */
const waitBlock = (text: string) => {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^Waiting: \S/.test(l));
  if (first < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(first)) {
    if (!/^Waiting: \S/.test(line) && !line.startsWith("  ")) break;
    block.push(line);
  }
  return block;
};
const createArgs = (o: Operator, projectId: string, ready: string) => [
  "task",
  "create",
  "--project",
  projectId,
  "--title",
  "Follow-on",
  "--outcome-file",
  o.file("follow-on.md", "Show the next step"),
  "--ready",
  ready,
  "--connection",
  "rw",
];
const createdId = (out: string) =>
  out.match(/^Created task ([0-9a-f-]{36})/m)?.[1] ?? "";

test("task create on a paused project prints the same wait lines as task get", async (t) => {
  const o = await startCliOperator(t);
  const created = await o.h.run(createArgs(o, o.s.projectId, "true"));
  assert.equal(created.code, 0, created.err);
  const taskId = createdId(created.out);
  const got = await o.h.run(["task", "get", taskId, "--connection", "ro"]);
  const expected = waitBlock(got.out);
  assert.ok(expected.length >= 4, got.out);
  assert.ok(expected.some((l) => l.startsWith("  Fix: ")));
  assert.deepEqual(waitBlock(created.out), expected);
  assert.doesNotMatch(created.out, /^Next:/m);
  assert.equal(created.err, "");

  // The JSON data keeps its shape.
  const json = await o.cli(
    "rw",
    createArgs(o, o.s.projectId, "true").slice(0, -2),
  );
  assert.equal(json.code, 0, json.out);
  assert.deepEqual(Object.keys(json.json().data).sort(), [
    "admission",
    "effect",
    "receipt",
    "reusedRequest",
    "taskId",
  ]);
  assert.ok(!json.out.includes("Next:"));
});

test("a ready task with no waits ends with Next: task get", async (t) => {
  const o = await startCliOperator(t);
  const project = await seedReviewTask(o.s.f, "Open project", "Open task");
  configure(o.s.f, project.projectId, false);
  const created = await o.h.run(createArgs(o, project.projectId, "true"));
  assert.equal(created.code, 0, created.err);
  const taskId = createdId(created.out);
  assert.deepEqual(waitBlock(created.out), []);
  assert.equal(
    created.out.trimEnd().split("\n").at(-1),
    `Next: ensemble task get ${taskId}`,
  );
  await o.s.f.service.stopTask(taskId);
  await o.s.f.service.stopTask(project.taskId);
});

test("a task created not ready names the configure command", async (t) => {
  const o = await startCliOperator(t);
  const project = await seedReviewTask(o.s.f, "Open project", "Open task");
  configure(o.s.f, project.projectId, false);
  const created = await o.h.run(createArgs(o, project.projectId, "false"));
  assert.equal(created.code, 0, created.err);
  const taskId = createdId(created.out);
  const version = (await o.cli("ro", ["task", "get", taskId])).json().data.task
    .version;
  assert.equal(
    created.out.trimEnd().split("\n").at(-1),
    `Next: ensemble task configure ${taskId} --expected-version ${version} --ready true`,
  );
  // The command it names works as printed.
  const next = await o.h.run([
    "task",
    "configure",
    taskId,
    "--expected-version",
    String(version),
    "--ready",
    "true",
    "--connection",
    "rw",
  ]);
  assert.equal(next.code, 0, next.err);
  await o.s.f.service.stopTask(taskId);
  await o.s.f.service.stopTask(project.taskId);
});

test("a create whose post-read fails still names the next command", async (t) => {
  const o = await startCliOperator(t);
  const created = await o.h.run(createArgs(o, o.s.projectId, "false"), {
    fetch: failReadAfterPost(),
  });
  assert.equal(created.code, 0, created.err);
  const taskId = createdId(created.out);
  assert.match(created.out, /\(request [0-9a-f-]{36}\)\./);
  assert.equal(
    created.out.trimEnd().split("\n").at(-1),
    `Next: ensemble task get ${taskId}`,
  );
  const key = created.out.match(/\(request ([0-9a-f-]{36})\)/)?.[1];
  assert.equal(
    journalLines(o).findLast((l) => l.key === key).state,
    "recorded",
  );
  assert.equal(
    (await o.cli("ro", ["task", "get", taskId])).json().data.task.id,
    taskId,
  );
});
