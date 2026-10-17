import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Runtime } from "../../src/standalone/codex.js";
import type { OperatorFixture } from "./operator-web.js";

type Fixture = Pick<OperatorFixture<Runtime>, "service">;

export const addProfile = (f: Fixture) => {
  const profileId = randomUUID();
  f.service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Ada",
    instructions: "Lead",
    capabilities: "coordination",
  });
  return profileId;
};
/** An enabled project; pass a lead profile id for one that can run work. */
export const addProject = (
  f: Fixture,
  name: string,
  leadProfileId: string | null,
) => {
  const d = f.service.domain(),
    projectId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name,
    leadProfileId,
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  return projectId;
};
export const addTask = (f: Fixture, projectId: string, title: string) => {
  const taskId = randomUUID();
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title,
    outcome: "Probe",
    ready: false,
  });
  return taskId;
};

/**
 * Makes the task start its first turn. Before that, Home is only the getting-started card
 * and has no board, stat strip or Refresh tasks.
 */
export async function startFirstTurn(
  f: OperatorFixture<Runtime & { turns: number }>,
  projectId: string,
  taskId: string,
) {
  await f.service.provisionTask(taskId);
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const deadline = Date.now() + 5000;
  while (f.runtime.turns < 1 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.runtime.turns, 1);
}

/**
 * Leaves Home and returns through the navigation. A first-run Home has no Refresh tasks, so
 * entering it again is how it re-reads the workspace and the task list.
 */
export async function reenterHome(page: Page) {
  const menu = page.getByRole("button", { name: "Projects and navigation" });
  const open = async () => {
    if (await menu.isVisible()) await menu.click();
  };
  await open();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.waitForURL("**/app/tasks");
  await open();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.waitForURL(/\/app$/);
}
