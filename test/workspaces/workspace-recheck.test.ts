import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { controlledGit } from "../fixtures/controlled-git.js";
import { processIdentityDenied } from "../fixtures/host-access.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/questions.js";
import { startedOf } from "../fixtures/service-internals.js";
import { checkout } from "../fixtures/setup-home.js";

const stderr = "fatal: transient identity failure";

/** A task whose follow-up turn waits in admission because its worktree's identity read fails. */
async function heldTask(t: test.TestContext) {
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
    try {
      await f.close();
    } finally {
      await controlled.cleanup();
    }
  });
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  run({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Work",
    capabilities: "local",
  });
  run({
    type: "project.create",
    projectId,
    name: "Recheck",
    leadProfileId: profileId,
  });
  const source = join(f.directory, "source");
  await checkout(source, "https://github.com/acme/atlas.git");
  await f.service.domain().configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: f.service.domain().repositoryLinks(projectId).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_atlas",
        path: source,
        ref: "main",
      },
    ],
  } as never);
  run({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  run({
    type: "task.create",
    projectId,
    taskId,
    title: "Recheck",
    outcome: "Work",
    ready: false,
  });
  // The draft turn provisions the workspace; the lead's turn then waits in admission.
  await f.service.startDraftTurn({
    key: randomUUID(),
    taskId,
    expectedVersion: 1,
    message: "Look first",
  });
  await until(() => f.runtime.turns === 1);
  f.runtime.complete(1);
  const binding = await f.service.taskWorkspace(taskId);
  const repo = binding?.repositories[0];
  assert.ok(repo);
  controlled.setRule({
    commandPrefix: "rev-parse --show-toplevel",
    cwd: repo.workspacePath,
    behavior: "fail",
    stderr,
  });
  run({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: Number(f.service.domain().task(taskId).version),
    ready: true,
  });
  await until(() =>
    startedOf(f.service)
      .schedulerStore.forTask(taskId)
      .some(
        (r) =>
          r.reason?.startsWith("Workspace admission waiting:") &&
          r.reason.includes("Git could not read the worktree identity"),
      ),
  );
  assert.equal(f.runtime.turns, 1);
  const recheck = (key = randomUUID()) =>
    new OperatorApi(f.service, [f.directory]).execute({
      type: "task.workspace.recheck",
      key,
      taskId,
    });
  const stored = () => startedOf(f.service).workspaceBindings.get(taskId);
  return { f, controlled, taskId, recheck, stored };
}

test("a held workspace is released at startup and its queued turn starts without evidence", {
  skip: processIdentityDenied(),
}, async (t) => {
  const { f, controlled, stored } = await heldTask(t);
  assert.equal(stored()?.holdReleasable, true);
  controlled.setRule(undefined);
  await f.reopen();
  assert.equal(stored()?.state, "ready");
  await until(() => f.runtime.turns === 1);
});

test("the recheck command releases a held workspace, replays without Git and lets the turn start", {
  skip: processIdentityDenied(),
}, async (t) => {
  const { f, controlled, taskId, recheck, stored } = await heldTask(t);
  // Stop keeps admission from rechecking first, so only the command can release it.
  await f.service.controlTask({ type: "task.stop", key: randomUUID(), taskId });
  controlled.setRule(undefined);
  const key = randomUUID();
  const receipt = await recheck(key);
  assert.deepEqual(receipt, {
    kind: "workspace-recheck",
    key,
    recorded: true,
    taskId,
    released: true,
  });
  assert.equal(stored()?.state, "ready");
  const gitStarts = controlled
    .events()
    .filter((e) => e.event === "start").length;
  assert.deepEqual(await recheck(key), receipt);
  assert.equal(
    controlled.events().filter((e) => e.event === "start").length,
    gitStarts,
  );
  await f.service.controlTask({
    type: "task.resume",
    key: randomUUID(),
    taskId,
  });
  await until(() => f.runtime.turns === 2);
});

test("the recheck command refuses a still-failing check and a hold that needs a person", {
  skip: processIdentityDenied(),
}, async (t) => {
  const { f, taskId, recheck, stored } = await heldTask(t);
  const receipts = () => {
    let count = -1;
    f.seedPersistedState((db) => {
      count = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM task_control_receipts WHERE taskId = ?",
            )
            .get(taskId) as { n: number }
        ).n,
      );
    });
    return count;
  };
  const before = receipts();
  const refused = (pattern: RegExp) => (error: unknown) =>
    error instanceof OperatorApiError &&
    error.status === 409 &&
    pattern.test(error.publicMessage ?? "");
  await assert.rejects(
    recheck(),
    refused(new RegExp(`^Task workspace is still unavailable: .*${stderr}`)),
  );
  assert.equal(stored()?.state, "held");
  assert.equal(receipts(), before);

  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE task_workspace_bindings SET state = 'archiving' WHERE taskId = ?",
      )
      .run(taskId),
  );
  await f.reopen();
  await assert.rejects(
    recheck(),
    refused(
      /^This workspace hold needs a person's judgement and cannot be rechecked: .*cleanup was interrupted/,
    ),
  );
  assert.equal(stored()?.state, "held");
  assert.equal(receipts(), before);
  assert.equal(f.runtime.turns, 0);
});
