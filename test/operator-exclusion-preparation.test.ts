import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../src/standalone/operator-api.js";
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
