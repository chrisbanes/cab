import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { addTask } from "../fixtures/operator-first-run.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedOwnQuestion } from "../fixtures/questions.js";

const test = browserSuite("operator-project-labels-browser");

async function signIn(
  page: Page,
  origin: string,
  password: string,
  path: string,
) {
  await page.goto(origin + path);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}

const sidebarLinks = (page: Page) =>
  page.locator(
    'nav[aria-label="Operator navigation"]:visible a[href^="/app/projects/"]:not([href$="/settings"])',
  );

async function sidebar(page: Page) {
  return (await sidebarLinks(page).evaluateAll((links) =>
    links.map((link) => [
      link.getAttribute("href"),
      (link.querySelector(".nav-label")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    ]),
  )) as [string, string][];
}

/** The options of a labelled select as [value, text], without its placeholder. */
async function options(page: Page, label: string) {
  return (await page
    .getByRole("combobox", { name: label, exact: true })
    .evaluate((select) =>
      [...(select as HTMLSelectElement).options]
        .filter((option) => option.value)
        .map((option) => [
          option.value,
          option.text.replace(/\s+/g, " ").trim(),
        ]),
    )) as [string, string][];
}

test("same-named projects stay distinguishable in the sidebar, selects and Inbox, and selections stay by id", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain();
  const profile = (name: string) => {
    const profileId = randomUUID();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name,
      instructions: "Lead",
      capabilities: "coordination",
    });
    return profileId;
  };
  const mira = profile("Mira"),
    jonas = profile("Jonas");
  // Two projects with an Inbox request each, plus a third whose task has no request.
  const first = await seedOwnQuestion(
    f,
    undefined,
    "First request",
    "Atlas one",
  );
  const second = await seedOwnQuestion(
    f,
    undefined,
    "Second request",
    "Atlas two",
  );
  const third = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: third,
    name: "Atlas three",
    leadProfileId: jonas,
  });
  addTask(f, third, "Third task");
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Relay",
    leadProfileId: mira,
  });
  // Projects created before the rule share a name; write that state straight into storage.
  const atlas = [first.projectId, second.projectId, third];
  f.seedPersistedState((db) => {
    for (const projectId of atlas)
      db.prepare(
        "UPDATE domain_projects SET name = 'Atlas', leadProfileId = ? WHERE id = ?",
      ).run(projectId === third ? jonas : mira, projectId);
  });
  const ordered = [...atlas].sort();
  const short = (projectId: string) => projectId.slice(0, 8);
  const expected = ordered.map(
    (projectId) =>
      [
        projectId,
        projectId === third ? "Atlas · Jonas" : `Atlas · ${short(projectId)}`,
      ] as const,
  );

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app/tasks");

  // The sidebar: id order, id hrefs, distinct accessible names.
  await sidebarLinks(page).first().waitFor();
  const links = await sidebar(page);
  assert.deepEqual(
    links.slice(0, 3),
    expected.map(([projectId, text]) => [`/app/projects/${projectId}`, text]),
  );
  assert.equal(links[3]?.[1], "Relay");
  for (const [, text] of expected)
    assert.equal(
      await page
        .locator('nav[aria-label="Operator navigation"]:visible')
        .getByRole("link", { name: new RegExp(`^${text}`) })
        .count(),
      1,
      text,
    );

  // Selects offer the same distinct texts and choose by id.
  const project = (rows: [string, string][]) =>
    rows.filter(([, text]) => text.startsWith("Atlas"));
  assert.deepEqual(
    project(await options(page, "Project")),
    expected.map(([value, text]) => [value, text]),
  );
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption(third);
  await page.waitForURL(`**/app/tasks?*project=${third}*`);
  await page.getByText("Third task", { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText("Third task", { exact: true }).first().waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .inputValue(),
    third,
  );
  assert.equal(
    await page.getByText("First request", { exact: true }).count(),
    0,
  );

  await page.goto(`${web.origin}/app/search?query=request`);
  await page.getByRole("combobox", { name: "Project", exact: true }).waitFor();
  assert.deepEqual(
    project(await options(page, "Project")),
    expected.map(([value, text]) => [value, text]),
  );

  await page.goto(`${web.origin}/app/tasks/new`);
  await page.getByRole("combobox", { name: "Project", exact: true }).waitFor();
  assert.deepEqual(
    project(await options(page, "Project")),
    expected.map(([value, text]) => [value, text]),
  );

  await page.goto(`${web.origin}/app/inbox`);
  await page.getByRole("combobox", { name: "Project", exact: true }).waitFor();
  // The Inbox lists projects in the order its requests appear, so compare by id.
  assert.deepEqual((await options(page, "Project")).sort(), [
    ...[first.projectId, second.projectId]
      .sort()
      .map((projectId) => [projectId, `Atlas · ${short(projectId)} · 1`]),
  ]);

  // A project page selects its own sidebar item.
  for (const [projectId, text] of expected) {
    await page.goto(`${web.origin}/app/projects/${projectId}`);
    await page.locator("main.page h1").waitFor();
    const current = page.locator(
      'nav[aria-label="Operator navigation"]:visible a[aria-current]',
    );
    assert.equal(
      await current.getAttribute("href"),
      `/app/projects/${projectId}`,
    );
    assert.equal(
      ((await current.locator(".nav-label").textContent()) ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      text,
    );
  }

  // Every other project list reads the same labels: Overview Projects, Settings and Runtime.
  for (const [path, heading] of [
    ["/app", ".overview-project-name"],
    ["/app/settings", ".settings-row-heading h3"],
    ["/app/settings/runtime", ".settings-row-heading h3"],
  ] as const) {
    await page.goto(`${web.origin}${path}`);
    for (const [, text] of expected)
      await page.locator(heading).filter({ hasText: text }).first().waitFor();
    const shown = (
      await page
        .locator(heading)
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            (node.textContent ?? "").replace(/\s+/g, " ").trim(),
          ),
        )
    ).filter((text) => text.startsWith("Atlas"));
    assert.ok(
      expected.every(([, text]) => shown.includes(text)),
      `${path}: ${shown.join(" | ")}`,
    );
  }

  await page.goto(`${web.origin}/app/tasks`);
  // Phone: the drawer carries the same labels without horizontal overflow.
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole("button", { name: "Projects and navigation", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Projects and navigation",
    exact: true,
  });
  await dialog.waitFor({ state: "visible" });
  for (const [, text] of expected)
    await dialog.getByRole("link", { name: new RegExp(`^${text}`) }).waitFor();
  assert.ok(
    await dialog
      .locator("nav")
      .evaluate((nav) => nav.scrollWidth <= nav.clientWidth),
    "the drawer navigation does not overflow",
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1366, height: 900 });

  // Labels are derived: renaming one duplicate to a unique name drops the others' suffixes
  // for the next read, with no stale suffix kept anywhere.
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: third,
    expectedVersion: Number(d.project(third).version),
    name: "Atlas Jonas",
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: second.projectId,
    expectedVersion: Number(d.project(second.projectId).version),
    name: "Atlas Second",
  });
  await page.goto(`${web.origin}/app/tasks`);
  await sidebarLinks(page).first().waitFor();
  assert.deepEqual((await sidebar(page)).map(([, text]) => text).sort(), [
    "Atlas",
    "Atlas Jonas",
    "Atlas Second",
    "Relay",
  ]);
});

test("same-named projects whose ids share their first eight characters stay distinct in selects and the sidebar", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain();
  const lead = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: lead,
    name: "Mira",
    instructions: "Lead",
    capabilities: "coordination",
  } as never);
  const twins = [
    "abcdef12-0001-4000-8000-000000000000",
    "abcdef12-0002-4000-8000-000000000000",
  ];
  for (const [index, projectId] of twins.entries())
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: `Twin ${index}`,
      leadProfileId: lead,
    });
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_projects SET name = 'Twin' WHERE id IN (?, ?)")
      .run(...twins),
  );
  const expected = twins.map(
    (projectId) =>
      [projectId, `Twin · ${projectId.slice(0, 16)}`] as [string, string],
  );

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app/tasks");
  await sidebarLinks(page).first().waitFor();
  assert.deepEqual(
    await sidebar(page),
    expected.map(([projectId, text]) => [`/app/projects/${projectId}`, text]),
  );
  assert.deepEqual(await options(page, "Project"), expected);
  await page.goto(`${web.origin}/app/tasks/new`);
  await page.getByRole("combobox", { name: "Project", exact: true }).waitFor();
  assert.deepEqual(await options(page, "Project"), expected);
});

test("same-named projects whose ids differ only by letter case are numbered in the sidebar and selects", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain();
  const lower = "abcdef12-0001-4000-8000-00000000abcd";
  const upper = lower.toUpperCase();
  for (const [index, projectId] of [lower, upper].entries())
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: `Case ${index}`,
      leadProfileId: null,
    });
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_projects SET name = 'Case' WHERE id IN (?, ?)")
      .run(lower, upper),
  );
  const expected: [string, string][] = [
    [upper, `Case · ${upper} #1`],
    [lower, `Case · ${lower} #2`],
  ];
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app/tasks");
  await sidebarLinks(page).first().waitFor();
  assert.deepEqual(
    await sidebar(page),
    expected.map(([projectId, text]) => [`/app/projects/${projectId}`, text]),
  );
  assert.deepEqual(await options(page, "Project"), expected);
});
