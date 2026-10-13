import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { DomainPolicyError, DomainStore } from "../../src/core/domain.js";
import { githubConfigurationCommandSchema } from "../../src/core/github-source-contracts.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  createOperatorFixture,
  seedOperatorRecovery,
} from "../fixtures/operator-web.js";

test("configuration receipts preserve original creation after later configuration and private instructions never cross the API", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const profile = {
    type: "profile.create",
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Lead",
    instructions: "PRIVATE CONFIGURATION SENTINEL",
    capabilities: "Review",
  };
  const receipt = await api.execute(profile);
  assert.match(JSON.stringify(receipt), /"revoked":false/);
  await api.execute({
    type: "profile.configure",
    key: randomUUID(),
    profileId: profile.profileId,
    expectedVersion: 1,
    name: "Changed",
    revoked: true,
  });
  assert.deepEqual(await api.execute(profile), receipt);
  assert.equal(JSON.stringify(receipt).includes(profile.instructions), false);
  const project = {
    type: "project.create",
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Paused project",
    leadProfileId: null,
  };
  const created = await api.execute(project);
  assert.match(JSON.stringify(created), /"paused":true/);
  assert.match(JSON.stringify(created), /"leadProfileId":null/);
  await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId: project.projectId,
    expectedVersion: 1,
    instructions: "PRIVATE PROJECT SENTINEL",
  });
  const unpaused = await api.execute({
    type: "project.configure",
    key: randomUUID(),
    projectId: project.projectId,
    expectedVersion: 2,
    name: "New name",
    paused: false,
  });
  assert.match(JSON.stringify(unpaused), /"paused":false/);
  assert.deepEqual(await api.execute(project), created);
  assert.equal(
    f.service.domain().project(project.projectId).instructions,
    "PRIVATE PROJECT SENTINEL",
  );
  assert.equal(f.runtime.turns, 0);
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(profile), receipt);
  assert.deepEqual(await reopened.execute(project), created);
});

test("profile operation lookup returns an unchanged legacy receipt after SQLite migration", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const command = {
    type: "profile.create" as const,
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Legacy profile",
    instructions: "Private instructions",
    capabilities: "review",
  };
  const receipt = await api.execute(command);
  f.seedPersistedState((db) => {
    const row = db
      .prepare(
        "SELECT result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .get(`profile:${command.profileId}`, command.key) as { result: string };
    const legacy = JSON.parse(row.result) as Record<string, unknown>;
    delete legacy.summary;
    db.prepare(
      "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
    ).run(JSON.stringify(legacy), `profile:${command.profileId}`, command.key);
    db.exec("ALTER TABLE profiles DROP COLUMN summary");
  });
  await f.reopen();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(command), receipt);
  const readback = await reopened.readOperation(
    new URLSearchParams({
      scope: `profile:${command.profileId}`,
      type: "profile.create",
      key: command.key,
    }),
  );
  assert.deepEqual(readback.data, { state: "recorded", receipt });
});

test("GitHub omitted reference is preserved at apply and its original receipt replays after later changes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Source",
    leadProfileId: null,
  });
  const base = {
    type: "github.configure" as const,
    projectId,
    selections: [],
    repositories: [],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  };
  await api.execute({
    ...base,
    key: randomUUID(),
    expectedVersion: 1,
    credentialRef: "env:FIRST_REF",
  });
  const omitted = { ...base, key: randomUUID(), expectedVersion: 2 };
  const original = await api.execute(omitted);
  assert.match(JSON.stringify(original), /"credentialConfigured":true/);
  assert.equal(
    f.service.domain().githubConfiguration(projectId).credentialRef,
    "env:FIRST_REF",
  );
  await api.execute({
    ...base,
    key: randomUUID(),
    expectedVersion: 3,
    credentialRef: "env:SECOND_REF",
  });
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(omitted), original);
  await assert.rejects(reopened.execute({ ...omitted, credentialRef: null }), {
    status: 409,
  });
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 4);
  await assert.rejects(
    reopened.execute({
      ...base,
      key: randomUUID(),
      expectedVersion: 4,
      repositories: [
        { repositoryId: "repo", path: "relative-private-path", ref: "main" },
      ],
    }),
    { status: 400, code: "invalid-input", fieldPaths: ["repositories"] },
  );
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 4);
});

test("preview original activation receipt replays without provider access after configuration changes", async (t) => {
  let reads = 0;
  const reader = {
    async readSelection() {
      reads++;
      return { complete: true as const, issues: [], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "unknown" as const };
    },
  };
  const f = await createOperatorFixture(null, () => reader);
  t.after(() => f.close());
  const api = new OperatorApi(
      f.service,
      [f.directory],
      undefined,
      () => reader,
    ),
    projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Preview",
    leadProfileId: null,
  });
  const config = {
    type: "github.configure",
    projectId,
    selections: [
      { id: "search", kind: "search", query: "repo:example/private" },
    ],
    repositories: [],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    credentialRef: "env:FIXTURE_PREVIEW",
  };
  await api.execute({ ...config, key: randomUUID(), expectedVersion: 1 });
  const command = {
    type: "github.preview",
    key: randomUUID(),
    projectId,
    selectionId: "search",
    expectedVersion: 2,
  };
  const receipt = await api.execute(command);
  assert.equal(reads, 1);
  await api.execute({
    ...config,
    key: randomUUID(),
    expectedVersion: 2,
    credentialRef: null,
  });
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(reads, 1);
  await assert.rejects(api.execute({ ...command, selectionId: "other" }), {
    status: 409,
  });
  assert.equal(reads, 1);
});

test("capacity receipts replay original limits and recovery exposes bounded independent evidence", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  await api.execute({
    type: "profile.create",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Held",
    leadProfileId: profileId,
  });
  f.service.domain().execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "Recovery",
    outcome: "Done",
    ready: false,
  });
  f.service.domain().execute({
    type: "assignment.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  const command = {
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 3,
    projectOverrides: { [projectId]: 1 },
  };
  const receipt = await api.execute(command);
  await api.execute({
    type: "capacity.configure",
    key: randomUUID(),
    globalLimit: 4,
    projectOverrides: { [projectId]: null },
  });
  assert.deepEqual(await api.execute(command), receipt);
  const settings = await api.readRuntimeSettings();
  assert.equal(settings.data.globalLimit, 4);
  assert.equal(settings.data.projects[0]?.limit, 2);
  const recovery = await api.readAssignmentRecovery(assignmentId);
  assert.equal(recovery.data.assignment.assignmentId, assignmentId);
  assert.equal(recovery.data.evidenceAvailable, false);
  assert.equal(recovery.data.records.length, 0);
  assert.equal(JSON.stringify(recovery).includes("private"), false);
});

test("recovery aggregates omitted old ownership after Resume separately from task-wide Stop and newer receipt", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Recovery",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Recovery task",
    outcome: "Done",
    ready: false,
  });
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  seedOperatorRecovery(f, { projectId, taskId, assignmentId });
  f.seedPersistedState((db) => {
    for (const workId of ["foreign-record", "unbound-record"]) {
      db.prepare(
        "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'Private','/private','held',NULL,NULL,NULL,'chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId);
      db.prepare(
        "INSERT INTO execution_recovery_identities(workId,workRevision,requestSequence) VALUES (?,1,99)",
      ).run(workId);
      if (workId === "foreign-record")
        db.prepare(
          "INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
        ).run(workId, randomUUID(), assignmentId);
    }
  });

  const stopped = (await api.readAssignmentRecovery(assignmentId)).data;
  assert.equal(stopped.holds.stop, true);
  assert.ok(stopped.records.every((r) => r.holds.stop));
  await f.service.resumeTask(taskId);
  const after = (await api.readAssignmentRecovery(assignmentId)).data;
  assert.deepEqual(after.holds, {
    stop: false,
    task: false,
    writer: true,
    capacity: true,
    uncertainty: true,
  });
  assert.equal(after.held, true);
  assert.equal(after.omittedCount, 1);
  assert.equal(after.records.length, 20);
  assert.equal(after.records[0]?.generation.requestSequence, 2);
  assert.equal(after.records.at(-1)?.generation.requestSequence, 21);
  assert.ok(
    after.records.every(
      (r) => r.workId !== "foreign-record" && r.workId !== "unbound-record",
    ),
  );
  assert.ok(
    after.records.every(
      (r) =>
        !r.holds.writer &&
        !r.holds.capacity &&
        !r.holds.uncertainty &&
        !r.holds.stop,
    ),
  );
  assert.equal(after.records.at(-1)?.receiptRecorded, true);
  assert.equal(JSON.stringify(after).includes("PRIVATE"), false);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_holds (taskId,reason) VALUES (?,'PRIVATE HOLD REASON')",
      )
      .run(taskId),
  );
  assert.equal(
    (await api.readAssignmentRecovery(assignmentId)).data.holds.task,
    true,
  );
});

test("post-commit configuration notification failure stays uncertain and exact receipt replay does not reapply", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  let failure = true;
  const store = new DomainStore(db, () => {
    if (failure)
      throw new DomainPolicyError(
        "invalid-input",
        "PRIVATE POSTCOMMIT DIAGNOSTIC",
      );
  });
  const command = {
    type: "project.create" as const,
    actor: "operator" as const,
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Recorded once",
    leadProfileId: null,
  };
  assert.throws(
    () => store.execute(command),
    (e) =>
      e instanceof Error &&
      !(e instanceof DomainPolicyError) &&
      e.message === "Command committed but change notification failed",
  );
  failure = false;
  const original = store.recordedCommand(command);
  assert.ok(original);
  assert.deepEqual(store.execute(command), original);
  assert.equal(store.project(command.projectId).version, 1);
});
test("private labels are unavailable for editing and strict public configuration rejects authority extensions", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    profileId = randomUUID(),
    projectId = randomUUID();
  await api.execute({
    type: "profile.create",
    key: randomUUID(),
    profileId,
    name: "PRIVATE SECRET PROFILE",
    summary: "PRIVATE SECRET PROFILE",
    instructions: "PRIVATE SECRET PROFILE",
    capabilities: "Capabilities PRIVATE SECRET PROFILE",
  });
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "PRIVATE SECRET PROFILE",
    leadProfileId: null,
  });
  const profile = await api.readProfileConfiguration(profileId),
    project = await api.readProjectConfiguration(projectId);
  assert.equal(profile.data.profile.name, null);
  assert.equal(profile.data.profile.summary, null);
  assert.equal(project.data.project.name, null);
  assert.equal(
    JSON.stringify({ profile, project }).includes("PRIVATE SECRET PROFILE"),
    false,
  );
  for (const type of [
    "github.activate",
    "recovery.resolve",
    "imported-blockers.set",
  ]) {
    await assert.rejects(
      api.execute({ type, key: randomUUID(), projectId, actor: "operator" }),
    );
  }
  await assert.rejects(
    api.execute({
      type: "project.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      actor: "operator",
      instructions: "New",
    }),
  );
  assert.equal(f.service.domain().project(projectId).version, 1);
});

test("delivery and source credential reference, key and value are excluded from public configuration and receipts", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const envKey = "UI06_FAKE_DELIVERY_REDACTION",
    previous = process.env[envKey],
    hadKey = Object.hasOwn(process.env, envKey),
    envValue = "UI06_FAKE_PRIVATE_DELIVERY_VALUE",
    reference = `env:${envKey}`;
  process.env[envKey] = envValue;
  t.after(() => {
    if (hadKey) process.env[envKey] = previous;
    else delete process.env[envKey];
  });
  const d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  for (const privateText of [reference, envKey, envValue]) {
    const projectId = randomUUID(),
      profileId = randomUUID(),
      taskId = randomUUID();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: privateText,
      instructions: "Ordinary instructions",
      capabilities: privateText,
    });
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: privateText,
      leadProfileId: profileId,
    });
    d.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: reference,
      grants: [],
      requiredChecks: [],
    });
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: null,
      selections: [],
      repositories: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: privateText }],
      },
    });
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: privateText,
      outcome: privateText,
      ready: false,
    });
    const receipt = await api.execute({
      type: "profile.configure",
      key: randomUUID(),
      profileId,
      expectedVersion: 1,
      name: privateText,
    });
    const publicData = {
      workspace: await api.readWorkspace(),
      project: await api.readProjectConfiguration(projectId),
      profile: await api.readProfileConfiguration(profileId),
      task: await api.readTask(taskId),
      receipt,
    };
    for (const excluded of [reference, envKey, envValue])
      assert.equal(
        JSON.stringify(publicData).includes(excluded),
        false,
        "private delivery material excluded",
      );
    assert.equal(publicData.project.data.project.name, null);
    assert.equal(publicData.project.data.source.readiness, null);
    assert.equal(publicData.profile.data.capabilities, "[redacted]");
    await assert.rejects(
      api.execute({
        type: "delivery.configure",
        key: randomUUID(),
        projectId,
        expectedVersion: 2,
        mode: "reviewable-pr",
        credentialRef: reference,
        grants: [],
        requiredChecks: [],
      }),
    );
  }
  assert.equal(f.runtime.turns, 0);
});

test("unavailable delivery exclusions fail closed without replacing safe labels with private material", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const projectId = randomUUID(),
    api = new OperatorApi(f.service, [f.directory]);
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Project label",
    leadProfileId: null,
  });
  const original = DomainStore.prototype.deliveryCredentialReference;
  DomainStore.prototype.deliveryCredentialReference = () => {
    throw Error("private lookup failure");
  };
  try {
    const result = await api.readProjectConfiguration(projectId);
    assert.equal(result.data.project.name, null);
    assert.equal(
      JSON.stringify(result).includes("private lookup failure"),
      false,
    );
  } finally {
    DomainStore.prototype.deliveryCredentialReference = original;
  }
  assert.equal(f.runtime.turns, 0);
});

import { OperatorApiError } from "../../src/standalone/operator-api.js";
import { OperatorClient } from "../../web/src/api.js";
import { ConfigurationDraft } from "../../web/src/settings-state.js";

test("typed post-commit failure remains unknown through private configuration consumer and original API replay applies once", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const domain = f.service.domain(),
    profileId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Profile",
    instructions: "Original",
    capabilities: "Coordinate",
  });
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  let failing = true;
  const injected = new DomainStore(db, () => {
    if (failing)
      throw new DomainPolicyError("invalid-input", "SYNTHETIC CALLBACK ERROR");
  });
  const originalExecute = domain.execute;
  domain.execute = (command) => injected.execute(command);
  t.after(() => {
    domain.execute = originalExecute;
  });
  const api = new OperatorApi(f.service, [f.directory]),
    bodies: string[] = [];
  const client = new OperatorClient(async (_path, init) => {
    bodies.push(String(init?.body));
    try {
      return Response.json(await api.execute(JSON.parse(String(init?.body))));
    } catch (error) {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.code, "command-outcome-unknown");
      return Response.json(
        { error: { code: error.code, message: "Outcome unknown" } },
        { status: error.status },
      );
    }
  });
  const command = {
    type: "profile.configure" as const,
    key: randomUUID(),
    profileId,
    expectedVersion: 1,
    instructions: "PRIVATE NEW INPUT",
  };
  const draft = new ConfigurationDraft();
  draft.set("instructions", command.instructions);
  await draft.submit(client, command, "csrf");
  assert.equal(draft.phase, "unknown");
  assert.equal(domain.profile(profileId).version, 2);
  assert.ok(injected.recordedCommand({ ...command, actor: "operator" }));
  failing = false;
  await draft.reconcile(client, "csrf");
  assert.equal(draft.phase, "recorded");
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.equal(domain.profile(profileId).version, 2);
  assert.equal(JSON.stringify(draft.receipt).includes("PRIVATE"), false);
  await assert.rejects(
    api.execute({ ...command, instructions: "Changed payload" }),
    (error) => error instanceof OperatorApiError && error.status === 409,
  );
  assert.equal(f.runtime.turns, 0);
});

test("routing guidance is kept when omitted and cleared only by an explicit empty string", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID();
  await api.execute({
    type: "profile.create",
    key: randomUUID(),
    profileId,
    name: "Worker",
    instructions: "Work",
    capabilities: "Build",
  });
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Routing",
    leadProfileId: null,
  });
  const routing = {
    type: "routing.configure" as const,
    projectId,
    enabled: false,
    candidateProfileIds: [],
  };
  const disabledReceipt = await api.execute({
    ...routing,
    key: randomUUID(),
    expectedVersion: 1,
    guidance: "PRIVATE ROUTING SENTINEL",
  });
  assert.match(JSON.stringify(disabledReceipt), /"enabled":false/);
  assert.match(JSON.stringify(disabledReceipt), /"credentialConfigured":false/);
  const before = d.routing(projectId);
  const omitted = {
    ...routing,
    key: randomUUID(),
    expectedVersion: Number(before.version),
    enabled: true,
    candidateProfileIds: [profileId],
  };
  const receipt = await api.execute(omitted);
  assert.match(JSON.stringify(receipt), /"enabled":true/);
  const after = d.routing(projectId);
  assert.equal(after.guidance, "PRIVATE ROUTING SENTINEL");
  assert.equal(after.enabled, 1);
  assert.equal(Number(after.version), Number(before.version) + 1);
  assert.equal(JSON.stringify(receipt).includes("PRIVATE"), false);
  await api.execute({
    ...routing,
    key: randomUUID(),
    expectedVersion: Number(after.version),
    guidance: "",
  });
  assert.equal(d.routing(projectId).guidance, "");
});

test("GitHub keep markers and pathless links resolve from the saved configuration and replay across restart", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    d = f.service.domain(),
    projectId = randomUUID(),
    repositoryPath = join(f.directory, "kept-repository"),
    run = promisify(execFile);
  await mkdir(repositoryPath);
  await run("git", ["init", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "Fixture\n");
  await run("git", ["-C", repositoryPath, "add", "README.md"]);
  await run("git", [
    "-C",
    repositoryPath,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Source",
    leadProfileId: null,
  });
  const readiness = {
    mode: "all" as const,
    conditions: [{ kind: "label" as const, name: "ready" }],
  };
  const s1 = {
    id: "S-1",
    kind: "repository" as const,
    repositoryId: "repo-1",
    owner: "acme",
    name: "atlas",
  };
  const s2 = { id: "S-2", kind: "search" as const, query: "PRIVATE QUERY" };
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_REF",
    selections: [s1, s2],
    readiness,
    repositories: [
      { repositoryId: "repo-1", path: repositoryPath, ref: "HEAD" },
    ],
  });
  const savedPath = d.githubConfiguration(projectId).repositories[0]?.path;
  assert.equal(savedPath, await realpath(repositoryPath));
  const version = d.githubConfiguration(projectId).version;
  for (const selectionId of ["S-1", "S-2"])
    d.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId,
      expectedVersion: version,
    });
  const edit = {
    type: "github.configure" as const,
    key: randomUUID(),
    projectId,
    expectedVersion: version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-4", kind: "search", query: "PRIVATE NEW" },
    ],
    readiness,
    repositories: [{ repositoryId: "repo-1", ref: "HEAD" }],
  };
  const receipt = await api.execute(edit);
  const saved = d.githubConfiguration(projectId);
  assert.deepEqual(saved.selections, [
    s1,
    { id: "S-4", kind: "search", query: "PRIVATE NEW" },
  ]);
  assert.equal(saved.repositories[0]?.path, savedPath);
  assert.equal(saved.credentialRef, "env:FIXTURE_REF");
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  assert.deepEqual(
    db
      .prepare(
        "SELECT selectionId FROM project_github_active WHERE projectId = ? ORDER BY selectionId",
      )
      .all(projectId)
      .map((row) => row.selectionId),
    ["S-1"],
  );
  // The kept row survives, but activation counts only at the version it was previewed,
  // so the read and sync treat S-1 as inactive until it is previewed again.
  assert.deepEqual(d.githubActiveSelectionIds(projectId), []);
  const configuration = await api.readProjectConfiguration(projectId);
  assert.deepEqual(
    configuration.data.source.selections.map((s) => [s.id, s.active]),
    [
      ["S-1", false],
      ["S-4", false],
    ],
  );
  const read = JSON.stringify(configuration);
  for (const secret of ["PRIVATE QUERY", "PRIVATE NEW", String(savedPath)])
    assert.equal(read.includes(secret), false);
  assert.equal(JSON.stringify(receipt).includes("PRIVATE"), false);

  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: saved.version,
    selections: [{ id: "S-1", keep: true }],
    readiness,
    repositories: [],
  });
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(edit), receipt);
  await assert.rejects(
    reopened.execute({ ...edit, selections: [{ id: "S-1", keep: true }] }),
    { status: 409 },
  );

  const current = f.service.domain().githubConfiguration(projectId);
  await assert.rejects(
    reopened.execute({
      ...edit,
      key: randomUUID(),
      expectedVersion: current.version,
      selections: [{ id: "S-9", keep: true }],
      repositories: [],
    }),
    { status: 409 },
  );
  const failure = await reopened
    .execute({
      ...edit,
      key: randomUUID(),
      expectedVersion: current.version,
      selections: [{ id: "S-1", keep: true }],
      repositories: [{ repositoryId: "repo-1", ref: "HEAD" }],
    })
    .then(
      () => assert.fail("expected rejection"),
      (error: unknown) => error as OperatorApiError,
    );
  assert.equal(failure.status, 400);
  assert.deepEqual(failure.fieldPaths, ["repositories"]);
  assert.equal(
    JSON.stringify({ ...failure, message: failure.message }).includes(
      String(savedPath),
    ),
    false,
  );
  assert.equal(
    f.service.domain().githubConfiguration(projectId).version,
    current.version,
  );
  // A failing new link followed by an unsaved pathless link rejects as one 400; the
  // earlier verification's rejection is handled, so the service keeps running.
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    await assert.rejects(
      reopened.execute({
        ...edit,
        key: randomUUID(),
        expectedVersion: current.version,
        selections: [{ id: "S-1", keep: true }],
        repositories: [
          { repositoryId: "new", path: "relative-path", ref: "main" },
          { repositoryId: "unsaved", ref: "main" },
        ],
      }),
      { status: 400 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", record);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(
    f.service.domain().githubConfiguration(projectId).version,
    current.version,
  );
});

test("GitHub configuration command contract accepts only exact keep markers and unique ids", () => {
  const base = {
    credentialRef: null,
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  };
  const parse = (selections: unknown[]) =>
    githubConfigurationCommandSchema.safeParse({ ...base, selections }).success;
  assert.equal(parse([{ id: "S-1", keep: true }]), true);
  assert.equal(parse([{ id: "S-1", keep: false }]), false);
  assert.equal(parse([{ id: "S-1", keep: true, query: "x" }]), false);
  assert.equal(
    parse([
      { id: "S-1", keep: true },
      { id: "S-1", kind: "search", query: "x" },
    ]),
    false,
  );
  assert.equal(
    githubConfigurationCommandSchema.safeParse({
      ...base,
      selections: [],
      repositories: [
        { repositoryId: "r", ref: "main" },
        { repositoryId: "r", path: "/x", ref: "main" },
      ],
    }).success,
    false,
  );
});

import { chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createFakeGh } from "../fixtures/fake-gh.js";

test("source observations bound child fanout, share equivalent logins and refresh request/fence scopes", async (t) => {
  const fake = createFakeGh();
  t.after(() => fake.close());
  const root = dirname(fake.executable);
  await mkdir(join(root, "active"));
  await writeFile(join(root, "login"), "octo");
  const executable = join(root, "gh");
  await writeFile(
    executable,
    `#!${process.execPath}\n
const fs = require('node:fs'), path = require('node:path');
const root = __dirname, marker = path.join(root, 'active', String(process.pid));
fs.writeFileSync(marker, '');
const command = process.argv[3];
fs.appendFileSync(path.join(root, 'events'), JSON.stringify({ command, peak: fs.readdirSync(path.join(root, 'active')).length }) + '\\n');
setTimeout(() => {
  const login = fs.readFileSync(path.join(root, 'login'), 'utf8');
  if (command === 'status') process.stdout.write(JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login }] } }));
  else process.stdout.write('gho_fake-observation-' + login + '\\n');
  fs.unlinkSync(marker);
}, 40);
`,
  );
  await chmod(executable, 0o700);
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    undefined,
    { ghExecutable: executable },
  );
  t.after(() => f.close());
  const d = f.service.domain();
  const oldGh = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "chosen-observation-canary";
  t.after(() => {
    if (oldGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldGh;
  });
  const original = f.service.gitHubSourceCredentialStatus.bind(f.service);
  const scopes = new Set<unknown>();
  const captures: string[] = [];
  let mutate: (() => void) | undefined;
  f.service.gitHubSourceCredentialStatus = async (projectId, scope) => {
    scopes.add(scope);
    captures.push(projectId);
    const result = await original(projectId, scope);
    mutate?.();
    mutate = undefined;
    return result;
  };
  t.after(() => {
    f.service.gitHubSourceCredentialStatus = original;
  });
  const projects: string[] = [];
  for (let i = 0; i < 11; i++) {
    const projectId = randomUUID();
    projects.push(projectId);
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: `Project ${i}`,
      leadProfileId: null,
    });
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef:
        i < 9 ? "gh:github.com" : i === 9 ? null : "env:MISSING_OBSERVATION",
      selections: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
  }
  const events = async () =>
    (await readFile(join(root, "events"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; peak: number });
  const api = new OperatorApi(f.service, [f.directory]);
  const first = await api.readSourceObservations();
  assert.deepEqual(
    first.data.projects.map((p) => p.projectId),
    d.projects().map((p) => String(p.id)),
  );
  assert.ok(
    first.data.projects
      .filter((p) => projects.slice(0, 9).includes(p.projectId))
      .every(
        (p) => p.credential?.usable && p.credential?.gh.state === "signed-in",
      ),
  );
  const initial = await events();
  assert.equal(
    initial.filter((e) => e.command === "status").length,
    1,
    "equivalent candidate-gh offers share one detector",
  );
  assert.equal(initial.filter((e) => e.command === "token").length, 9);
  assert.ok(initial.every((e) => e.peak <= 4));
  assert.equal(scopes.size, 1);
  await writeFile(join(root, "login"), "replacement");
  const second = await api.readSourceObservations();
  assert.ok(
    second.data.projects
      .filter((p) => projects.slice(0, 9).includes(p.projectId))
      .every(
        (p) =>
          p.credential?.gh.state === "signed-in" &&
          p.credential?.gh.login === "replacement",
      ),
  );
  assert.equal(scopes.size, 2, "second request gets a fresh login scope");
  assert.equal(
    (await events()).filter((e) => e.command === "status").length,
    2,
  );
  const queued = projects[8]!;
  const before = captures.length;
  mutate = () => {
    d.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: queued,
      expectedVersion: d.githubConfiguration(queued).version,
      credentialRef: null,
      selections: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
  };
  const fenced = await api.readSourceObservations();
  assert.equal(
    fenced.data.projects.find((p) => p.projectId === queued)?.credential
      ?.reason,
    "missing-credential",
  );
  assert.equal(
    captures.length - before,
    22,
    "source fence rebuilds the full read once",
  );
  assert.equal(scopes.size, 4, "each fence attempt owns a fresh scope");
  const allEvents = await events();
  assert.ok(allEvents.every((e) => e.peak <= 4));
  t.diagnostic(
    `Observed child peak ${Math.max(...allEvents.map((e) => e.peak))}; first request detection 1, fresh token commands 9; four independent request/attempt scopes.`,
  );
  assert.equal(f.runtime.turns, 0);
});
