import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { DomainPolicyError, DomainStore } from "../../src/core/domain.js";
import { githubConfigurationCommandSchema } from "../../src/core/github-source-contracts.js";
import { repositoriesConfigurationCommandSchema } from "../../src/core/repository-links.js";
import { readinessRuleViewSchema } from "../../src/operator/contracts.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { insertExternalItem } from "../fixtures/source-rows.js";
import { checkout, createSetupHome } from "../fixtures/setup-home.js";
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

test("the project read shows no readiness rule, a rule, and no rule again after removal and restart", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  let api = new OperatorApi(f.service, [f.directory]);
  const projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Readiness",
    leadProfileId: null,
  });
  const read = async () =>
    (await api.readProjectConfiguration(projectId)).data.source.readiness;
  assert.deepEqual(await read(), { kind: "none" });
  const rule = {
    mode: "any" as const,
    conditions: [
      {
        kind: "label" as const,
        operator: "has" as const,
        name: "ready-for-agent",
      },
    ],
  };
  const configure = (
    readiness: unknown,
    expectedVersion = f.service.domain().githubConfiguration(projectId).version,
  ) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId,
      expectedVersion,
      selections: [],
      readiness,
    } as never);
  await configure(rule);
  assert.deepEqual(await read(), { kind: "rule", ...rule });
  // No-rule is only `null`: an empty rule and the read shape are not commands.
  for (const bad of [
    { mode: "all", conditions: [] },
    { kind: "rule", ...rule },
  ])
    await assert.rejects(configure(bad));
  await configure(null);
  assert.deepEqual(await read(), { kind: "none" });
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await read(), { kind: "none" });
  assert.equal(
    readinessRuleViewSchema.safeParse({ kind: "none", mode: "all" }).success,
    false,
  );
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
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
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
      type: "repositories.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "repo",
          path: "relative-private-path",
          ref: "main",
        },
      ],
    }),
    { status: 400, code: "invalid-input", fieldPaths: ["repositories"] },
  );
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 4);
  assert.equal(f.service.domain().repositoryLinks(projectId).version, 1);
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
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
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

async function previewFixture(
  t: TestContext,
  readSelection: () => Promise<{
    complete: true;
    issues: never[];
    reason: null;
  }>,
) {
  const reader = {
    readSelection,
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "unknown" as const };
    },
  };
  const f = await createOperatorFixture(null, () => reader);
  t.after(() => f.close());
  const build = () =>
    new OperatorApi(f.service, [f.directory], undefined, () => reader);
  const api = build();
  const projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Preview",
    leadProfileId: null,
  });
  await api.execute({
    type: "github.configure",
    projectId,
    selections: [
      { id: "search", kind: "search", query: "repo:example/private" },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
    credentialRef: "env:FIXTURE_PREVIEW",
    key: randomUUID(),
    expectedVersion: 1,
  });
  const preview = () => ({
    type: "github.preview" as const,
    key: randomUUID(),
    projectId,
    selectionId: "search",
    expectedVersion: 2,
  });
  const read = (api: OperatorApi, key: string) =>
    api.readOperation(
      new URLSearchParams({
        scope: `project:${projectId}`,
        type: "github.preview",
        key,
      }),
    );
  return { f, api, build, projectId, preview, read };
}

test("concurrent source previews report exactly one first activation", async (t) => {
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { f, api, projectId, preview, read } = await previewFixture(
    t,
    async () => {
      if (++reads === 2) release();
      await bothRead;
      return { complete: true as const, issues: [], reason: null };
    },
  );
  const [a, b] = [preview(), preview()];
  const receipts = await Promise.all([api.execute(a), api.execute(b)]);
  const flags = receipts.map((r) => {
    assert.equal(r.kind, "configuration");
    assert.equal(r.result.commandType, "github.preview");
    return r.result.alreadyActive;
  });
  assert.deepEqual([...flags].sort(), [false, true]);
  assert.deepEqual(f.service.domain().githubActiveSelectionIds(projectId), [
    "search",
  ]);
  for (const [i, command] of [a, b].entries())
    assert.deepEqual((await read(api, command.key)).data, {
      state: "recorded",
      receipt: receipts[i],
    });
  const third = await api.execute(preview());
  assert.equal(
    third.kind === "configuration" &&
      third.result.commandType === "github.preview" &&
      third.result.alreadyActive,
    true,
  );
});

test("preview lookup replays an unchanged receipt recorded before alreadyActive existed", async (t) => {
  let reads = 0;
  const { f, build, projectId, preview, read } = await previewFixture(
    t,
    async () => {
      reads++;
      return { complete: true as const, issues: [], reason: null };
    },
  );
  const command = preview();
  const receipt = await build().execute(command);
  assert.equal(
    receipt.kind === "configuration" &&
      receipt.result.commandType === "github.preview" &&
      receipt.result.alreadyActive,
    false,
  );
  f.seedPersistedState((db) => {
    const row = db
      .prepare(
        "SELECT result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .get(projectId, command.key) as { result: string };
    const legacy = JSON.parse(row.result) as Record<string, unknown>;
    delete legacy.alreadyActive;
    db.prepare(
      "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
    ).run(JSON.stringify(legacy), projectId, command.key);
  });
  await f.reopen();
  const reopened = build();
  const readsBefore = reads; // service start may read the active selection itself
  const replayed = await reopened.execute(command);
  assert.equal(reads, readsBefore);
  assert.equal(
    "alreadyActive" in (replayed as { result: object }).result,
    false,
  );
  assert.deepEqual(
    replayed,
    JSON.parse(
      JSON.stringify(receipt, (k, v) =>
        k === "alreadyActive" ? undefined : v,
      ),
    ),
  );
  assert.deepEqual((await read(reopened, command.key)).data, {
    state: "recorded",
    receipt: replayed,
  });
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
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: privateText }],
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
    // A withheld rule is unknown, never shown as no rule.
    assert.deepEqual(publicData.project.data.source.readiness, {
      kind: "unavailable",
    });
    assert.equal(publicData.profile.data.capabilities, "[redacted]");
    const configured = await api.execute({
      type: "delivery.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: reference,
      grants: [],
      requiredChecks: [],
    });
    assert.deepEqual(configured, {
      kind: "configuration",
      key: configured.key,
      recorded: true,
      result: {
        commandType: "delivery.configure",
        resourceId: projectId,
        version: 3,
        credentialConfigured: true,
      },
    });
    const afterSet = await api.readProjectConfiguration(projectId);
    assert.equal(JSON.stringify(afterSet).includes(reference), false);
    assert.equal(JSON.stringify(afterSet).includes(envKey), false);
    assert.equal(JSON.stringify(afterSet).includes(envValue), false);
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

test("a GitLab link saves with a matching origin and a mismatch is refused with its reason", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]),
    projectId = randomUUID(),
    lab = join(f.directory, "lab"),
    wrong = join(f.directory, "wrong");
  await checkout(lab, "https://gitlab.example.com/group/atlas.git");
  await checkout(wrong, "https://gitlab.example.com/group/other.git");
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Lab",
    leadProfileId: null,
  });
  const row = (path: string) => ({
    codeHost: "gitlab" as const,
    host: "gitlab.example.com",
    repositoryId: "42",
    projectPath: "group/atlas",
    path,
    ref: "main",
  });
  const refusal = await api
    .execute({
      type: "repositories.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [row(wrong)],
    })
    .then(
      () => assert.fail("expected rejection"),
      (error: unknown) => error as OperatorApiError,
    );
  assert.equal(refusal.status, 400);
  assert.equal(refusal.code, "invalid-input");
  assert.deepEqual(refusal.fieldPaths, ["repositories.0.path"]);
  assert.match(
    refusal.publicMessage ?? "",
    /^Repository 1: .*different project/,
  );
  assert.equal(refusal.publicMessage?.includes(wrong), false);
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [row(lab)],
  });
  const read = await api.readProjectConfiguration(projectId);
  assert.deepEqual(read.data.repositories.links, [
    {
      repositoryId: "42",
      codeHost: "gitlab",
      host: "gitlab.example.com",
      ref: "main",
    },
  ]);
});

test("a GitHub link reads its observed or setup-verified name, withheld with its ID and excluded text", async (t) => {
  const f = await createOperatorFixture(),
    home = await createSetupHome();
  t.after(async () => {
    await f.close();
    await home.close();
  });
  const api = new OperatorApi(f.service, [f.directory], undefined, undefined, {
      home: home.home,
    }),
    d = f.service.domain(),
    projectId = randomUUID(),
    setupId = randomUUID(),
    [oldTask, newTask, plainTask] = [randomUUID(), randomUUID(), randomUUID()],
    named = join(f.directory, "named"),
    plain = join(f.directory, "plain");
  await checkout(named);
  await checkout(plain);
  const project = (id: string, name: string) => ({
    type: "project.create" as const,
    key: randomUUID(),
    projectId: id,
    name,
    leadProfileId: null,
  });
  await api.execute(project(projectId, "Names"));
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_named",
        path: named,
        ref: "main",
      },
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_plain",
        path: plain,
        ref: "main",
      },
    ],
  });
  for (const [taskId, title] of [
    [oldTask, "Old"],
    [newTask, "New"],
    [plainTask, "Local"],
  ] as const)
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title,
      outcome: "Done",
      ready: false,
    });
  // The newest observation of an ID names it.
  f.seedPersistedState((db) => {
    for (const [taskId, externalId, containerName] of [
      [oldTask, "I1", "acme/old"],
      [newTask, "I2", "acme/atlas"],
    ] as const)
      insertExternalItem(db, {
        externalId,
        taskId,
        containerId: "R_named",
        containerName,
        number: 1,
        observedTitle: "Issue",
        observedBody: "Body",
        observedState: "open",
        labels: "[]",
      });
  });
  // Guided setup's typed row stores the verified `github.com/owner/name` as its ID.
  await api.execute({
    ...project(setupId, "Relay"),
    repositories: [
      {
        repositoryId: "github.com/acme/relay",
        owner: "acme",
        name: "relay",
        path: "~/src/relay",
        ref: "main",
      },
    ],
  });
  const names = async (id = projectId) =>
    (await api.readProjectConfiguration(id)).data.repositories.links.map(
      (link) => [link.repositoryId, "name" in link ? link.name : undefined],
    );
  assert.deepEqual(await names(), [
    ["R_named", "acme/atlas"],
    ["R_plain", null],
  ]);
  assert.deepEqual(await names(setupId), [
    ["github.com/acme/relay", "acme/relay"],
  ]);
  assert.deepEqual((await api.readTask(plainTask)).data.repositoryNames, [
    { repositoryId: "R_named", name: "acme/atlas" },
  ]);
  // Private text in the name withholds the name but not the ID the name is not part of.
  const envKey = "NAMES_FAKE_PRIVATE_NAME",
    hadKey = Object.hasOwn(process.env, envKey);
  process.env[envKey] = "acme/atlas";
  t.after(() => {
    if (!hadKey) delete process.env[envKey];
  });
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: `env:${envKey}`,
    grants: [],
    requiredChecks: [],
  });
  assert.deepEqual(await names(), [
    ["R_named", null],
    ["R_plain", null],
  ]);
  assert.deepEqual((await api.readTask(plainTask)).data.repositoryNames, []);
});

test("a new GitHub link needs a node ID, while a saved owner/name link keeps re-saving", async (t) => {
  const f = await createOperatorFixture(),
    home = await createSetupHome();
  t.after(async () => {
    await f.close();
    await home.close();
  });
  const api = new OperatorApi(f.service, [f.directory], undefined, undefined, {
      home: home.home,
    }),
    projectId = randomUUID(),
    path = join(f.directory, "atlas");
  await checkout(path);
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Setup",
    leadProfileId: null,
    repositories: [
      {
        repositoryId: "github.com/acme/relay",
        owner: "acme",
        name: "relay",
        path: "~/src/relay",
        ref: "main",
      },
    ],
  });
  const link = (repositoryId: string, extra: Record<string, unknown> = {}) => ({
    codeHost: "github" as const,
    host: "github.com" as const,
    repositoryId,
    ...extra,
  });
  const save = (expectedVersion: number, ...repositories: object[]) =>
    api.execute({
      type: "repositories.configure",
      key: randomUUID(),
      projectId,
      expectedVersion,
      repositories,
    } as Parameters<OperatorApi["execute"]>[0]);
  const read = async () => api.readProjectConfiguration(projectId);
  const before = (await read()).data.repositories,
    relay = {
      path: f.service.domain().repositoryLinks(projectId).links[0]!.path,
      ref: "main",
    };
  const refusal = await save(
    before.version,
    link("github.com/acme/relay", relay),
    link("acme/atlas", { path, ref: "main" }),
  ).then(
    () => assert.fail("expected rejection"),
    (error: unknown) => error as OperatorApiError,
  );
  assert.equal(refusal.status, 400);
  assert.equal(refusal.code, "invalid-input");
  assert.deepEqual(refusal.fieldPaths, ["repositories.1.repositoryId"]);
  assert.match(
    refusal.publicMessage ?? "",
    /^Repository 2: .*node ID.*gh api repos\/OWNER\/NAME/,
  );
  assert.deepEqual((await read()).data.repositories, before);
  // The saved provisional link is kept (with a ref change) beside a node-ID link.
  await save(
    before.version,
    link("github.com/acme/relay", { ...relay, ref: "HEAD" }),
    link("R_atlas", { path, ref: "main" }),
  );
  const after = (await read()).data.repositories.links;
  assert.deepEqual(
    after.map((item) => [item.repositoryId, item.ref]),
    [
      ["github.com/acme/relay", "HEAD"],
      ["R_atlas", "main"],
    ],
  );
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
    conditions: [
      { kind: "label" as const, operator: "has" as const, name: "ready" },
    ],
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
  });
  const linked = await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "repo-1",
        path: repositoryPath,
        ref: "HEAD",
      },
    ],
  });
  assert.deepEqual(linked.kind === "configuration" && linked.result, {
    commandType: "repositories.configure",
    resourceId: projectId,
    version: 2,
    repositoryCount: 1,
  });
  const savedPath = d.repositoryLinks(projectId).links[0]?.path;
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
  };
  const receipt = await api.execute(edit);
  const saved = d.githubConfiguration(projectId);
  assert.deepEqual(saved.selections, [
    s1,
    { id: "S-4", kind: "search", query: "PRIVATE NEW" },
  ]);
  // Saving the source leaves the repository links and their version alone.
  assert.equal(d.repositoryLinks(projectId).links[0]?.path, savedPath);
  assert.equal(d.repositoryLinks(projectId).version, 2);
  assert.equal(saved.credentialRef, "env:FIXTURE_REF");
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  assert.deepEqual(
    db
      .prepare(
        "SELECT selectionId FROM project_active_selections WHERE projectId = ? ORDER BY selectionId",
      )
      .all(projectId)
      .map((row) => row.selectionId),
    ["S-1"],
  );
  // The kept row survives, but activation counts only at the version it was previewed,
  // so the read and sync treat S-1 as inactive until it is previewed again.
  assert.deepEqual(d.githubActiveSelectionIds(projectId), []);
  const configuration = await api.readProjectConfiguration(projectId);
  assert.equal(configuration.data.source.closedIssues, "skip");
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
  });
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
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
    }),
    { status: 409 },
  );
  const links = f.service.domain().repositoryLinks(projectId);
  const failure = await reopened
    .execute({
      type: "repositories.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: links.version,
      repositories: [
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "repo-1",
          ref: "HEAD",
        },
      ],
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
    f.service.domain().repositoryLinks(projectId).version,
    links.version,
  );
  // A failing new link followed by an unsaved pathless link rejects as one 400; the
  // earlier verification's rejection is handled, so the service keeps running.
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    await assert.rejects(
      reopened.execute({
        type: "repositories.configure",
        key: randomUUID(),
        projectId,
        expectedVersion: links.version,
        repositories: [
          {
            codeHost: "github",
            host: "github.com",
            repositoryId: "new",
            path: "relative-path",
            ref: "main",
          },
          {
            codeHost: "github",
            host: "github.com",
            repositoryId: "unsaved",
            ref: "main",
          },
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
    f.service.domain().repositoryLinks(projectId).version,
    links.version,
  );
  // A github.configure that carries links is refused and records nothing.
  await assert.rejects(
    reopened.execute({
      ...edit,
      key: randomUUID(),
      expectedVersion: current.version,
      selections: [{ id: "S-1", keep: true }],
      repositories: [{ repositoryId: "repo-1", ref: "HEAD" }],
    }),
    (error: unknown) =>
      (error as OperatorApiError).status === 400 &&
      (error as OperatorApiError).fieldPaths?.[0] === "repositories",
  );
  assert.equal(
    f.service.domain().githubConfiguration(projectId).version,
    current.version,
  );
});

test("a github.configure command recorded with links replays its receipt through the operator API", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Replay",
    leadProfileId: null,
  });
  // The command and result as recorded before repository links moved to the project.
  const key = randomUUID();
  const command = {
    type: "github.configure" as const,
    actor: "operator" as const,
    key,
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [],
    readiness: null,
    repositories: [{ repositoryId: "repo-1", path: "/old/path", ref: "main" }],
  };
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(",")}}`
        : JSON.stringify(value);
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO command_receipts (scope, key, payloadHash, result) VALUES (?, ?, ?, ?)",
  ).run(
    projectId,
    key,
    createHash("sha256").update(canonical(command)).digest("hex"),
    JSON.stringify({
      version: 2,
      credentialRef: null,
      selections: [],
      readiness: null,
      closedIssues: "skip",
      repositories: [
        {
          repositoryId: "repo-1",
          path: "/old/path",
          ref: "main",
          gitCommonDirectory: "/old/path/.git",
        },
      ],
    }),
  );
  const { actor: _actor, ...input } = command;
  const receipt = await api.execute(input as never);
  assert.deepEqual(receipt.kind === "configuration" && receipt.result, {
    commandType: "github.configure",
    resourceId: projectId,
    version: 2,
    credentialConfigured: false,
    selectionCount: 0,
    repositoryCount: 1,
  });
  // The links were never applied to the project, and the source version did not move.
  assert.deepEqual(f.service.domain().repositoryLinks(projectId).links, []);
  assert.equal(f.service.domain().githubConfiguration(projectId).version, 1);
});

test("GitHub configuration command contract accepts only exact keep markers and unique ids", () => {
  const base = {
    credentialRef: null,
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  };
  const parse = (selections: unknown[]) =>
    githubConfigurationCommandSchema.safeParse({ ...base, selections }).success;
  assert.equal(parse([{ id: "S-1", keep: true }]), true);
  assert.equal(parse([{ id: "S-1", keep: false }]), false);
  const mode = (closedIssues: unknown) =>
    githubConfigurationCommandSchema.safeParse({
      ...base,
      selections: [],
      closedIssues,
    }).success;
  assert.equal(mode("done"), true);
  assert.equal(mode("skip"), true);
  assert.equal(mode(undefined), true);
  assert.equal(mode("closed"), false);
  assert.equal(
    githubConfigurationCommandSchema.safeParse({
      ...base,
      selections: [],
      closedIssueMode: "done",
    }).success,
    false,
  );
  assert.equal(parse([{ id: "S-1", keep: true, query: "x" }]), false);
  assert.equal(
    parse([
      { id: "S-1", keep: true },
      { id: "S-1", kind: "search", query: "x" },
    ]),
    false,
  );
  const link = { codeHost: "github", host: "github.com", ref: "main" };
  const links = (repositories: unknown[]) =>
    repositoriesConfigurationCommandSchema.safeParse({ repositories }).success;
  assert.equal(links([{ ...link, repositoryId: "r" }]), true);
  assert.equal(
    links([
      { ...link, repositoryId: "r" },
      { ...link, repositoryId: "r", path: "/x" },
    ]),
    false,
  );
  assert.equal(links([{ repositoryId: "r", ref: "main" }]), false);
  assert.equal(
    links([{ ...link, host: "gitlab.com", repositoryId: "r" }]),
    false,
  );
  const lab = {
    codeHost: "gitlab",
    host: "gitlab.example.com",
    repositoryId: "42",
    ref: "main",
  };
  assert.equal(links([lab]), true);
  assert.equal(links([{ ...lab, projectPath: "group/sub/atlas" }]), true);
  assert.equal(links([{ ...lab, host: "github.com" }]), false);
  assert.equal(links([{ ...lab, host: "gitlab.example.com:22" }]), false);
  assert.equal(links([{ ...lab, repositoryId: "abc" }]), false);
  assert.equal(links([{ ...lab, projectPath: "atlas" }]), false);
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
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
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
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
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

const deliveryInput = (projectId: string, extra: object = {}) => ({
  type: "delivery.configure" as const,
  key: randomUUID(),
  projectId,
  expectedVersion: 1,
  mode: "reviewable-pr" as const,
  grants: [],
  requiredChecks: [],
  ...extra,
});

async function deliveryFixture(t: TestContext) {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const projectId = randomUUID();
  await api.execute({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Delivery",
    leadProfileId: null,
  });
  return { f, api, projectId };
}

const historicalDeliveryHash = (value: unknown): string => {
  const canonical = (item: unknown): string =>
    Array.isArray(item)
      ? `[${item.map(canonical).join(",")}]`
      : item && typeof item === "object"
        ? `{${Object.entries(item)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
            .join(",")}}`
        : JSON.stringify(item);
  return createHash("sha256").update(canonical(value)).digest("hex");
};

test("delivery JSON preserves every accepted action, supplemental scope and optional shape", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const { actionKinds } = await import("../../src/core/delivery.js");
  const grants = actionKinds.flatMap((action) => {
    const grant = {
      action,
      repositoryId: "container",
      mode:
        action === "branch.adopt" ? ("approval" as const) : ("allow" as const),
      projectNodeId: "P",
      fieldNodeId: "F",
      optionNodeIds: action === "project.field" ? ["O", "O"] : [],
      ...(action === "issue.status" ? { statusIds: ["S", "S"] } : {}),
    };
    return [grant, grant];
  });
  const requiredChecks = [
    { name: "build" },
    { name: "build", appId: 42 },
    { name: "build", appId: 42 },
  ];
  const first = await api.execute(
    deliveryInput(projectId, { mode: "through-merge", grants, requiredChecks }),
  );
  assert.deepEqual(first.kind === "configuration" && first.result, {
    commandType: "delivery.configure",
    resourceId: projectId,
    version: 2,
    credentialConfigured: false,
  });
  // The credential status is asserted on its own; it depends on the host's gh.
  const { credential, ...visible } = (
    await api.readProjectConfiguration(projectId)
  ).data.delivery!;
  assert.equal(credential?.configured, false);
  assert.deepEqual(visible, {
    version: 2,
    mode: "through-merge",
    credentialConfigured: false,
    grants,
    requiredChecks,
    repositories: [],
  });
  assert.equal(Object.hasOwn(visible, "branchPrefix"), false);
  await api.execute(
    deliveryInput(projectId, {
      expectedVersion: 2,
      grants,
      requiredChecks,
      branchPrefix: "",
    }),
  );
  assert.equal(
    (await api.readProjectConfiguration(projectId)).data.delivery!.branchPrefix,
    "",
  );
  assert.equal(f.service.delivery().configuration(projectId).branchPrefix, "");
  assert.equal(f.runtime.turns, 0);
});

test("delivery credentials normalize Preserve Set Clear and expose only original minimal receipts after restart", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const set = deliveryInput(projectId, { credentialRef: "env:DELIVERY_FIRST" });
  const setReceipt = await api.execute(set);
  assert.equal(
    f.service.domain().deliveryCredentialReference(projectId),
    "env:DELIVERY_FIRST",
  );
  const preserve = deliveryInput(projectId, { expectedVersion: 2 });
  const original = await api.execute(preserve);
  assert.equal(
    f.service.domain().deliveryCredentialReference(projectId),
    "env:DELIVERY_FIRST",
  );
  await api.execute(
    deliveryInput(projectId, {
      expectedVersion: 3,
      credentialRef: "env:DELIVERY_SECOND",
    }),
  );
  await assert.rejects(
    api.execute(preserve),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  assert.deepEqual(await api.execute(set), setReceipt);
  await api.execute(
    deliveryInput(projectId, { expectedVersion: 4, credentialRef: null }),
  );
  assert.equal(f.service.domain().deliveryCredentialReference(projectId), null);
  await f.reopen();
  const reopened = new OperatorApi(f.service, [f.directory]);
  const lookup = await reopened.readOperation(
    new URLSearchParams({
      scope: `project:${projectId}`,
      type: "delivery.configure",
      key: preserve.key,
    }),
  );
  assert.deepEqual(lookup.data, { state: "recorded", receipt: original });
  assert.deepEqual(await reopened.execute(set), setReceipt);
  for (const value of [
    original,
    lookup,
    await reopened.readProjectConfiguration(projectId),
  ])
    assert.doesNotMatch(
      JSON.stringify(value),
      /DELIVERY_FIRST|DELIVERY_SECOND|credentialRef"|grants".*operation/,
    );
  assert.equal(f.service.delivery().configuration(projectId).version, 5);
  assert.equal(f.runtime.turns, 0);
});

test("delivery excluded rows and prefix expose only version-bound references and keep exact values or remove", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const envKey = "DELIVERY_OPAQUE_COLLISION",
    previous = process.env[envKey];
  process.env[envKey] = "private-prefix/";
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  const hiddenGrant = {
    action: "issue.comment" as const,
    mode: "allow" as const,
    repositoryId: "ordinary",
    projectNodeId: envKey,
    fieldNodeId: "F",
    optionNodeIds: ["O", "O"],
  };
  const visibleGrant = {
    action: "branch.push" as const,
    mode: "approval" as const,
    repositoryId: "ordinary",
    optionNodeIds: [],
  };
  const hiddenCheck = { name: `env:${envKey}`, appId: 7 };
  const visibleCheck = { name: "build" };
  f.service.domain().execute({
    ...deliveryInput(projectId),
    credentialRef: `env:${envKey}`,
    grants: [hiddenGrant, visibleGrant, hiddenGrant],
    requiredChecks: [hiddenCheck, visibleCheck],
    branchPrefix: "private-prefix/",
    actor: "operator",
  });
  const read = (await api.readProjectConfiguration(projectId)).data.delivery!;
  assert.deepEqual(read.grants[1], visibleGrant);
  assert.deepEqual(read.requiredChecks[1], visibleCheck);
  assert.deepEqual(read.grants[0], {
    kind: "unavailable",
    label: "Unavailable saved row",
    savedRow: { projectId, section: "delivery-grants", version: 2, index: 0 },
  });
  assert.deepEqual(read.requiredChecks[0], {
    kind: "unavailable",
    label: "Unavailable saved row",
    savedRow: { projectId, section: "delivery-checks", version: 2, index: 0 },
  });
  assert.equal(read.branchPrefix, null);
  assert.equal(read.branchPrefixUnavailable, true);
  for (const secret of [envKey, `env:${envKey}`, "private-prefix/"])
    assert.equal(JSON.stringify(read).includes(secret), false);
  const grant = read.grants[0]!,
    check = read.requiredChecks[0]!;
  assert.ok("savedRow" in grant && "savedRow" in check);
  const keep = deliveryInput(projectId, {
    expectedVersion: 2,
    preserveBranchPrefix: true,
    grants: [{ savedRow: grant.savedRow, keep: true }, visibleGrant],
    requiredChecks: [visibleCheck, { savedRow: check.savedRow, keep: true }],
  });
  const receipt = await api.execute(keep);
  assert.deepEqual(f.service.delivery().configuration(projectId), {
    version: 3,
    mode: "reviewable-pr",
    credentialRef: `env:${envKey}`,
    branchPrefix: "private-prefix/",
    grants: [hiddenGrant, visibleGrant],
    requiredChecks: [visibleCheck, hiddenCheck],
    repositories: [],
  });
  assert.equal(JSON.stringify(receipt).includes(envKey), false);
  f.seedPersistedState((db) => {
    const row = db
      .prepare(
        "SELECT payloadHash FROM command_receipts WHERE scope=? AND key=?",
      )
      .get(projectId, keep.key) as { payloadHash: string };
    assert.equal(
      row.payloadHash,
      historicalDeliveryHash({
        ...deliveryInput(projectId, {
          key: keep.key,
          expectedVersion: 2,
          credentialRef: `env:${envKey}`,
          branchPrefix: "private-prefix/",
          grants: [hiddenGrant, visibleGrant],
          requiredChecks: [visibleCheck, hiddenCheck],
        }),
        actor: "operator",
      }),
    );
  });
  await api.execute(
    deliveryInput(projectId, {
      expectedVersion: 3,
      branchPrefix: "",
      grants: [visibleGrant],
      requiredChecks: [visibleCheck],
    }),
  );
  const after = (await api.readProjectConfiguration(projectId)).data.delivery!;
  assert.deepEqual(after.grants, [visibleGrant]);
  assert.deepEqual(after.requiredChecks, [visibleCheck]);
  assert.equal(after.branchPrefix, "");
});

test("delivery saved row references reject duplicates foreign sections indexes and revisions without recording", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const grant = { action: "issue.comment", repositoryId: "R", mode: "allow" };
  await api.execute(
    deliveryInput(projectId, {
      grants: [grant],
      requiredChecks: [{ name: "build" }],
    }),
  );
  const savedRow = {
    projectId,
    section: "delivery-grants",
    version: 2,
    index: 0,
  };
  for (const [extra, status, paths] of [
    [
      {
        grants: [
          { savedRow, keep: true },
          { savedRow, keep: true },
        ],
      },
      400,
      ["grants.1.savedRow"],
    ],
    [
      {
        grants: [
          { savedRow: { ...savedRow, projectId: randomUUID() }, keep: true },
        ],
      },
      400,
      ["grants.0.savedRow"],
    ],
    [
      {
        grants: [
          { savedRow: { ...savedRow, section: "delivery-checks" }, keep: true },
        ],
      },
      400,
      ["grants.0.savedRow"],
    ],
    [
      { grants: [{ savedRow: { ...savedRow, index: 1 }, keep: true }] },
      400,
      ["grants.0.savedRow"],
    ],
    [
      { grants: [{ savedRow: { ...savedRow, version: 1 }, keep: true }] },
      409,
      undefined,
    ],
    [
      { requiredChecks: [{ savedRow, keep: true }] },
      400,
      ["requiredChecks.0.savedRow"],
    ],
  ] as const) {
    const input = deliveryInput(projectId, { expectedVersion: 2, ...extra });
    await assert.rejects(api.execute(input), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.status, status);
      assert.deepEqual(error.fieldPaths, paths);
      return true;
    });
    assert.equal(f.service.delivery().configuration(projectId).version, 2);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "delivery.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  }
});

test("delivery missing exclusion evidence withholds policy text and refuses normalization", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  await api.execute(
    deliveryInput(projectId, {
      branchPrefix: "private/",
      grants: [
        {
          action: "issue.comment",
          repositoryId: "private-repo",
          mode: "allow",
        },
      ],
      requiredChecks: [{ name: "private-check", appId: 42 }],
    }),
  );
  const original = DomainStore.prototype.deliveryCredentialReference;
  DomainStore.prototype.deliveryCredentialReference = () => {
    throw new Error("unavailable private lookup");
  };
  try {
    const policy = (await api.readProjectConfiguration(projectId)).data
      .delivery!;
    assert.equal(policy.branchPrefix, null);
    assert.equal(policy.branchPrefixUnavailable, true);
    assert.ok(policy.grants.every((row) => "savedRow" in row));
    assert.ok(policy.requiredChecks.every((row) => "savedRow" in row));
    assert.doesNotMatch(
      JSON.stringify(policy),
      /private-repo|private-check|private\/|unavailable private lookup/,
    );
    const input = deliveryInput(projectId, { expectedVersion: 2 });
    await assert.rejects(
      api.execute(input),
      (error: unknown) =>
        error instanceof OperatorApiError && error.status === 503,
    );
    assert.equal(f.service.delivery().configuration(projectId).version, 2);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "delivery.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  } finally {
    DomainStore.prototype.deliveryCredentialReference = original;
  }
});

test("delivery semantic refusals report indexed fields and do not write or leave receipts", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const base = { repositoryId: "R", mode: "allow" };
  for (const [grant, paths] of [
    [
      { ...base, action: "project.field" },
      [
        "grants.0.projectNodeId",
        "grants.0.fieldNodeId",
        "grants.0.optionNodeIds",
      ],
    ],
    [{ ...base, action: "project.item.add" }, ["grants.0.projectNodeId"]],
    [
      { ...base, action: "issue.status", statusIds: [] },
      ["grants.0.statusIds"],
    ],
    [
      { ...base, action: "issue.comment", statusIds: [] },
      ["grants.0.statusIds"],
    ],
  ] as const) {
    const input = deliveryInput(projectId, { grants: [grant] });
    await assert.rejects(api.execute(input), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.status, 400);
      assert.deepEqual(error.fieldPaths, paths);
      return true;
    });
    assert.equal(f.service.delivery().configuration(projectId).version, 1);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "delivery.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  }
});

test("delivery exclusion collisions reject explicit policy text but permit opaque preservation", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  await api.execute(
    deliveryInput(projectId, {
      credentialRef: "env:DELIVERY_POLICY_COLLISION",
    }),
  );
  for (const [extra, path] of [
    [
      {
        grants: [
          {
            action: "issue.comment",
            repositoryId: "DELIVERY_POLICY_COLLISION",
            mode: "allow",
          },
        ],
      },
      "grants.0",
    ],
    [
      { requiredChecks: [{ name: "env:DELIVERY_POLICY_COLLISION" }] },
      "requiredChecks.0.name",
    ],
    [{ branchPrefix: "DELIVERY_POLICY_COLLISION" }, "branchPrefix"],
  ] as const) {
    const input = deliveryInput(projectId, { expectedVersion: 2, ...extra });
    await assert.rejects(api.execute(input), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError && error.status === 400);
      assert.deepEqual(error.fieldPaths, [path]);
      return true;
    });
    assert.equal(f.service.delivery().configuration(projectId).version, 2);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "delivery.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  }
});

test("delivery explicit legacy hash and receipt replay survive later credentials restart and explicit undefined", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const original = {
    ...deliveryInput(projectId),
    credentialRef: "env:DELIVERY_LEGACY",
    branchPrefix: undefined,
    actor: "operator" as const,
  };
  const legacyResult = {
    mode: "reviewable-pr",
    version: 2,
    credentialConfigured: true,
    grants: [],
    requiredChecks: [],
  };
  const { branchPrefix: _absent, ...omitted } = original;
  assert.notEqual(
    historicalDeliveryHash(original),
    historicalDeliveryHash(omitted),
  );
  const expectedHash = historicalDeliveryHash(original);
  // An original pre-API receipt stores the legacy canonical digest, including explicit undefined.
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO command_receipts (scope,key,payloadHash,result) VALUES (?,?,?,?)",
    ).run(projectId, original.key, expectedHash, JSON.stringify(legacyResult));
  });
  const { actor: _actor, ...input } = original;
  const receipt = await api.execute(input);
  assert.deepEqual(receipt.kind === "configuration" && receipt.result, {
    commandType: "delivery.configure",
    resourceId: projectId,
    version: 2,
    credentialConfigured: true,
  });
  await api.execute(
    deliveryInput(projectId, {
      credentialRef: "env:DELIVERY_LATER",
      branchPrefix: "current/",
    }),
  );
  await f.reopen();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(input), receipt);
  assert.deepEqual(
    (
      await reopened.readOperation(
        new URLSearchParams({
          scope: `project:${projectId}`,
          type: "delivery.configure",
          key: input.key,
        }),
      )
    ).data,
    { state: "recorded", receipt },
  );
  await assert.rejects(
    reopened.execute({ ...input, credentialRef: null }),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  f.seedPersistedState((db) => {
    const row = db
      .prepare(
        "SELECT payloadHash,result FROM command_receipts WHERE scope=? AND key=?",
      )
      .get(projectId, original.key) as { payloadHash: string; result: string };
    assert.equal(row.payloadHash, expectedHash);
    assert.equal(row.result, JSON.stringify(legacyResult));
  });
  assert.equal(
    f.service.domain().deliveryCredentialReference(projectId),
    "env:DELIVERY_LATER",
  );
  assert.equal(f.service.delivery().configuration(projectId).version, 2);
});

test("delivery final domain CAS rejects a policy changed between normalization and the store call", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  const input = deliveryInput(projectId);
  const original = domain.execute.bind(domain);
  domain.execute = (command) => {
    if (command.type === "delivery.configure" && command.key === input.key)
      original({
        ...deliveryInput(projectId),
        actor: "operator",
        credentialRef: null,
        mode: "through-merge",
      });
    return original(command);
  };
  try {
    await assert.rejects(
      api.execute(input),
      (error: unknown) =>
        error instanceof OperatorApiError && error.status === 409,
    );
    assert.equal(f.service.delivery().configuration(projectId).version, 2);
    assert.equal(
      f.service.delivery().configuration(projectId).mode,
      "through-merge",
    );
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "delivery.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  } finally {
    domain.execute = original;
  }
});

test("delivery accepts policy row limits and rejects malformed shapes without writes or receipts", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const grant = { action: "issue.comment", repositoryId: "R", mode: "allow" };
  const failures: [object, string][] = [
    [{ grants: Array.from({ length: 257 }, () => grant) }, "grants"],
    [
      {
        requiredChecks: Array.from({ length: 101 }, () => ({ name: "build" })),
      },
      "requiredChecks",
    ],
    [{ credentialRef: "gh:example.com" }, "credentialRef"],
    [{ credentialRef: "env:not_valid" }, "credentialRef"],
    [{ branchPrefix: "../unsafe" }, "branchPrefix"],
    [{ branchPrefix: "x".repeat(65) }, "branchPrefix"],
    [{ preserveBranchPrefix: true, branchPrefix: "" }, "branchPrefix"],
    [{ grants: [{ ...grant, action: "branch.adopt" }] }, "grants.0.mode"],
    [{ grants: [{ ...grant, repositoryId: "" }] }, "grants.0.repositoryId"],
    [
      {
        grants: [
          { ...grant, statusIds: Array.from({ length: 257 }, () => "S") },
        ],
      },
      "grants.0.statusIds",
    ],
    [
      { requiredChecks: [{ name: "build", appId: 0 }] },
      "requiredChecks.0.appId",
    ],
    [
      { requiredChecks: [{ name: "build", appId: 1.5 }] },
      "requiredChecks.0.appId",
    ],
    [{ requiredChecks: [{ name: "" }] }, "requiredChecks.0.name"],
    [
      {
        grants: [
          {
            savedRow: {
              projectId,
              section: "delivery-grants",
              version: 1,
              index: -1,
            },
            keep: true,
          },
        ],
      },
      "grants.0.savedRow.index",
    ],
    [
      {
        grants: [
          {
            ...grant,
            savedRow: {
              projectId,
              section: "delivery-grants",
              version: 1,
              index: 0,
            },
            keep: true,
          },
        ],
      },
      "grants.0",
    ],
  ];
  for (const [extra, path] of failures) {
    const input = deliveryInput(projectId, extra);
    await assert.rejects(api.execute(input), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError && error.status === 400);
      const paths = error.fieldPaths ?? [];
      assert.ok(
        paths.some(
          (candidate) => candidate === path || candidate.startsWith(`${path}.`),
        ),
        `${path}: ${paths.join(",")}`,
      );
      return true;
    });
    assert.equal(f.service.delivery().configuration(projectId).version, 1);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "delivery.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  }
  const grants = Array.from({ length: 256 }, () => grant);
  const requiredChecks = Array.from({ length: 100 }, () => ({
    name: "build",
    appId: 1,
  }));
  await api.execute(deliveryInput(projectId, { grants, requiredChecks }));
  const read = (await api.readProjectConfiguration(projectId)).data.delivery!;
  assert.deepEqual(read.grants, grants);
  assert.deepEqual(read.requiredChecks, requiredChecks);
  assert.equal(f.runtime.turns, 0);
});

test("delivery preserved prefix keeps absence and empty as distinct policy shapes", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  await api.execute(deliveryInput(projectId, { preserveBranchPrefix: true }));
  assert.equal(
    Object.hasOwn(
      f.service.delivery().configuration(projectId),
      "branchPrefix",
    ),
    false,
  );
  await api.execute(
    deliveryInput(projectId, { expectedVersion: 2, branchPrefix: "" }),
  );
  await api.execute(
    deliveryInput(projectId, {
      expectedVersion: 3,
      preserveBranchPrefix: true,
    }),
  );
  assert.equal(f.service.delivery().configuration(projectId).branchPrefix, "");
  assert.equal(
    (await api.readProjectConfiguration(projectId)).data.delivery!.branchPrefix,
    "",
  );
});

test("delivery configuration read rebuilds when a credential exclusion changes after collection", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const envKey = "DELIVERY_READ_FENCE",
    previous = process.env[envKey];
  process.env[envKey] = "old-private-value";
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  await api.execute(
    deliveryInput(projectId, {
      credentialRef: `env:${envKey}`,
      branchPrefix: "new-private/",
    }),
  );
  const delivery = f.service.delivery();
  const original = delivery.publicConfiguration.bind(delivery);
  let reads = 0;
  delivery.publicConfiguration = (id) => {
    const value = original(id);
    if (++reads === 1) process.env[envKey] = "new-private/";
    return value;
  };
  try {
    const policy = (await api.readProjectConfiguration(projectId)).data
      .delivery!;
    assert.equal(policy.branchPrefix, null);
    assert.equal(policy.branchPrefixUnavailable, true);
    assert.equal(JSON.stringify(policy).includes("new-private/"), false);
    assert.equal(reads, 2);
  } finally {
    delivery.publicConfiguration = original;
  }
});

test("delivery HTTP writes retain session Origin CSRF and bearer scopes with indexed 400 and stale 409", async (t) => {
  const { f, projectId } = await deliveryFixture(t);
  const { serveCli } = await import("../fixtures/operator-cli.js");
  const s = await serveCli(t, f);
  const endpoint = "/api/operator/commands";
  const command = deliveryInput(projectId, {
    credentialRef: "env:HTTP_DELIVERY",
  });
  assert.equal(
    (
      await fetch(`${s.origin}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await s.sessionPost(endpoint, command, {
        origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await s.sessionPost(endpoint, command, { "x-csrf-token": "wrong" }))
      .status,
    403,
  );
  const read = await s.issue("read");
  const write = await s.issue("read-write");
  assert.equal(
    (await s.bearer(read.token, endpoint, { method: "POST", body: command }))
      .status,
    403,
  );
  for (const [extra, path] of [
    [
      {
        grants: [{ action: "project.field", repositoryId: "R", mode: "allow" }],
      },
      "grants.0.projectNodeId",
    ],
    [
      {
        grants: [{ action: "branch.adopt", repositoryId: "R", mode: "allow" }],
      },
      "grants.0.mode",
    ],
    [
      { requiredChecks: [{ name: "build", appId: 0 }] },
      "requiredChecks.0.appId",
    ],
    [{ branchPrefix: "../bad" }, "branchPrefix"],
    [{ credentialRef: "env:invalid" }, "credentialRef"],
  ] as const) {
    const invalid = deliveryInput(projectId, extra);
    const response = await s.sessionPost(endpoint, invalid);
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      error: { code: string; fieldPaths: string[] };
    };
    assert.equal(body.error.code, "invalid-input");
    assert.ok(body.error.fieldPaths.includes(path), JSON.stringify(body));
    assert.equal(f.service.delivery().configuration(projectId).version, 1);
    const lookup = await s.sessionGet(
      `/api/operator/operations?scope=project:${projectId}&type=delivery.configure&key=${invalid.key}`,
    );
    assert.deepEqual(((await lookup.json()) as { data: unknown }).data, {
      state: "not-recorded",
    });
  }
  const set = await s.bearer(write.token, endpoint, {
    method: "POST",
    body: command,
  });
  assert.equal(set.status, 200);
  const receipt = await set.json();
  assert.deepEqual(receipt, {
    kind: "configuration",
    key: command.key,
    recorded: true,
    result: {
      commandType: "delivery.configure",
      resourceId: projectId,
      version: 2,
      credentialConfigured: true,
    },
  });
  const stale = await s.sessionPost(endpoint, deliveryInput(projectId));
  assert.equal(stale.status, 409);
  const collision = await s.sessionPost(
    endpoint,
    deliveryInput(projectId, {
      expectedVersion: 2,
      requiredChecks: [{ name: "HTTP_DELIVERY" }],
    }),
  );
  assert.equal(collision.status, 400);
  assert.equal((await collision.text()).includes("HTTP_DELIVERY"), false);
  const config = await s.bearer(
    read.token,
    `/api/operator/projects/${projectId}/configuration`,
  );
  assert.equal(config.status, 200);
  const publicText = await config.text();
  assert.equal(publicText.includes("HTTP_DELIVERY"), false);
  assert.equal(publicText.includes('"credentialRef"'), false);
  assert.equal((await s.sessionPost(endpoint, command)).status, 200);
  const lookup = await s.bearer(
    read.token,
    `/api/operator/operations?scope=project:${projectId}&type=delivery.configure&key=${command.key}`,
  );
  assert.equal(lookup.status, 200);
  assert.deepEqual(((await lookup.json()) as { data: unknown }).data, {
    state: "recorded",
    receipt,
  });
  assert.equal(f.runtime.turns, 0);
});

test("delivery unknown normalized save is recovered by original operation after credential change and restart", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  await api.execute(
    deliveryInput(projectId, {
      credentialRef: "env:DELIVERY_UNKNOWN_ORIGINAL",
    }),
  );
  const input = deliveryInput(projectId, { expectedVersion: 2 });
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const injected = new DomainStore(db, () => {
    throw new DomainPolicyError("invalid-input", "private postcommit failure");
  });
  const domain = f.service.domain(),
    original = domain.execute.bind(domain);
  domain.execute = (command) =>
    command.key === input.key ? injected.execute(command) : original(command);
  try {
    await assert.rejects(
      api.execute(input),
      (error: unknown) =>
        error instanceof OperatorApiError &&
        error.status === 503 &&
        error.code === "command-outcome-unknown",
    );
  } finally {
    domain.execute = original;
  }
  assert.equal(f.service.delivery().configuration(projectId).version, 3);
  await api.execute(
    deliveryInput(projectId, {
      expectedVersion: 3,
      credentialRef: "env:DELIVERY_UNKNOWN_LATER",
    }),
  );
  await f.reopen();
  const reopened = new OperatorApi(f.service, [f.directory]);
  const query = new URLSearchParams({
    scope: `project:${projectId}`,
    type: "delivery.configure",
    key: input.key,
  });
  const readback = await reopened.readOperation(query);
  assert.deepEqual(readback.data, {
    state: "recorded",
    receipt: {
      kind: "configuration",
      key: input.key,
      recorded: true,
      result: {
        commandType: "delivery.configure",
        resourceId: projectId,
        version: 3,
        credentialConfigured: true,
      },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(readback),
    /DELIVERY_UNKNOWN|private postcommit failure/,
  );
  await assert.rejects(
    reopened.execute(input),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  assert.equal(f.service.delivery().configuration(projectId).version, 4);
  assert.equal(
    f.service.domain().deliveryCredentialReference(projectId),
    "env:DELIVERY_UNKNOWN_LATER",
  );
  await assert.rejects(
    reopened.readOperation(
      new URLSearchParams({
        ...Object.fromEntries(query),
        type: "project.configure",
      }),
    ),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  f.seedPersistedState((store) =>
    store
      .prepare("UPDATE command_receipts SET result=? WHERE scope=? AND key=?")
      .run('{"version":"invalid"}', projectId, input.key),
  );
  await assert.rejects(
    reopened.readOperation(query),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  assert.equal(f.runtime.turns, 0);
});

test("opaque GitHub selections retain definitions readiness and closed mode with visible edits without activating", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  domain.execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: "env:HIDDEN_SELECTION",
  });
  const hidden = {
    id: "HIDDEN_SELECTION",
    kind: "search" as const,
    query: "is:open private query",
  };
  const visible = {
    id: "visible",
    kind: "repository" as const,
    repositoryId: "R",
    owner: "acme",
    name: "app",
  };
  const readiness = {
    mode: "all" as const,
    conditions: [
      {
        kind: "label" as const,
        operator: "has" as const,
        name: "HIDDEN_SELECTION",
      },
    ],
  };
  domain.execute({
    type: "github.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    selections: [hidden, visible],
    readiness,
    closedIssues: "done",
  });
  const read = (await api.readProjectConfiguration(projectId)).data.source;
  assert.equal(read.selections[0]!.id, null);
  assert.deepEqual(read.selections[0]!.savedRow, {
    projectId,
    section: "source",
    version: 2,
    index: 0,
  });
  assert.equal(read.readiness.kind, "unavailable");
  assert.equal(JSON.stringify(read).includes(hidden.id), false);
  const kept = { savedRow: read.selections[0]!.savedRow, keep: true };
  const added = { id: "new", kind: "search", query: "new private query" };
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    selections: [kept, { id: visible.id, keep: true }, added],
  });
  assert.deepEqual(domain.githubConfiguration(projectId).selections, [
    hidden,
    visible,
    added,
  ]);
  assert.deepEqual(domain.githubConfiguration(projectId).readiness, readiness);
  assert.equal(domain.githubConfiguration(projectId).closedIssues, "done");
  assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 3,
    selections: [{ id: visible.id, keep: true }],
  });
  assert.deepEqual(domain.githubConfiguration(projectId).selections, [visible]);
  assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
  assert.equal(f.runtime.turns, 0);
});

test("opaque source references reject foreign tracker section ordinal duplicates collisions and limits without writes", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  domain.execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: "env:HIDDEN_SELECTION",
  });
  domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    selections: [{ id: "HIDDEN_SELECTION", kind: "search", query: "query" }],
    readiness: null,
  });
  const savedRow = { projectId, section: "source", version: 2, index: 0 };
  const keep = { savedRow, keep: true };
  const base = {
    type: "github.configure",
    projectId,
    expectedVersion: 2,
    selections: [keep],
  };
  const matrix: [object, number, string?][] = [
    [{ selections: [keep, keep] }, 400, "selections.1.savedRow"],
    [
      {
        selections: [
          { savedRow: { ...savedRow, projectId: randomUUID() }, keep: true },
        ],
      },
      400,
      "selections.0.savedRow",
    ],
    [
      {
        selections: [
          { savedRow: { ...savedRow, section: "repositories" }, keep: true },
        ],
      },
      400,
      "selections.0.savedRow",
    ],
    [
      { selections: [{ savedRow: { ...savedRow, index: 1 }, keep: true }] },
      400,
      "selections.0.savedRow",
    ],
    [
      { selections: [{ savedRow: { ...savedRow, version: 1 }, keep: true }] },
      409,
    ],
    [
      { type: "jira.configure", instance: "example.atlassian.net" },
      400,
      "selections.0.savedRow",
    ],
    [
      {
        selections: [
          keep,
          { id: "HIDDEN_SELECTION", kind: "search", query: "replacement" },
        ],
      },
      400,
      "selections.1.id",
    ],
    [
      {
        selections: [
          { id: "HIDDEN_SELECTION", kind: "search", query: "replacement" },
        ],
      },
      400,
      "selections.0.id",
    ],
    [
      {
        selections: [
          ...Array.from({ length: 30 }, (_, i) => ({
            id: `new-${i}`,
            kind: "search",
            query: "query",
          })),
          keep,
        ],
      },
      400,
      "selections",
    ],
  ];
  for (const [extra, status, path] of matrix) {
    const input = { ...base, key: randomUUID(), ...extra };
    await assert.rejects(api.execute(input), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.status, status);
      if (path)
        assert.ok(
          error.fieldPaths?.includes(path),
          JSON.stringify(error.fieldPaths),
        );
      assert.equal(JSON.stringify(error).includes("HIDDEN_SELECTION"), false);
      return true;
    });
    assert.equal(domain.githubConfiguration(projectId).version, 2);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type:
              input.type === "jira.configure"
                ? "jira.configure"
                : "github.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  }
  // A selection that became withheld since the read must be reviewed, not substituted by its old visible id.
  const visible = { id: "BECOMES_HIDDEN", kind: "search", query: "query" };
  await api.execute({
    ...base,
    key: randomUUID(),
    selections: [keep, visible],
  });
  domain.execute({
    ...deliveryInput(projectId),
    actor: "operator",
    expectedVersion: 2,
    credentialRef: "env:BECOMES_HIDDEN",
  });
  await assert.rejects(
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 3,
      selections: [{ id: visible.id, keep: true }],
    }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.status === 400 &&
      error.fieldPaths?.[0] === "selections.0.id",
  );
  assert.equal(domain.githubConfiguration(projectId).version, 3);
});

test("a Jira query added beside a hidden sequential identity round trips through the editor command", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  const previous = process.env.JIRA_HIDDEN_SELECTION;
  process.env.JIRA_HIDDEN_SELECTION = "S-1";
  t.after(() => {
    if (previous === undefined) delete process.env.JIRA_HIDDEN_SELECTION;
    else process.env.JIRA_HIDDEN_SELECTION = previous;
  });
  domain.execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: "env:JIRA_HIDDEN_SELECTION",
  });
  domain.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: "example.atlassian.net",
    credential: {
      siteRef: "env:JIRA_SITE",
      emailRef: "env:JIRA_EMAIL",
      tokenRef: "env:JIRA_TOKEN",
    },
  });
  const hidden = { id: "S-1", kind: "jql" as const, jql: "project = PRIVATE" };
  domain.execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance: "example.atlassian.net",
    selections: [hidden],
  });
  f.service.jiraJqlErrors = async () => [];
  const { jiraRowsFrom, jiraSelections } = await import(
    "../../web/src/settings-changes.js"
  );
  const source = (await api.readProjectConfiguration(projectId)).data.source;
  assert.equal(source.selections[0]!.id, null);
  const selections = jiraSelections(source, {
    ...jiraRowsFrom(source),
    jql: "project = NEW",
  });
  await api.execute({
    type: "jira.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: source.version,
    selections,
  });
  const saved = domain.jiraConfiguration(projectId)!;
  assert.deepEqual(saved.selections[0], hidden);
  assert.equal(saved.selections[1]!.jql, "project = NEW");
  assert.notEqual(saved.selections[1]!.id, hidden.id);
  const read = await api.readProjectConfiguration(projectId);
  assert.equal(read.data.source.selections.length, 2);
  assert.equal(JSON.stringify(read).includes("S-1"), false);
});

test("opaque Jira selections preserve hidden IDs JQL readiness closed mode and instance beside visible edits", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  const previousSite = process.env.HIDDEN_JIRA_ID;
  process.env.HIDDEN_JIRA_ID = "example.atlassian.net";
  t.after(() => {
    if (previousSite === undefined) delete process.env.HIDDEN_JIRA_ID;
    else process.env.HIDDEN_JIRA_ID = previousSite;
  });
  domain.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: "example.atlassian.net",
    credential: {
      siteRef: "env:JIRA_SITE",
      emailRef: "env:JIRA_EMAIL",
      tokenRef: "env:JIRA_TOKEN",
    },
  });
  domain.execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: "env:HIDDEN_JIRA_ID",
  });
  const hidden = {
    id: "HIDDEN_JIRA_ID",
    kind: "jql" as const,
    jql: "project = PRIVATE",
  };
  const readiness = {
    mode: "all" as const,
    conditions: [
      {
        kind: "status" as const,
        operator: "in" as const,
        statusIds: ["ready"],
      },
    ],
  };
  domain.execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance: "example.atlassian.net",
    selections: [
      hidden,
      { id: "visible", kind: "jql", jql: "project = VISIBLE" },
    ],
    readiness,
    closedIssues: "done",
  });
  let queries = 0;
  f.service.jiraJqlErrors = async () => {
    queries++;
    return [];
  };
  const source = (await api.readProjectConfiguration(projectId)).data.source;
  assert.equal(source.selections[0]!.id, null);
  assert.equal(source.instance, null);
  const input = {
    type: "jira.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    selections: [
      { savedRow: source.selections[0]!.savedRow, keep: true },
      { id: "visible", kind: "jql", jql: "project = CHANGED" },
    ],
  };
  const receipt = await api.execute(input);
  const saved = domain.jiraConfiguration(projectId)!;
  assert.equal(queries, 1);
  assert.deepEqual(saved.selections, [
    hidden,
    { id: "visible", kind: "jql", jql: "project = CHANGED" },
  ]);
  assert.deepEqual(saved.readiness, readiness);
  assert.equal(saved.closedIssues, "done");
  assert.equal(saved.instance, "example.atlassian.net");
  assert.equal(JSON.stringify(receipt).includes(hidden.id), false);
  const wrongKind = {
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 3,
    selections: [
      {
        savedRow: { projectId, section: "source", version: 3, index: 0 },
        keep: true,
      },
    ],
  };
  await assert.rejects(
    api.execute(wrongKind),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 400,
  );
  await assert.rejects(
    api.execute({
      type: "jira.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 3,
      instance: "other.atlassian.net",
      selections: [
        {
          savedRow: { projectId, section: "source", version: 3, index: 0 },
          keep: true,
        },
      ],
    }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.status === 400 &&
      error.fieldPaths?.[0] === "instance",
  );
  assert.equal(queries, 1);
  await f.reopen();
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(
    (
      await reopened.readOperation(
        new URLSearchParams({
          scope: `project:${projectId}`,
          type: "jira.configure",
          key: input.key,
        }),
      )
    ).data,
    { state: "recorded", receipt },
  );
  await assert.rejects(
    reopened.execute(input),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  assert.equal(f.service.domain().jiraConfiguration(projectId)!.version, 3);
  assert.equal(f.runtime.turns, 0);
});

test("opaque GitHub and GitLab links preserve exact path ref host project path and still verify every checkout", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const github = join(f.directory, "opaque-gh"),
    gitlab = join(f.directory, "opaque-gl"),
    visible = join(f.directory, "visible-link");
  await checkout(github, "https://github.com/acme/app.git");
  await checkout(gitlab, "https://secret.example.com/group/app.git");
  await checkout(visible, "https://github.com/acme/visible.git");
  const envKey = "OPAQUE_LINK_ID",
    previous = process.env[envKey];
  process.env[envKey] = "secret.example.com";
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  f.service.domain().execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: `env:${envKey}`,
  });
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: envKey,
        path: github,
        ref: "main",
      },
      {
        codeHost: "gitlab",
        host: "secret.example.com",
        repositoryId: "42",
        projectPath: "group/app",
        path: gitlab,
        ref: "main",
      },
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "visible",
        path: visible,
        ref: "main",
      },
    ],
  });
  const saved = f.service.domain().repositoryLinks(projectId);
  const read = (await api.readProjectConfiguration(projectId)).data
    .repositories;
  assert.ok(
    read.links
      .slice(0, 2)
      .every(
        (row) =>
          row.repositoryId === null &&
          row.host === null &&
          row.ref === null &&
          row.savedRow,
      ),
  );
  assert.doesNotMatch(
    JSON.stringify(read),
    /OPAQUE_LINK_ID|secret.example.com|group\/app|opaque-gh|opaque-gl/,
  );
  // The whole link is opaque when its host is withheld, even if its numeric ID alone is public.
  const collision = {
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    repositories: [
      {
        codeHost: "gitlab",
        host: "secret.example.com",
        repositoryId: "42",
        projectPath: "group/app",
        path: gitlab,
        ref: "main",
      },
    ],
  };
  await assert.rejects(
    api.execute(collision),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.status === 400 &&
      error.fieldPaths?.[0] === "repositories.0.repositoryId",
  );
  assert.equal(f.service.domain().repositoryLinks(projectId).version, 2);
  const originalKeep = {
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    repositories: [
      ...read.links
        .slice(0, 2)
        .map((row) => ({ savedRow: row.savedRow, keep: true })),
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "visible",
        ref: "HEAD",
      },
    ],
  };
  const originalReceipt = await api.execute(originalKeep);
  assert.deepEqual(
    f.service.domain().repositoryLinks(projectId).links,
    saved.links.map((row, index) =>
      index === 2 ? { ...row, ref: "HEAD" } : row,
    ),
  );
  const current = (await api.readProjectConfiguration(projectId)).data
    .repositories;
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 3,
    repositories: [{ savedRow: current.links[1]!.savedRow, keep: true }],
  });
  assert.deepEqual(f.service.domain().repositoryLinks(projectId).links, [
    saved.links[1],
  ]);
  // A retained link is not a verification bypass: changing its actual origin refuses the next save.
  await promisify(execFile)("git", [
    "-C",
    gitlab,
    "remote",
    "set-url",
    "origin",
    "https://secret.example.com/group/other.git",
  ]);
  const last = (await api.readProjectConfiguration(projectId)).data
    .repositories;
  const bad = {
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 4,
    repositories: [{ savedRow: last.links[0]!.savedRow, keep: true }],
  };
  await assert.rejects(
    api.execute(bad),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.status === 400 &&
      error.fieldPaths?.[0] === "repositories.0.path",
  );
  assert.equal(f.service.domain().repositoryLinks(projectId).version, 4);
  assert.deepEqual(
    (
      await api.readOperation(
        new URLSearchParams({
          scope: `project:${projectId}`,
          type: "repositories.configure",
          key: bad.key,
        }),
      )
    ).data,
    { state: "not-recorded" },
  );
  await f.reopen();
  const reopened = new OperatorApi(f.service, [f.directory]);
  await assert.rejects(
    reopened.execute(originalKeep),
    (error: unknown) =>
      error instanceof OperatorApiError && error.status === 409,
  );
  assert.deepEqual(
    (
      await reopened.readOperation(
        new URLSearchParams({
          scope: `project:${projectId}`,
          type: "repositories.configure",
          key: originalKeep.key,
        }),
      )
    ).data,
    { state: "recorded", receipt: originalReceipt },
  );
  assert.deepEqual(f.service.domain().repositoryLinks(projectId).links, [
    saved.links[1],
  ]);
  assert.equal(f.runtime.turns, 0);
});

test("opaque repository handles reject section project ordinal duplicates stale versions and expanded limits", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const path = join(f.directory, "kept-link");
  await checkout(path, "https://github.com/acme/app.git");
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R",
        path,
        ref: "main",
      },
    ],
  });
  const savedRow = { projectId, section: "repositories", version: 2, index: 0 };
  const keep = { savedRow, keep: true };
  for (const [rows, status, field] of [
    [[keep, keep], 400, "repositories.1.savedRow"],
    [
      [{ savedRow: { ...savedRow, section: "source" }, keep: true }],
      400,
      "repositories.0.savedRow",
    ],
    [
      [{ savedRow: { ...savedRow, projectId: randomUUID() }, keep: true }],
      400,
      "repositories.0.savedRow",
    ],
    [
      [{ savedRow: { ...savedRow, index: 1 }, keep: true }],
      400,
      "repositories.0.savedRow",
    ],
    [[{ savedRow: { ...savedRow, version: 1 }, keep: true }], 409, undefined],
    [
      [
        keep,
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "R",
          path,
          ref: "main",
        },
      ],
      400,
      "repositories.1.repositoryId",
    ],
    [
      [
        keep,
        ...Array.from({ length: 20 }, (_, index) => ({
          codeHost: "github",
          host: "github.com",
          repositoryId: `R-${index}`,
          path,
          ref: "main",
        })),
      ],
      400,
      "repositories",
    ],
  ] as const) {
    const input = {
      type: "repositories.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      repositories: rows,
    };
    await assert.rejects(api.execute(input), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.status, status);
      if (field)
        assert.ok(
          error.fieldPaths?.includes(field),
          JSON.stringify(error.fieldPaths),
        );
      return true;
    });
    assert.equal(f.service.domain().repositoryLinks(projectId).version, 2);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "repositories.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  }
});

test("opaque source reads fail closed without exclusion evidence and refuse keep normalization without mutations", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    selections: [
      { id: "saved-private", kind: "search", query: "private query" },
    ],
    readiness: null,
  });
  const original = DomainStore.prototype.deliveryCredentialReference;
  DomainStore.prototype.deliveryCredentialReference = () => {
    throw new Error("private exclusion lookup unavailable");
  };
  try {
    const read = (await api.readProjectConfiguration(projectId)).data.source;
    assert.equal(read.selections[0]!.id, null);
    assert.equal(JSON.stringify(read).includes("saved-private"), false);
    const input = {
      type: "github.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      selections: [{ savedRow: read.selections[0]!.savedRow, keep: true }],
    };
    await assert.rejects(
      api.execute(input),
      (error: unknown) =>
        error instanceof OperatorApiError && error.status === 503,
    );
    assert.equal(f.service.domain().githubConfiguration(projectId).version, 2);
    assert.deepEqual(
      (
        await api.readOperation(
          new URLSearchParams({
            scope: `project:${projectId}`,
            type: "github.configure",
            key: input.key,
          }),
        )
      ).data,
      { state: "not-recorded" },
    );
  } finally {
    DomainStore.prototype.deliveryCredentialReference = original;
  }
});

test("credential exclusions protect the entire configuration including status mapping scopes", async (t) => {
  for (const tracker of ["github", "jira"] as const)
    await t.test(tracker, async (t) => {
      const { f, api, projectId } = await deliveryFixture(t);
      const domain = f.service.domain();
      const envKey = "STATUS_MAPPING_PRIVATE_REFERENCE";
      const privateValue = "STATUS_MAPPING_PRIVATE_VALUE";
      const previous = process.env[envKey];
      process.env[envKey] = privateValue;
      t.after(() => {
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
      });
      if (tracker === "github")
        domain.execute({
          type: "github.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          expectedVersion: 1,
          selections: [
            {
              id: envKey,
              kind: "project",
              projectNodeId: privateValue,
              filter: "",
            },
          ],
          readiness: null,
        });
      else {
        domain.execute({
          type: "issue-tracker-credential.configure",
          actor: "operator",
          key: randomUUID(),
          issueTracker: "jira",
          instance: "example.atlassian.net",
          credential: {
            siteRef: "env:JIRA_SITE",
            emailRef: "env:JIRA_EMAIL",
            tokenRef: "env:JIRA_TOKEN",
          },
        });
        domain.execute({
          type: "jira.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          expectedVersion: 1,
          instance: "example.atlassian.net",
          selections: [
            { id: "visible", kind: "jql", jql: "project = VISIBLE" },
          ],
          readiness: null,
        });
      }
      const grant =
        tracker === "github"
          ? {
              action: "project.field" as const,
              repositoryId: "R",
              mode: "allow" as const,
              projectNodeId: privateValue,
              fieldNodeId: envKey,
              optionNodeIds: [envKey, privateValue],
            }
          : {
              action: "issue.status" as const,
              repositoryId: "R",
              mode: "allow" as const,
              statusIds: [envKey, privateValue],
            };
      domain.execute({
        ...deliveryInput(projectId),
        actor: "operator",
        credentialRef: `env:${envKey}`,
        grants: [grant],
      });
      const withoutMapping = await api.readProjectConfiguration(projectId);
      for (const secret of [envKey, `env:${envKey}`, privateValue])
        assert.equal(JSON.stringify(withoutMapping).includes(secret), false);
      assert.equal(withoutMapping.data.statusMapping, undefined);
      const mapping =
        tracker === "github"
          ? {
              selectionId: envKey,
              projectNodeId: privateValue,
              fieldNodeId: envKey,
              events: {
                turnStarted: null,
                handedBack: null,
                held: null,
                done: privateValue,
              },
            }
          : {
              tracker: "jira" as const,
              events: {
                turnStarted: null,
                handedBack: null,
                held: null,
                done: privateValue,
              },
            };
      domain.execute({
        type: "status-mapping.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: 1,
        mapping,
      });
      for (const removeGrant of [false, true]) {
        if (removeGrant)
          domain.execute({
            ...deliveryInput(projectId),
            expectedVersion: 2,
            actor: "operator",
            credentialRef: `env:${envKey}`,
            grants: [],
          });
        const read = await api.readProjectConfiguration(projectId);
        for (const secret of [envKey, `env:${envKey}`, privateValue])
          assert.equal(JSON.stringify(read).includes(secret), false);
        assert.equal(
          read.data.statusMapping,
          undefined,
          "a withheld mapping must not become an editable empty mapping",
        );
        if (!removeGrant)
          assert.equal("savedRow" in read.data.delivery!.grants[0]!, true);
        assert.deepEqual(
          domain.statusMapping(projectId).mapping,
          mapping,
          "read projection never changes persisted mapping",
        );
      }
      assert.equal(f.runtime.turns, 0);
    });
});

test("delivery policies with 257 Project options save and preserve the full configuration read", async (t) => {
  for (const duplicates of [false, true])
    await t.test(duplicates ? "duplicates" : "distinct", async (t) => {
      const { f, api, projectId } = await deliveryFixture(t);
      const grant = {
        action: "project.field" as const,
        repositoryId: "R",
        mode: "allow" as const,
        projectNodeId: "P",
        fieldNodeId: "F",
        optionNodeIds: Array.from({ length: 257 }, (_, index) =>
          duplicates ? "option" : `option-${index}`,
        ),
      };
      const input = deliveryInput(projectId, { grants: [grant] });
      assert.ok(Buffer.byteLength(JSON.stringify(input)) < 64 * 1024);
      await api.execute(input);
      const read = await api.readProjectConfiguration(projectId);
      assert.deepEqual(read.data.delivery!.grants, [grant]);
      const mapping = read.data.statusMapping;
      assert.ok(mapping && !("tracker" in mapping));
      assert.deepEqual(mapping.granted, [
        {
          projectNodeId: "P",
          fieldNodeId: "F",
          optionNodeIds: grant.optionNodeIds,
        },
      ]);
      assert.deepEqual(f.service.delivery().configuration(projectId).grants, [
        grant,
      ]);
      assert.equal(f.runtime.turns, 0);
    });
});

test("a withheld Project selection leaves public grant reductions warnable without disclosing its id", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  const envKey = "PRIVATE_MAPPING_SELECTION";
  domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    selections: [
      { id: envKey, kind: "project", projectNodeId: "P", filter: "" },
    ],
    readiness: null,
  });
  const grant = {
    action: "project.field" as const,
    repositoryId: "R",
    mode: "allow" as const,
    projectNodeId: "P",
    fieldNodeId: "F",
    optionNodeIds: ["O"],
  };
  domain.execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: `env:${envKey}`,
    grants: [grant],
  });
  domain.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mapping: {
      selectionId: envKey,
      projectNodeId: "P",
      fieldNodeId: "F",
      events: { turnStarted: null, handedBack: null, held: null, done: "O" },
    },
  });
  const read = await api.readProjectConfiguration(projectId);
  assert.equal(JSON.stringify(read).includes(envKey), false);
  assert.equal(read.data.statusMapping, undefined);
  const saved = read.data.delivery!;
  assert.deepEqual(saved.grants, [grant]);
  const { deliveryMappingCoverageWarning } = await import(
    "../../web/src/delivery-policy-draft.js"
  );
  for (const grants of [[], [{ ...grant, mode: "approval" as const }]])
    assert.match(
      deliveryMappingCoverageWarning(
        saved,
        { ...saved, grants },
        read.data.statusMapping,
      ) ?? "",
      /may remove status-mapping authority/,
    );
  assert.equal(f.runtime.turns, 0);
});

test("routing Settings partial edits preserve an existing 129-candidate domain configuration", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const domain = f.service.domain();
  const ids = Array.from({ length: 129 }, () => randomUUID()).sort();
  for (const profileId of ids)
    domain.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: "Candidate",
      instructions: "Routing candidate",
      capabilities: "Work",
    });
  domain.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "Original",
    candidateProfileIds: ids,
  });
  const read = await api.readProjectConfiguration(projectId);
  assert.deepEqual(read.data.routing.candidateProfileIds, ids);
  const { routingCommand } = await import("../../web/src/settings-changes.js");
  const command = routingCommand(
    projectId,
    {
      key: randomUUID(),
      expectedVersion: "2",
      enabled: true,
      candidateProfileIds: ids,
      guidance: "Updated",
      referenceMode: "preserve",
    },
    read.data,
    "Original",
  );
  assert.ok(Buffer.byteLength(JSON.stringify(command)) < 64 * 1024);
  await api.execute(command);
  const after = await api.readProjectConfiguration(projectId);
  assert.deepEqual(after.data.routing.candidateProfileIds, ids);
  assert.equal(domain.routing(projectId).guidance, "Updated");
  assert.equal(domain.routing(projectId).enabled, 1);
  assert.equal(f.runtime.turns, 0);
});

import { repositoryLevelGrants } from "../../src/core/delivery-levels.js";
import {
  applyRepositoryDeliveryLevel,
  deliveryPolicyDraft,
  deliveryPolicySubmission,
} from "../../web/src/delivery-policy-draft.js";

test("repository preset submissions persist complete policy atomically through the keyed API", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const retained = [
    {
      action: "issue.comment",
      repositoryId: "R",
      mode: "allow",
      optionNodeIds: ["O", "O"],
    },
    {
      action: "branch.adopt",
      repositoryId: "R",
      mode: "approval",
      projectNodeId: "P",
    },
    {
      action: "issue.comment",
      repositoryId: "R",
      mode: "allow",
      optionNodeIds: ["O", "O"],
    },
  ];
  const requiredChecks = [{ name: "build", appId: 42 }, { name: "build" }];
  await api.execute(
    deliveryInput(projectId, {
      credentialRef: "env:PRESET_CREDENTIAL",
      branchPrefix: "",
      requiredChecks,
      grants: [
        ...retained,
        ...repositoryLevelGrants("unlinked", "merge-with-approval"),
      ],
    }),
  );
  for (const [targets, level, mode] of [
    [["R", "42"], "open-prs", "through-merge"],
    [["R"], "merge-with-approval", "through-merge"],
    [["R"], "merge-when-ready", "through-merge"],
    [["unlinked", "R"], "open-prs", "reviewable-pr"],
  ] as const) {
    const saved = (await api.readProjectConfiguration(projectId)).data
      .delivery!;
    const result = applyRepositoryDeliveryLevel(
      deliveryPolicyDraft(saved),
      targets,
      level,
    );
    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") throw Error("Preset unexpectedly refused");
    const command = {
      type: "delivery.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: saved.version,
      ...deliveryPolicySubmission(result.draft),
    };
    await api.execute(command);
    const read = (await api.readProjectConfiguration(projectId)).data.delivery!;
    assert.equal(read.version, saved.version + 1);
    assert.equal(read.mode, mode);
    assert.deepEqual(read.grants, result.draft.grants);
    assert.deepEqual(read.grants.slice(0, 3), retained);
    for (const id of targets)
      assert.deepEqual(
        read.grants.filter(
          (g) =>
            !("savedRow" in g) &&
            g.repositoryId === id &&
            !g.action.startsWith("issue.") &&
            g.action !== "branch.adopt",
        ),
        repositoryLevelGrants(id, level),
      );
    assert.equal(read.branchPrefix, "");
    assert.deepEqual(read.requiredChecks, requiredChecks);
    assert.equal(
      f.service.domain().deliveryCredentialReference(projectId),
      "env:PRESET_CREDENTIAL",
    );
  }
  assert.equal(f.runtime.turns, 0);
  assert.deepEqual(f.service.delivery().actions(), []);
});

test("advanced submission preserves opaque grants checks and prefix alongside public edits", async (t) => {
  const { f, api, projectId } = await deliveryFixture(t);
  const hidden = "PRESET_PRIVATE_MATERIAL";
  const grants: import("../../src/core/delivery.js").DeliveryPolicy["grants"] =
    [
      { action: "issue.comment", repositoryId: hidden, mode: "approval" },
      { action: "issue.labels", repositoryId: "public", mode: "allow" },
    ];
  f.service.domain().execute({
    ...deliveryInput(projectId),
    actor: "operator",
    credentialRef: `env:${hidden}`,
    branchPrefix: hidden,
    grants,
    requiredChecks: [{ name: hidden }],
  });
  const saved = (await api.readProjectConfiguration(projectId)).data.delivery!;
  assert.ok(saved.grants.some((row) => "savedRow" in row));
  assert.equal(saved.branchPrefix, null);
  const draft = deliveryPolicyDraft(saved);
  draft.grants.push({
    action: "issue.comment",
    repositoryId: "public",
    mode: "allow",
  });
  draft.grantKeys.push("public-edit");
  const submission = deliveryPolicySubmission(draft);
  assert.doesNotMatch(JSON.stringify(submission), new RegExp(hidden));
  await api.execute({
    type: "delivery.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: saved.version,
    ...submission,
  });
  const persisted = f.service.delivery().configuration(projectId);
  assert.deepEqual(persisted.grants, [
    ...grants,
    { action: "issue.comment", repositoryId: "public", mode: "allow" },
  ]);
  assert.deepEqual(persisted.requiredChecks, [{ name: hidden }]);
  assert.equal(persisted.branchPrefix, hidden);
  assert.equal(persisted.version, saved.version + 1);
  assert.equal(f.runtime.turns, 0);
});

/** A project with a linked repository the operator cannot see (its ID is a credential's name) and a visible one. */
async function hiddenRepositoryFixture(t: TestContext) {
  const { f, api, projectId } = await deliveryFixture(t);
  const hiddenPath = join(f.directory, "hidden-repository"),
    visiblePath = join(f.directory, "visible-repository");
  await checkout(hiddenPath, "https://github.com/acme/hidden.git");
  await checkout(visiblePath, "https://github.com/acme/visible.git");
  const hidden = "HIDDEN_REPOSITORY_ID",
    previous = process.env[hidden];
  process.env[hidden] = "hidden-repository-value";
  t.after(() => {
    if (previous === undefined) delete process.env[hidden];
    else process.env[hidden] = previous;
  });
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: hidden,
        path: hiddenPath,
        ref: "main",
      },
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "visible",
        path: visiblePath,
        ref: "main",
      },
    ],
  });
  const policy = (
    requiredChecks: Array<{ name: string }>,
    repositories?: unknown[],
  ) =>
    f.service.domain().execute({
      ...deliveryInput(projectId, {
        expectedVersion: f.service.delivery().configuration(projectId).version,
        credentialRef: `env:${hidden}`,
        requiredChecks,
        ...(repositories ? { repositories } : {}),
      }),
      actor: "operator",
    } as never);
  const save = (repositories: unknown[], key = randomUUID()) =>
    api.execute(
      deliveryInput(projectId, {
        key,
        expectedVersion: f.service.delivery().configuration(projectId).version,
        repositories,
      }),
    );
  const visible = {
    repositoryId: "visible",
    mergeMethod: "squash",
    requiredChecks: [{ name: "build" }],
  };
  return { f, api, projectId, hidden, policy, save, visible };
}

test("a per-repository save carries the project-wide list to repositories the operator cannot see", async (t) => {
  const { f, projectId, hidden, policy, save, visible } =
    await hiddenRepositoryFixture(t);
  const saved = () => f.service.delivery().configuration(projectId);
  // A hidden linked repository without an entry gets one carrying the list the save empties.
  policy([{ name: "legacy" }]);
  await save([visible]);
  assert.deepEqual(saved().requiredChecks, []);
  assert.deepEqual(saved().repositories, [
    visible,
    { repositoryId: hidden, requiredChecks: [{ name: "legacy" }] },
  ]);
  // A hidden repository's saved entry is kept, with a project-wide list re-added since appended to it.
  policy(
    [{ name: "late" }],
    [
      visible,
      {
        repositoryId: hidden,
        mergeMethod: "merge",
        requiredChecks: [{ name: "own" }],
      },
    ],
  );
  await save([visible]);
  assert.deepEqual(saved().repositories, [
    visible,
    {
      repositoryId: hidden,
      mergeMethod: "merge",
      requiredChecks: [{ name: "own" }, { name: "late" }],
    },
  ]);
  // A command cannot name a repository the operator cannot see.
  const version = saved().version;
  await assert.rejects(
    save([{ repositoryId: hidden, requiredChecks: [] }]),
    (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.equal(error.status, 400);
      assert.deepEqual(error.fieldPaths, ["repositories.0.repositoryId"]);
      return true;
    },
  );
  assert.equal(saved().version, version);
});

test("a retried command without per-repository settings replays on a project that has them", async (t) => {
  const { f, api, projectId, save, visible } = await hiddenRepositoryFixture(t);
  await save([visible]);
  const before = f.service.delivery().configuration(projectId);
  const retry = deliveryInput(projectId, {
    expectedVersion: before.version,
    credentialRef: null,
    requiredChecks: [{ name: "lint" }],
  });
  const first = await api.execute(retry);
  const after = f.service.delivery().configuration(projectId);
  assert.deepEqual(after.repositories, before.repositories);
  assert.deepEqual(await api.execute(retry), first);
  assert.equal(
    f.service.delivery().configuration(projectId).version,
    after.version,
  );
});

test("a retried per-repository save replays its receipt, and the same key with other settings is refused", async (t) => {
  const { f, api, projectId, hidden, policy, visible } =
    await hiddenRepositoryFixture(t);
  const key = randomUUID();
  const expectedVersion = f.service.delivery().configuration(projectId).version;
  const send = (repositories: unknown[]) =>
    api.execute(
      deliveryInput(projectId, { key, expectedVersion, repositories }),
    );
  const first = await send([visible]);
  const after = f.service.delivery().configuration(projectId);
  assert.equal(after.version, expectedVersion + 1);
  // A lost response is retried with the version the first run started from: it replays, not conflicts.
  assert.deepEqual(await send([visible]), first);
  assert.deepEqual(f.service.delivery().configuration(projectId), after);
  for (const changed of [
    [{ ...visible, mergeMethod: "merge" }],
    [{ ...visible, requiredChecks: [{ name: "lint" }] }],
    [],
  ])
    await assert.rejects(send(changed), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.deepEqual([error.status, error.code], [409, "conflict"]);
      return true;
    });
  assert.deepEqual(f.service.delivery().configuration(projectId), after);
  // A kept row resolves against the policy the first run changed, so its retry replays by the recorded save.
  policy([], [{ repositoryId: "visible", requiredChecks: [{ name: hidden }] }]);
  const keptVersion = f.service.delivery().configuration(projectId).version;
  const keptKey = randomUUID();
  const kept = () =>
    api.execute(
      deliveryInput(projectId, {
        key: keptKey,
        expectedVersion: keptVersion,
        repositories: [
          {
            repositoryId: "visible",
            mergeMethod: "squash",
            requiredChecks: [
              {
                savedRow: {
                  projectId,
                  section: "delivery-checks",
                  version: keptVersion,
                  index: 0,
                  repositoryId: "visible",
                },
                keep: true,
              },
            ],
          },
        ],
      }),
    );
  const keptFirst = await kept();
  assert.deepEqual(
    f.service.delivery().configuration(projectId).repositories?.[0],
    {
      repositoryId: "visible",
      mergeMethod: "squash",
      requiredChecks: [{ name: hidden }],
    },
  );
  assert.deepEqual(await kept(), keptFirst);
});

test("a retried per-repository save replays only with the credential reference its first run saved", async (t) => {
  const { f, api, projectId, visible } = await hiddenRepositoryFixture(t);
  const key = randomUUID();
  const expectedVersion = f.service.delivery().configuration(projectId).version;
  const send = (credentialRef: string | null) =>
    api.execute(
      deliveryInput(projectId, {
        key,
        expectedVersion,
        credentialRef,
        repositories: [visible],
      }),
    );
  const first = await send("env:DELIVERY_RETRY_FIRST");
  const after = f.service.delivery().configuration(projectId);
  assert.deepEqual(await send("env:DELIVERY_RETRY_FIRST"), first);
  for (const other of ["env:DELIVERY_RETRY_OTHER", null])
    await assert.rejects(send(other), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.deepEqual([error.status, error.code], [409, "conflict"]);
      return true;
    });
  assert.deepEqual(f.service.delivery().configuration(projectId), after);
  assert.equal(
    f.service.domain().deliveryCredentialReference(projectId),
    "env:DELIVERY_RETRY_FIRST",
  );
});

test("a retried per-repository save replays only the exact request, kept-row references included", async (t) => {
  const { f, api, projectId, hidden } = await hiddenRepositoryFixture(t);
  const withheld = [{ name: hidden }, { name: `env:${hidden}` }];
  f.service.domain().execute({
    ...deliveryInput(projectId, {
      expectedVersion: f.service.delivery().configuration(projectId).version,
      credentialRef: `env:${hidden}`,
      grants: [
        { action: "issue.comment", repositoryId: hidden, mode: "approval" },
        { action: "issue.labels", repositoryId: hidden, mode: "approval" },
      ],
      requiredChecks: [],
      repositories: [{ repositoryId: "visible", requiredChecks: withheld }],
    }),
    actor: "operator",
  } as never);
  const version = f.service.delivery().configuration(projectId).version;
  const key = randomUUID();
  const kept = (
    section: "delivery-grants" | "delivery-checks",
    index: number,
  ) => ({
    savedRow: {
      projectId,
      section,
      version,
      index,
      ...(section === "delivery-checks" ? { repositoryId: "visible" } : {}),
    },
    keep: true,
  });
  const send = (grant: number, check: number) =>
    api.execute(
      deliveryInput(projectId, {
        key,
        expectedVersion: version,
        preserveBranchPrefix: true,
        grants: [kept("delivery-grants", grant)],
        repositories: [
          {
            repositoryId: "visible",
            mergeMethod: "squash",
            requiredChecks: [kept("delivery-checks", check)],
          },
        ],
      }),
    );
  const first = await send(0, 0);
  const after = f.service.delivery().configuration(projectId);
  assert.deepEqual(after.grants, [
    { action: "issue.comment", repositoryId: hidden, mode: "approval" },
  ]);
  assert.deepEqual(after.repositories?.[0]?.requiredChecks, [withheld[0]]);
  assert.deepEqual(await send(0, 0), first);
  // Another saved row was never applied under this key, so pointing at it is a different request.
  for (const [grant, check] of [
    [1, 0],
    [0, 1],
  ] as const)
    await assert.rejects(send(grant, check), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.deepEqual([error.status, error.code], [409, "conflict"]);
      return true;
    });
  assert.deepEqual(f.service.delivery().configuration(projectId), after);
  // The recorded receipt carries no request digest.
  const recorded = await api.readOperation(
    new URLSearchParams({
      scope: `project:${projectId}`,
      type: "delivery.configure",
      key,
    }),
  );
  assert.doesNotMatch(JSON.stringify(recorded), /requestDigest/);
});
