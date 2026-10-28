import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import type { BrowserJourney } from "../fixtures/browser-diagnostics.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  inFirstViewport,
  noPageOverflow,
  outcomeMessages,
  phone,
} from "../fixtures/operator-settings.js";
import { createFakeGh } from "../fixtures/fake-gh.js";
import {
  atlasIssueReader,
  chooseRepository,
  setupJourney,
  stubReadiness,
} from "../fixtures/setup-browser.js";
const test = browserSuite("operator-first-run-browser");

/** Every target is wholly in the first screen, unscrolled and without sideways overflow. */
async function firstScreen(page: Page, where: string, targets: Locator[]) {
  for (const target of targets)
    assert.equal(
      await inFirstViewport(page, target),
      true,
      `${where} is in the first view ${JSON.stringify(await target.boundingBox())}`,
    );
  assert.equal(await page.evaluate(() => scrollY), 0, `${where} not scrolled`);
  await noPageOverflow(page);
}

// docs/user-flows/first-run.md: a fresh sign-in on Home to a created task. Readiness is
// stubbed to pass because the fixture host has no Codex login to read.
async function firstRun(
  journey: BrowserJourney,
  viewport: typeof desktop,
  engine?: "webkit",
  // A repository with its GitHub Project: the ready check offers Preview and import now.
  linked = false,
) {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    profiles: false,
    discovery: linked,
    path: "/app",
    viewport,
    ...(engine ? { engine } : {}),
    ...(linked
      ? { ghExecutable: gh.executable, readerFactory: atlasIssueReader }
      : {}),
  });
  await stubReadiness(page);
  // Not counted: it applies the stub to the Home card's own readiness read.
  await page.reload();
  let interactions = 0;
  const click = async (target: Locator) => {
    await target.click();
    interactions++;
  };
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });

  const card = page.getByRole("region", { name: "Get cab running" });
  const row = card.locator("li[aria-label]").filter({ hasText: "Project" });
  const create = card.getByRole("link", {
    name: "Create project",
    exact: true,
  });
  await create.waitFor();
  await row.getByText("Next", { exact: true }).waitFor();
  await firstScreen(page, "Home", [card, create]);
  await click(create);

  const profile = page.getByRole("group", { name: "New lead profile" });
  const projectName = page.getByLabel("Project name", { exact: true });
  const profileName = profile.getByLabel("Profile name", { exact: true });
  const createProfile = profile.getByRole("button", { name: "Create profile" });
  const createProject = button("Create paused project");
  await profile.waitFor();
  // One screen's form fill counts as one interaction.
  await projectName.fill("Atlas");
  await profileName.fill("Ada");
  interactions++;
  await firstScreen(page, "setup", [
    projectName,
    profileName,
    createProfile,
    createProject,
  ]);
  // The repository joins the same fill; the screens above were checked before it.
  if (linked) {
    await chooseRepository(page, "acme/atlas");
    await page.getByLabel("Local repository path").fill("~/src/atlas");
    await page.getByLabel("Local repository path").blur();
    await page
      .getByText(/^Verified on this Mac: git checkout · origin acme\/atlas/)
      .waitFor();
    // Create records the gh credential only once step 3 has read the login.
    await page
      .getByText(/^GitHub source credential: GitHub CLI · @octo\. /)
      .waitFor();
  }
  await click(createProfile);
  const lead = page.getByLabel("Lead profile", { exact: true });
  await lead.waitFor();
  assert.equal(
    await lead.evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.text,
    ),
    "Ada",
  );
  // The repository fill scrolled the page; the sticky bar still keeps Create in view.
  if (linked) assert.equal(await inFirstViewport(page, createProject), true);
  else await firstScreen(page, "setup with the profile", [lead, createProject]);
  await click(createProject);

  const ready = page.getByRole("region", { name: "Ready check" });
  const resume = ready.getByRole("button", {
    name: "Resume and create first task",
    exact: true,
  });
  await ready.waitFor();
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  assert.equal(await resume.isEnabled(), true);
  const imported = ready.getByRole("link", { name: "View imported tasks" });
  const importNow = ready.getByRole("button", {
    name: "Preview and import now",
    exact: true,
  });
  assert.equal(await imported.count(), 0);
  if (linked) {
    await firstScreen(page, "ready check", [ready, importNow]);
    await click(importNow);
    await imported.waitFor();
    for (const line of [/^Previewed/, /Read .* completely at/])
      assert.equal(
        await inFirstViewport(
          page,
          outcomeMessages(ready).filter({ hasText: line }),
        ),
        true,
        `${line} is in view`,
      );
    assert.equal(await inFirstViewport(page, imported), true);
    await noPageOverflow(page);
  } else {
    assert.equal(await importNow.count(), 0);
    await firstScreen(page, "ready check", [ready, resume]);
  }
  const importedTasks = f.service
    .domain()
    .tasks(String(f.service.domain().projects()[0]?.id)).length;
  assert.equal(importedTasks > 0, linked);
  await click(resume);

  const project = f.service.domain().projects()[0];
  assert.ok(project);
  const composerProject = page.getByLabel("Project", { exact: true }),
    title = page.getByLabel("Task title", { exact: true }),
    outcome = page.getByLabel("Desired outcome", { exact: true }),
    verdict = page.getByRole("region", { name: "If you create it now" }),
    badge = verdict.getByText(/^(Will wait|Starts now)$/),
    start = button("Create and start");
  await title.waitFor();
  assert.equal(await composerProject.inputValue(), String(project.id));
  await title.fill("First task");
  await outcome.fill("The first task is created.");
  interactions++;
  await badge.waitFor();
  await firstScreen(page, "composer", [
    composerProject,
    title,
    outcome,
    verdict,
    badge,
    start,
  ]);
  await click(start);

  const created = page.getByRole("region", { name: "Task created" });
  const open = created.getByRole("link", { name: "Open task" });
  await created.waitFor();
  await firstScreen(page, "result", [created, open]);
  assert.equal(interactions, linked ? 8 : 7);
  const domain = f.service.domain();
  assert.equal(domain.projects().length, 1);
  assert.equal(domain.project(String(project.id)).paused, 0);
  assert.equal(domain.tasks(String(project.id)).length, importedTasks + 1);
}

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const)
  test(`first run budget: seven interactions from sign-in to a created task (${label})`, async (_t, journey) => {
    await firstRun(journey, viewport);
  });

test(
  "first run budget: seven interactions from sign-in to a created task in WebKit (390 x 844)",
  { browserEngine: "webkit" },
  async (_t, journey) => {
    journey.restart();
    await firstRun(journey, phone, "webkit");
  },
);

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const)
  test(`first run budget: eight interactions from sign-in to a created task with a linked GitHub Project (${label})`, async (_t, journey) => {
    await firstRun(journey, viewport, undefined, true);
  });

test(
  "first run budget: eight interactions from sign-in to a created task with a linked GitHub Project in WebKit (390 x 844)",
  { browserEngine: "webkit" },
  async (_t, journey) => {
    journey.restart();
    await firstRun(journey, phone, "webkit", true);
  },
);
