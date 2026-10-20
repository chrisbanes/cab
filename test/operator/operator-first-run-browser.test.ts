import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import type { BrowserJourney } from "../fixtures/browser-diagnostics.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  inFirstViewport,
  noPageOverflow,
  phone,
} from "../fixtures/operator-settings.js";
import { setupJourney, stubReadiness } from "../fixtures/setup-browser.js";

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
) {
  const { f, page } = await setupJourney(journey, {
    profiles: false,
    discovery: false,
    path: "/app",
    viewport,
    ...(engine ? { engine } : {}),
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

  const card = page.getByRole("region", { name: "Get Ensemble running" });
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
  await click(createProfile);
  const lead = page.getByLabel("Lead profile", { exact: true });
  await lead.waitFor();
  assert.equal(
    await lead.evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.text,
    ),
    "Ada",
  );
  await firstScreen(page, "setup with the profile", [lead, createProject]);
  await click(createProject);

  const ready = page.getByRole("region", { name: "Ready check" });
  const resume = ready.getByRole("button", {
    name: "Resume and create first task",
    exact: true,
  });
  await ready.waitFor();
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  assert.equal(await resume.isEnabled(), true);
  await firstScreen(page, "ready check", [ready, resume]);
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
  assert.equal(interactions, 7);
  const domain = f.service.domain();
  assert.equal(domain.projects().length, 1);
  assert.equal(domain.project(String(project.id)).paused, 0);
  assert.equal(domain.tasks(String(project.id)).length, 1);
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
