import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  captureBrowserEvidence,
  type BrowserJourney,
} from "./browser-diagnostics.js";
import type { ExecutionHarness } from "../../src/core/execution-runtime.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import type { OperatorSetupSeams } from "../../src/standalone/operator-setup.js";
import type {
  RuntimeSpawnContext,
  StandaloneServiceOptions,
} from "../../src/standalone/service.js";
import {
  createOperatorFixture,
  type OperatorFixtureRuntime,
  seedOperatorRecovery,
} from "./operator-web.js";

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
  options: {
    runtimeFactory?: (
      context: RuntimeSpawnContext,
      harness: ExecutionHarness,
    ) => OperatorFixtureRuntime;
    serviceOptions?: StandaloneServiceOptions;
    /** Answers GitHub reads, so a source preview can succeed offline. */
    readerFactory?: GitHubReaderFactory;
    /** Setup seams for the web listener, such as a fake discovery reader. */
    setup?: OperatorSetupSeams;
  } = {},
) {
  const f = await journey.start("fixture.create", () =>
    options.runtimeFactory
      ? createOperatorFixture(
          null,
          options.readerFactory,
          undefined,
          journey.fixtureOptions,
          options.runtimeFactory,
          options.serviceOptions,
        )
      : createOperatorFixture(
          null,
          options.readerFactory,
          undefined,
          journey.fixtureOptions,
          undefined,
          options.serviceOptions,
        ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seedSettingsWorld(f);
  const web = await journey.start("fixture.web", () =>
    f.startWeb(undefined, options.setup),
  );
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
/** Reloads the page and returns once the service home read has been answered and rendered. */
export async function reloadAfterSetupHome(page: Page) {
  const answered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/setup/home",
  );
  await page.reload();
  await (await answered).finished();
  // Two frames let the answered read render before the test acts on it.
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
}
/**
 * Evidence capture for the settings pages. The source tab shows saved search queries and
 * local paths, and a revealed field shows private text, so every text field and every
 * `[data-private]` name is masked while
 * the screenshot is taken: evidence uploaded by CI never carries those values.
 */
export async function captureSettingsEvidence(page: Page, name: string) {
  const mask = await page.addStyleTag({
    content:
      "input[id$='-query'], input[id$='-path'], textarea, [data-private] { color: transparent !important; -webkit-text-fill-color: transparent !important; }",
  });
  try {
    await captureBrowserEvidence(page, name);
  } finally {
    await mask.evaluate((e) => (e as Element).remove());
  }
}
export const noPageOverflow = (page: Page) =>
  page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
/**
 * Text of every badge within `scope` that shows a word without a symbol. Count and label
 * badges are not states, so they are allowed to stay symbol-less.
 */
export const unpairedBadges = (
  scope: Page | Locator,
  allowed = /^(Matches |New repository link$|\d+ unresolved$)/,
) =>
  scope.locator('[data-slot="badge"]').evaluateAll(
    (es, source) =>
      es
        .filter((e) => !e.querySelector('svg[aria-hidden="true"]'))
        .map((e) => e.textContent ?? "")
        .filter((t) => !new RegExp(source).test(t)),
    allowed.source,
  );
/** The breadcrumb as read aloud: its items joined by the drawn separator. */
export const trail = (page: Page) =>
  page
    .getByRole("navigation", { name: "Breadcrumb" })
    .locator("li")
    .evaluateAll((es) => es.map((e) => e.textContent).join(" / "));
/** Every outcome message within `scope` (the page by default); an action leaves at most one. */
export const outcomeMessages = (scope: Page | Locator) =>
  scope.locator('[data-slot="action-outcome"]');
/**
 * The one saved line the last save left. The page shows exactly one outcome message, and its
 * text carries no service vocabulary, version or identifier.
 */
export async function savedOutcome(
  scope: Page | Locator,
  text: RegExp = /^Saved\./,
) {
  const saved = outcomeMessages(scope).filter({ hasText: text });
  await saved.waitFor();
  assert.equal(await outcomeMessages(scope).count(), 1);
  assert.doesNotMatch(
    await saved.innerText(),
    /recorded|receipt|revision|version|\w+\.(?:create|configure|preview|place)\b|system:/i,
  );
  return saved;
}
