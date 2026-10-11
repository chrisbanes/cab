import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import type { BrowserJourney } from "./browser-diagnostics.js";
import { createOperatorFixture, seedOperatorRecovery } from "./operator-web.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
export const desktop = { width: 1366, height: 900 },
  phone = { width: 390, height: 844 };

/** A committed Git checkout on `main` under the fixture directory. */
export async function createCheckout(directory: string, name: string) {
  const path = join(directory, name),
    git = promisify(execFile);
  await mkdir(path);
  await git("git", ["init", "-b", "main", path]);
  await writeFile(join(path, "README.md"), "Fixture repository\n");
  await git("git", ["-C", path, "add", "README.md"]);
  await git("git", [
    "-C",
    path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  return path;
}

/**
 * The settings world of frames 114–128: seven profiles (Reviewer revoked), Atlas with a
 * GitHub source and one linked checkout, Relay paused with routing and a held task, and
 * Fieldnotes with nothing configured. Private values carry PRIVATE sentinels.
 */
export async function seedSettingsWorld(f: Fixture) {
  const api = new OperatorApi(f.service, [f.directory]);
  const run = (command: Record<string, unknown>) =>
    api.execute({ key: randomUUID(), ...command } as Parameters<
      OperatorApi["execute"]
    >[0]);
  const profiles: Record<string, string> = {};
  for (const [name, summary] of [
    ["Mira", "Lead"],
    ["Jonas", "Lead"],
    ["Nora", "Lead"],
    ["Eli", "Repairs"],
    ["Builder", "Implementation"],
    ["Worker", "Bounded tasks"],
    ["Reviewer", "Review"],
  ] as const) {
    const profileId = randomUUID();
    profiles[name] = profileId;
    await run({
      type: "profile.create",
      profileId,
      name,
      summary,
      instructions: `PRIVATE ${name.toUpperCase()} INSTRUCTIONS`,
      capabilities: `${name} capabilities`,
    });
  }
  await run({
    type: "profile.configure",
    profileId: profiles.Reviewer,
    expectedVersion: 1,
    revoked: true,
  });
  const project = async (name: string, lead: string, paused: boolean) => {
    const projectId = randomUUID();
    await run({
      type: "project.create",
      projectId,
      name,
      leadProfileId: profiles[lead],
    });
    await run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused,
      instructions: `PRIVATE ${name.toUpperCase()} INSTRUCTIONS`,
    });
    return projectId;
  };
  const atlas = await project("Atlas", "Mira", false),
    relay = await project("Relay", "Jonas", true),
    fieldnotes = await project("Fieldnotes", "Nora", false);
  const checkout = await createCheckout(f.directory, "atlas-checkout");
  await run({
    type: "github.configure",
    projectId: atlas,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: [
      {
        id: "S-1",
        kind: "repository",
        repositoryId: "acme/atlas",
        owner: "acme",
        name: "atlas",
      },
      { id: "S-2", kind: "search", query: "PRIVATE SAVED QUERY" },
      {
        id: "S-3",
        kind: "project",
        projectNodeId: "PVT_atlas",
        filter: "PRIVATE FILTER",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", path: checkout, ref: "main" }],
  });
  await run({
    type: "routing.configure",
    projectId: relay,
    expectedVersion: 1,
    enabled: true,
    guidance: "PRIVATE ROUTING GUIDANCE",
    credentialRef: "env:FIXTURE_TYPESAFE",
    candidateProfileIds: [profiles.Eli, profiles.Builder, profiles.Worker],
  });
  const taskId = randomUUID(),
    assignmentId = randomUUID(),
    d = f.service.domain();
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: relay,
    taskId,
    title: "Restore webhook delivery",
    outcome: "Work",
    ready: false,
  });
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: relay,
    taskId,
    assignmentId,
    profileId: profiles.Worker as string,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  seedOperatorRecovery(f, { taskId, assignmentId, projectId: relay });
  return { profiles, atlas, relay, fieldnotes, checkout, taskId, assignmentId };
}

/**
 * An imported task in the first project whose source issue is a member of every listed
 * project, so the task has a placement conflict between them.
 */
export function seedImportedConflict(
  f: Fixture,
  taskId: string,
  projectIds: string[],
  nodeId = "I_PLACEMENT",
  issueNumber = 1,
) {
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: projectIds[0] as string,
    taskId,
    title: "Conflicting imported task",
    outcome: "Work",
    ready: false,
  });
  f.service.domain().markImportedTask(taskId, nodeId, "R_PLACEMENT");
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO github_external_issues VALUES ('github.com',?,?,'R_PLACEMENT','owner/repo',?,'Imported','Body','open','[]')",
    ).run(nodeId, taskId, issueNumber);
    for (const projectId of projectIds)
      db.prepare(
        "INSERT INTO github_memberships VALUES (?,'selection',?,'[]')",
      ).run(projectId, nodeId);
  });
}

/** One fixture with the settings world, one Chromium page, signed in on `path`. */
export async function startSettings(
  journey: BrowserJourney,
  path: string,
  viewport = desktop,
  launch = () => chromium.launch(),
) {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seedSettingsWorld(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", launch);
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, resolve(path, ids));
  return { f, ids, web, page };
}
type Ids = Awaited<ReturnType<typeof seedSettingsWorld>>;
/** `:atlas`, `:relay`, `:assignment` and `:reviewer` placeholders in a path. */
export const resolve = (path: string, ids: Ids) =>
  path
    .replace(":atlas", ids.atlas)
    .replace(":relay", ids.relay)
    .replace(":fieldnotes", ids.fieldnotes)
    .replace(":assignment", ids.assignmentId)
    .replace(":reviewer", ids.profiles.Reviewer ?? "");
export async function signIn(
  page: Page,
  web: { origin: string; password: string },
  path: string,
) {
  await page.goto(web.origin + path);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}
export const noPageOverflow = (page: Page) =>
  page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
/** The breadcrumb as read aloud: its items joined by the drawn separator. */
export const trail = (page: Page) =>
  page
    .getByRole("navigation", { name: "Breadcrumb" })
    .locator("li")
    .evaluateAll((es) => es.map((e) => e.textContent).join(" / "));
