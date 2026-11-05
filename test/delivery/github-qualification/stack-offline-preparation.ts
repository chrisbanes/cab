import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { StandaloneService } from "../../../src/standalone/service.js";
import { git } from "../../fixtures/publication.js";
import { tmpdir } from "../../fixtures/temp.js";

/** Fresh prepared data, never a reset of previously executed work. */
export async function freshOfflineStack(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-fresh-stack-")));
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  const service = new StandaloneService(
    join(root, "data"),
    () => {
      throw Error("offline-preparation-must-never-run");
    },
    undefined,
    { runtimeHarnesses: [], routingClient: null, power: { enabled: false } },
  );
  await service.start();
  t.after(async () => {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const profileId = randomUUID(),
    projectId = randomUUID();
  const run = (command: Record<string, unknown>) =>
    service.domain().execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  run({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Register the existing PR and report.",
    capabilities: "work",
  });
  run({
    type: "project.create",
    projectId,
    name: "Offline stack",
    leadProfileId: profileId,
  });
  await service.domain().configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R1",
        path: source,
        ref: "main",
      },
    ],
  });
  run({
    type: "project.configure",
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    stacking: true,
    paused: true,
  });
  run({
    type: "delivery.configure",
    projectId,
    expectedVersion: service.delivery().configuration(projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [],
    requiredChecks: [],
    repositories: [
      {
        repositoryId: "R1",
        mergeMethod: "squash",
        requiredChecks: [{ name: "offline-check" }],
      },
    ],
  });
  const tasks = [randomUUID(), randomUUID()] as [string, string];
  const heads: string[] = [];
  const branchOf = (taskId: string) =>
    service.delivery().taskBranch(taskId, "R1");
  const workspaceOf = async (taskId: string) => {
    const binding = await service.taskWorkspace(taskId);
    assert.ok(binding?.repositories[0]);
    return { root: binding.path, path: binding.repositories[0].workspacePath };
  };
  for (const [index, taskId] of tasks.entries()) {
    run({
      type: "task.create",
      projectId,
      taskId,
      title: `Task ${index + 1}`,
      outcome: "Register existing synthetic PR then report",
      ready: false,
      ...(index ? { blockerTaskIds: [tasks[0]] } : {}),
    });
    for (
      let revision = Number(service.domain().task(taskId).version);
      revision < index + 2;
      revision++
    ) {
      run({
        type: "task.configure",
        projectId,
        taskId,
        expectedVersion: Number(service.domain().task(taskId).version),
        outcome: `Register existing synthetic PR then report (${revision + 1})`,
      });
    }
    run({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: Number(service.domain().task(taskId).version),
      ready: true,
    });
    assert.ok(service.domain().ensureLeadAssignment(taskId));
    service.delivery().assignTaskBranchWithinTransaction(taskId, "R1");
    if (index) {
      // Model the already selected dependency before the retained upper workspace exists.
      const db = new DatabaseSync(join(root, "data/standalone.sqlite"));
      try {
        db.prepare(
          "INSERT INTO stacked_dependencies (taskId,blockerTaskId,repositoryId,parentHead,settledHead,restack,restackFromSha,recordedAt) VALUES (?,?,'R1',?,?,'current',NULL,?)",
        ).run(taskId, tasks[0], heads[0]!, heads[0]!, Date.now());
      } finally {
        db.close();
      }
    }
    await service.provisionTask(taskId, [
      {
        repositoryId: "R1",
        path: source,
        ref: "main",
        commit: index ? heads[0]! : base,
      },
    ]);
    const workspace = await workspaceOf(taskId);
    writeFileSync(join(workspace.path, `part-${index}.txt`), `part ${index}\n`);
    git(workspace.path, "add", ".");
    git(workspace.path, "commit", "-q", "-m", `part ${index}`);
    const head = git(workspace.path, "rev-parse", "HEAD");
    heads.push(head);
    const branch = branchOf(taskId)!;
    git(source, "update-ref", `refs/heads/${branch.branch}`, head);
    const db = new DatabaseSync(join(root, "data/standalone.sqlite"));
    try {
      db.prepare(
        "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=? AND repositoryId='R1'",
      ).run(head, taskId);
    } finally {
      db.close();
    }
  }
  assert.equal(
    service.list().every((intent) => intent.state === "ready"),
    true,
  );
  assert.equal(
    service
      .list()
      .every((intent) => intent.threadId === null && intent.turnId === null),
    true,
  );
  const [lowerHead, upperHead] = heads as [string, string];
  // A real squash of the lower diff, then the unchanged upper patch on that base.
  const lowerTree = git(source, "rev-parse", `${lowerHead}^{tree}`);
  const mergedBase = git(
    source,
    "commit-tree",
    lowerTree,
    "-p",
    base,
    "-m",
    "platform squash",
  );
  const upperTree = git(source, "rev-parse", `${upperHead}^{tree}`);
  const rebasedHead = git(
    source,
    "commit-tree",
    upperTree,
    "-p",
    mergedBase,
    "-m",
    "part 1",
  );
  return {
    root,
    source,
    base,
    service,
    projectId,
    tasks,
    run,
    branchOf,
    workspaceOf,
    lowerHead,
    upperHead,
    mergedBase,
    rebasedHead,
  };
}
