import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { derivedUuid } from "../../src/cli/write.js";
import { LocalOperatorUi } from "../../src/standalone/operator.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { completedLead, until } from "../fixtures/completed-lead.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { startCliOperator } from "../fixtures/operator-cli.js";
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
  for (const [name, text, ready] of [
    ["blank.md", "   ", "false"],
    ["long.md", "x".repeat(16001), "false"],
    ["ok.md", "fine", undefined],
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
      ...(ready ? ["--ready", ready] : []),
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
    new RegExp(`Cannot read --outcome-file ${missing}: it does not exist\\.`),
  );
  assert.match(human.err, /^Fix: Check the path given to --outcome-file\.$/m);
  const json = await o.h.run([...args, "--output", "json"]);
  assert.equal(json.code, 2);
  assert.equal(json.json().error.code, "invalid-input");
  assert.equal(json.json().error.category, "usage");
  assert.equal(posts(o), sent, "nothing was sent");
});
