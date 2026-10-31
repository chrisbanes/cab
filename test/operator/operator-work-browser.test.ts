import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { taskSchema, type TaskRead } from "../../src/operator/contracts.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { exhaustibleRuntime } from "../fixtures/runtime-exhaustion.js";
import {
  addProfile,
  addProject,
  addTask,
  startFirstTurn,
} from "../fixtures/operator-first-run.js";
import { openMoreFilters, seedCatalog } from "../fixtures/operator-work.js";
import { choiceForm, guideForm } from "../fixtures/question-data.js";
import {
  seedOwnApproval,
  seedOwnIntervention,
  seedOwnQuestion,
} from "../fixtures/questions.js";

const test = browserSuite("operator-work-browser");
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
const desktop = { width: 1366, height: 900 },
  phone = { width: 390, height: 844 };

/**
 * One fixture, one Chromium page and the seeded catalog, signed in on `path`. The seeded
 * Draft, Done and Cancelled tasks are not Ready, so a task view opens with Any readiness
 * (remembered for later bare visits) unless `defaults` keeps the Ready default.
 */
async function open(
  defaults: boolean,
  journey: BrowserJourney,
  path = "/app/tasks",
  runtimes?: Pick<
    ReturnType<typeof exhaustibleRuntime>,
    "factory" | "serviceOptions"
  >,
  afterSeed?: (
    f: Awaited<ReturnType<typeof createOperatorFixture>>,
  ) => Promise<void>,
) {
  const f = await journey.start("fixture.create", () =>
    runtimes
      ? (createOperatorFixture(
          null,
          undefined,
          undefined,
          journey.fixtureOptions,
          runtimes.factory,
          runtimes.serviceOptions,
        ) as unknown as ReturnType<typeof createOperatorFixture>)
      : createOperatorFixture(
          null,
          undefined,
          undefined,
          journey.fixtureOptions,
        ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seedCatalog(f);
  await afterSeed?.(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: desktop });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  let commandPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commandPosts++;
  });
  const url = new URL(web.origin + path);
  if (
    !defaults &&
    !url.searchParams.has("ready") &&
    /^\/app(\/tasks|\/projects\/[^/]+)?$/.test(url.pathname)
  )
    url.searchParams.set("ready", "any");
  await page.goto(url.href);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  return { f, ids, web, page, commands: () => commandPosts };
}
type StartArgs = [
  journey: BrowserJourney,
  path?: string,
  runtimes?: Parameters<typeof open>[3],
  afterSeed?: Parameters<typeof open>[4],
];
const start = (...args: StartArgs) => open(false, ...args);
const startDefaults = (...args: StartArgs) => open(true, ...args);
const shot = (page: Page, name: string) => captureBrowserEvidence(page, name);
const taskIds = (page: Page, scope = "main") =>
  page
    .locator(`${scope} [data-task-id]`)
    .evaluateAll((es) => es.map((e) => e.getAttribute("data-task-id")).sort());
const noPageOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
const mainText = (page: Page) => page.locator("main").innerText();
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const responseName =
  /^(Answer question|Review material & decide|Inspect execution)$/;
/** One Overview stat strip value, as shown. */
const stat = (page: Page, name: string) =>
  page
    .locator(".overview-stats > div")
    .filter({ has: page.getByText(name, { exact: true }) })
    .locator("dd")
    .innerText();

/** A fixture with only what `seed` adds, signed in on Overview; records each command body. */
async function startBare<T>(
  journey: BrowserJourney,
  seed: (f: Awaited<ReturnType<typeof createOperatorFixture>>) => Promise<T>,
) {
  const fixture = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const seeded = await seed(fixture);
  const web = await journey.start("fixture.web", () => fixture.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: desktop });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const posts: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      posts.push(request.postDataJSON());
  });
  await page.goto(`${web.origin}/app`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".overview-card").first().waitFor();
  return { f: Object.assign(fixture, { seeded }), web, page, posts };
}

test("toolbar puts the filters, switch and count on one row with Active tasks as the default", async (_t, journey) => {
  const { ids, web, page, commands } = await startDefaults(journey);
  const state = page.getByRole("combobox", { name: "State", exact: true }),
    project = page.getByRole("combobox", { name: "Project", exact: true });
  await page
    .getByRole("heading", { name: "Across your projects", level: 2 })
    .waitFor();
  await page
    .locator(`.task-list [data-task-id="${ids.question.id}"]`)
    .waitFor();
  const tops = await Promise.all(
    [
      project,
      state,
      page.getByRole("button", { name: "List", exact: true }),
      page.getByRole("button", { name: "Board", exact: true }),
    ].map((c) => c.evaluate((e) => e.getBoundingClientRect().top)),
  );
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, `one row: ${tops}`);
  assert.equal(await page.locator(".work-toolbar label").count(), 0);
  assert.equal(await page.getByLabel("Source").isVisible(), false);
  assert.equal(
    await state.evaluate(
      (s: HTMLSelectElement) => s.selectedOptions[0]?.textContent,
    ),
    "Active tasks",
  );
  const active = page.locator(".task-list");
  for (const hidden of ["Completed result", "Cancelled work"])
    assert.equal(
      await active.getByRole("link", { name: hidden, exact: true }).count(),
      0,
    );
  assert.equal(
    await page.locator(".work-count").innerText(),
    `${(await taskIds(page, ".task-list")).length} tasks`,
  );
  await shot(page, "1366-tasks-toolbar");

  await state.selectOption("All tasks");
  await page.waitForURL((u) => u.searchParams.get("state") === "all");
  // The seeded Done and Cancelled tasks are not Ready, so the default readiness hides them.
  await openMoreFilters(page);
  await page.getByLabel("Readiness").selectOption("any");
  await page.waitForURL((u) => u.searchParams.get("ready") === "any");
  for (const shown of ["Completed result", "Cancelled work"])
    await active.getByRole("link", { name: shown, exact: true }).waitFor();
  await state.selectOption("Stopping");
  await page.waitForURL((u) => u.searchParams.get("state") === "Stopping");
  assert.deepEqual(
    await taskIds(page),
    [ids.normal.id, ids.uncertainStop.id].sort(),
  );
  await page.reload();
  assert.equal(await state.inputValue(), "Stopping");
  await page.goBack();
  await page.waitForURL((u) => u.searchParams.get("state") === "all");
  await page.goForward();
  await page.waitForURL((u) => u.searchParams.get("state") === "Stopping");

  // Filter tasks, Source and Readiness live in the disclosure, which opens for a URL filter.
  await page.goto(`${web.origin}/app/tasks?q=Question`);
  assert.equal(await page.locator(".work-more").getAttribute("open"), "");
  assert.equal(await page.getByLabel("Filter tasks").inputValue(), "Question");
  assert.equal(await page.getByLabel("Search tasks").count(), 0);
  // A bare URL would restore the remembered filter, so forget it first.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.equal(await page.locator(".work-more").getAttribute("open"), null);
  await openMoreFilters(page);
  await page.getByLabel("Filter tasks").fill("Normal Stop");
  await page.waitForURL((u) => u.searchParams.get("q") === "Normal Stop");
  assert.deepEqual(await taskIds(page), [ids.normal.id]);
  await page.getByLabel("Filter tasks").fill("");
  // The imported task is a Draft, which the Ready default hides.
  await page.getByLabel("Readiness").selectOption("any");
  await page.getByLabel("Source").selectOption("github");
  await page.waitForURL((u) => u.searchParams.get("source") === "github");
  assert.deepEqual(await taskIds(page), [ids.importedId]);
  await page.getByLabel("Source").selectOption("");
  await page.getByLabel("Readiness").selectOption("no");
  await page.waitForURL((u) => u.searchParams.get("ready") === "no");
  assert.ok((await taskIds(page)).includes(ids.draft));

  // The switch keeps every filter and the same task set, and sends no command.
  await page.goto(
    `${web.origin}/app/tasks?project=${ids.projectId}&state=all&q=a&source=local&ready=any`,
  );
  await page.locator(".task-list [data-task-id]").first().waitFor();
  const before = await taskIds(page);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.locator(".board-columns").waitFor();
  const url = new URL(page.url());
  for (const [key, value] of [
    ["project", ids.projectId],
    ["state", "all"],
    ["q", "a"],
    ["source", "local"],
    ["ready", "any"],
    ["view", "board"],
  ] as const)
    assert.equal(url.searchParams.get(key), value, key);
  assert.deepEqual(await taskIds(page), before);
  assert.equal(commands(), 0);
});

const filtersKey = "cab.task-filters.v1";
const stored = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), filtersKey);
const tasksLink = (page: Page) =>
  page.getByRole("link", { name: "Tasks", exact: true });

test("task filters are remembered across navigation and reload, and the URL wins", async (_t, journey) => {
  const { ids, web, page } = await startDefaults(journey, "/app/tasks");
  // Ready is the default readiness: a fresh visit lists no Draft task and stores nothing.
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.ok(!(await taskIds(page, ".task-list")).includes(ids.draft));
  await openMoreFilters(page);
  assert.equal(await page.getByLabel("Readiness").inputValue(), "yes");
  assert.equal(new URL(page.url()).search, "");
  assert.equal(await stored(page), null);

  // A filtered visit is remembered, and the bare Tasks link restores it.
  const filtered = "?state=all&source=local&ready=any";
  await page.goto(`${web.origin}/app/tasks${filtered}`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  const expected = await taskIds(page, ".task-list");
  assert.ok(expected.includes(ids.draft));
  await page.goto(`${web.origin}/app/search`);
  await tasksLink(page).click();
  await page.waitForURL((u) => u.search === filtered);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.deepEqual(await taskIds(page, ".task-list"), expected);
  await openMoreFilters(page);
  assert.equal(await page.getByLabel("Readiness").inputValue(), "any");
  await page.goto(`${web.origin}/app/tasks`);
  await page.waitForURL((u) => u.search === filtered);
  assert.deepEqual(await taskIds(page, ".task-list"), expected);

  // The URL wins and becomes the remembered set.
  await page.goto(`${web.origin}/app/tasks?ready=no`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  const unready = await taskIds(page, ".task-list");
  assert.ok(unready.includes(ids.draft));
  assert.ok(!unready.includes(ids.question.id));
  await page.goto(`${web.origin}/app/tasks`);
  await page.waitForURL((u) => u.search === "?ready=no");

  // A project page keeps its route's project and the remembered project.
  await page.goto(
    `${web.origin}/app/tasks?project=${ids.pausedProject}&state=all&ready=any`,
  );
  await page.locator(".task-list [data-task-id]").first().waitFor();
  await page.goto(`${web.origin}/app/projects/${ids.projectId}`);
  await page.waitForURL((u) => u.search === "?state=all&ready=any");
  await page
    .locator(`.task-list [data-task-id="${ids.question.id}"]`)
    .waitFor();
  assert.equal((await taskIds(page, ".task-list")).includes(ids.paused), false);
  assert.match(
    (await stored(page)) ?? "",
    new RegExp(`project=${ids.pausedProject}`),
  );

  // Overview shows the same set.
  await page.goto(`${web.origin}/app`);
  await page.waitForURL((u) => u.search.includes("ready=any"));
});

test("active filters are counted, reset in one step and undone by Back", async (_t, journey) => {
  const { f, ids, web, page } = await startDefaults(journey, "/app/tasks");
  const summary = page.locator(".work-more > summary"),
    reset = page.getByRole("button", { name: "Reset filters" });
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.equal(await summary.innerText(), "More filters");
  assert.equal(await reset.count(), 0);
  await page.goto(`${web.origin}/app/tasks?source=github`);
  await page.locator(".work-more").waitFor();
  // A URL filter opens the disclosure; the indicator is for when it is collapsed.
  await summary.click();
  assert.equal(await page.locator(".work-more").getAttribute("open"), null);
  assert.match(await summary.innerText(), /More filters · 1 active$/);
  assert.equal(await reset.count(), 1);
  await page.goto(`${web.origin}/app/tasks?source=github&ready=any`);
  await page.locator(".work-more").waitFor();
  assert.match(await summary.innerText(), /More filters · 2 active$/);

  // Reset pushes the defaults and forgets the set; Back returns to the filtered URL.
  await page.goto(`${web.origin}/app/tasks?state=all&view=board`);
  await page.locator(".board-columns").waitFor();
  await reset.click();
  await page.waitForURL((u) => u.search === "?view=board");
  assert.equal(await reset.count(), 0);
  assert.equal(await stored(page), "view=board");
  await page.goBack();
  await page.waitForURL((u) => u.search === "?state=all&view=board");
  assert.equal(await stored(page), "state=all&view=board");

  // The count line separates no tasks from no matches.
  await page.goto(`${web.origin}/app/tasks?q=zzz-no-match`);
  await page
    .getByText("No tasks match these filters", { exact: true })
    .waitFor();
  assert.equal(await reset.count(), 1);
  await reset.click();
  await page.waitForURL((u) => u.search === "");
  await page
    .locator(`.task-list [data-task-id="${ids.question.id}"]`)
    .waitFor();
  const emptyProject = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId: emptyProject,
    name: "Empty project",
    leadProfileId: ids.profileId,
  });
  await page.goto(`${web.origin}/app/projects/${emptyProject}`);
  await page.getByText("No tasks", { exact: true }).waitFor();
  assert.equal(await reset.count(), 0);
  await page.goto(`${web.origin}/app/projects/${ids.pausedProject}?state=Done`);
  await page
    .getByText("No tasks match these filters", { exact: true })
    .waitFor();
  await page.goto(`${web.origin}/app?q=zzz-no-match`);
  await page
    .locator(".empty-state")
    .getByText("No tasks match these filters.")
    .waitFor();
  assert.equal(await reset.count(), 1);
});

test("typing in the text filter adds one history entry that one Back clears", async (_t, journey) => {
  const { page } = await start(journey, "/app");
  await tasksLink(page).click();
  await page.waitForURL((u) => u.pathname === "/app/tasks");
  await page.locator(".task-list [data-task-id]").first().waitFor();
  const before = await page.evaluate(() => history.length);
  await openMoreFilters(page);
  await page.getByLabel("Filter tasks").pressSequentially("Normal");
  await page.waitForURL((u) => u.searchParams.get("q") === "Normal");
  assert.equal(await page.evaluate(() => history.length), before + 1);
  await page.goBack();
  await page.waitForURL(
    (u) => u.pathname === "/app/tasks" && !u.searchParams.has("q"),
  );
  assert.equal(await page.getByLabel("Filter tasks").inputValue(), "");
  await page.goForward();
  await page.waitForURL((u) => u.searchParams.get("q") === "Normal");
  // Clearing the text leaves a URL with no query for it, and that must not bring it back.
  await page.getByLabel("Filter tasks").fill("");
  await page.waitForURL((u) => u.searchParams.get("q") === null);
  assert.equal(await stored(page), "ready=any");
});

test("Back and Forward show each entry's own filters", async (_t, journey) => {
  const { page } = await startDefaults(journey, "/app/tasks");
  await page.locator(".task-list [data-task-id]").first().waitFor();
  await openMoreFilters(page);
  await page.getByLabel("Source").selectOption("github");
  await page.waitForURL((u) => u.searchParams.get("source") === "github");
  assert.equal(await stored(page), "source=github");
  await page.goBack();
  await page.waitForURL((u) => u.search === "");
  assert.equal(await page.getByLabel("Source").inputValue(), "");
  assert.equal(await stored(page), null);
  await page.goForward();
  await page.waitForURL((u) => u.search === "?source=github");
  assert.equal(await stored(page), "source=github");
  // Reset is undone by Back and redone by Forward.
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.waitForURL((u) => u.search === "");
  await page.goBack();
  await page.waitForURL((u) => u.search === "?source=github");
  await page.goForward();
  await page.waitForURL((u) => u.search === "");
  assert.equal(await page.getByLabel("Source").inputValue(), "");
  assert.equal(await stored(page), null);
});

test("headers carry the new subtitles, one New task action and the page-owned refresh", async (_t, journey) => {
  const { ids, web, page } = await start(journey, "/app");
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "New task", exact: true }).count(),
    1,
  );
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.match(
    await page.locator(".page-header-title p").innerText(),
    /^\d+ active tasks? · \d+ projects?$/,
  );
  await page.goto(`${web.origin}/app/projects/${ids.projectId}`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.match(
    await page.locator(".page-header-title p").innerText(),
    /^\d+ active tasks? · accountable lead Accountable lead$/,
  );
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Open existing project controls" })
      .count(),
    0,
  );
  assert.equal(await page.locator(".task-actions").count(), 0);
  await page.getByText(/^Updated \d{2}:\d{2}$/).waitFor();
  assert.equal(await page.getByText(/Task states read/).count(), 0);
  const reads = [
    page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/operator/workspace",
    ),
    page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/operator/inbox",
    ),
  ];
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await Promise.all(reads);
  await shot(page, "1366-overview-toolbar");

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.ok(await noPageOverflow(page));
  const heights = await page
    .locator(".work-toolbar button, .work-toolbar select")
    .evaluateAll((es) =>
      es.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
  assert.ok(
    heights.length >= 4 && heights.every((h) => h >= 44),
    `touch targets ${heights}`,
  );
  await shot(page, "390-tasks-toolbar");
});

test("a paused project's banner resumes it with confirmation and shows the save outcome", async (_t, journey) => {
  const { f, ids, page, web } = await start(journey);
  const d = f.service.domain();
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      sent.push(request.postDataJSON());
  });
  const open = async () => {
    await page.goto(`${web.origin}/app/projects/${ids.pausedProject}`);
    await banner.waitFor();
  };
  const pauseAgain = () =>
    d.execute({
      type: "project.configure",
      key: randomUUID(),
      actor: "operator",
      projectId: ids.pausedProject,
      expectedVersion: Number(d.project(ids.pausedProject).version),
      paused: true,
    });
  const banner = page
    .getByRole("status")
    .filter({ hasText: "Project paused · New turns are held." });
  const resume = page.getByRole("button", {
    name: "Resume project",
    exact: true,
  });
  const dialog = page.getByRole("alertdialog");
  const confirm = () =>
    dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await open();
  await banner
    .getByText("Resume doesn't clear stop, task or writer holds.")
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Project settings", exact: true })
      .count(),
    1,
  );
  // Pause stays in project configuration.
  assert.equal(await banner.getByRole("button", { name: /Pause/ }).count(), 0);

  // Cancel sends nothing.
  await resume.click();
  await dialog.getByText("Resume Paused project?").waitFor();
  await dialog.getByText("Holds and access are unchanged.").waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(sent.length, 0);
  assert.equal(d.project(ids.pausedProject).paused, 1);

  // Confirm sends exactly one project.configure and the outcome outlives the banner.
  await resume.click();
  await confirm();
  await page.getByText("Project resumed.", { exact: true }).waitFor();
  await banner.waitFor({ state: "hidden" });
  assert.equal(sent.length, 1);
  const first = sent[0];
  assert.ok(first);
  assert.deepEqual(
    { type: first.type, projectId: first.projectId, paused: first.paused },
    { type: "project.configure", projectId: ids.pausedProject, paused: false },
  );
  assert.deepEqual(Object.keys(first).sort(), [
    "expectedVersion",
    "key",
    "paused",
    "projectId",
    "type",
  ]);
  assert.equal(d.project(ids.pausedProject).paused, 0);
  assert.equal(await page.getByText("Project resumed.").count(), 1);
  assert.equal(await page.getByRole("button", { name: /Resum/ }).count(), 0);

  // A lost reply is unknown: Resume leaves, and Check resends the exact request.
  pauseAgain();
  await open();
  await page.route("**/api/operator/commands", (route) => route.abort());
  await resume.click();
  await confirm();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  assert.equal(await page.getByRole("button", { name: /Resum/ }).count(), 0);
  assert.equal(sent.length, 2);
  await page.unroute("**/api/operator/commands");
  await check.click();
  await page.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2], sent[1]);
  assert.equal(d.project(ids.pausedProject).paused, 0);

  // A rejected save says so and leaves the banner with Resume project to try again.
  pauseAgain();
  await open();
  await page.route("**/api/operator/commands", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "invalid-input", message: "Rejected" },
      }),
    }),
  );
  await resume.click();
  await confirm();
  await page
    .getByText("Couldn't save. Your changes are still here.", { exact: true })
    .waitFor();
  await resume.waitFor();
  assert.equal(await page.getByText("Project resumed.").count(), 0);
  await page.unroute("**/api/operator/commands");

  // On a phone the banner and its button fit without page scroll.
  await page.setViewportSize(phone);
  await banner.waitFor();
  await resume.waitFor();
  assert.ok(await noPageOverflow(page));
});

test("a recorded resume hides the banner's action while the workspace read is still stale", async (_t, journey) => {
  const { f, ids, page, web } = await start(journey);
  const d = f.service.domain();
  let sent = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      sent++;
  });
  await page.goto(`${web.origin}/app/projects/${ids.pausedProject}`);
  const resume = page.getByRole("button", {
    name: "Resume project",
    exact: true,
  });
  await resume.waitFor();
  // The save is recorded, but the workspace read that clears the pause never arrives.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/workspace", async (route) => {
    await held;
    await route.continue();
  });
  await resume.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await page.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(d.project(ids.pausedProject).paused, 0);
  assert.equal(await page.getByRole("button", { name: /Resum/ }).count(), 0);
  assert.equal(
    await page.getByText("Project paused · New turns are held.").count(),
    0,
  );
  assert.equal(await page.getByText("Project resumed.").count(), 1);
  assert.equal(sent, 1);
  release();
  await page.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Resum/ }).count(), 0);
  assert.equal(sent, 1);
});

test("a recorded resume stays suppressed across navigation until a read shows the project paused again", async (_t, journey) => {
  const { f, ids, page, web } = await start(journey);
  const d = f.service.domain();
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      sent.push(request.postDataJSON());
  });
  await page.goto(`${web.origin}/app/projects/${ids.pausedProject}`);
  const banner = page
    .getByRole("status")
    .filter({ hasText: "Project paused · New turns are held." });
  const resume = page.getByRole("button", {
    name: "Resume project",
    exact: true,
  });
  const resumed = page.getByText("Project resumed.", { exact: true });
  await banner.waitFor();
  // The save is recorded, but every later workspace read fails: the page keeps the old one.
  await page.route("**/api/operator/workspace", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unavailable", message: "Unavailable." },
      }),
    }),
  );
  await resume.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await resumed.waitFor();
  assert.equal(sent.length, 1);
  const recordedVersion = Number(d.project(ids.pausedProject).version);

  // Leave the project and come back inside the app: the stale read still says paused.
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Tasks" })
    .first()
    .click();
  await resumed.waitFor({ state: "hidden" });
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Paused project" })
    .click();
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .waitFor();
  // The mount purge clears the earlier confirmation; nothing else may take its place.
  await resumed.waitFor({ state: "hidden" });
  assert.equal(await banner.count(), 0);
  assert.equal(await page.getByRole("button", { name: /Resum/ }).count(), 0);
  assert.equal(sent.length, 1);
  assert.equal(await page.getByText(/saved elsewhere/).count(), 0);

  // Once a read shows the project paused again at a newer version, Resume is offered again.
  await page.unroute("**/api/operator/workspace");
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.pausedProject,
    expectedVersion: recordedVersion,
    paused: true,
  });
  const pausedVersion = Number(d.project(ids.pausedProject).version);
  assert.ok(pausedVersion > recordedVersion);
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await banner.waitFor();
  assert.equal(await resumed.count(), 0);
  await resume.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await resumed.waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.expectedVersion, pausedVersion);
  assert.equal(d.project(ids.pausedProject).paused, 0);
});

test("a project paused again after a recorded resume offers Resume project on the same page", async (_t, journey) => {
  const { f, ids, page, web } = await start(journey);
  const d = f.service.domain();
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      sent.push(request.postDataJSON());
  });
  await page.goto(`${web.origin}/app/projects/${ids.pausedProject}`);
  const banner = page
    .getByRole("status")
    .filter({ hasText: "Project paused · New turns are held." });
  const resume = page.getByRole("button", {
    name: "Resume project",
    exact: true,
  });
  const resumed = page.getByText("Project resumed.", { exact: true });
  const confirm = async () => {
    await resume.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Resume", exact: true })
      .click();
  };
  await banner.waitFor();
  await confirm();
  await resumed.waitFor();
  await banner.waitFor({ state: "hidden" });
  // Someone pauses it again; the next read shows the newer version, so the old confirmation goes.
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.pausedProject,
    expectedVersion: Number(d.project(ids.pausedProject).version),
    paused: true,
  });
  const pausedVersion = Number(d.project(ids.pausedProject).version);
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await banner.waitFor();
  await resumed.waitFor({ state: "hidden" });
  await confirm();
  await resumed.waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.expectedVersion, pausedVersion);
  assert.equal(await page.getByText(/saved elsewhere/).count(), 0);
  assert.equal(d.project(ids.pausedProject).paused, 0);
});

test("reopening Resume project after cancelling uses the version now shown", async (_t, journey) => {
  const { f, ids, page, web } = await start(journey);
  const d = f.service.domain();
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      sent.push(request.postDataJSON());
  });
  await page.goto(`${web.origin}/app/projects/${ids.pausedProject}`);
  const resume = page.getByRole("button", {
    name: "Resume project",
    exact: true,
  });
  const dialog = page.getByRole("alertdialog");
  await resume.waitFor();
  await resume.click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(sent.length, 0);
  // The project changes while it stays paused, and the page reads it.
  const before = Number(d.project(ids.pausedProject).version);
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.pausedProject,
    expectedVersion: before,
    instructions: "Changed elsewhere",
  });
  const after = Number(d.project(ids.pausedProject).version);
  assert.ok(after > before);
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Project paused" })
    .waitFor();
  await resume.click();
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.expectedVersion, after);
  assert.equal(await page.getByText(/saved elsewhere/).count(), 0);
  assert.equal(d.project(ids.pausedProject).paused, 0);
});

test("a Resume conflict reviewed while the project is still paused resumes with the newer version", async (_t, journey) => {
  const { f, ids, page, web } = await start(journey);
  const d = f.service.domain();
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      sent.push(request.postDataJSON());
  });
  await page.goto(`${web.origin}/app/projects/${ids.pausedProject}`);
  const resume = page.getByRole("button", {
    name: "Resume project",
    exact: true,
  });
  const confirm = async () => {
    await resume.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Resume", exact: true })
      .click();
  };
  await resume.waitFor();
  // Another actor changes the project while it stays paused; this page has not read it.
  const before = Number(d.project(ids.pausedProject).version);
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId: ids.pausedProject,
    expectedVersion: before,
    instructions: "Changed elsewhere",
  });
  const after = Number(d.project(ids.pausedProject).version);
  await confirm();
  const review = page.getByRole("button", {
    name: "Review changes",
    exact: true,
  });
  await review.waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.expectedVersion, before);
  assert.equal(d.project(ids.pausedProject).paused, 1);
  await review.click();
  await review.waitFor({ state: "hidden" });
  await resume.waitFor();
  await confirm();
  await page.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.expectedVersion, after);
  assert.notEqual(sent[1]?.key, sent[0]?.key);
  assert.equal(d.project(ids.pausedProject).paused, 0);
});

test("a routing fallback row names cab as the next actor without the operator tone", async (_t, journey) => {
  const { ids, page } = await start(journey, "/app/tasks?state=all");
  await page.route("**/api/operator/task-list*", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    for (const task of json.data.tasks)
      if (task.id === ids.running.id)
        task.attention = { codes: ["lead-review"], count: 1 };
    await route.fulfill({ response, json });
  });
  await page.reload();
  const next = page.locator(
    `.task-list [data-task-id="${ids.running.id}"] .task-next`,
  );
  await next.waitFor();
  assert.equal(await next.getAttribute("data-operator"), null);
  // cab acting is not the amber "you act" tone.
  assert.notEqual(
    await next.evaluate((e) => getComputedStyle(e).color),
    await resolved(page, "color", "var(--attn)"),
  );
});

test("task rows show state, next actor and lead from recorded facts without raw identifiers", async (_t, journey) => {
  const { ids, web, page } = await start(journey, "/app/tasks?state=all");
  const row = (id: string) => page.locator(`.task-list [data-task-id="${id}"]`);
  await row(ids.importedId).waitFor();
  const imported = await row(ids.importedId)
    .locator(".task-project-metadata")
    .innerText();
  assert.match(imported, /Service integration/);
  assert.match(imported, /fixture\/source#42/);
  assert.doesNotMatch(imported, /GitHub fixture/);
  assert.equal(
    await row(ids.importedId).locator(".task-lead").innerText(),
    "Accountable lead · lead",
  );
  assert.equal(
    await row(ids.importedId).locator(".task-source-state").count(),
    0,
  );
  const question = row(ids.question.id);
  assert.match(await question.locator(".task-status").innerText(), /Running/);
  await question
    .getByText("Question needs an answer", { exact: true })
    .waitFor();
  await question
    .getByText("Next: you · answer question", { exact: true })
    .waitFor();
  // Nobody must act on these: no Next line at all, not a "none" fallback.
  for (const id of [ids.running.id, ids.done, ids.cancelled]) {
    assert.equal(await row(id).locator(".task-next").count(), 0, id);
    assert.doesNotMatch(
      await row(id).innerText(),
      /No operator decision|Next: none/,
    );
  }
  assert.doesNotMatch(await mainText(page), uuidText);
  // The whole row is the title link's target.
  await row(ids.running.id).scrollIntoViewIfNeeded();
  const box = (await row(ids.running.id).boundingBox())!;
  const at = [box.x + box.width - 8, box.y + box.height / 2] as const;
  assert.equal(
    await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.className,
      at,
    ),
    "small-heading task-title",
  );
  await page.mouse.click(...at);
  await page.waitForURL((u) => u.pathname === `/app/tasks/${ids.running.id}`);
  await page.goBack();
  await shot(page, "1366-list");

  await page.goto(`${web.origin}/app`);
  await page
    .getByRole("region", { name: "Across your projects" })
    .locator(".task-row")
    .first()
    .waitFor();
  // A task that needs attention is also in the work list.
  await row(ids.question.id).waitFor();
  assert.doesNotMatch(await mainText(page), uuidText);
  await shot(page, "1366-overview-work");

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?state=all&ready=any`);
  await row(ids.importedId).waitFor();
  assert.ok(await noPageOverflow(page));
  const narrow = await page.locator(".task-row > *").evaluateAll((es) =>
    es
      .filter((e) => e.textContent?.trim())
      .map((e) => [e.className, e.getBoundingClientRect().width] as const)
      .filter(([c, w]) => w < (String(c).includes("task-status") ? 56 : 100)),
  );
  assert.deepEqual(narrow, []);
  await shot(page, "390-list");
});

test("overview cards read the Inbox and cover its failure and partial states", async (_t, journey) => {
  const { f, ids, web, page } = await start(journey, "/app");
  const attention = page.getByRole("region", {
    name: "Needs you",
    exact: true,
  });
  await attention
    .getByRole("heading", { level: 2, name: "Needs you" })
    .waitFor();
  const cards = attention.locator(".overview-card");
  await cards.first().waitFor();
  const navCount = await page
    .locator('.sidebar a[href="/app/inbox"] .nav-count')
    .innerText();
  assert.equal(await stat(page, "Needs you"), navCount);
  const inboxLink = attention.getByRole("link", { name: /^Open Inbox/ });
  assert.equal(squash(await inboxLink.innerText()), `Open Inbox · ${navCount}`);
  assert.equal(await inboxLink.getAttribute("href"), "/app/inbox");
  assert.ok((await cards.count()) <= 3);
  for (const text of await cards.evaluateAll((es) =>
    es.map((e) => e.textContent ?? ""),
  )) {
    assert.match(text, /Question|Approval|Execution uncertain|Intervention/);
    // A missing time or requester is omitted, never printed as a placeholder.
    assert.doesNotMatch(text, /Age unknown|Responsibility unknown/);
    if (!/Intervention|Execution uncertain/.test(text)) {
      assert.match(text, /\d\d:\d\d · /);
      assert.match(text, /Requested by /);
    }
    assert.doesNotMatch(text, uuidText);
  }
  for (let i = 0; i < (await cards.count()); i++) {
    const card = cards.nth(i);
    const response = card.getByRole("link", { name: responseName });
    assert.equal(await response.count(), 1);
    const describedBy = await response.getAttribute("aria-describedby");
    assert.equal(
      await card.locator(`h3[id="${describedBy}"]`).count(),
      1,
      "the response names its headline",
    );
  }
  assert.equal(
    await attention
      .getByText("Normal Stop observation", { exact: true })
      .count(),
    0,
  );
  const question = cards.filter({ hasText: "Question requiring action" }),
    questionLink = question.getByRole("link", {
      name: "Answer question",
      exact: true,
    });
  assert.match(
    (await questionLink.getAttribute("href")) ?? "",
    new RegExp(`^/app/inbox\\?task=${ids.question.id}&request=`),
  );
  const intervention = cards.filter({
    hasText: "Stop with uncertain ownership",
  });
  assert.equal(
    await intervention
      .getByRole("link", { name: "Inspect execution" })
      .getAttribute("href"),
    `/app/tasks/${ids.uncertainStop.id}?section=decisions`,
  );
  assert.equal(await attention.locator(".overview-overflow").count(), 0);
  await shot(page, "1366-overview-attention");

  // Answering opens the Inbox with that request selected; Back restores Overview.
  await questionLink.click();
  await page.locator(".inbox-row[aria-pressed='true']").waitFor();
  await page.goBack();
  await attention.waitFor();

  // Coordination timestamps have second precision; make the existing question older.
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE coordination_interactions SET createdAt=createdAt-1 WHERE taskId=?",
      )
      .run(ids.question.id),
  );
  // A fourth request becomes the dashed row and the counts follow the sidebar.
  await seedOwnQuestion(f, undefined, "Fourth request");
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  const overflow = attention.locator(".overview-overflow");
  await overflow.waitFor();
  assert.equal(
    squash(await overflow.innerText()),
    "1 more · Question project / Fourth request · Inbox",
  );
  assert.equal(await overflow.getAttribute("href"), "/app/inbox");
  assert.equal(await cards.count(), 3);
  await page.waitForFunction(
    (n) => document.querySelector(".overview-stats dd")?.textContent === n,
    String(Number(navCount) + 1),
  );
  assert.equal(
    await page.locator('.sidebar a[href="/app/inbox"] .nav-count').innerText(),
    String(Number(navCount) + 1),
  );

  // Completed work stays reachable although Active tasks hides it.
  const completed = page.getByRole("region", {
    name: "Completed work",
    exact: true,
  });
  await completed
    .getByText("1 completed task · no decision needed", { exact: true })
    .waitFor();
  assert.equal(
    await completed
      .getByRole("link", { name: "View completed" })
      .getAttribute("href"),
    "/app/tasks?state=Done&ready=any",
  );
  await shot(page, "1366-overview-completed");

  // Unavailable Inbox: the work list still renders and no total is claimed.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/operator/inbox**", async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    });
  });
  try {
    await page.reload();
    release();
    await attention
      .getByText("Requests are unavailable. Try again.", { exact: true })
      .waitFor();
    await page
      .locator(`.task-list [data-task-id="${ids.question.id}"]`)
      .waitFor();
    assert.equal(await stat(page, "Needs you"), "—");
    assert.equal(squash(await inboxLink.innerText()), "Open Inbox");
    assert.equal(await attention.getByText(/unresolved/).count(), 0);
  } finally {
    release();
    await page.unroute("**/api/operator/inbox**");
  }
  await attention
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await cards.first().waitFor();

  // A partial read says so and shows no total.
  await page.route("**/api/operator/inbox**", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.data.complete = false;
    await route.fulfill({ response, json: body });
  });
  try {
    await page.reload();
    await attention
      .getByText(
        "Queue coverage is incomplete. Unavailable requests may remain.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await stat(page, "Needs you"), "—");
    assert.equal(await attention.getByText(/unresolved/).count(), 0);
  } finally {
    await page.unroute("**/api/operator/inbox**");
  }

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app`);
  await cards.first().waitFor();
  assert.ok(await noPageOverflow(page));
  const action = await cards
    .first()
    .getByRole("link", { name: responseName })
    .boundingBox();
  assert.ok(action && action.height >= 44);
  await shot(page, "390-overview-attention");
});

test("the stat strip counts the installation and shows — until the task list loads", async (_t, journey) => {
  const { page } = await start(journey, "/app");
  await page.locator(".task-list .task-row").first().waitFor();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/operator/task-list**", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await page.reload();
    await page.locator(".overview-stats").waitFor();
    for (const name of ["Uncertain", "Active tasks", "Running turns"])
      assert.equal(await stat(page, name), "—", name);
  } finally {
    release();
    await page.unroute("**/api/operator/task-list**");
  }
  const rows = page.locator(".task-list .task-row");
  await rows.first().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".overview-stats dd")[2]?.textContent !== "—",
  );
  assert.equal(await stat(page, "Active tasks"), String(await rows.count()));
  assert.equal(
    await stat(page, "Uncertain"),
    String(
      await rows
        .filter({ hasText: "Execution ownership is uncertain" })
        .count(),
    ),
  );
  const meter = await page.locator(".capacity-meter .identifier").innerText();
  assert.equal(
    (await stat(page, "Running turns")).replace(/\s+/g, ""),
    meter.replace(/\s+/g, ""),
  );
  await page.setViewportSize(phone);
  // Phone: the strip is a 2 × 2 grid.
  const tops = await page
    .locator(".overview-stats > div")
    .evaluateAll((es) =>
      es.map((e) => Math.round(e.getBoundingClientRect().top)),
    );
  assert.equal(new Set(tops).size, 2, `two rows: ${tops}`);
  assert.ok(await noPageOverflow(page));
});

test("cards put uncertain interventions first, then the oldest, with exact approval facts and recorded evidence", async (_t, journey) => {
  const { f, page } = await startBare(journey, async (f) => {
    const intervention = await seedOwnIntervention(f);
    const approval = await seedOwnApproval(f);
    const question = await seedOwnQuestion(
      f,
      choiceForm,
      "Overview choice",
      "Overview project",
    );
    return { intervention, approval, question };
  });
  const { approval } = f.seeded;
  const cards = page.locator(".overview-card");
  await page.locator(".overview-card[data-kind='approval'] dl").waitFor();
  // The intervention leads; the rest keep the Inbox's oldest-first order.
  const inbox = await page.evaluate(() =>
    fetch("/api/operator/inbox").then((r) => r.json()),
  );
  assert.deepEqual(
    await cards.evaluateAll((es) =>
      es.map((e) => e.getAttribute("data-request-id")),
    ),
    inbox.data.items.map((i: { id: string }) => i.id),
  );
  assert.equal(await cards.first().getAttribute("data-kind"), "intervention");
  const approvalCard = page.locator(".overview-card[data-kind='approval']");
  const text = await approvalCard.innerText();
  assert.match(text, /Approval/);
  assert.ok(text.includes(approval.request.action), text);
  assert.ok(text.includes(approval.request.target), text);
  assert.match(text, /version \d+/);
  assert.equal(
    await approvalCard.getByRole("button", { name: /approve|deny/i }).count(),
    0,
  );
  assert.equal(
    await approvalCard
      .getByRole("link", { name: "Review material & decide" })
      .getAttribute("href"),
    `/app/tasks/${approval.taskId}?request=${approval.interactionId}`,
  );
  // The paused approval project holds execution; the card says approval does not clear it.
  await approvalCard.getByText(/Approval does not resume work/).waitFor();

  // A failed task read never reads as "no holds".
  await page.route(`**/api/operator/tasks/${approval.taskId}`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    }),
  );
  await page.reload();
  await approvalCard
    .getByText("Independent holds could not be read; they remain in effect.", {
      exact: true,
    })
    .waitFor();
  await approvalCard
    .getByRole("link", { name: "Review material & decide" })
    .waitFor();
  await page.unroute(`**/api/operator/tasks/${approval.taskId}`);

  const intervention = page.locator(".overview-card[data-kind='intervention']");
  const evidence = await intervention.innerText();
  assert.match(evidence, /Execution uncertain/);
  assert.match(evidence, / · lead|No lead configured/);
  assert.match(evidence, /Execution ownership is uncertain/);
  assert.match(evidence, /Ownership stays held/);
  assert.doesNotMatch(evidence, /observation|heartbeat/i);
  assert.equal(
    await intervention.getByRole("link", { name: "Inspect execution" }).count(),
    1,
  );
  assert.doesNotMatch(await mainText(page), uuidText);
  await shot(page, "1366-overview-card-kinds");
});

const approvalHold = "Execution held (approval needs a decision)";
/** Serves the task read with an `approval` wait linking these requests, as the server merges open approvals. */
const serveApprovalWait = (page: Page, taskId: string, ids: string[]) =>
  page.route(`**/api/operator/tasks/${taskId}`, async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as TaskRead;
    body.data.waits = [
      ...body.data.waits.filter((wait) => wait.code !== "approval"),
      {
        code: "approval",
        fix: null,
        links: ids.map((id) => ({
          kind: "request",
          id,
          label: "Review material & decide",
        })),
      },
    ];
    taskSchema.parse(body);
    await route.fulfill({ response, json: body });
  });

test("an Overview approval card lists another open approval as a hold, but not its own", async (_t, journey) => {
  const { f, page } = await startBare(journey, (f) => seedOwnApproval(f));
  const approval = f.seeded;
  const card = page.locator(".overview-card[data-kind='approval']");
  // Two open approvals on the task, one in view: the other still holds execution.
  await serveApprovalWait(page, approval.taskId, [
    approval.interactionId,
    randomUUID(),
  ]);
  await page.reload();
  await card.getByText(approvalHold, { exact: true }).waitFor();
  assert.equal(await card.getByText(approvalHold).count(), 1);
  // Only the card's own approval: not a hold on itself, while the project hold still lists.
  await page.unrouteAll();
  await serveApprovalWait(page, approval.taskId, [approval.interactionId]);
  await page.reload();
  await card.getByText(/Approval does not resume work/).waitFor();
  assert.equal(await card.getByText(approvalHold).count(), 0);
  await card.getByRole("link", { name: "Review material & decide" }).waitFor();
});

test("an Overview question card lists an open approval beside it as a hold", async (_t, journey) => {
  const { f, page } = await startBare(journey, (f) =>
    seedOwnQuestion(f, choiceForm, "Overview choice", "Overview project"),
  );
  const question = f.seeded;
  await serveApprovalWait(page, question.taskId, [randomUUID()]);
  await page.reload();
  const card = page.locator(
    `.overview-card[data-request-id="${question.interactionId}"]`,
  );
  await card.getByText(approvalHold, { exact: true }).waitFor();
  assert.doesNotMatch(await card.innerText(), /Approving/);
  await card
    .getByRole("button", { name: "Submit answer", exact: true })
    .waitFor();
});

test("a single-choice question is answered in its card with the Inbox's command and outcomes", async (_t, journey) => {
  const { f, page, web, posts } = await startBare(journey, async (f) => ({
    card: await seedOwnQuestion(
      f,
      choiceForm,
      "Overview choice",
      "Overview project",
    ),
    inbox: await seedOwnQuestion(
      f,
      choiceForm,
      "Inbox choice",
      "Inbox project",
    ),
    grouped: await seedOwnQuestion(
      f,
      guideForm,
      "Grouped guide",
      "Guide project",
    ),
  }));
  const { card: a, inbox: b, grouped } = f.seeded;
  const cardOf = (id: string) =>
    page.locator(`.overview-card[data-request-id="${id}"]`);
  const inline = cardOf(a.interactionId);
  await inline.getByRole("radio", { name: /Every new member/ }).waitFor();
  await inline.getByRole("radio", { name: /Team owners/ }).waitFor();
  await inline.getByText("Separate owner setup.", { exact: true }).waitFor();
  await inline
    .getByRole("button", { name: "Submit answer", exact: true })
    .waitFor();
  assert.match(await inline.innerText(), /Choose the guide's audience/);
  assert.equal(
    await inline.getByRole("link", { name: "Answer question" }).count(),
    0,
  );
  const guide = cardOf(grouped.interactionId);
  await guide
    .getByRole("link", { name: "Answer question", exact: true })
    .waitFor();
  assert.equal(await guide.getByRole("radio").count(), 0);
  await shot(page, "1366-overview-inline-question");

  // A failed gate read falls back to the Inbox link.
  await page.route(`**/questions/${a.interactionId}`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    }),
  );
  await page.reload();
  await inline
    .getByRole("link", { name: "Answer question", exact: true })
    .waitFor();
  assert.equal(await inline.getByRole("radio").count(), 0);
  await page.unroute(`**/questions/${a.interactionId}`);
  await page.reload();
  const submit = inline.getByRole("button", {
    name: "Submit answer",
    exact: true,
  });
  await submit.waitFor();

  // Validation is the shared form's: an error beside the question, focus on it, nothing sent.
  await submit.click();
  await inline.locator("fieldset [role=alert]").waitFor();
  const focused = await page.evaluate(() => ({
    id: document.activeElement?.getAttribute("data-question-id"),
    html: document.activeElement?.outerHTML.slice(0, 200),
  }));
  assert.equal(focused.id, "choice", String(focused.html));
  assert.equal(posts.length, 0);

  // Drafts are shared with the Inbox: a choice in the card is selected there too.
  await cardOf(b.interactionId)
    .getByRole("radio", { name: /Team owners/ })
    .check();
  // In-app navigation: drafts live in this tab's session, not across a reload.
  await page.locator('.sidebar a[href="/app/inbox"]').click();
  await page.locator(".inbox-row").filter({ hasText: "Inbox choice" }).click();
  const inboxForm = page.locator(".inbox-detail");
  await inboxForm.getByRole("radio", { name: /Team owners/ }).waitFor();
  assert.equal(
    await inboxForm.getByRole("radio", { name: /Team owners/ }).isChecked(),
    true,
  );
  await inboxForm
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await inboxForm
    .getByText("Answer sent. It reaches the requester on its next turn.", {
      exact: true,
    })
    .waitFor();
  const inboxCommand = posts.at(-1)!;

  // Refused, then unconfirmed, then checked: the card keeps the choice and its outcomes.
  await page.goto(`${web.origin}/app`);
  await inline.getByRole("radio", { name: /Every new member/ }).check();
  const before = Number(await stat(page, "Needs you"));
  await page.route("**/api/operator/commands", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "invalid-input", message: "Rejected fixture" },
      }),
    }),
  );
  await submit.click();
  await inline
    .getByText(
      "Couldn't send the answer: the service didn't accept it. Your answer is still here.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await inline.getByRole("radio", { name: /Every new member/ }).isChecked(),
    true,
  );
  await page.unroute("**/api/operator/commands");
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await inline
    .getByRole("button", { name: "Retry answer", exact: true })
    .click();
  await inline
    .getByText(
      "We couldn't confirm your answer was sent. Your answer is kept until you check.",
      { exact: true },
    )
    .waitFor();
  await page.unroute("**/api/operator/commands");
  await inline
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await inline
    .getByText("Answer sent. It reaches the requester on its next turn.", {
      exact: true,
    })
    .waitFor();
  const cardCommand = posts.at(-1)!;
  for (const command of [cardCommand, inboxCommand]) {
    assert.equal(typeof command.expectedRevision, "number");
    assert.match(String(command.key), uuidText);
  }
  assert.equal(cardCommand.type, inboxCommand.type);
  assert.deepEqual(
    Object.keys(cardCommand.answers as object),
    Object.keys(inboxCommand.answers as object),
  );
  for (const id of [a.taskId, b.taskId])
    assert.notEqual(
      f.service.coordinationView().readTask(id).questions[0]?.status,
      "open",
    );

  // The confirmation stays in its card while the refreshed Inbox drops the request.
  await page.waitForFunction(
    (n) => document.querySelector(".overview-stats dd")?.textContent === n,
    String(before - 1),
  );
  await inline
    .getByText("Answer sent. It reaches the requester on its next turn.", {
      exact: true,
    })
    .waitFor();
  await inline.getByText(/does not resume execution/).waitFor();
  assert.ok(
    [null, a.interactionId].includes(
      await page.evaluate(
        () =>
          document.activeElement
            ?.closest(".overview-card")
            ?.getAttribute("data-request-id") ?? null,
      ),
    ),
    "no other card takes focus",
  );
  await shot(page, "1366-overview-answer-recorded");
  await page.reload();
  await guide.waitFor();
  assert.equal(await inline.count(), 0);
});

test("overview work sits in a panel beside Projects and Completed work and stacks on a phone", async (_t, journey) => {
  const { ids, web, page, commands } = await start(journey, "/app");
  const work = page.getByRole("region", {
    name: "Across your projects",
    exact: true,
  });
  await work.locator(".task-row").first().waitFor();
  const labels = work.locator(".overview-columns");
  assert.equal(await labels.getAttribute("aria-hidden"), "true");
  assert.deepEqual((await labels.innerText()).split(/\s+/).filter(Boolean), [
    "Task",
    "State",
    "Next",
    "Lead",
  ]);
  const tops = await Promise.all(
    [
      work.getByRole("combobox", { name: "Project", exact: true }),
      work.getByRole("combobox", { name: "State", exact: true }),
      work.getByRole("button", { name: "List", exact: true }),
      work.getByRole("button", { name: "Board", exact: true }),
    ].map((c) => c.evaluate((e) => e.getBoundingClientRect().top)),
  );
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, `one row: ${tops}`);

  // Next: you is amber; other next actors are not.
  const operator = work.locator('.task-next[data-operator="true"]');
  assert.ok((await operator.count()) > 0);
  for (const text of await operator.allInnerTexts())
    assert.match(text, /^Next: you · /);
  const colour = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((e) => getComputedStyle(e).color);
  const attn = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--attn)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  assert.equal(await colour('.task-next[data-operator="true"]'), attn);

  const projects = page.getByRole("region", { name: "Projects", exact: true });
  const links = projects.getByRole("link");
  assert.equal(await links.count(), 2);
  const service = links.filter({ hasText: "Service integration" });
  assert.equal(
    await service.getAttribute("href"),
    `/app/projects/${ids.projectId}`,
  );
  const serviceText = await service.innerText();
  assert.match(serviceText, /Lead · Accountable lead/);
  assert.match(serviceText, /1 from GitHub/);
  assert.match(serviceText, /^\d+ uncertain( · \d+ \w+)*$/m);
  const paused = await links.filter({ hasText: "Paused project" }).innerText();
  assert.match(paused, /Project paused/);
  assert.match(paused, /No imported tasks/);
  assert.doesNotMatch(await projects.innerText(), /sync|Question|Approval/i);

  const completed = page.getByRole("region", {
    name: "Completed work",
    exact: true,
  });
  assert.equal(
    await completed
      .getByRole("link", { name: "Completed result", exact: true })
      .getAttribute("href"),
    `/app/tasks/${ids.done}`,
  );
  // Beside the work panel at the desktop review width.
  const [panel, side] = await Promise.all(
    [work, page.locator(".overview-side")].map((l) => l.boundingBox()),
  );
  assert.ok(panel && side && side.x >= panel.x + panel.width - 1);
  await shot(page, "1366-overview");

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.locator(".board-columns").waitFor();
  assert.equal(commands(), 0);

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app?view=list`);
  await work.locator(".task-row").first().waitFor();
  assert.ok(await noPageOverflow(page));
  assert.equal(await labels.isVisible(), false);
  const [stackedPanel, stackedSide] = await Promise.all(
    [work, page.locator(".overview-side")].map((l) => l.boundingBox()),
  );
  assert.ok(
    stackedPanel &&
      stackedSide &&
      stackedSide.y >= stackedPanel.y + stackedPanel.height - 1,
  );
  const heights = await page
    .locator(".work-toolbar button, .work-toolbar select")
    .evaluateAll((es) =>
      es.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
  assert.ok(
    heights.length >= 4 && heights.every((h) => h >= 44),
    `touch targets ${heights}`,
  );
  await shot(page, "390-overview");
});

test("overview without requests or completed work says so and omits the completed line", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  // Home is only the getting-started card until a task has started a turn.
  const projectId = addProject(f, "Quiet project", addProfile(f));
  addTask(f, projectId, "Quiet draft");
  await startFirstTurn(f, projectId, addTask(f, projectId, "Quiet runner"));
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: desktop });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  // The Draft task is not Ready, which the default readiness hides.
  await page.goto(`${web.origin}/app?ready=any`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByText("Nothing needs your attention.", { exact: true })
    .waitFor();
  await page.getByText("Quiet draft", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("region", { name: "Completed work" }).count(),
    0,
  );
});

/** The column sits inside the board's own scroll area. */
const inBoard = (page: Page, column: string) =>
  page.waitForFunction((id) => {
    const board = document
        .querySelector(".board-columns")!
        .getBoundingClientRect(),
      area = document.getElementById(id)!.getBoundingClientRect();
    return area.left >= board.left - 1 && area.right <= board.right + 1;
  }, `column-${column}`);

test("board headings show every count, with collapsed empty columns and drawn cards", async (_t, journey) => {
  const { ids, web, page, commands } = await start(
    journey,
    "/app/tasks?view=board&state=all",
  );
  const bar = page.getByRole("toolbar", { name: "Board columns" });
  await page.locator(".board-column").first().waitFor();
  const counts = new Map<string, number>();
  for (const section of await page.locator(".board-column").all()) {
    const column = (await section.getAttribute("id"))!.slice("column-".length);
    const count = Number(
      await section.locator(".board-column-count").innerText(),
    );
    assert.equal(
      await section.locator("[data-task-id]").count(),
      count,
      column,
    );
    counts.set(column, count);
  }
  assert.deepEqual(
    [...counts.keys()],
    [
      "Ready",
      "Running",
      "Waiting",
      "Paused",
      "Stopping",
      "Uncertain",
      "Not started",
      "Draft",
      "Done",
      "Cancelled",
    ],
  );
  const widths = await page
    .locator(".board-column")
    .evaluateAll((es) =>
      es.map(
        (e) =>
          [
            e.getAttribute("data-empty"),
            e.getBoundingClientRect().width,
          ] as const,
      ),
    );
  for (const [empty, width] of widths)
    assert.ok(
      empty ? width >= 40 && width <= 60 : width >= 140,
      `${empty} ${width}`,
    );
  const populated = widths.filter(([empty]) => !empty).map(([, w]) => w);
  assert.ok(Math.max(...populated) - Math.min(...populated) <= 1, "equal");
  await shot(page, "1366-board");

  // Tab reaches a card in an off-screen column and scrolls only the board to it.
  await page.locator("#column-Uncertain").getByRole("link").first().focus();
  await inBoard(page, "Uncertain");
  await shot(page, "1366-board-later");

  const card = page.locator(`[data-task-id="${ids.question.id}"]`);
  assert.match(
    (await card
      .getByRole("link", { name: "Answer question" })
      .getAttribute("href")) ?? "",
    /^\/app\/inbox\?task=/,
  );
  const source = page
    .locator(`[data-task-id="${ids.importedId}"]`)
    .getByRole("link", { name: /fixture\/source#42/ });
  assert.equal(await source.getAttribute("target"), "_blank");
  assert.match((await source.getAttribute("rel")) ?? "", /noopener/);
  assert.match(await source.innerText(), /opens GitHub/);
  assert.equal(
    await card
      .locator(".task-card")
      .evaluate((e) => getComputedStyle(e).padding),
    "10px",
  );
  assert.doesNotMatch(await mainText(page), uuidText);

  // Keyboard: Tab reaches a card's title and Enter opens the task; Back restores the column.
  await card
    .getByRole("link", { name: "Question requiring action", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.pathname === `/app/tasks/${ids.question.id}`);
  await page.goBack();
  await inBoard(page, "Uncertain");

  // A failed Inbox read keeps the reasons and drops the action link.
  await page.route("**/api/operator/inbox**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    }),
  );
  try {
    await page.reload();
    await card.waitFor();
    await card.getByText("Question needs an answer", { exact: true }).waitFor();
    assert.equal(
      await card.getByRole("link", { name: "Answer question" }).count(),
      0,
    );
  } finally {
    await page.unroute("**/api/operator/inbox**");
  }

  // Active tasks with only Done added shows the terminal column the filter names.
  await page.goto(`${web.origin}/app/tasks?view=board&state=Done&ready=any`);
  await page.locator(".board-column").first().waitFor();
  assert.equal(await page.locator(".board-column").count(), 9);
  assert.equal(
    await page.locator("#column-Done .board-column-count").innerText(),
    "1",
  );
  // The filtered column is on screen without a tab click, and the page itself did not scroll.
  await page.waitForFunction(() => {
    const area = document
        .querySelector(".board-columns")!
        .getBoundingClientRect(),
      column = document.querySelector("#column-Done")!.getBoundingClientRect();
    return column.left >= area.left - 1 && column.right <= area.right + 1;
  });
  assert.equal(await page.evaluate(() => scrollY), 0);
  // Nothing but Done matches, so every other column is empty and collapsed.
  const empties = await page
    .locator(".board-column")
    .evaluateAll((es) =>
      es.map(
        (e) =>
          [
            e.id,
            e.getAttribute("data-empty"),
            e.getBoundingClientRect().width,
          ] as const,
      ),
    );
  assert.equal(empties.length, 9);
  for (const [id, empty, width] of empties)
    if (id === "column-Done") assert.equal(empty, null);
    else {
      assert.equal(empty, "true", id);
      assert.ok(width <= 60, `${id} collapses to ${width}px`);
    }
  assert.equal(
    await page.locator("#column-Ready p").innerText(),
    "None ready. Held Ready work is in Waiting.",
  );
  assert.equal(await page.locator("#column-Paused p").innerText(), "No tasks");
  await shot(page, "1366-board-collapsed-empty");
  assert.equal(commands(), 0);

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?view=board&state=all&ready=any`);
  await bar.waitFor();
  assert.ok(await noPageOverflow(page));
  const tabs = await bar
    .getByRole("button")
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect()));
  assert.ok(tabs.every((r) => r.height >= 44));
  assert.equal(
    new Set(tabs.map((r) => Math.round(r.top))).size,
    1,
    "10 tabs share one scrolling row",
  );
  await bar.getByRole("button", { name: /^Waiting · / }).click();
  assert.equal(await bar.locator('[aria-pressed="true"]').count(), 1);
  assert.deepEqual(
    await page
      .locator(".board-column")
      .evaluateAll((es) =>
        es
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.id),
      ),
    ["column-Waiting"],
  );
  const next = page.getByRole("button", { name: "Next column: Paused" }),
    previous = page.getByRole("button", { name: "Previous column: Running" });
  assert.equal(await next.innerText(), "Paused →");
  assert.equal(await previous.innerText(), "← Running");
  await shot(page, "390-board-waiting");
  await next.click();
  assert.equal(
    await bar
      .getByRole("button", { name: /^Paused · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Previous column: Waiting" }).click();
  assert.equal(
    await bar
      .getByRole("button", { name: /^Waiting · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  await bar.getByRole("button", { name: /^Ready · / }).click();
  const first = page.getByRole("button", { name: /^Previous column/ });
  assert.equal(await first.isDisabled(), true);
  assert.equal(await first.innerText(), "1 of 10");
  await bar.getByRole("button", { name: /^Cancelled · / }).click();
  const last = page.getByRole("button", { name: /^Next column/ });
  assert.equal(await last.isDisabled(), true);
  assert.equal(await last.innerText(), "10 of 10");
  await bar.getByRole("button", { name: /^Uncertain · / }).click();
  await shot(page, "390-board-uncertain");

  // Choosing a State on an open Board selects that column without a reload; with the
  // same filter the operator's own tab choice stays.
  const visible = () =>
    page
      .locator(".board-column")
      .evaluateAll((es) =>
        es
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.id),
      );
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("Waiting");
  await page.waitForURL((u) => u.searchParams.get("state") === "Waiting");
  assert.deepEqual(await visible(), ["column-Waiting"]);
  assert.equal(
    await bar
      .getByRole("button", { name: /^Waiting · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  await bar.getByRole("button", { name: /^Draft · / }).click();
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption(ids.projectId);
  await page.waitForURL((u) => u.searchParams.get("project") === ids.projectId);
  assert.deepEqual(await visible(), ["column-Draft"]);
});

/** What `property: value` computes to on a probe element, e.g. a token's colour. */
const resolved = (page: Page, property: string, value: string) =>
  page.evaluate(
    ([property, value]) => {
      const probe = document.createElement("span");
      probe.style.setProperty(property, value);
      probe.style.borderStyle = "solid";
      document.body.append(probe);
      const result = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return result;
    },
    [property, value] as const,
  );
const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate(
      (e, property) => getComputedStyle(e).getPropertyValue(property),
      property,
    );

test("board cards follow the frame's anatomy", async (_t, journey) => {
  const { ids, page, commands } = await start(journey, "/app/tasks?view=board");
  const card = (id: string) => `[data-task-id="${id}"]`;
  await page.locator(card(ids.question.id)).waitFor();
  await page
    .locator(card(ids.question.id))
    .getByRole("link", { name: "Answer question" })
    .waitFor();
  const lines = (await page.locator(card(ids.question.id)).innerText())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.deepEqual(lines, [
    "Question requiring action",
    "Service integration · Local task",
    "Question needs an answer",
    "Next: you · answer question",
    "Accountable lead · accountable lead",
    "Answer question →",
  ]);
  // Capacity is stated once for the board; a card nobody must act on has no Next line.
  assert.equal(await page.getByText(/Capacity is full/).count(), 1);
  assert.equal(await page.locator(".work-capacity").count(), 1);
  assert.equal(
    await page.locator(`${card(ids.running.id)} .task-next`).count(),
    0,
  );
  const [lead, response] = await Promise.all(
    [".task-card-footer .task-lead", ".task-card-footer .task-request"].map(
      (s) => page.locator(`${card(ids.question.id)} ${s}`).boundingBox(),
    ),
  );
  // The lead leads the footer; a narrow card wraps the response below it.
  assert.ok(
    lead &&
      response &&
      (lead.x + lead.width <= response.x || lead.y + lead.height <= response.y),
  );
  assert.match(
    (await page
      .locator(`${card(ids.question.id)} .task-request`)
      .getAttribute("href")) ?? "",
    /^\/app\/inbox\?task=/,
  );
  assert.equal(
    await page.locator(`${card(ids.question.id)} .task-status`).count(),
    0,
  );
  assert.equal(
    await style(page, `${card(ids.question.id)} .task-next`, "color"),
    await resolved(page, "color", "var(--attn)"),
  );
  const border = (id: string) =>
    style(page, `${card(id)} .task-card`, "border-top-color");
  assert.equal(
    await border(ids.question.id),
    await resolved(page, "border-top-color", "var(--attn-border)"),
  );
  assert.equal(
    await border(ids.uncertainStop.id),
    await resolved(page, "border-top-color", "var(--risk-border)"),
  );
  assert.equal(
    await border(ids.running.id),
    await resolved(page, "border-top-color", "var(--line-strong)"),
  );

  // Ready-but-blocked work keeps its Ready label in Waiting; nothing else repeats its column.
  const chip = page.locator(
    `#column-Waiting ${card(ids.waiting)} .task-state[data-column="Ready"]`,
  );
  assert.equal(await chip.innerText(), "Ready");
  assert.equal(await chip.locator("svg").count(), 1);
  for (const id of [ids.ready, ids.running.id])
    assert.equal(await page.locator(`${card(id)} .task-state`).count(), 0);
  const uncertainChip = page.locator(
    `${card(ids.uncertain.id)} .task-state[data-column="Uncertain"]`,
  );
  assert.equal(await uncertainChip.isVisible(), false);

  // Each heading: symbol, the column word and a mono count of its cards.
  for (const section of await page
    .locator('.board-column:not([data-empty="true"])')
    .all()) {
    const heading = section.locator(".board-column-heading");
    const column = (await section.getAttribute("id"))!.slice("column-".length);
    assert.equal(
      await heading.locator(".board-column-name").innerText(),
      column,
    );
    assert.equal(await heading.locator("svg").count(), 1, column);
    assert.equal(
      Number(await heading.locator(".board-column-count").innerText()),
      await section.locator("[data-task-id]").count(),
      column,
    );
    assert.match(
      await style(page, `#column-${column} .board-column-count`, "font-family"),
      /Geist Mono/,
    );
  }
  assert.equal(
    await style(page, "#column-Running .board-column-name", "color"),
    await resolved(page, "color", "var(--run)"),
  );
  assert.equal(
    await style(page, "#column-Uncertain .board-column-name", "color"),
    await resolved(page, "color", "var(--risk)"),
  );
  assert.equal(
    await style(page, "#column-Uncertain", "border-top-color"),
    await resolved(page, "border-top-color", "var(--risk-border)"),
  );

  // Imported identity in mono, opening GitHub in a new tab.
  const source = page
    .locator(card(ids.importedId))
    .getByRole("link", { name: /fixture\/source#42/ });
  assert.match(
    await source.evaluate((e) => getComputedStyle(e).fontFamily),
    /Geist Mono/,
  );
  assert.equal(await source.getAttribute("target"), "_blank");
  assert.match((await source.getAttribute("rel")) ?? "", /noopener/);
  assert.match(await source.innerText(), /opens GitHub/);
  await shot(page, "1366-board-cards");

  // One column at a time on a phone, so the Uncertain card names its state.
  await page.setViewportSize(phone);
  await page
    .getByRole("toolbar", { name: "Board columns" })
    .getByRole("button", { name: /^Uncertain · / })
    .click();
  assert.equal(await uncertainChip.isVisible(), true);
  assert.equal(await uncertainChip.innerText(), "Uncertain");
  assert.equal(commands(), 0);
});

test("board columns share one 1366 screen, collapse to rails and scroll only inside the board", async (_t, journey) => {
  const { ids, web, page, commands } = await start(
    journey,
    "/app/tasks?view=board",
  );
  const bar = page.getByRole("toolbar", { name: "Board columns" });
  await page.locator(`[data-task-id="${ids.question.id}"]`).waitFor();
  const layout = () =>
    page.evaluate(() => {
      const board = document.querySelector<HTMLElement>(".board-columns")!,
        b = board.getBoundingClientRect();
      return {
        scrollWidth: board.scrollWidth,
        clientWidth: board.clientWidth,
        columns: [...board.querySelectorAll<HTMLElement>(".board-column")].map(
          (c) => {
            const r = c.getBoundingClientRect();
            return {
              id: c.id,
              empty: c.dataset.empty === "true",
              width: r.width,
              inside: r.left >= b.left - 1 && r.right <= b.right + 1,
            };
          },
        ),
      };
    });

  // (a) Seven populated Active columns, equal and all on one screen, beside the empty
  // Not started rail.
  const one = await layout();
  assert.equal(one.columns.length, 8);
  assert.deepEqual(
    one.columns.filter((c) => c.empty).map((c) => c.id),
    ["column-Not started"],
  );
  const populated = one.columns.filter((c) => !c.empty);
  assert.ok(one.columns.every((c) => c.inside));
  assert.ok(populated.every((c) => c.width >= 140));
  const widths = populated.map((c) => c.width);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `${widths}`);
  assert.ok(one.scrollWidth <= one.clientWidth, "board does not scroll");
  assert.ok(await noPageOverflow(page));
  assert.equal(await page.evaluate(() => scrollX), 0);
  await shot(page, "1366-board-all-columns");

  // (b) Ten columns overflow into the board, never the page; Back restores its scroll.
  await page.goto(`${web.origin}/app/tasks?view=board&state=all&ready=any`);
  await page.locator(".board-column").first().waitFor();
  const all = await layout();
  assert.equal(all.columns.length, 10);
  assert.ok(all.scrollWidth > all.clientWidth);
  assert.ok(await noPageOverflow(page));
  const scrolled = await page
    .locator(".board-columns")
    .evaluate(async (board) => {
      board.scrollLeft = board.scrollWidth;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      return board.scrollLeft;
    });
  assert.ok(scrolled > 0);
  await page.waitForFunction(
    (left) => history.state?.board?.scrollLeft === left,
    scrolled,
  );
  const title = page.getByRole("link", { name: "Cancelled work", exact: true });
  await title.click();
  await page.waitForURL((u) => u.pathname.startsWith("/app/tasks/"));
  await page.goBack();
  await page.locator(".board-column").first().waitFor();
  await page.waitForFunction(
    (left) => document.querySelector(".board-columns")?.scrollLeft === left,
    scrolled,
  );
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Cancelled work",
  );

  // (c) Every empty column is a labelled vertical rail that does not clip its text.
  await page.goto(`${web.origin}/app/tasks?view=board&state=Done&ready=any`);
  await page.locator(".board-column").first().waitFor();
  const rails = await page.locator(".board-column").evaluateAll((es) =>
    es.map((e) => ({
      id: e.id,
      empty: e.getAttribute("data-empty") === "true",
      width: e.getBoundingClientRect().width,
      count: e.querySelector(".board-column-count")?.checkVisibility(),
      vertical: getComputedStyle(e.querySelector(".board-column-name")!)
        .writingMode,
      clipped: e.scrollHeight > e.clientHeight + 1,
    })),
  );
  assert.equal(rails.filter((r) => r.empty).length, 8);
  for (const rail of rails)
    if (rail.empty) {
      assert.ok(rail.width >= 40 && rail.width <= 60, JSON.stringify(rail));
      assert.equal(rail.vertical, "vertical-rl", rail.id);
      assert.equal(rail.count, true, rail.id);
      assert.equal(rail.clipped, false, rail.id);
    } else assert.ok(rail.id === "column-Done" && rail.width > 500);
  assert.equal(
    await page.locator("#column-Ready p").innerText(),
    "None ready. Held Ready work is in Waiting.",
  );
  assert.equal(await page.locator("#column-Paused p").innerText(), "No tasks");
  await shot(page, "1366-board-rails");

  // (d) Tablet: the board scrolls inside itself and the link bar reaches Uncertain.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${web.origin}/app/tasks?view=board&ready=any`);
  await bar.waitFor();
  const tablet = await layout();
  assert.ok(tablet.scrollWidth > tablet.clientWidth);
  assert.ok(await noPageOverflow(page));
  await bar.getByRole("button", { name: /^Uncertain · 1$/ }).click();
  await page.waitForFunction(() => {
    const board = document
        .querySelector(".board-columns")!
        .getBoundingClientRect(),
      column = document
        .querySelector("#column-Uncertain")!
        .getBoundingClientRect();
    return column.left >= board.left - 1 && column.right <= board.right + 1;
  });
  // Tabs transition their colours; capture the settled selection.
  const settled = () =>
    page.waitForFunction(() => document.getAnimations().length === 0);
  await settled();
  await shot(page, "1024-board");

  // (e) Phone: selected tab and Uncertain tones, 44px targets and the footer sentence.
  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?view=board&ready=any`);
  await bar.waitFor();
  await bar.getByRole("button", { name: /^Waiting · / }).click();
  // Buttons transition their colours, so wait for the settled value.
  const settles = async (property: string, token: string) => {
    const want = await resolved(page, property, token);
    await page.waitForFunction(
      ([property, want]) =>
        getComputedStyle(
          document.querySelector('.column-tab[aria-pressed="true"]')!,
        ).getPropertyValue(property) === want,
      [property, want] as const,
    );
  };
  await settles("background-color", "var(--overlay)");
  await settles("border-top-color", "var(--accent-border)");
  assert.equal(
    await bar
      .getByRole("button", { name: /^Uncertain · 1$/ })
      .evaluate((e) => getComputedStyle(e).color),
    await resolved(page, "color", "var(--risk)"),
  );
  const targets = await page
    .locator(".column-tab, .phone-column-controls button")
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    targets.every((h) => h >= 44),
    `${targets}`,
  );
  assert.equal(
    squash(await page.locator(".board-footer").innerText()),
    "Columns describe cab work, not GitHub issue state. Cards open the task; nothing here changes state, and there is no drag and drop.",
  );
  assert.ok(await noPageOverflow(page));
  await shot(page, "390-board-waiting-tabs");
  await bar.getByRole("button", { name: /^Uncertain · 1$/ }).click();
  await page
    .locator(`[data-task-id="${ids.uncertain.id}"] .task-state`)
    .getByText("Uncertain")
    .waitFor();
  await settled();
  await shot(page, "390-board-uncertain-chip");

  // (f) Overview's Board sits in its work panel and keeps the List's task IDs.
  await page.setViewportSize(desktop);
  await page.goto(`${web.origin}/app?view=board&ready=any`);
  await page.locator(".overview-panel .board-columns").waitFor();
  await page.locator(".overview-panel .task-card").first().waitFor();
  assert.ok(await noPageOverflow(page));
  const board = await taskIds(page, ".overview-panel .board-columns");
  await page.goto(`${web.origin}/app?view=list&ready=any`);
  await page.locator(".overview-panel .task-row").first().waitFor();
  assert.deepEqual(await taskIds(page, ".overview-panel .task-list"), board);
  assert.equal(commands(), 0);
});

test("the board column chips render only below the shell breakpoint", async (_t, journey) => {
  const { web, page, commands } = await start(
    journey,
    "/app/tasks?view=board&state=all",
  );
  const bar = page.getByRole("toolbar", { name: "Board columns" });
  const cardCount = () => page.locator(".board-columns [data-task-id]").count();
  // A fresh load, so Tab below starts from the top of the page.
  await page.goto(`${web.origin}/app/tasks?view=board&state=all&ready=any`);
  await page.locator(".board-column").first().waitFor();
  const cards = await cardCount();

  // (a) From 1121px the chips are out of the accessibility tree and the Tab order, while
  // Tab still reaches a card in an off-screen column and only the board scrolls to it.
  assert.equal(page.viewportSize()?.width, 1366);
  assert.equal(await bar.count(), 0);
  assert.equal(await style(page, ".column-navigation", "display"), "none");
  const reached: string[] = [];
  for (let presses = 0; presses < 150; presses++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => ({
      chip: !!document.activeElement?.closest(".column-navigation"),
      text: document.activeElement?.textContent ?? "",
    }));
    assert.equal(at.chip, false, "Tab never lands on a column chip");
    reached.push(at.text);
    if (at.text === "Cancelled work") break;
  }
  assert.equal(reached.at(-1), "Cancelled work", "Tab reaches the last column");
  await inBoard(page, "Cancelled");
  assert.ok(await noPageOverflow(page));
  assert.equal(await page.evaluate(() => scrollX), 0);

  // (b) Below the breakpoint the chips are back, with every column's count.
  await page.setViewportSize({ width: 1120, height: 800 });
  await bar.waitFor({ state: "visible" });
  const headings = await page
    .locator(".board-column")
    .evaluateAll((es) =>
      es.map(
        (e) =>
          `${e.querySelector(".board-column-name")?.textContent?.trim()} · ${e.querySelector(".board-column-count")?.textContent?.trim()}`,
      ),
    );
  assert.equal(headings.length, 10);
  assert.deepEqual(
    (await bar.getByRole("button").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    ),
    headings,
  );
  await bar.getByRole("button", { name: "Uncertain · 1", exact: true }).click();
  const uncertain = bar.getByRole("button", { name: "Uncertain · 1" });
  assert.equal(await uncertain.getAttribute("aria-pressed"), "true");

  // (c) Widening to the breakpoint hides them again without losing the board.
  for (const width of [1121, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await bar.waitFor({ state: "detached" });
    assert.equal(await cardCount(), cards, `${width}px`);
  }

  // (d) Narrowing to the phone restores the operator's selection.
  await page.setViewportSize({ width: 390, height: 844 });
  await bar.waitFor({ state: "visible" });
  assert.equal(await uncertain.getAttribute("aria-pressed"), "true");
  assert.deepEqual(
    await page
      .locator(".board-column")
      .evaluateAll((es) =>
        es
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.id),
      ),
    ["column-Uncertain"],
  );

  // (e) Beside the sidebar, seven Active columns overflow the board: Tab still reaches Uncertain.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${web.origin}/app/tasks?view=board&ready=any`);
  await page.locator(".board-column").first().waitFor();
  assert.equal(await bar.count(), 0);
  await page
    .getByRole("link", { name: "Uncertain execution", exact: true })
    .focus();
  await page.waitForFunction(() => {
    const board = document
      .querySelector(".board-columns")!
      .getBoundingClientRect();
    const link = document.activeElement!.getBoundingClientRect();
    return link.left >= board.left - 1 && link.left < board.right;
  });
  assert.ok(await noPageOverflow(page));
  assert.equal(commands(), 0);
});

test("phone board keeps filters and column chips in one horizontal row with the first card on screen", async (_t, journey) => {
  const { f, ids, web, page, commands } = await start(
    journey,
    "/app/tasks?view=board&state=all",
  );
  // A long project name must truncate in the Project select, not widen the row.
  f.service.domain().execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId: randomUUID(),
    name: "Customer onboarding and billing reconciliation platform 2026",
    leadProfileId: ids.profileId,
  });
  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?view=board&state=all&ready=any`);
  const bar = page.getByRole("toolbar", { name: "Board columns" }),
    state = page.getByRole("combobox", { name: "State", exact: true }),
    project = page.getByRole("combobox", { name: "Project", exact: true }),
    row = page.locator(".work-filters"),
    refresh = page.getByRole("button", { name: "Refresh tasks", exact: true });
  await bar.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const inRow = async (name: string | RegExp) => {
    const chip = bar.getByRole("button", { name }),
      [r, c] = await Promise.all([
        row.evaluate((e) => e.getBoundingClientRect().toJSON()),
        chip.evaluate((e) => e.getBoundingClientRect().toJSON()),
      ]);
    return c.left >= r.left - 1 && c.right <= r.right + 1;
  };

  // (1) One row: both selects and every chip share a top, the row scrolls, the page does not.
  const tops = await Promise.all(
    [project, state, bar.getByRole("button")].map((l) =>
      l.evaluateAll((es) => es.map((e) => e.getBoundingClientRect().top)),
    ),
  ).then((groups) => groups.flat());
  assert.ok(tops.length >= 9, `selects and chips: ${tops.length}`);
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `one row: ${tops}`);
  // Left to right: Project, State, then the chips, which is also the Tab order.
  const [pr, sr, cr] = await Promise.all(
    [project, state, bar.getByRole("button").first()].map((l) =>
      l.evaluate((e) => e.getBoundingClientRect().toJSON()),
    ),
  );
  assert.ok(pr.right <= sr.left + 1 && sr.right <= cr.left + 1, "order");
  assert.ok(pr.width <= 200, `Project select truncates: ${pr.width}`);
  const scroller = await row.evaluate((e) => ({
    overflowX: getComputedStyle(e).overflowX,
    scrolls: e.scrollWidth > e.clientWidth,
  }));
  assert.deepEqual(scroller, { overflowX: "auto", scrolls: true });
  assert.ok(await noPageOverflow(page));

  // (2) The first card is on the first screen.
  await bar.getByRole("button", { name: /^Waiting · / }).click();
  const title = page.locator(
    ".board-columns .selected-column [data-task-id] .task-title",
  );
  assert.ok((await title.count()) >= 1, "the Waiting column holds a card");
  assert.ok(
    (await title.first().evaluate((e) => e.getBoundingClientRect().bottom)) <=
      844,
  );

  // (3) The pressed chip is fully visible, and the switch and Refresh share the next line.
  const waiting = bar.getByRole("button", { name: /^Waiting · / });
  assert.equal(await waiting.getAttribute("aria-pressed"), "true");
  assert.ok(await inRow(/^Waiting · /));
  const second = await Promise.all(
    [
      page.getByRole("button", { name: "List", exact: true }),
      page.getByRole("button", { name: "Board", exact: true }),
      refresh,
    ].map((c) => c.evaluate((e) => e.getBoundingClientRect().top)),
  );
  assert.ok(Math.max(...second) - Math.min(...second) <= 1, `${second}`);
  assert.ok(Math.min(...second) > Math.max(...tops));

  // (4) The last chip can be chosen and stays fully visible.
  await bar.getByRole("button", { name: "Cancelled · 1", exact: true }).click();
  const last = bar.getByRole("button", { name: "Cancelled · 1" });
  assert.equal(await last.getAttribute("aria-pressed"), "true");
  assert.ok(await inRow("Cancelled · 1"));
  assert.ok(await noPageOverflow(page));
  assert.equal(
    await page
      .locator(`.selected-column [data-task-id="${ids.cancelled}"]`)
      .count(),
    1,
  );

  // (5) Crossing the 759/760 boundary moves the chips, never duplicates them or loses the column.
  for (const [width, inToolbar] of [
    [760, false],
    [759, true],
    [761, false],
    [390, true],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(
      ([want]) =>
        document.querySelectorAll(".work-filters .column-navigation").length ===
        (want ? 1 : 0),
      [inToolbar] as const,
    );
    assert.equal(await bar.count(), 1, `${width}px`);
    assert.equal(await refresh.count(), 1, `${width}px`);
    assert.equal(
      await page.locator(".task-board > .column-navigation").count(),
      inToolbar ? 0 : 1,
      `${width}px`,
    );
    assert.equal(
      await bar
        .getByRole("button", { name: "Cancelled · 1" })
        .getAttribute("aria-pressed"),
      "true",
      `${width}px`,
    );
    assert.ok(await noPageOverflow(page), `${width}px`);
  }
  assert.ok(await inRow("Cancelled · 1"));

  // (6) A State change keeps focus on the select and re-points the chips.
  await state.focus();
  await state.selectOption("Paused");
  await bar.getByRole("button", { name: /^Paused · / }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "State",
  );
  assert.equal(
    await bar
      .getByRole("button", { name: /^Paused · / })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(await inRow(/^Paused · /));
  assert.equal(await bar.count(), 1);

  // A fresh load that opens a later column fits its chip once the fonts have settled.
  await page.goto(`${web.origin}/app/tasks?view=board&state=Paused&ready=any`);
  await bar.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const chip = document.querySelector('.column-tab[aria-pressed="true"]')!,
      row = document.querySelector(".work-filters")!;
    const c = chip.getBoundingClientRect(),
      r = row.getBoundingClientRect();
    return c.left >= r.left - 1 && c.right <= r.right + 1;
  });

  // (7) Refresh tasks is the one refresh and still rereads the workspace.
  const read = page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/api/operator/workspace",
  );
  await refresh.click();
  await read;

  // (8) The project route has no Project select; Overview puts the chips in its work panel.
  await page.goto(
    `${web.origin}/app/projects/${ids.projectId}?view=board&ready=any`,
  );
  await bar.waitFor();
  assert.equal(await project.count(), 0);
  assert.equal(
    await page.locator(".work-filters .column-navigation").count(),
    1,
  );
  const projectTops = await Promise.all(
    [state, bar.getByRole("button")].map((l) =>
      l.evaluateAll((es) => es.map((e) => e.getBoundingClientRect().top)),
    ),
  ).then((groups) => groups.flat());
  assert.ok(Math.max(...projectTops) - Math.min(...projectTops) <= 1);
  await page.goto(`${web.origin}/app?view=board&ready=any`);
  await page
    .locator(".overview-panel .work-toolbar .column-navigation")
    .waitFor();
  assert.equal(await bar.count(), 1);

  // (9) List has no chip slot and keeps its visible count.
  await page.goto(`${web.origin}/app/tasks?view=list&ready=any`);
  await page.locator(".task-row").first().waitFor();
  assert.equal(await page.locator(".work-columns").count(), 0);
  assert.equal(await bar.count(), 0);
  assert.ok(await page.locator(".work-count").isVisible());
  assert.equal(commands(), 0);
});

test("attention summary names the uncertain or stopping task and links to the Inbox", async (_t, journey) => {
  const { ids, web, page } = await start(journey);
  const summary = page.getByRole("region", {
    name: "Attention summary",
    exact: true,
  });
  await summary.waitFor();
  const text = await summary.innerText();
  assert.match(text, /^Inspect execution · /);
  // The requester of the matching Inbox request, as on Overview; never the task lead.
  assert.match(text, /Execution may still be active; ownership stays held\./);
  assert.doesNotMatch(text, /Responsibility unknown|Accountable lead/);
  assert.equal(await summary.locator("[data-task-id]").count(), 0);
  const action = summary.getByRole("link", {
    name: "Inspect execution",
    exact: true,
  });
  assert.match(
    (await action.getAttribute("href")) ?? "",
    /^\/app\/tasks\/[0-9a-f-]{36}\?section=decisions$/,
  );
  const navCount = await page
    .locator('.sidebar a[href="/app/inbox"] .nav-count')
    .innerText();
  const inbox = summary.getByRole("link", { name: /^Inbox/ });
  assert.equal(
    (await inbox.innerText()).replace(/\s+/g, " ").trim(),
    `Inbox · ${navCount}`,
  );
  assert.equal(await inbox.getAttribute("href"), "/app/inbox");
  const list = await taskIds(page);
  await shot(page, "1366-tasks-attention-bar");
  // Like the Inbox, it lands on the task's decision card with the hold lines in view.
  await action.click();
  const card = page.locator("section#decisions");
  await card.getByRole("list", { name: "Also held", exact: true }).waitFor();
  const box = await card.boundingBox();
  assert.ok(box && box.y >= 0 && box.y < (page.viewportSize()?.height ?? 0));
  await page.goBack();
  await summary.waitFor();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await summary.waitFor();
  assert.deepEqual(await taskIds(page), list);

  // Scoped to the project; the Inbox number stays global.
  await page.goto(`${web.origin}/app/projects/${ids.projectId}`);
  await summary.waitFor();
  await page.locator('.sidebar a[href="/app/inbox"] .nav-count').waitFor();
  assert.equal(
    await summary
      .getByRole("link", { name: /^Inbox/ })
      .innerText()
      .then((t) => t.replace(/\s+/g, " ").trim()),
    `Inbox · ${navCount}`,
  );
  // Without uncertain tasks the bar names the Stopping one; without either it is absent.
  const without = (
    drop: (t: {
      execution: { state: string };
      attention: { codes: string[] };
    }) => boolean,
  ) =>
    page.route("**/api/operator/task-list", async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      body.data.tasks = body.data.tasks.filter(
        (t: Parameters<typeof drop>[0]) => !drop(t),
      );
      await route.fulfill({ response, json: body });
    });
  await without(
    (t) =>
      t.execution.state === "uncertain" ||
      t.attention.codes.includes("execution-uncertain"),
  );
  await page.goto(`${web.origin}/app/tasks?view=list&ready=any`);
  await summary.getByText(/^Stopping · Normal Stop observation/).waitFor();
  await summary.getByRole("link", { name: "Open task", exact: true }).waitFor();
  await page.unroute("**/api/operator/task-list");
  await without(
    (t) =>
      t.execution.state === "uncertain" ||
      t.execution.state === "stopping" ||
      t.attention.codes.includes("execution-uncertain"),
  );
  await page.goto(`${web.origin}/app/tasks?view=list&ready=any`);
  await page.locator(".task-list [data-task-id]").first().waitFor();
  assert.equal(await summary.count(), 0);
  await page.unroute("**/api/operator/task-list");

  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/tasks?view=board&ready=any`);
  await summary.waitFor();
  assert.ok(await noPageOverflow(page));
  await shot(page, "390-board-attention-bar");
});

test("the Updated line shows the last successful read and keeps it through a failed refresh", async (_t, journey) => {
  const { web, page } = await start(journey, "/app/tasks");
  const label = (at: number) =>
    page.evaluate((t) => {
      const d = new Date(t);
      return `Updated ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }, at);
  // Reads are reported at a fixed instant, so the line is predictable whatever the local clock.
  const first = Date.UTC(2026, 9, 17, 15, 47, 10);
  const second = first + 60_000;
  let observedAt = first;
  const answerWith = async (route: import("playwright").Route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), observedAt },
    });
  };
  await page.route("**/api/operator/task-list", answerWith);
  await page.goto(`${web.origin}/app/tasks?view=list&ready=any`);
  const line = page.locator("main p.metadata", { hasText: /^Updated / });
  const refresh = page.getByRole("button", {
    name: "Refresh tasks",
    exact: true,
  });
  await page.getByText(await label(first), { exact: true }).waitFor();
  assert.equal(await line.count(), 1);

  await page.unroute("**/api/operator/task-list");
  await page.route("**/api/operator/task-list", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unavailable", message: "Tasks unavailable" },
      }),
    }),
  );
  await refresh.click();
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await line.innerText(), await label(first));

  await page.unroute("**/api/operator/task-list");
  observedAt = second;
  await page.route("**/api/operator/task-list", answerWith);
  await refresh.click();
  await page.getByText(await label(second), { exact: true }).waitFor();
  assert.equal(
    await page
      .getByText("Refresh failed. Showing the last fetched data.")
      .count(),
    0,
  );
});

test("a runtime Needs you card comes first and links to runtime settings", async (_t, journey) => {
  const exhaustion = exhaustibleRuntime();
  const { page } = await start(journey, "/app", exhaustion, (f) =>
    exhaustion.exhaust(f.runtime),
  );
  const attention = page.getByRole("region", {
    name: "Needs you",
    exact: true,
  });
  const cards = attention.locator(".overview-card");
  await cards.first().waitFor();
  const first = cards.first();
  assert.equal(await first.getAttribute("data-kind"), "runtime");
  const text = (await first.textContent()) ?? "";
  for (const expected of [
    "Runtime",
    "Codex runtime unavailable",
    "Restart retries exhausted",
    "Open runtime settings",
  ])
    assert.ok(text.includes(expected), `${expected} in ${text}`);
  assert.doesNotMatch(text, uuidText);
  const link = first.getByRole("link", { name: "Open runtime settings" });
  assert.equal(await link.getAttribute("href"), "/app/settings/runtime");
  const describedBy = await link.getAttribute("aria-describedby");
  assert.equal(await first.locator(`h3[id="${describedBy}"]`).count(), 1);
  // The same total in the stat, the sidebar and the Open Inbox link.
  const navCount = await page
    .locator('.sidebar a[href="/app/inbox"] .nav-count')
    .innerText();
  assert.equal(await stat(page, "Needs you"), navCount);
  await link.click();
  await page.waitForURL("**/app/settings/runtime");
});
