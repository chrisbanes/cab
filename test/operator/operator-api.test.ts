import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainPolicyError, DomainStore } from "../../src/core/domain.js";
import { executionPolicy } from "../../src/standalone/codex.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { CoordinationView } from "../../src/standalone/coordination-view.js";
import { codexPolicyDisclosure } from "../../src/standalone/execution-policy.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { RoutingAttemptStore } from "../../src/standalone/routing.js";
import { ExecutionState } from "../../src/standalone/state.js";
import {
  ClaudeShapedFixtureRuntime,
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";
import { controlledGit } from "../fixtures/controlled-git.js";
import { mixedForm } from "../fixtures/question-data.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { tmpdir } from "../fixtures/temp.js";

test("API preserves original durable task receipts independently of current version and paused admission", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Real project",
    leadProfileId: null,
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const command = {
    type: "task.create" as const,
    key: randomUUID(),
    projectId,
    taskId: randomUUID(),
    title: "Actual task",
    outcome: "Finish",
    ready: false,
  };
  const first = await api.execute(command);
  assert.match(JSON.stringify(first), /"ready":false/);
  assert.deepEqual(await api.execute(command), first);
  assert.equal(
    (await api.readTask(command.taskId)).data.execution.state,
    "paused",
  );
  assert.equal(f.runtime.turns, 0);
  await api.execute({
    type: "task.configure",
    key: randomUUID(),
    projectId,
    taskId: command.taskId,
    expectedVersion: 1,
    title: "Changed",
  });
  assert.deepEqual(await api.execute(command), first);
  assert.equal(f.service.domain().tasks(projectId).length, 1);
  await assert.rejects(api.execute({ ...command, title: "Different" }));
  assert.equal(
    (await api.readWorkspace()).data.projects[0]?.name,
    "Real project",
  );
});

test("operator API maps the issue.comment-only policy by type, not its message", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const api = new OperatorApi(f.service, [f.directory]);
  const commands = (
    api as unknown as {
      commands: { execute: (command: unknown) => Promise<unknown> };
    }
  ).commands;
  commands.execute = async () => {
    throw new DomainPolicyError(
      "forbidden",
      "Operator delivery only permits issue.comment",
    );
  };
  await assert.rejects(
    api.execute({
      type: "task.configure",
      key: randomUUID(),
      projectId: ids.projectId,
      taskId: ids.taskId,
      expectedVersion: 1,
      title: "Policy probe",
    }),
    (error) =>
      error instanceof OperatorApiError &&
      error.status === 403 &&
      error.code === "forbidden",
  );
});

test("task.configure preflight preserves policy and identity priority around key replay", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const domain = f.service.domain();
  domain.markImportedTask(ids.taskId, "preflight-import", "repository");
  const api = new OperatorApi(f.service, [f.directory]);
  const commands = (
    api as unknown as {
      commands: { execute: (command: unknown) => Promise<unknown> };
    }
  ).commands;
  const version = Number(domain.task(ids.taskId).version);
  const configure = (
    taskId: string,
    projectId: string,
    key: string,
    fields: Record<string, unknown> = {},
    expectedVersion = version,
  ) => ({
    type: "task.configure" as const,
    key,
    projectId,
    taskId,
    expectedVersion,
    ...fields,
  });
  const expectApiError = (status: number, code: string) => (error: unknown) =>
    error instanceof OperatorApiError &&
    error.status === status &&
    error.code === code;

  for (const fields of [
    { title: "Override" },
    { outcome: "Override outcome" },
    { ready: false },
  ])
    await assert.rejects(
      api.execute(
        configure(
          ids.taskId,
          ids.projectId,
          randomUUID(),
          fields,
          version + 10,
        ),
      ),
      expectApiError(403, "forbidden"),
    );

  const durableKey = randomUUID();
  const durable = configure(ids.taskId, ids.projectId, durableKey);
  const receipt = await api.execute(durable);
  assert.deepEqual(await api.execute(durable), receipt);
  await assert.rejects(
    api.execute(
      configure(
        ids.taskId,
        ids.projectId,
        durableKey,
        { title: "Forbidden despite stale version" },
        version + 10,
      ),
    ),
    expectApiError(403, "forbidden"),
  );

  const otherProjectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: otherProjectId,
    name: "Other project",
    leadProfileId: null,
  });
  const otherTaskId = randomUUID();
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: otherProjectId,
    taskId: otherTaskId,
    title: "Other task",
    outcome: "Keep it private",
  });
  await assert.rejects(
    api.execute(
      configure(otherTaskId, ids.projectId, durableKey, { title: "No" }),
    ),
    expectApiError(403, "forbidden"),
  );
  await assert.rejects(
    api.execute(
      configure(randomUUID(), ids.projectId, durableKey, { title: "No" }),
    ),
    expectApiError(404, "not-found"),
  );

  const localTaskId = randomUUID();
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: localTaskId,
    title: "Local task",
    outcome: "Mutable locally",
  });
  const localConfigure = configure(localTaskId, ids.projectId, randomUUID(), {
    title: "Updated locally",
  });
  const localReceipt = await api.execute(localConfigure);
  assert.deepEqual(await api.execute(localConfigure), localReceipt);
  await assert.rejects(
    api.execute({ ...localConfigure, title: "Different payload" }),
    expectApiError(409, "conflict"),
  );

  const inFlightKey = randomUUID();
  const inFlightBase = configure(
    ids.taskId,
    ids.projectId,
    inFlightKey,
    {},
    Number(domain.task(ids.taskId).version),
  );
  const inFlight = commands.execute({ ...inFlightBase, actor: "operator" });
  const policyRejection = commands.execute({
    ...configure(ids.taskId, ids.projectId, inFlightKey, {
      outcome: "Denied",
    }),
    actor: "operator",
  });
  assert.ok(policyRejection instanceof Promise);
  await assert.rejects(
    policyRejection,
    (error) => error instanceof DomainPolicyError && error.code === "forbidden",
  );
  await inFlight;

  const projectVersion = Number(domain.project(ids.projectId).version);
  const collisionKey = randomUUID();
  const pendingProjectWrite = commands.execute({
    type: "project.configure",
    actor: "operator",
    key: collisionKey,
    projectId: ids.projectId,
    expectedVersion: projectVersion,
    paused: true,
  });
  const wrongProjectInFlight = api.execute(
    configure(otherTaskId, ids.projectId, collisionKey, { title: "No" }),
  );
  const missingTaskInFlight = api.execute(
    configure(randomUUID(), ids.projectId, collisionKey, { title: "No" }),
  );
  await assert.rejects(wrongProjectInFlight, expectApiError(403, "forbidden"));
  await assert.rejects(missingTaskInFlight, expectApiError(404, "not-found"));
  await pendingProjectWrite;
});

test("assignment and dependency commands preflight their target before key conflicts", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const target = await seed(f);
  const submitted = await seed(f);
  const domain = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const commands = (
    api as unknown as {
      commands: { execute: (command: unknown) => Promise<unknown> };
    }
  ).commands;
  const assignmentId = randomUUID();
  const assignment = {
    type: "assignment.create" as const,
    key: randomUUID(),
    projectId: target.projectId,
    taskId: target.taskId,
    assignmentId,
    profileId: target.profileId,
    brief: "Existing assignment",
    resultDestination: "lead",
    requesterAssignmentId: null,
  };
  await domain.execute({ ...assignment, actor: "operator" });
  const assignmentRow = domain.assignment(assignmentId);
  const targetVersion = Number(domain.task(target.taskId).version);

  const preflightCases = [
    {
      command: {
        type: "assignment.apply" as const,
        assignmentId,
        expectedVersion: Number(assignmentRow.version) + 20,
      },
      status: 403,
    },
    {
      command: {
        type: "dependency.add" as const,
        taskId: target.taskId,
        blockerTaskId: randomUUID(),
        expectedVersion: targetVersion + 20,
      },
      status: 403,
    },
    {
      command: {
        type: "dependency.remove" as const,
        taskId: target.taskId,
        blockerTaskId: randomUUID(),
        expectedVersion: targetVersion + 20,
      },
      status: 403,
    },
    {
      command: {
        type: "assignment.apply" as const,
        assignmentId: randomUUID(),
        expectedVersion: 1,
      },
      status: 404,
    },
    {
      command: {
        type: "dependency.add" as const,
        taskId: randomUUID(),
        blockerTaskId: randomUUID(),
        expectedVersion: 1,
      },
      status: 404,
    },
  ];
  const expectStatus = (status: number) => (error: unknown) =>
    error instanceof OperatorApiError && error.status === status;

  // A durable receipt from another command must not mask target ownership.
  const durableKey = randomUUID();
  await api.execute({
    type: "project.configure",
    key: durableKey,
    projectId: submitted.projectId,
    expectedVersion: Number(domain.project(submitted.projectId).version),
    paused: true,
  });
  for (const command of preflightCases)
    await assert.rejects(
      api.execute({
        ...command.command,
        key: durableKey,
        projectId: submitted.projectId,
      }),
      expectStatus(command.status),
      command.command.type,
    );

  // The in-flight map has the same priority boundary as durable receipts.
  const inFlightKey = randomUUID();
  const pending = commands.execute({
    type: "project.configure",
    actor: "operator",
    key: inFlightKey,
    projectId: submitted.projectId,
    expectedVersion: Number(domain.project(submitted.projectId).version),
    paused: false,
  });
  const inFlightAssertions = preflightCases.map((command) =>
    assert.rejects(
      api.execute({
        ...command.command,
        key: inFlightKey,
        projectId: submitted.projectId,
      }),
      expectStatus(command.status),
      `${command.command.type} in-flight`,
    ),
  );
  await Promise.all(inFlightAssertions);
  await pending;

  await assert.rejects(
    api.execute({
      type: "assignment.apply",
      key: randomUUID(),
      projectId: submitted.projectId,
      assignmentId,
      expectedVersion: Number(assignmentRow.version) + 20,
    }),
    (error) => error instanceof OperatorApiError && error.status === 403,
  );
  await assert.rejects(
    api.execute({
      type: "dependency.add",
      key: randomUUID(),
      projectId: submitted.projectId,
      taskId: target.taskId,
      blockerTaskId: randomUUID(),
      expectedVersion: targetVersion + 20,
    }),
    (error) => error instanceof OperatorApiError && error.status === 403,
  );

  for (const command of [
    {
      type: "assignment.apply" as const,
      assignmentId,
      expectedVersion: Number(assignmentRow.version) + 20,
    },
    {
      type: "dependency.add" as const,
      taskId: target.taskId,
      blockerTaskId: randomUUID(),
      expectedVersion: targetVersion + 20,
    },
    {
      type: "dependency.remove" as const,
      taskId: target.taskId,
      blockerTaskId: randomUUID(),
      expectedVersion: targetVersion + 20,
    },
  ]) {
    const key = randomUUID();
    await api.execute({
      type: "project.configure",
      key,
      projectId: target.projectId,
      expectedVersion: Number(domain.project(target.projectId).version),
      paused: true,
    });
    await assert.rejects(
      api.execute({ ...command, key, projectId: target.projectId }),
      (error) => error instanceof OperatorApiError && error.status === 409,
      `${command.type} same-project key conflict`,
    );
  }

  // Same-project subordinate errors and missing targets retain their statuses.
  await assert.rejects(
    api.execute({
      type: "assignment.apply",
      key: randomUUID(),
      projectId: target.projectId,
      assignmentId,
      expectedVersion: Number(assignmentRow.version) + 20,
    }),
    (error) => error instanceof OperatorApiError && error.status === 409,
  );
  await assert.rejects(
    api.execute({
      type: "assignment.apply",
      key: randomUUID(),
      projectId: target.projectId,
      assignmentId: randomUUID(),
      expectedVersion: 1,
    }),
    (error) => error instanceof OperatorApiError && error.status === 404,
  );
  await assert.rejects(
    api.execute({
      type: "dependency.add",
      key: randomUUID(),
      projectId: target.projectId,
      taskId: target.taskId,
      blockerTaskId: randomUUID(),
      expectedVersion: targetVersion,
    }),
    (error) => error instanceof OperatorApiError && error.status === 404,
  );
  await assert.rejects(
    api.execute({
      type: "dependency.remove",
      key: randomUUID(),
      projectId: target.projectId,
      taskId: target.taskId,
      blockerTaskId: target.taskId,
      expectedVersion: targetVersion + 20,
    }),
    (error) => error instanceof OperatorApiError && error.status === 409,
  );
  await assert.rejects(
    api.execute({
      type: "dependency.add",
      key: randomUUID(),
      projectId: target.projectId,
      taskId: randomUUID(),
      blockerTaskId: randomUUID(),
      expectedVersion: 1,
    }),
    (error) => error instanceof OperatorApiError && error.status === 404,
  );
  assert.equal(domain.assignment(assignmentId).version, assignmentRow.version);
  assert.equal(domain.task(target.taskId).version, targetVersion);
  assert.equal(domain.task(target.taskId).importedBlockers, "clear");
  assert.equal(
    (await api.readTask(target.taskId)).data.localDependencies.length,
    0,
  );
});

test("target project visibility keeps its not-found precedence before ownership and keys", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const hidden = await seed(f);
  const visible = await seed(f);
  const domain = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const commands = (
    api as unknown as {
      commands: { execute: (command: unknown) => Promise<unknown> };
    }
  ).commands;
  const hiddenVersion = Number(domain.task(hidden.taskId).version);
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "DELETE FROM project_instruction_revisions WHERE projectId = ?",
    ).run(hidden.projectId);
  });

  const cases = [
    {
      type: "task.configure" as const,
      taskId: hidden.taskId,
      expectedVersion: hiddenVersion + 10,
      title: "Hidden task",
    },
    {
      type: "dependency.add" as const,
      taskId: hidden.taskId,
      blockerTaskId: randomUUID(),
      expectedVersion: hiddenVersion + 10,
    },
    {
      type: "dependency.remove" as const,
      taskId: hidden.taskId,
      blockerTaskId: randomUUID(),
      expectedVersion: hiddenVersion + 10,
    },
  ];
  const notFound = (error: unknown) =>
    error instanceof OperatorApiError && error.status === 404;

  const durableKey = randomUUID();
  await api.execute({
    type: "project.configure",
    key: durableKey,
    projectId: visible.projectId,
    expectedVersion: Number(domain.project(visible.projectId).version),
    paused: true,
  });
  for (const command of cases)
    await assert.rejects(
      api.execute({
        ...command,
        key: durableKey,
        projectId: visible.projectId,
      }),
      notFound,
      `${command.type} hidden target before durable replay`,
    );

  const inFlightKey = randomUUID();
  const pending = commands.execute({
    type: "project.configure",
    actor: "operator",
    key: inFlightKey,
    projectId: visible.projectId,
    expectedVersion: Number(domain.project(visible.projectId).version),
    paused: false,
  });
  const inFlightAssertions = cases.map((command) =>
    assert.rejects(
      api.execute({
        ...command,
        key: inFlightKey,
        projectId: visible.projectId,
      }),
      notFound,
      `${command.type} hidden target before in-flight admission`,
    ),
  );
  await Promise.all(inFlightAssertions);
  await pending;
  assert.equal(domain.task(hidden.taskId).version, hiddenVersion);
});
test("workspace reports the Codex runtime as unavailable after a runtime failure", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual((await api.readWorkspace()).data.runtime, {
    state: "available",
  });
  f.runtime.crash();
  const { runtime } = (await api.readWorkspace()).data;
  assert.equal(runtime.state, "unavailable");
  assert.equal(
    runtime.state === "unavailable" && Number.isSafeInteger(runtime.since),
    true,
  );
});
async function seed(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  active = false,
  snapshots?: { project: string; profile: string },
) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: snapshots?.profile ?? "PRIVATE INSTRUCTIONS",
    capabilities: "coordination",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  if (snapshots)
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      instructions: snapshots.project,
    });
  if (active)
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      paused: false,
    });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Task <script>bad()</script>",
    outcome: "PRIVATE INSTRUCTIONS token=SECRET",
    ready: false,
  });
  if (active) {
    await f.service.provisionTask(taskId);
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await until(() => f.runtime.turns === 1);
  }
  return { profileId, projectId, taskId };
}

test("task summaries classify Stop and independent holds by type, not display reason", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const stopOnly = await seed(f);
  const withAmbiguity = await seed(f);
  const withArchival = await seed(f);
  const withWriterHold = await seed(f);
  for (const { taskId } of [
    stopOnly,
    withAmbiguity,
    withArchival,
    withWriterHold,
  ])
    await f.service.stopTask(taskId);

  f.seedPersistedState((db) => {
    db.prepare("UPDATE task_writer_holds SET reason = ? WHERE taskId = ?").run(
      "Operator chose to stop this task",
      stopOnly.taskId,
    );
    db.prepare(
      "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, ?)",
    ).run(withAmbiguity.taskId, "Writer ownership is unclear");
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason) VALUES (?, ?)",
    ).run(withArchival.taskId, "Archival is awaiting review");
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, '')",
    ).run(withWriterHold.taskId);
  });

  const taskSummary = async (taskId: string) => {
    const read = await api.readTask(taskId);
    const listed = (await api.readTaskListPage()).data.tasks.find(
      (task) => task.id === taskId,
    );
    assert.ok(listed);
    return { execution: read.data.execution, codes: listed.attention.codes };
  };
  const stop = await taskSummary(stopOnly.taskId);
  assert.equal(stop.execution.state, "stopping");
  assert.equal(stop.execution.holds.stop, true);
  assert.equal(stop.codes.includes("execution-uncertain"), false);

  const writerHold = await taskSummary(withWriterHold.taskId);
  assert.equal(writerHold.execution.state, "stopping");
  assert.equal(writerHold.execution.holds.stop, true);
  assert.ok(writerHold.codes.includes("execution-uncertain"));
  assert.equal(f.service.taskHold(withWriterHold.taskId), "Task held");

  const ambiguityBefore = await taskSummary(withAmbiguity.taskId);
  assert.equal(ambiguityBefore.execution.state, "stopping");
  assert.equal(ambiguityBefore.execution.holds.stop, true);
  assert.ok(ambiguityBefore.codes.includes("execution-uncertain"));
  const archivalBefore = await taskSummary(withArchival.taskId);
  assert.equal(archivalBefore.execution.state, "stopping");
  assert.equal(archivalBefore.execution.holds.stop, true);
  assert.ok(archivalBefore.codes.includes("execution-uncertain"));

  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE task_writer_ambiguity_holds SET reason = ? WHERE taskId = ?",
    ).run("Ownership review remains unresolved", withAmbiguity.taskId);
    db.prepare(
      "UPDATE task_archival_holds SET reason = ? WHERE taskId = ?",
    ).run("Archival review still pending", withArchival.taskId);
  });
  const ambiguityAfter = await taskSummary(withAmbiguity.taskId);
  assert.equal(ambiguityAfter.execution.state, "stopping");
  assert.equal(ambiguityAfter.execution.holds.stop, true);
  assert.ok(ambiguityAfter.codes.includes("execution-uncertain"));
  const archivalAfter = await taskSummary(withArchival.taskId);
  assert.equal(archivalAfter.execution.state, "stopping");
  assert.equal(archivalAfter.execution.holds.stop, true);
  assert.ok(archivalAfter.codes.includes("execution-uncertain"));
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Fixture timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}
test("active execution retains its admitted generation while next-turn instructions advance", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const api = new OperatorApi(f.service, [f.directory]);
  const before = await api.readTask(ids.taskId);
  const a = before.data.assignments[0];
  assert.ok(a);
  assert.equal(before.data.execution.state, "running");
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 2,
    instructions: "NEW PRIVATE INSTRUCTIONS",
  });
  const command = {
    type: "assignment.apply" as const,
    key: randomUUID(),
    projectId: ids.projectId,
    assignmentId: a.assignmentId,
    expectedVersion: a.version,
  };
  const receipt = await api.execute(command);
  const after = await api.readTask(ids.taskId);
  assert.equal(after.data.execution.state, "running");
  assert.equal(after.data.assignments[0]?.version, a.version + 1);
  assert.deepEqual(
    after.data.assignments[0]?.executionGeneration,
    a.executionGeneration,
  );
  assert.deepEqual(after.data.execution.holds, before.data.execution.holds);
  assert.deepEqual(await api.execute(command), receipt);
  assert.doesNotMatch(
    JSON.stringify(after),
    /PRIVATE INSTRUCTIONS|SECRET|ensemble-ui02-/,
  );
  assert.match(after.data.task.title ?? "", /<script>/);
});
test("scoped interactions preserve exact material, revision conflicts, and original receipt replay", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const api = new OperatorApi(f.service, [f.directory]);
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const call = (tool: string, args: Record<string, unknown>, callId: string) =>
    f.runtime.callTool({
      threadId: work.threadId ?? "",
      turnId: work.turnId ?? "",
      tool,
      arguments: args,
      callId,
    });
  assert.equal(
    (await call("ensemble_ask_question", { question: "Choose target" }, "q1"))
      .success,
    true,
  );
  assert.equal(
    (
      await call(
        "ensemble_request_approval",
        { action: "Publish", target: "next", material: { version: "next" } },
        "a1",
      )
    ).success,
    true,
  );
  const read = await api.readTask(ids.taskId);
  const q = read.data.questions[0],
    a = read.data.approvals[0];
  assert.ok(q && a);
  assert.deepEqual(
    (await api.readTaskListPage()).data.tasks.find((t) => t.id === ids.taskId)
      ?.attention.codes,
    ["question", "approval"],
  );
  assert.deepEqual(a.material, { version: "next" });
  assert.equal(a.approvable, true);
  const answer = {
    type: "question.answer" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: q.interactionId,
    expectedRevision: q.revision,
    answer: "Target A",
  };
  const first = await api.execute(answer);
  assert.deepEqual(await api.execute(answer), first);
  await assert.rejects(api.execute({ ...answer, key: randomUUID() }));
  const approval = {
    type: "approval.decide" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: a.interactionId,
    expectedRevision: a.revision,
    decision: "approved" as const,
    action: "Publish",
    target: "next",
    material: { version: "next" },
  };
  const saved = await api.execute(approval);
  assert.deepEqual(await api.execute(approval), saved);
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    instructions: "next",
  });
  assert.equal(
    (await api.readTask(ids.taskId)).data.approvals.find(
      (v) => v.interactionId === a.interactionId,
    )?.approvable,
    false,
  );
  assert.deepEqual(await api.execute(approval), saved);
  await assert.rejects(
    api.execute({ ...approval, material: { version: "other" } }),
  );
  assert.equal(
    (
      await call(
        "ensemble_request_approval",
        { action: "Publish", material: { text: "PRIVATE INSTRUCTIONS" } },
        "a2",
      )
    ).success,
    true,
  );
  const unsafe = (await api.readTask(ids.taskId)).data.approvals.find(
    (v) => v.interactionId !== a.interactionId,
  );
  assert.ok(unsafe);
  assert.equal(unsafe.material, null);
  assert.equal(unsafe.approvable, false);
  const denied = {
    type: "approval.decide" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: unsafe.interactionId,
    expectedRevision: unsafe.revision,
    decision: "denied" as const,
    action: unsafe.action ?? "",
    ...(unsafe.target === null ? {} : { target: unsafe.target }),
  };
  const deniedReceipt = await api.execute(denied);
  assert.deepEqual(await api.execute(denied), deniedReceipt);
  assert.doesNotMatch(
    JSON.stringify(deniedReceipt),
    /PRIVATE INSTRUCTIONS|SECRET/,
  );
  await assert.rejects(api.execute({ ...denied, key: randomUUID() }));
  await assert.rejects(api.execute({ ...denied, action: "Changed" }));
  await assert.rejects(api.execute({ ...denied, target: "Changed" }));
  await assert.rejects(
    api.execute({ ...denied, material: { text: "Altered" } }),
  );

  await assert.rejects(
    api.execute({
      type: "approval.decide",
      key: randomUUID(),
      taskId: ids.taskId,
      interactionId: unsafe.interactionId,
      expectedRevision: unsafe.revision,
      decision: "approved",
      action: "Publish",
      material: { text: "PRIVATE INSTRUCTIONS" },
    }),
  );
});
test("local dependencies reject foreign, self, cycle and stale writes without changing task", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seed(f),
    b = await seed(f);
  const api = new OperatorApi(f.service, [f.directory]);
  const create = await api.execute({
    type: "task.create",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: randomUUID(),
    title: "Blocker",
    outcome: "Done",
    ready: false,
  });
  assert.equal(create.kind, "domain");
  if (create.kind !== "domain") return;
  const blockerId = create.result.id;
  const add = {
    type: "dependency.add" as const,
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    blockerTaskId: blockerId,
    expectedVersion: 1,
  };
  const first = await api.execute(add);
  assert.deepEqual(await api.execute(add), first);
  for (const command of [
    { ...add, key: randomUUID(), blockerTaskId: a.taskId, expectedVersion: 2 },
    { ...add, key: randomUUID(), blockerTaskId: b.taskId, expectedVersion: 2 },
    {
      ...add,
      key: randomUUID(),
      taskId: blockerId,
      blockerTaskId: a.taskId,
      expectedVersion: 1,
    },
    { ...add, key: randomUUID() },
  ])
    await assert.rejects(api.execute(command));
  assert.equal((await api.readTask(a.taskId)).data.localDependencies.length, 1);
});
test("saved command receipt survives service reopen and a stale fresh key cannot replay it", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  let api = new OperatorApi(f.service, [f.directory]);
  const c = {
    type: "task.configure" as const,
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: 1,
    title: "Saved title",
  };
  const receipt = await api.execute(c);
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await api.execute(c), receipt);
  await assert.rejects(api.execute({ ...c, key: randomUUID() }));
  assert.equal((await api.readTask(ids.taskId)).data.task.title, "Saved title");
});
test("unresolved result supplies exact revision and permitted recipient; replay survives resolution and reopen", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const workerId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    assignmentId: workerId,
    profileId: ids.profileId,
    brief: "Report findings",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET resultRecipientDisposition='unresolved' WHERE id=?",
      )
      .run(workerId),
  );
  f.runtime.complete(1);
  await until(() => f.runtime.turns >= 2);
  await until(() =>
    f.service
      .turnRequests()
      .some((r) => r.assignmentId === workerId && r.state === "active"),
  );
  const request = f.service
    .turnRequests()
    .find((r) => r.assignmentId === workerId && r.state === "active");
  assert.ok(request);
  const work = f.service
    .list()
    .find((w) => w.workId === request.workId && w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const result = await f.runtime.callTool({
    threadId: work.threadId,
    turnId: work.turnId,
    callId: "result1",
    tool: "ensemble_report_result",
    arguments: { summary: "Exact retained result <script>still text</script>" },
  });
  assert.equal(result.success, true, result.text);
  let api = new OperatorApi(f.service, [f.directory]);
  let u = (await api.readTask(ids.taskId)).data.unresolvedResults[0];
  assert.ok(u?.permittedRecipient);
  assert.ok(
    (await api.readTaskListPage()).data.tasks
      .find((t) => t.id === ids.taskId)
      ?.attention.codes.includes("unresolved-result"),
  );
  assert.equal(u.reasonCode, "unresolved-destination");
  const recipientId = u.permittedRecipient.assignmentId;
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET requesterAssignmentId=? WHERE id=?",
      )
      .run(randomUUID(), workerId),
  );
  const unavailable = (await api.readTask(ids.taskId)).data
    .unresolvedResults[0];
  assert.equal(unavailable?.availability, "recipient-unavailable");
  assert.equal(unavailable?.permittedRecipient, null);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_assignments SET requesterAssignmentId=NULL WHERE id=?",
      )
      .run(workerId),
  );
  u = (await api.readTask(ids.taskId)).data.unresolvedResults[0];
  assert.ok(u?.permittedRecipient);
  const command = {
    type: "result.recipient" as const,
    key: randomUUID(),
    taskId: u.taskId,
    resultId: u.resultId,
    expectedRevision: u.revision,
    recipientAssignmentId: u.permittedRecipient.assignmentId,
  };
  const other = await seed(f);
  const foreignId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: other.projectId,
    taskId: other.taskId,
    assignmentId: foreignId,
    profileId: other.profileId,
    brief: "Foreign",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await assert.rejects(
    api.execute({
      ...command,
      key: randomUUID(),
      recipientAssignmentId: foreignId,
    }),
  );
  const saved = await api.execute(command);
  assert.deepEqual(await api.execute(command), saved);
  assert.equal(
    (await api.readTaskListPage()).data.tasks
      .find((t) => t.id === ids.taskId)
      ?.attention.codes.includes("unresolved-result"),
    false,
  );
  assert.equal(
    (await api.readTask(ids.taskId)).data.unresolvedResults.length,
    0,
  );
  assert.equal(
    (await api.readTask(ids.taskId)).data.results[0]?.recipientAssignmentId,
    recipientId,
  );
  await assert.rejects(api.execute({ ...command, key: randomUUID() }));
  await assert.rejects(
    api.execute({ ...command, recipientAssignmentId: foreignId }),
  );
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await api.execute(command), saved);
  assert.equal(
    (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.resultId === command.resultId,
    ).length,
    1,
  );
});
test("post-commit wakeup rejection is unknown and matching key reconciles one original saved event", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const assignment = f.service.domain().assignments(ids.taskId)[0];
  assert.ok(assignment);
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const domain = new DomainStore(db);
  const coordination = new CoordinationStore(db, domain);
  let rejectWakeup = true;
  let wakeError: Error = Error("PRIVATE WAKEUP DIAGNOSTIC");
  const view = new CoordinationView(
    domain,
    coordination,
    new ExecutionState(db),
    new RoutingAttemptStore(db),
    async () => {
      if (rejectWakeup) throw wakeError;
    },
  );
  const api = new OperatorApi(f.service, [f.directory], () => view);
  const command = {
    type: "message" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    recipientAssignmentId: String(assignment.id),
    expectedAssignmentVersion: Number(assignment.version),
    message: "Durable input",
  };
  await assert.rejects(
    api.execute(command),
    (error) =>
      error instanceof Error && error.message === "command-outcome-unknown",
  );
  const before = (await api.readTask(ids.taskId)).data.messages.filter(
    (m) => m.text === "Durable input",
  );
  assert.equal(before.length, 1);
  rejectWakeup = false;
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "coordination");
  if (receipt.kind === "coordination")
    assert.equal(receipt.eventId, before[0]?.eventId);
  assert.equal(
    (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.text === "Durable input",
    ).length,
    1,
  );
  await assert.rejects(api.execute({ ...command, message: "Different" }));
  for (const code of ["forbidden", "invalid-input"] as const) {
    wakeError = new DomainPolicyError(code, "PRIVATE POSTCOMMIT POLICY ERROR");
    rejectWakeup = true;
    const typedCommand = {
      ...command,
      key: randomUUID(),
      message: `Durable typed ${code}`,
    };
    await assert.rejects(
      api.execute(typedCommand),
      (error) =>
        error instanceof Error && error.message === "command-outcome-unknown",
    );
    const events = (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.text === typedCommand.message,
    );
    assert.equal(events.length, 1);
    rejectWakeup = false;
    const saved = await api.execute(typedCommand);
    assert.equal(saved.kind, "coordination");
    if (saved.kind === "coordination")
      assert.equal(saved.eventId, events[0]?.eventId);
    assert.equal(
      (await api.readTask(ids.taskId)).data.messages.filter(
        (m) => m.text === typedCommand.message,
      ).length,
      1,
    );
  }
});
test("history preserves omission identities and excludes captured instructions and paths", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const assignment = f.service.domain().assignments(ids.taskId)[0];
  const request = f.service
    .turnRequests()
    .find((r) => r.assignmentId === assignment?.id);
  const work = f.service.list().find((w) => w.workId === request?.workId);
  assert.ok(assignment && request && work?.threadId && work.turnId);
  const binding = {
    workId: work.workId,
    taskId: ids.taskId,
    assignmentId: String(assignment.id),
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: work.threadId,
    turnId: work.turnId,
  };
  f.seedPersistedState((db) => {
    const history = new ConversationHistoryStore(db);
    history.omitItem(binding, "omitted1", "size-limit");
    history.recordEarlyBufferLimit(binding);
    history.record(
      binding,
      {
        kind: "completed",
        threadId: work.threadId ?? "",
        turnId: work.turnId ?? "",
        itemId: "safe1",
        text: `PRIVATE INSTRUCTIONS ${f.directory} token=SECRET visible text`,
      },
      ["PRIVATE INSTRUCTIONS", f.directory],
    );
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const history = await api.readAssignmentHistory(String(assignment.id));
  assert.equal(
    history.data.items.find((i) => i.itemId === "omitted1")?.omissionReason,
    "size-limit",
  );
  assert.equal(history.data.turnOmissions[0]?.reason, "early-buffer-limit");
  assert.equal(
    history.data.items.every((i) => i.assignmentId === assignment.id),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(history),
    /PRIVATE INSTRUCTIONS|SECRET|ensemble-ui02-/,
  );
});
test("retained ownership without a confirmed active intent and held request stays uncertain", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const request = f.service.turnRequests().find((r) => r.state === "active");
  assert.ok(request);
  const api = new OperatorApi(f.service, [f.directory]);
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE execution_intents SET state='held' WHERE workId=?")
      .run(request.workId),
  );
  let read = await api.readTask(ids.taskId);
  assert.equal(read.data.execution.state, "uncertain");
  assert.equal(read.data.execution.holds.writer, true);
  assert.equal(read.data.execution.holds.capacity, true);
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE execution_intents SET state='running' WHERE workId=?",
    ).run(request.workId);
    db.prepare("UPDATE turn_requests SET state='held' WHERE workId=?").run(
      request.workId,
    );
  });
  read = await api.readTask(ids.taskId);
  assert.equal(read.data.execution.state, "uncertain");
});
test("imported projections validate provider fields and distinguish attempted sync from successful sync", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const d = f.service.domain();
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    credentialRef: "env:UI02_SYNTHETIC_REFERENCE",
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
    projectId: ids.projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  const source = f.service.githubSources();
  source.reconcileSelection(ids.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "owner/repo",
        number: 42,
        title: "Imported <script>text</script>",
        body: "PRIVATE INSTRUCTIONS token=SECRET",
        state: "open",
        labels: ["ready"],
        projectFields: [
          { projectNodeId: "P1", fieldNodeId: "F1", optionNodeId: "O1" },
        ],
      },
    ],
  });
  const task = d
    .tasks(ids.projectId)
    .find((t) => t.title === "Imported <script>text</script>");
  assert.ok(task);
  const api = new OperatorApi(f.service, [f.directory]);
  let read = await api.readTask(String(task.id));
  assert.equal(
    read.data.source?.url,
    "https://github.com/owner/repo/issues/42",
  );
  assert.equal(
    read.data.source?.memberships[0]?.projectFields[0]?.optionNodeId,
    "O1",
  );
  assert.ok(read.data.source?.memberships[0]?.sync.lastSuccessfulAt);
  assert.doesNotMatch(
    JSON.stringify(read),
    /PRIVATE INSTRUCTIONS|SECRET|UI02_SYNTHETIC_REFERENCE/,
  );
  await assert.rejects(
    api.execute({
      type: "task.configure",
      key: randomUUID(),
      projectId: ids.projectId,
      taskId: String(task.id),
      expectedVersion: Number(task.version),
      title: "Local override",
    }),
  );
  source.reconcileSelection(ids.projectId, "repo", {
    complete: false,
    reason: "PRIVATE PROVIDER ERROR",
    issues: [],
  });
  read = await api.readTask(String(task.id));
  assert.equal(read.data.source?.memberships[0]?.sync.lastSuccessfulAt, null);
  assert.equal(
    read.data.source?.memberships[0]?.sync.reasonCode,
    "partial-sync",
  );
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE PROVIDER ERROR/);
});
test("omitted-material denial replay remains exact after privacy-context change and service reopen", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        callId: "unsafe-denial",
        tool: "ensemble_request_approval",
        arguments: {
          action: "Publish",
          material: { value: "PRIVATE INSTRUCTIONS" },
        },
      })
    ).success,
    true,
  );
  let api = new OperatorApi(f.service, [f.directory]);
  const approval = (await api.readTask(ids.taskId)).data.approvals[0];
  assert.ok(approval);
  assert.equal(approval.materialUnavailable, true);
  const command = {
    type: "approval.decide" as const,
    key: randomUUID(),
    taskId: ids.taskId,
    interactionId: approval.interactionId,
    expectedRevision: approval.revision,
    decision: "denied" as const,
    action: approval.action ?? "",
  };
  const receipt = await api.execute(command);
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    instructions: "Different current instructions",
  });
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, []);
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(
    (await api.readTask(ids.taskId)).data.messages.filter(
      (m) => m.interactionId === approval.interactionId,
    ).length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE INSTRUCTIONS|SECRET/);
});

test("admitted and historical instruction snapshots stay private after configured revisions advance", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const old = {
    project: "OLD PRIVATE PROJECT SNAPSHOT",
    profile: "OLD PRIVATE PROFILE SNAPSHOT",
  };
  const ids = await seed(f, true, old);
  const d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  const a = d.assignments(ids.taskId)[0],
    work = f.service.list().find((w) => w.state === "running");
  assert.ok(a && work?.threadId && work.turnId);
  const before = (await api.readTask(ids.taskId)).data.assignments[0]
    ?.executionGeneration;
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        callId: "old-snapshot-approval",
        tool: "ensemble_request_approval",
        arguments: {
          action: "Publish",
          material: { project: old.project, profile: old.profile },
        },
      })
    ).success,
    true,
  );
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: Number(d.project(ids.projectId).version),
    instructions: "NEW PROJECT INSTRUCTIONS",
    name: old.project,
  });
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    instructions: "NEW PROFILE INSTRUCTIONS",
    name: old.profile,
  });
  await api.execute({
    type: "assignment.apply",
    key: randomUUID(),
    projectId: ids.projectId,
    assignmentId: String(a.id),
    expectedVersion: Number(a.version),
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: Number(d.task(ids.taskId).version),
    outcome: `${old.project} ${old.profile}`,
  });
  const read = await api.readTask(ids.taskId);
  assert.deepEqual(read.data.assignments[0]?.executionGeneration, before);
  assert.doesNotMatch(JSON.stringify(read), /OLD PRIVATE/);
  assert.equal(read.data.approvals[0]?.materialUnavailable, true);
  assert.equal(read.data.approvals[0]?.approvable, false);
  assert.doesNotMatch(JSON.stringify(await api.readWorkspace()), /OLD PRIVATE/);
  assert.doesNotMatch(
    JSON.stringify(await api.readProject(ids.projectId)),
    /OLD PRIVATE/,
  );
  await f.service.stop();
  await f.service.start();
  assert.doesNotMatch(
    JSON.stringify(await api.readTask(ids.taskId)),
    /OLD PRIVATE/,
  );
});

test("global labels exclude retained private revisions without any task or project binding", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f),
    d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    instructions: "UNBOUND OLD PROJECT SNAPSHOT",
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 2,
    name: "UNBOUND OLD PROJECT SNAPSHOT",
    instructions: "CURRENT PROJECT SNAPSHOT",
  });
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    name: "PRIVATE INSTRUCTIONS",
    instructions: "CURRENT PROFILE SNAPSHOT",
  });
  const api = new OperatorApi(f.service);
  const workspace = await api.readWorkspace(),
    project = await api.readProject(ids.projectId);
  assert.doesNotMatch(
    JSON.stringify({ workspace, project }),
    /PRIVATE INSTRUCTIONS|UNBOUND OLD PROJECT SNAPSHOT/,
  );
  assert.equal(workspace.data.profiles[0]?.id, ids.profileId);
  assert.equal(workspace.data.profiles[0]?.version, 2);
  const domain = {
    profiles: () => d.profiles(),
    profile: d.profile.bind(d),
    profileRevision: d.profileRevision.bind(d),
    profileRuntime: d.profileRuntime.bind(d),
    claudeTokenReference: () => null,
    projects: () => [],
    gettingStartedDismissed: () => false,
  };
  const isolated = new OperatorApi({
    domain: () => domain,
    runtimeStatus: () => ({ state: "available" }),
    harnessStatuses: () => [],
    taskTurnStarted: () => false,
  } as unknown as ConstructorParameters<typeof OperatorApi>[0]);
  assert.doesNotMatch(
    JSON.stringify(await isolated.readWorkspace()),
    /PRIVATE INSTRUCTIONS/,
  );
});

test("global snapshot privacy fails closed before excessive revision lookup work", async () => {
  const profileId = randomUUID();
  let lookups = 0;
  const domain = {
    projects: () => [],
    profiles: () => [
      {
        id: profileId,
        name: "UNSAFE NAME",
        version: 1_000_000_000,
        revoked: 0,
      },
    ],
    profileRevision: () => {
      lookups++;
      return { instructions: "PRIVATE" };
    },
    profileRuntime: () => ({ harness: "codex" }),
    claudeTokenReference: () => null,
    gettingStartedDismissed: () => false,
  };
  const api = new OperatorApi({
    domain: () => domain,
    runtimeStatus: () => ({ state: "available" }),
    harnessStatuses: () => [],
    taskTurnStarted: () => false,
  } as unknown as ConstructorParameters<typeof OperatorApi>[0]);
  const read = await api.readWorkspace();
  assert.equal(read.data.profiles[0]?.name, null);
  assert.equal(read.data.profiles[0]?.id, profileId);
  assert.equal(lookups, 0);
});

test("project task summaries share task workspace and repository exclusions", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true),
    api = new OperatorApi(f.service, [f.directory]);
  const workspace = await f.service.taskWorkspace(ids.taskId);
  assert.ok(workspace);
  const repository = {
    repositoryId: "synthetic-repo",
    sourcePath: "/synthetic/source-repository",
    workspacePath: "/synthetic/task-repository",
    gitCommonDir: "/synthetic/git-common",
    ref: "main",
    commit: null,
  };
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE task_workspace_bindings SET repositories = ? WHERE taskId = ?",
    ).run(JSON.stringify([repository]), ids.taskId);
  });
  const d = f.service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: Number(d.task(ids.taskId).version),
    title: `Workspace ${workspace.path} ${repository.sourcePath} ${repository.workspacePath} ${repository.gitCommonDir}`,
  });
  const task = (await api.readTask(ids.taskId)).data.task.title;
  const project = (await api.readProject(ids.projectId)).data.tasks[0]?.title;
  assert.equal(project, task);
  assert.ok(!String(project).includes(workspace.path));
  assert.doesNotMatch(String(project), /synthetic/);
});

test("polled task list, project and Inbox reads redact stored workspace paths without launching Git", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-polled-redaction-")),
    source = join(root, "source");
  mkdirSync(source);
  for (const args of [
    ["init", "--quiet", source],
    ["-C", source, "config", "user.name", "Polled Test"],
    ["-C", source, "config", "user.email", "polled@example.invalid"],
    ["-C", source, "commit", "--quiet", "--allow-empty", "-m", "fixture"],
  ])
    execFileSync("git", args);
  const controlled = controlledGit();
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    undefined,
    { workspaceManager: { gitExecutable: controlled.executable } },
  );
  t.after(async () => {
    await f.close();
    await controlled.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const ids = await seedOwnQuestion(f, mixedForm, "Polled", "Polled project", [
    { repositoryId: "repo", path: source },
  ]);
  const workspace = await f.service.taskWorkspace(ids.taskId);
  assert.ok(workspace?.repositories[0]?.gitCommonDir);
  const paths = [
    workspace.path,
    ...workspace.repositories.flatMap((r) => [
      r.sourcePath,
      r.workspacePath,
      r.gitCommonDir ?? "",
    ]),
  ];
  assert.deepEqual(
    [...f.service.taskWorkspaceRedactionPaths(ids.taskId)].sort(),
    [...new Set(paths)].sort(),
  );
  const d = f.service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: Number(d.task(ids.taskId).version),
    title: `Safe title ${paths.join(" ")}`,
  });
  const starts = () =>
    controlled.events().filter((e) => e.event === "start").length;
  const baseline = starts();
  assert.ok(baseline > 0);
  const api = new OperatorApi(f.service, [f.directory]);
  const reads = [
    await api.readTaskListPage(),
    await api.readProject(ids.projectId),
    await api.readInbox(),
  ].map((read) => JSON.stringify(read));
  assert.equal(starts(), baseline);
  for (const read of reads) {
    assert.match(read, /Safe title/);
    for (const path of paths) assert.ok(!read.includes(path), path);
  }
  assert.match(reads[2]!, new RegExp(ids.interactionId));
});

test("history supplements captured privacy with external auth and GitHub values while retaining omissions and revisions", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true),
    d = f.service.domain();
  const reference = "env:UI02_REVIEW_SYNTHETIC_GITHUB",
    secret = "github-synthetic-value-475",
    authPath = "/synthetic/external/operator-auth-file";
  process.env.UI02_REVIEW_SYNTHETIC_GITHUB = secret;
  t.after(() => {
    delete process.env.UI02_REVIEW_SYNTHETIC_GITHUB;
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    credentialRef: reference,
    selections: [],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  const a = d.assignments(ids.taskId)[0],
    request = f.service.turnRequests().find((r) => r.assignmentId === a?.id),
    work = f.service.list().find((w) => w.workId === request?.workId);
  assert.ok(a && request && work?.threadId && work.turnId);
  const binding = {
    workId: work.workId,
    taskId: ids.taskId,
    assignmentId: String(a.id),
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: work.threadId,
    turnId: work.turnId,
  };
  f.seedPersistedState((db) => {
    const store = new ConversationHistoryStore(db);
    store.record(
      binding,
      {
        kind: "completed",
        threadId: work.threadId ?? "",
        turnId: work.turnId ?? "",
        itemId: "private-history",
        text: `${authPath} ${reference} ${secret} PRIVATE INSTRUCTIONS visible text`,
      },
      [],
    );
    store.omitItem(binding, "known-omission", "size-limit");
    store.recordEarlyBufferLimit(binding);
  });
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    instructions: "New private instructions",
  });
  await new OperatorApi(f.service).execute({
    type: "assignment.apply",
    key: randomUUID(),
    projectId: ids.projectId,
    assignmentId: String(a.id),
    expectedVersion: Number(a.version),
  });
  const read = await new OperatorApi(f.service, [
    authPath,
  ]).readAssignmentHistory(String(a.id));
  assert.doesNotMatch(
    JSON.stringify(read),
    /operator-auth-file|UI02_REVIEW_SYNTHETIC_GITHUB|github-synthetic-value-475|PRIVATE INSTRUCTIONS/,
  );
  const item = read.data.items.find((i) => i.itemId === "private-history");
  assert.ok(item);
  assert.equal(item.profileRevision, 1);
  assert.equal(item.assignmentVersion, 1);
  assert.match(item.text ?? "", /visible text/);
  assert.equal(
    read.data.items.find((i) => i.itemId === "known-omission")?.omissionReason,
    "size-limit",
  );
  assert.equal(read.data.turnOmissions[0]?.reason, "early-buffer-limit");
  const unavailable = await new OperatorApi(
    f.service,
    Array.from({ length: 129 }, (_, i) => `synthetic-path-${i}`),
  ).readAssignmentHistory(String(a.id));
  assert.equal(
    unavailable.data.items.find((i) => i.itemId === "private-history")
      ?.omissionReason,
    "redaction-unavailable",
  );
  f.seedPersistedState((db) => {
    new ConversationHistoryStore(db).record(
      { ...binding, profileRevision: 999 },
      {
        kind: "completed",
        threadId: work.threadId ?? "",
        turnId: work.turnId ?? "",
        itemId: "inconsistent-revision",
        text: "Unverified snapshot prose",
      },
      [],
    );
  });
  const inconsistent = await new OperatorApi(f.service, [
    authPath,
  ]).readAssignmentHistory(String(a.id));
  assert.equal(
    inconsistent.data.items.find((i) => i.itemId === "inconsistent-revision")
      ?.profileRevision,
    999,
  );
  assert.equal(
    inconsistent.data.items.find((i) => i.itemId === "inconsistent-revision")
      ?.omissionReason,
    "redaction-unavailable",
  );
  assert.equal(
    inconsistent.data.items.find((i) => i.itemId === "private-history")?.text,
    null,
  );
});

test("core-valid material beyond public collection and depth limits remains privately denyable with exact replay", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true),
    api = new OperatorApi(f.service, [f.directory]),
    work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  let deep: unknown = "PRIVATE INSTRUCTIONS";
  for (let i = 0; i < 14; i++) deep = { nested: deep };
  const materials = [
    Array(257).fill(0),
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), 0])),
    deep,
  ];
  const commands = [];
  for (const [i, material] of materials.entries()) {
    assert.equal(
      (
        await f.runtime.callTool({
          threadId: work.threadId,
          turnId: work.turnId,
          callId: `beyond-public-${i}`,
          tool: "ensemble_request_approval",
          arguments: { action: "Publish", target: "artifact", material },
        })
      ).success,
      true,
    );
    const approval = (await api.readTask(ids.taskId)).data.approvals.find(
      (a) => a.status === "open",
    );
    assert.ok(approval);
    assert.equal(approval.materialUnavailable, true);
    assert.equal(approval.material, null);
    assert.equal(approval.approvable, false);
    const command = {
      type: "approval.decide" as const,
      key: randomUUID(),
      taskId: ids.taskId,
      interactionId: approval.interactionId,
      expectedRevision: approval.revision,
      decision: "denied" as const,
      action: approval.action ?? "",
      target: approval.target ?? undefined,
    };
    await assert.rejects(
      api.execute({ ...command, decision: "approved", material: {} }),
    );
    await assert.rejects(
      api.execute({
        ...command,
        expectedRevision: command.expectedRevision + 1,
      }),
    );
    await assert.rejects(api.execute({ ...command, action: "Different" }));
    await assert.rejects(api.execute({ ...command, target: "Different" }));
    await assert.rejects(
      api.execute({ ...command, material: { altered: true } }),
    );
    const receipt = await api.execute(command);
    assert.deepEqual(await api.execute(command), receipt);
    await assert.rejects(api.execute({ ...command, key: randomUUID() }));
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE INSTRUCTIONS|nested/);
    commands.push({ command, receipt });
  }
  await f.service.stop();
  await f.service.start();
  for (const { command, receipt } of commands)
    assert.deepEqual(await api.execute(command), receipt);
  const read = await api.readTask(ids.taskId);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE INSTRUCTIONS|nested/);
  for (const { command } of commands)
    assert.equal(
      read.data.messages.filter(
        (m) => m.interactionId === command.interactionId,
      ).length,
      1,
    );
});

test("rich creation rejects a revoked explicit assignee without recording a task", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const d = f.service.domain();
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: ids.profileId,
    expectedVersion: 1,
    revoked: true,
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const taskId = randomUUID();
  await assert.rejects(
    api.execute({
      type: "task.create",
      key: randomUUID(),
      projectId: ids.projectId,
      taskId,
      title: "Rejected",
      outcome: "Ship",
      ready: true,
      initialAssignment: {
        assignmentId: randomUUID(),
        profileId: ids.profileId,
      },
    }),
    (e: unknown) => e instanceof Error && "code" in e && e.code === "forbidden",
  );
  assert.ok(!d.tasks(ids.projectId).some((t) => t.id === taskId));
});

test("catalog attention tracks current rejected completion and lead review, excluding historical fallback", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true),
    api = new OperatorApi(f.service, [f.directory]);
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const call = (
    tool: string,
    arguments_: Record<string, unknown>,
    callId: string,
  ) =>
    f.runtime.callTool({
      threadId: work.threadId ?? "",
      turnId: work.turnId ?? "",
      tool,
      arguments: arguments_,
      callId,
    });
  assert.equal(
    (await call("ensemble_ask_question", { question: "Choose" }, "attention-q"))
      .success,
    true,
  );
  assert.equal(
    (
      await call(
        "ensemble_request_completion",
        { reviewedResultIds: [] },
        "attention-c",
      )
    ).success,
    true,
  );
  f.runtime.complete(1);
  await until(() =>
    f.service
      .coordinationView()
      .readTask(ids.taskId)
      .completionRequests.some((c) => c.status === "rejected"),
  );
  const codes = async (id: string) =>
    (await api.readTaskListPage()).data.tasks.find((t) => t.id === id)
      ?.attention.codes ?? [];
  assert.ok((await codes(ids.taskId)).includes("completion-rejected"));
  f.service.domain().execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: Number(f.service.domain().task(ids.taskId).version),
    ready: false,
  });
  assert.equal(
    (await codes(ids.taskId)).includes("completion-rejected"),
    false,
  );
  const other = await seed(f);
  f.seedPersistedState((db) => {
    const routing = new RoutingAttemptStore(db),
      operation = routing.ensureOperation({
        projectId: other.projectId,
        taskId: other.taskId,
        taskVersion: 1,
        guidanceRevision: 1,
        brief: "Work",
        findings: "",
        guidance: "",
        candidates: [],
      });
    routing.completeFallback(operation.operationId, {
      kind: "lead-review",
      reason: "no-candidates",
      requestedModel: "jev-1.13.0",
    });
  });
  assert.ok((await codes(other.taskId)).includes("lead-review"));
  f.service.domain().execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: other.projectId,
    taskId: other.taskId,
    expectedVersion: 1,
    title: "Next version",
  });
  assert.deepEqual(await codes(other.taskId), []);
  assert.equal(
    f.service.coordinationView().readTask(other.taskId).routing.attempts.length,
    1,
  );
});
test("a task read reports source review, hold and unknown source as source-held", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Source project",
    leadProfileId: null,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "Imported",
    outcome: "Provider outcome",
    ready: true,
  });
  d.markImportedTask(taskId, "I1", "R1");
  const api = new OperatorApi(f.service, [f.directory]);
  const reasons = async () =>
    (await api.readTask(taskId)).data.admission.reasons;
  // No imported source rows: the domain reports source-unknown.
  assert.deepEqual(
    (await reasons()).filter(
      (r) => r.startsWith("source-") || r === "admission-blocked",
    ),
    ["source-held"],
  );
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO github_external_issues VALUES ('github.com','I1',?,'R1','owner/repo',1,'Imported','Body','open','[]')",
    ).run(taskId);
    db.prepare(
      "INSERT INTO github_memberships VALUES (?,'repo','I1','[]')",
    ).run(projectId);
    db.prepare("INSERT INTO github_source_reviews VALUES (?,?,?,?,NULL)").run(
      "I1",
      "a".repeat(64),
      "b".repeat(64),
      "accept-revised-scope",
    );
    db.prepare(
      "INSERT INTO github_source_holds VALUES ('I1',1,'source hold',1)",
    ).run();
  });
  assert.ok(d.admission(taskId).reasons.includes("source-hold"));
  assert.ok(d.admission(taskId).reasons.includes("source-review-required"));
  const read = await reasons();
  assert.ok(read.includes("source-held"), read.join());
  assert.ok(!read.includes("admission-blocked"), read.join());
});
test("profile configuration reads and writes a validated execution runtime", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(
    (await api.readProfileConfiguration(ids.profileId)).data.runtime,
    { harness: "codex" },
  );
  await assert.rejects(
    api.execute({
      type: "profile.configure",
      key: randomUUID(),
      profileId: ids.profileId,
      expectedVersion: 1,
      runtime: { harness: "codex", model: "opus" },
    } as never),
    /Unrecognized key/,
  );
  assert.equal(f.service.domain().profile(ids.profileId).version, 1);
  const runtime = {
    harness: "claude" as const,
    model: "opus",
    reasoningEffort: "high",
  };
  await api.execute({
    type: "profile.configure",
    key: randomUUID(),
    profileId: ids.profileId,
    expectedVersion: 1,
    runtime,
  });
  assert.deepEqual(
    (await api.readProfileConfiguration(ids.profileId)).data.runtime,
    runtime,
  );
});
test("task reads report the persisted binding harness of each execution generation", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f, true);
  const api = new OperatorApi(f.service, [f.directory]);
  assert.equal(
    (await api.readTask(ids.taskId)).data.assignments[0]?.executionGeneration
      ?.harness,
    "codex",
  );

  const d = f.service.domain();
  const claudeProfile = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: claudeProfile,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [claudeProfile],
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    title: "Claude task",
    outcome: "Wait for Claude",
    ready: false,
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "assignment.create",
    actor: "agent",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    assignmentId,
    profileId: claudeProfile,
    brief: "Claude work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() =>
    f.service
      .list()
      .some((w) => w.reason === "Claude runtime is not configured"),
  );
  const read = await api.readTask(taskId);
  const assignment = read.data.assignments.find(
    (a) => a.assignmentId === assignmentId,
  );
  assert.equal(assignment?.executionGeneration?.harness, "claude");
  assert.match(
    assignment?.waitReason ?? "",
    /Claude runtime is not configured/,
  );
  assert.equal(f.runtime.turns, 1);
  assert.deepEqual(assignment?.runtime, {
    harness: "claude",
    model: null,
    reasoningEffort: null,
  });
  assert.equal(assignment?.executionGeneration?.failure, null);

  // A failed Claude turn reports its bounded classification; malformed codes read unknown.
  const workId = String(assignment?.executionGeneration?.workId);
  const failed = (reasonCode: string) =>
    f.seedPersistedState((db) => {
      db.prepare("DELETE FROM runtime_terminal_evidence WHERE workId = ?").run(
        workId,
      );
      db.prepare(
        "INSERT INTO runtime_terminal_evidence (threadId,turnId,firstStatus,workId,firstRuntimeGeneration,lastRuntimeGeneration,firstObservedAt,lastObservedAt,failureEvidence,harness) VALUES ('t','u','failed',?,'g','g',1,1,?,'claude')",
      ).run(
        workId,
        JSON.stringify({
          classification: "permanent",
          reasonCode,
          source: "harness",
          harnessRetries: null,
        }),
      );
    });
  const failure = async () =>
    (await api.readTask(taskId)).data.assignments.find(
      (a) => a.assignmentId === assignmentId,
    )?.executionGeneration?.failure;
  failed("unauthorized");
  // Reported only while the execution intent is held.
  assert.equal(await failure(), null);
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE execution_intents SET state = 'held' WHERE workId = ?")
      .run(workId),
  );
  assert.deepEqual(await failure(), {
    classification: "permanent",
    reasonCode: "unauthorized",
  });
  failed("bad code <script>");
  assert.deepEqual(await failure(), {
    classification: "permanent",
    reasonCode: "unknown",
  });

  // The Codex assignment keeps its captured revision's runtime after the profile moves to Claude.
  const codex = (await api.readTask(ids.taskId)).data.assignments[0];
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: String(codex?.profileId),
    expectedVersion: Number(d.profile(String(codex?.profileId)).version),
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: "high" },
  });
  const after = (await api.readTask(ids.taskId)).data.assignments[0];
  assert.deepEqual(after?.runtime, { harness: "codex" });
  assert.equal(
    after?.currentProfileRevision,
    Number(codex?.profileRevision) + 1,
  );
  assert.equal(after?.executionGeneration?.harness, "codex");
  assert.equal(after?.executionGeneration?.failure, null);
});

test("workspace reads report every harness's status", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const read = await new OperatorApi(f.service, [f.directory]).readWorkspace();
  assert.deepEqual(
    read.data.harnesses.map(({ harness, state, settings }) => ({
      harness,
      state,
      settings,
    })),
    [
      { harness: "codex", state: "available", settings: null },
      { harness: "claude", state: "not-configured", settings: null },
    ],
  );
  assert.deepEqual(read.data.harnesses[0]?.policy, codexPolicyDisclosure());
  assert.equal(read.data.harnesses[1]?.policy, null);
  // The disclosure describes the policy Codex is actually given.
  assert.deepEqual(executionPolicy("/w"), {
    type: "workspaceWrite",
    writableRoots: ["/w"],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  });
  assert.deepEqual(read.data.runtime, { state: "available" });

  const both = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    (_context, harness) => {
      if (harness === "claude") throw Error("Claude unavailable");
      return new OperatorFixtureRuntime();
    },
    { runtimeHarnesses: ["codex", "claude"] },
  );
  t.after(() => both.close());
  const api = new OperatorApi(both.service, [both.directory]);
  const [codex, claude] = (await api.readWorkspace()).data.harnesses;
  assert.equal(codex?.state, "available");
  assert.equal(claude?.state, "unavailable");
  assert.equal(typeof (claude as { since?: number }).since, "number");
  both.runtime.crash();
  assert.equal(
    (await api.readWorkspace()).data.harnesses[0]?.state,
    "unavailable",
  );
});

test("profile commands reject Claude values the started runtime does not support", async (t) => {
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    (_context, harness) =>
      harness === "claude"
        ? new ClaudeShapedFixtureRuntime()
        : new OperatorFixtureRuntime(),
    { runtimeHarnesses: ["codex", "claude"] },
  );
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const create = (model: string | null, reasoningEffort: string | null) => {
    const profileId = randomUUID();
    return {
      profileId,
      run: () =>
        api.execute({
          type: "profile.create",
          key: randomUUID(),
          profileId,
          name: "Claude",
          instructions: "x",
          capabilities: "x",
          runtime: { harness: "claude", model, reasoningEffort },
        }),
    };
  };
  for (const [model, effort, field] of [
    ["nope", null, "runtime.model"],
    ["sonnet", "low", "runtime.reasoningEffort"],
  ] as const) {
    const c = create(model, effort);
    await assert.rejects(c.run(), (error: unknown) => {
      assert.ok(error instanceof OperatorApiError);
      assert.deepEqual(error.fieldPaths, [field]);
      return true;
    });
    assert.equal(
      f.service
        .domain()
        .profiles()
        .some((p) => p.id === c.profileId),
      false,
    );
  }
  const ok = create("sonnet", "high");
  await ok.run();
  assert.deepEqual(f.service.domain().profileRuntime(ok.profileId), {
    harness: "claude",
    model: "sonnet",
    reasoningEffort: "high",
  });
});

test("unknown well-shaped Claude values save while supported settings are unknown", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const profileId = randomUUID();
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "profile.create",
    key: randomUUID(),
    profileId,
    name: "Claude",
    instructions: "x",
    capabilities: "x",
    runtime: {
      harness: "claude",
      model: "future-model",
      reasoningEffort: null,
    },
  });
  assert.equal(
    (f.service.domain().profileRuntime(profileId) as { model: string }).model,
    "future-model",
  );
});

test("an exact profile replay returns its receipt after supported settings become known", async (t) => {
  class LateSettings extends ClaudeShapedFixtureRuntime {
    known = false;
    override supportedSettings() {
      return this.known ? super.supportedSettings() : undefined;
    }
  }
  const claude = new LateSettings();
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    (_context, harness) =>
      harness === "claude" ? claude : new OperatorFixtureRuntime(),
    { runtimeHarnesses: ["codex", "claude"] },
  );
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  const command = {
    type: "profile.create" as const,
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Claude",
    instructions: "x",
    capabilities: "x",
    runtime: {
      harness: "claude" as const,
      model: "opus",
      reasoningEffort: null,
    },
  };
  const first = await api.execute(command);
  claude.known = true;
  assert.deepEqual(await api.execute(command), first);
  await assert.rejects(
    api.execute({ ...command, key: randomUUID(), profileId: randomUUID() }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.fieldPaths?.[0] === "runtime.model",
  );
});

test("task reads redact a file-sourced Claude token value and path", async (t) => {
  const value = "claude-file-redaction-canary-6610",
    root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-claude-file-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "claude-token");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const d = f.service.domain();
  d.execute({
    type: "claude-token.configure",
    actor: "operator",
    key: randomUUID(),
    credentialRef: `file:${path}`,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: Number(d.task(ids.taskId).version),
    outcome: `Use ${value} from ${path}`,
  });
  const read = JSON.stringify(
    await new OperatorApi(f.service, [f.directory]).readTask(ids.taskId),
  );
  assert.equal(read.includes(value), false);
  assert.equal(read.includes(path), false);
});

test("task reads redact the Claude token reference and its value", async (t) => {
  const name = "FIXTURE_CLAUDE_REDACTION",
    value = "claude-redaction-canary-7781";
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f);
  const d = f.service.domain();
  d.execute({
    type: "claude-token.configure",
    actor: "operator",
    key: randomUUID(),
    credentialRef: `env:${name}`,
  });
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    expectedVersion: Number(d.task(ids.taskId).version),
    outcome: `Use ${value} via ${name}`,
  });
  const read = JSON.stringify(
    await new OperatorApi(f.service, [f.directory]).readTask(ids.taskId),
  );
  assert.equal(read.includes(value), false);
  assert.equal(read.includes(name), false);
});

test("task and composer reads return ordered waits with Fix kinds and blocker links", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  const codes = async (taskId: string) =>
    (await api.readTask(taskId)).data.waits.map((w) => w.code);
  const task = (projectId: string, ready = true) => {
    const taskId = randomUUID();
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "Wait probe",
      outcome: "Probe",
      ready,
    });
    return taskId;
  };
  // A paused project with no lead.
  const bare = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: bare,
    name: "Bare",
    leadProfileId: null,
  });
  const bareTask = task(bare);
  assert.deepEqual(await codes(bareTask), [
    "project-paused",
    "project-lead-unconfigured",
  ]);
  assert.deepEqual((await api.readTask(bareTask)).data.waits[0]?.fix, {
    kind: "resume-project",
    projectId: bare,
  });
  assert.deepEqual(
    (await api.readComposerOptions(bare)).data.waits.map((w) => w.code),
    ["project-paused", "project-lead-unconfigured"],
  );
  // A Draft keeps its other waits; a closed task has none.
  assert.deepEqual(await codes(task(bare, false)), [
    "project-paused",
    "project-lead-unconfigured",
  ]);

  // A revoked lead.
  const revoked = await seed(f);
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: revoked.profileId,
    expectedVersion: 1,
    revoked: true,
  });
  assert.deepEqual(await codes(revoked.taskId), [
    "project-paused",
    "project-lead-revoked",
  ]);

  // A Claude lead with the Claude harness not configured and no token reference.
  const claude = await seed(f);
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: claude.profileId,
    expectedVersion: 1,
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  });
  const claudeWaits = (await api.readTask(claude.taskId)).data.waits;
  assert.deepEqual(
    claudeWaits.map((w) => w.code),
    [
      "project-paused",
      "claude-token-unavailable",
      "profile-runtime-not-configured",
    ],
  );
  assert.deepEqual(claudeWaits[1]?.fix, { kind: "add-claude" });
  assert.deepEqual(claudeWaits[2]?.fix, {
    kind: "open-profile",
    profileId: claude.profileId,
  });

  // An incomplete local dependency on an enabled project.
  const enabled = await seed(f);
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: enabled.projectId,
    expectedVersion: Number(d.project(enabled.projectId).version),
    paused: false,
  });
  assert.deepEqual(
    (await api.readComposerOptions(enabled.projectId)).data.waits,
    [],
  );
  const blocker = task(enabled.projectId, false),
    dependent = task(enabled.projectId);
  d.execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId: enabled.projectId,
    taskId: dependent,
    blockerTaskId: blocker,
    expectedVersion: Number(d.task(dependent).version),
  });
  assert.deepEqual((await api.readTask(dependent)).data.waits, [
    {
      code: "local-dependency",
      fix: null,
      links: [{ kind: "task", id: blocker, label: "Wait probe" }],
    },
  ]);

  // Capacity full: project limit 1 with one running reservation.
  d.execute({
    type: "capacity.configure",
    actor: "operator",
    key: randomUUID(),
    globalLimit: 4,
    projectOverrides: { [enabled.projectId]: 1 },
  });
  // A reservation without its intent stands in for another running turn.
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO execution_capacity_reservations(workId,projectId) VALUES ('capacity-probe',?)",
    ).run(enabled.projectId);
  });
  assert.deepEqual((await api.readTask(task(enabled.projectId))).data.waits, [
    {
      code: "capacity",
      fix: null,
      links: [{ kind: "tasks-running", label: "1 of 1 project turns running" }],
    },
  ]);
  assert.deepEqual(
    (await api.readComposerOptions(enabled.projectId)).data.waits.map(
      (w) => w.code,
    ),
    ["capacity"],
  );
});

test("the workspace read carries whether a turn started and whether getting started was dismissed", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual((await api.readWorkspace()).data.gettingStarted, {
    turnStarted: false,
    dismissed: false,
  });
  const receipt = await api.execute({
    type: "getting-started.configure",
    key: randomUUID(),
    dismissed: true,
  });
  assert.deepEqual(receipt.kind === "configuration" && receipt.result, {
    commandType: "getting-started.configure",
    resourceId: "system:getting-started",
    dismissed: true,
  });
  // A task-bound intent that records a turn id is a started turn.
  await seed(f, true);
  assert.deepEqual((await api.readWorkspace()).data.gettingStarted, {
    turnStarted: true,
    dismissed: true,
  });
});

test("runtime waits come from the pending assignment's profile, not only the lead's", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f),
    d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  const claude = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: claude,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [claude],
  });
  // The healthy Codex lead alone gives no runtime wait.
  assert.deepEqual(
    (await api.readComposerOptions(ids.projectId)).data.waits.map(
      (w) => w.code,
    ),
    ["project-paused"],
  );
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    title: "Explicit Claude assignee",
    outcome: "Probe",
    ready: true,
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId,
    assignmentId: randomUUID(),
    profileId: claude,
    brief: "Claude work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const waits = (await api.readTask(taskId)).data.waits;
  assert.deepEqual(
    waits.map((w) => w.code),
    [
      "project-paused",
      "claude-token-unavailable",
      "profile-runtime-not-configured",
    ],
  );
  assert.deepEqual(waits[2]?.fix, { kind: "open-profile", profileId: claude });
  // The composer predicts the same for that explicit assignee.
  assert.deepEqual(
    (await api.readComposerOptions(ids.projectId)).data.assigneeWaits[
      claude
    ]?.map((w) => w.code),
    ["claude-token-unavailable", "profile-runtime-not-configured"],
  );
});

test("an imported blocker marked done keeps its dependency link while its issue is not closed", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f),
    d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  const blocker = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: blocker,
    title: "Imported blocker",
    outcome: "Probe",
    ready: false,
  });
  d.execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    blockerTaskId: blocker,
    expectedVersion: Number(d.task(ids.taskId).version),
  });
  d.markImportedTask(blocker, "imported-blocker", "repository");
  f.seedPersistedState((db) =>
    db.prepare("UPDATE domain_tasks SET state='done' WHERE id=?").run(blocker),
  );
  assert.ok(d.admission(ids.taskId).reasons.includes("local-dependency"));
  // The composer applies the same rule to a chosen dependency.
  assert.equal(
    (await api.readComposerOptions(ids.projectId)).data.dependencies.find(
      (x) => x.id === blocker,
    )?.blocking,
    true,
  );
  const wait = (await api.readTask(ids.taskId)).data.waits.find(
    (w) => w.code === "local-dependency",
  );
  assert.deepEqual(wait?.links, [
    { kind: "task", id: blocker, label: "Imported blocker" },
  ]);
});

test("a running assignment with a queued turn reports its own runtime waits", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seed(f),
    d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]);
  const claude = randomUUID(),
    assignmentId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: claude,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [claude],
  });
  await f.service.provisionTask(ids.taskId);
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    taskId: ids.taskId,
    assignmentId,
    profileId: claude,
    brief: "Claude work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  // The Claude delegate already ran once and has a follow-up delivery queued.
  f.seedPersistedState((db) => {
    db.prepare("UPDATE domain_assignments SET state='running' WHERE id=?").run(
      assignmentId,
    );
    db.prepare(
      `INSERT INTO turn_requests (requestKey, workId, kind, taskId, projectId, assignmentId,
        assignmentVersion, profileRevision, prompt, state)
        VALUES ('probe-key', 'probe-work', 'assignment', ?, ?, ?, ?, 1, 'probe', 'queued')`,
    ).run(
      ids.taskId,
      ids.projectId,
      assignmentId,
      Number(d.assignment(assignmentId).version),
    );
  });
  assert.deepEqual(
    (await api.readTask(ids.taskId)).data.waits.map((w) => w.code),
    [
      "project-paused",
      "claude-token-unavailable",
      "profile-runtime-not-configured",
    ],
  );
});
