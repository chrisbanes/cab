import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { seedExecutionDiagnostics } from "./fixtures/execution-diagnostics.js";
import { wrapTaskExclusions } from "./fixtures/exclusions-hook.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";

test("list, project, Inbox and composer reads traverse retained instruction revisions once per request", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]),
    profileId = randomUUID(),
    projectId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Profile instructions",
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
  for (const instructions of ["First revision", "Second revision"])
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      instructions,
    });
  const taskIds: string[] = [1, 2, 3].map((n) => {
    const taskId = randomUUID();
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: `Task ${n} mentions Canary value`,
      outcome: "Outcome",
      ready: false,
    });
    return taskId;
  });
  const revisions =
    Number(d.profile(profileId).version) +
    Number(d.project(projectId).instructionsRevision);
  assert.ok(revisions >= 3);

  let reads = 0;
  const count = <K extends "profileRevision" | "instructionRevision">(
    name: K,
  ) => {
    const original = d[name].bind(d) as (...args: unknown[]) => unknown;
    (d as unknown as Record<K, unknown>)[name] = (...args: unknown[]) => {
      reads++;
      return original(...args);
    };
  };
  count("profileRevision");
  count("instructionRevision");
  const measure = async (read: () => Promise<unknown>) => {
    reads = 0;
    await read();
    return reads;
  };
  for (const [name, read] of [
    ["project", () => api.readProject(projectId)],
    ["task list", () => api.readTaskListPage()],
    ["Inbox", () => api.readInbox()],
    ["composer", () => api.readComposerOptions(projectId)],
  ] as const)
    assert.equal(await measure(read), revisions, name);

  // Each request reads current instructions: no list survives into the next request.
  const titles = async () =>
    (await api.readProject(projectId)).data.tasks
      .filter((task) => taskIds.includes(task.id))
      .map((task) => task.title);
  assert.ok((await titles()).every((title) => title?.includes("Canary")));
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    instructions: "Canary value",
  });
  assert.deepEqual(
    (await titles()).map((title) => title?.includes("[redacted]")),
    [true, true, true],
  );
});

test("a repository linked while a shared-base read is held is redacted in every task's text", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const seed = await seedExecutionDiagnostics(f);
  t.after(seed.cleanup);
  const d = f.service.domain(),
    api = new OperatorApi(f.service, [f.directory]),
    projectId = seed.projectA,
    taskId = randomUUID();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Untitled",
    outcome: "Outcome",
    ready: false,
  });
  const reads = {
    project: () => api.readProject(projectId),
    composer: () => api.readComposerOptions(projectId),
    "runtime settings": () => api.readRuntimeSettings(),
    "execution list": () =>
      api.readExecutionList(new URLSearchParams({ project: projectId })),
  };
  for (const [name, read] of Object.entries(reads)) {
    const canary = `/newly/private/${name.replace(" ", "-")}`;
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(d.task(taskId).version),
      title: `Checkout at ${canary}`,
    });
    f.seedPersistedState((db) =>
      db
        .prepare("UPDATE turn_requests SET reason=? WHERE workId=?")
        .run(`Failed at ${canary}`, seed.captured),
    );
    // Link the repository once, after the read captured its base but before a task lookup.
    let linked = false;
    const restore = wrapTaskExclusions(api, async (_id, run) => {
      if (!linked) {
        linked = true;
        await new Promise((resolve) => setImmediate(resolve));
        f.seedPersistedState((db) => {
          const row = db
            .prepare(
              "SELECT repositories FROM project_github_sources WHERE projectId=?",
            )
            .get(projectId) as { repositories: string };
          db.prepare(
            "UPDATE project_github_sources SET version=version+1, repositories=? WHERE projectId=?",
          ).run(
            JSON.stringify([
              ...JSON.parse(row.repositories),
              {
                repositoryId: name,
                path: canary,
                ref: "main",
                gitCommonDirectory: `${canary}/.git`,
              },
            ]),
            projectId,
          );
        });
      }
      return run();
    });
    try {
      const response = JSON.stringify(await read());
      assert.ok(linked, name);
      assert.equal(response.includes(canary), false, name);
      assert.ok(response.includes("[redacted]"), name);
    } finally {
      restore();
    }
  }

  // The execution list has no workspace snapshot: its own reference fence rejects a
  // credential value rotated after the base was captured.
  const envKey = d.routingCredentialReference(projectId)?.slice(4) ?? "",
    rotated = "rotated-routing-value-877";
  assert.ok(process.env[envKey]);
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE turn_requests SET reason=? WHERE workId=?")
      .run(`Failed with ${rotated}`, seed.captured),
  );
  let rotatedOnce = false;
  const restore = wrapTaskExclusions(api, async (_id, run) => {
    if (!rotatedOnce) {
      rotatedOnce = true;
      process.env[envKey] = rotated;
    }
    return run();
  });
  try {
    await assert.rejects(
      api.readExecutionList(new URLSearchParams({ project: projectId })),
      { status: 503 },
    );
    assert.ok(rotatedOnce);
  } finally {
    restore();
  }
});
