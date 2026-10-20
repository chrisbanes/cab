import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  desktop,
  inFirstViewport,
  noPageOverflow,
  phone,
  signIn,
} from "../fixtures/operator-settings.js";

const test = browserSuite("unblock-work-budget");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
type Domain = ReturnType<Fixture["service"]["domain"]>;
type Ids = { projectId: string; taskId: string };

/** One budgeted entry point: its seed, first screen, Fix and the result it must show. */
type Entry = {
  seed?: (d: Domain, ids: Ids) => void;
  path: (ids: Ids) => string;
  first: (page: Page) => Locator[];
  fix: (page: Page) => Locator;
  /** Awaits the settled result, then returns the targets that must be in view. */
  result: (page: Page) => Promise<Locator[]>;
};

const waits = (page: Page) => page.locator(".wait-reasons"),
  resumed = (page: Page) =>
    page.getByText("Project resumed.", { exact: true }).filter({
      visible: true,
    }),
  banner = (page: Page) =>
    page
      .getByRole("status")
      .filter({ hasText: "Project paused · New turns are held." }),
  verdict = (page: Page) =>
    page.getByRole("region", { name: "If you create it now" }),
  started = (page: Page) =>
    verdict(page).getByText("Starts now", { exact: true }),
  // The first reason is the numbered list's primary item.
  primaryFix = (page: Page) =>
    verdict(page)
      .locator('.wait-numbered > li[data-primary="true"]')
      .filter({ hasText: "Project paused" })
      .getByRole("button", { name: "Fix: Resume project" }),
  checklist = (page: Page) =>
    page.getByRole("region", { name: "Get Ensemble running" });

const entries: Record<string, Entry> = {
  "task detail": {
    // A blocker keeps the task unready after Resume, so no turn starts and the result is stable.
    seed(d, { projectId, taskId }) {
      const blocker = randomUUID();
      for (const [id, title, ready] of [
        [blocker, "Set up the deploy check", false],
        [taskId, "Add a health-check endpoint", true],
      ] as const)
        d.execute({
          type: "task.create",
          actor: "operator",
          key: randomUUID(),
          projectId,
          taskId: id,
          title,
          outcome: "Probe",
          ready,
        });
      d.execute({
        type: "dependency.add",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        blockerTaskId: blocker,
        expectedVersion: Number(d.task(taskId).version),
      });
    },
    path: ({ taskId }) => `/app/tasks/${taskId}`,
    first: (page) => [
      waits(page).getByText("Waiting · Project paused", { exact: true }),
      waits(page).getByRole("button", { name: "Fix: Resume project" }),
    ],
    fix: (page) =>
      waits(page).getByRole("button", { name: "Fix: Resume project" }),
    async result(page) {
      const reason = waits(page).getByText(
        "Waiting · Blocked by a task dependency",
        { exact: true },
      );
      await reason.waitFor();
      return [resumed(page), reason];
    },
  },
  "getting-started Project row": {
    // No task: no turn starts, so the card and its outcome line stay mounted.
    path: () => "/app",
    first: (page) => [
      checklist(page),
      checklist(page).getByText(
        "fixture-app is paused. Nothing runs until you resume it.",
      ),
      checklist(page).getByRole("button", { name: "Resume", exact: true }),
    ],
    fix: (page) =>
      checklist(page).getByRole("button", { name: "Resume", exact: true }),
    async result(page) {
      const row = checklist(page).getByText("fixture-app is running.");
      await row.waitFor();
      return [resumed(page), row];
    },
  },
  "project page": {
    seed(d, { projectId, taskId }) {
      d.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        title: "Add a health-check endpoint",
        outcome: "Probe",
        ready: true,
      });
    },
    path: ({ projectId }) => `/app/projects/${projectId}`,
    first: (page) => [
      banner(page),
      page.getByRole("button", { name: "Resume project", exact: true }),
    ],
    fix: (page) =>
      page.getByRole("button", { name: "Resume project", exact: true }),
    async result(page) {
      await banner(page).waitFor({ state: "hidden" });
      return [resumed(page)];
    },
  },
  composer: {
    path: ({ projectId }) => `/app/tasks/new?project=${projectId}`,
    first: (page) => [
      verdict(page),
      verdict(page).getByText("Will wait", { exact: true }),
      primaryFix(page),
    ],
    fix: primaryFix,
    async result(page) {
      await started(page).waitFor();
      return [started(page)];
    },
  },
};

async function start(
  journey: BrowserJourney,
  entry: Entry,
  viewport: { width: number; height: number },
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
  const d = f.service.domain(),
    ids: Ids = { projectId: randomUUID(), taskId: randomUUID() },
    lead = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: lead,
    name: "Ada",
    instructions: "Lead",
    capabilities: "coordination",
  });
  // A new project is paused.
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.projectId,
    name: "fixture-app",
    leadProfileId: lead,
  });
  entry.seed?.(d, ids);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const commands: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commands.push(request.postDataJSON());
  });
  await signIn(page, web, entry.path(ids));
  return { d, ids, page, commands };
}

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const)
  for (const [name, entry] of Object.entries(entries))
    test(`unblock waiting work budget: two interactions from ${name} (${label})`, async (_t, journey) => {
      const { d, ids, page, commands } = await start(journey, entry, viewport);
      const first = entry.first(page);
      for (const target of first) await target.waitFor();
      // Everything the first screen must show, together, once the page settles.
      for (const target of first)
        assert.equal(
          await inFirstViewport(page, target),
          true,
          `the wait and its Fix are in the first view ${JSON.stringify(await target.boundingBox())}`,
        );
      assert.equal(await page.evaluate(() => scrollY), 0, "nothing scrolled");
      await noPageOverflow(page);
      let interactions = 0;
      await entry.fix(page).click();
      interactions++;
      // Only Resume project has a confirmation (docs/user-flows/unblock-work.md "Budget"); it
      // is the second counted interaction.
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Resume", exact: true })
        .click();
      interactions++;
      for (const target of await entry.result(page))
        assert.equal(
          await inFirstViewport(page, target),
          true,
          `the result is in view ${JSON.stringify(await target.boundingBox())}`,
        );
      assert.equal(commands.length, 1, "exactly one command was sent");
      assert.deepEqual(
        {
          type: commands[0]?.type,
          projectId: commands[0]?.projectId,
          paused: commands[0]?.paused,
        },
        { type: "project.configure", projectId: ids.projectId, paused: false },
      );
      assert.deepEqual(Object.keys(commands[0] ?? {}).sort(), [
        "expectedVersion",
        "key",
        "paused",
        "projectId",
        "type",
      ]);
      assert.ok(!d.project(ids.projectId).paused, "the project is resumed");
      assert.equal(interactions, 2);
      await noPageOverflow(page);
    });
