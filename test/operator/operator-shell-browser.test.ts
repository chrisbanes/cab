import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
const test = browserSuite("operator-shell-browser");
import { chromium, webkit, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  addProfile,
  addProject,
  addTask,
  startFirstTurn,
} from "../fixtures/operator-first-run.js";
import { mixedForm } from "../fixtures/question-data.js";
import {
  seedOwnApproval,
  seedOwnIntervention,
  seedOwnQuestion,
} from "../fixtures/questions.js";

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

async function focusByTab(page: Page, target: import("playwright").Locator) {
  for (let index = 0; index < 60; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  assert.fail("Keyboard traversal did not reach the expected operator control");
}

test("production shell keeps direct task links usable and the navigation drawer keyboard-safe", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const longProjectName =
    "A project with a deliberately long navigation label for narrow operator layouts";
  const projectId = randomUUID(),
    taskId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: longProjectName,
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Direct shell task",
    outcome: "Inspect responsive navigation",
    ready: false,
  });

  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, `/app/tasks/${taskId}`);
  await page
    .getByRole("heading", { name: "Direct shell task", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, `/app/tasks/${taskId}`);

  for (const width of [759, 760, 800, 1119, 1120, 1121, 1366]) {
    await page.setViewportSize({ width, height: 768 });
    const geometry = await page.evaluate(() => {
      const display = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? getComputedStyle(element).display : "missing";
      };
      const workspace = document.querySelector<HTMLElement>(".workspace");
      const page = document.querySelector<HTMLElement>(".page");
      return {
        sidebar: display(".sidebar"),
        back: display(".page-header-back"),
        menu: display(".phone-nav"),
        workspaceWidth: workspace?.getBoundingClientRect().width ?? 0,
        pageContentWidth:
          (page?.getBoundingClientRect().width ?? 0) -
          (page ? parseFloat(getComputedStyle(page).paddingInline) * 2 : 0),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(
      geometry.sidebar,
      width <= 1120 ? "none" : "flex",
      `${width}px shell navigation mode`,
    );
    assert.equal(
      geometry.back,
      "flex",
      `${width}px task detail keeps its header Back at every width`,
    );
    assert.equal(
      geometry.menu,
      "missing",
      `${width}px nested route has no menu`,
    );
    assert.ok(
      geometry.documentWidth <= geometry.viewportWidth,
      `${width}px page must not scroll horizontally`,
    );
    if (width === 1121) assert.ok(geometry.pageContentWidth >= 849);
    if (width === 1366) assert.ok(geometry.workspaceWidth >= 1134);
  }
  await captureBrowserEvidence(page, "1121-shell-sidebar-threshold");

  // An unbroken 512-character name stays on one line inside the 48px top bar.
  const topBar = await page.evaluate(() => {
    const current = document.querySelector<HTMLElement>(
      '.top-bar-trail [aria-current="page"]',
    );
    if (current) current.textContent = "x".repeat(512);
    const bar = document.querySelector<HTMLElement>(".top-bar");
    const action = bar?.querySelector<HTMLElement>(":scope > a");
    return {
      height: bar?.getBoundingClientRect().height,
      overflowX: (bar?.scrollWidth ?? 0) - (bar?.clientWidth ?? 0),
      overflowY: (bar?.scrollHeight ?? 0) - (bar?.clientHeight ?? 0),
      actionRight: action?.getBoundingClientRect().right ?? Infinity,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  assert.equal(topBar.height, 48);
  assert.ok(
    topBar.overflowX <= 0 && topBar.overflowY <= 0,
    JSON.stringify(topBar),
  );
  assert.ok(topBar.actionRight <= topBar.viewportWidth, JSON.stringify(topBar));

  // A directly loaded task's Back returns to its project; the header has no menu.
  await page.setViewportSize({ width: 390, height: 844 });
  const back = page.getByRole("link", {
    name: `Back to ${longProjectName}`,
    exact: true,
  });
  assert.ok(
    (await back.evaluate((e) => e.getBoundingClientRect().height)) >= 44,
  );
  assert.equal(await page.locator("main h1").count(), 1);
  await back.click();
  await page.waitForURL(`**/app/projects/${projectId}`);
  await page.locator("main.page h1").waitFor();

  const trigger = page.getByRole("button", {
    name: "Projects and navigation",
    exact: true,
  });
  const phoneTargets = await trigger.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [rect.width, rect.height];
  });
  assert.ok(phoneTargets.every((size) => (size ?? 0) >= 44));
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Projects and navigation",
    exact: true,
  });
  await dialog.waitFor({ state: "visible" });
  assert.equal(
    await dialog.getByRole("link", { name: "Tasks", exact: true }).isVisible(),
    true,
  );
  const signOutHeight = await dialog
    .getByRole("button", { name: "Sign out", exact: true })
    .evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(signOutHeight >= 44, "drawer Sign out is a phone target");
  assert.equal(
    await page
      .getByRole("link", { name: "Existing operator controls" })
      .count(),
    0,
  );
  const longProjectLink = dialog.getByRole("link", {
    name: new RegExp(longProjectName),
  });
  await longProjectLink.waitFor({ state: "visible" });
  const longProjectLayout = await longProjectLink.evaluate((element) => ({
    projectLabel: element.querySelector("span")?.textContent?.trim(),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  assert.equal(longProjectLayout.projectLabel, longProjectName);
  assert.equal(longProjectLayout.whiteSpace, "normal");
  assert.ok(
    longProjectLayout.scrollWidth <= longProjectLayout.clientWidth,
    "long project navigation label wraps without overflowing its link",
  );
  const drawerLinkHeights = await dialog
    .locator(".nav-link")
    .evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height),
    );
  assert.ok(drawerLinkHeights.length > 0);
  assert.ok(drawerLinkHeights.every((height) => height >= 44));
  await dialog.getByRole("link", { name: "Search", exact: true }).click();
  await page.waitForURL("**/app/search");
  await page.goBack();
  await page
    .getByRole("heading", { name: longProjectName, exact: true, level: 1 })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, `/app/projects/${projectId}`);

  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await page.keyboard.press("Shift+Tab");
  const focusedInsideAfterShiftTab = await dialog.evaluate((element) =>
    element.contains(document.activeElement),
  );
  assert.equal(focusedInsideAfterShiftTab, true);
  await page.keyboard.press("Tab");
  const focusedInsideAfterTab = await dialog.evaluate((element) =>
    element.contains(document.activeElement),
  );
  assert.equal(focusedInsideAfterTab, true);
  await captureBrowserEvidence(page, "390-shell-drawer-open");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const trigger = document.querySelector(".phone-nav [data-slot=button]");
    return trigger !== null && trigger === document.activeElement;
  });
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
    "closing the drawer restores focus to its trigger",
  );
  assert.equal(new URL(page.url()).pathname, `/app/projects/${projectId}`);

  // Browser Back from an open drawer to a nested screen closes it; Forward does not reopen it.
  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await page.goBack();
  await page
    .getByRole("link", { name: `Back to ${longProjectName}`, exact: true })
    .waitFor();
  assert.equal(await dialog.count(), 0);
  await page.goForward();
  await trigger.waitFor();
  assert.equal(await dialog.count(), 0);

  // Sign out through the drawer ends the session at phone width.
  await trigger.click();
  await dialog.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).waitFor();
});

test("shared controls retain visible focus in forced colours and remove optional motion", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID(),
    taskId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Focus fixture project",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Focus fixture task",
    outcome: "Inspect keyboard-visible controls",
    ready: false,
  });

  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app/tasks");
  const search = page.getByRole("combobox", { name: "State", exact: true });
  const project = page.getByRole("combobox", { name: "Project", exact: true });
  const list = page.getByRole("button", { name: "List", exact: true });
  await search.waitFor();
  await project.waitFor();
  await focusByTab(page, search);
  const ordinaryFocus = await search.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
    };
  });
  assert.equal(ordinaryFocus.visible, true);
  assert.equal(ordinaryFocus.outlineStyle, "solid");
  assert.ok(ordinaryFocus.outlineWidth >= 2);
  await page.emulateMedia({ forcedColors: "active" });

  for (const control of [search, project, list]) {
    await focusByTab(page, control);
    const focus = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        visible: element.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
      };
    });
    assert.equal(focus.visible, true);
    assert.equal(focus.outlineStyle, "solid");
    assert.ok(focus.outlineWidth >= 2);
  }
  assert.equal(await list.getAttribute("aria-pressed"), "true");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  const motion = await list.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      transitionDuration: style.transitionDuration,
      animationDuration: style.animationDuration,
    };
  });
  assert.equal(motion.transitionDuration, "0s");
  assert.equal(motion.animationDuration, "0s");
  assert.equal(await list.textContent(), "List");
  await captureBrowserEvidence(page, "1366-shell-reduced-motion-focus");
});

const inboxResponse = (response: import("playwright").Response) =>
  new URL(response.url()).pathname === "/api/operator/inbox";

test("desktop shell lists the designed destinations, an honest Inbox count and a footer account group", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  await seedOwnQuestion(f);
  await seedOwnQuestion(f, mixedForm, "Second task");
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  const sidebar = page.locator(".sidebar");
  await sidebar.locator('a[href="/app/inbox"] .nav-count').waitFor();
  const labels = await sidebar
    .locator('nav[aria-label="Operator navigation"] a')
    .evaluateAll((links) =>
      links.map((link) => ({
        label: link.querySelector(".nav-label")?.textContent?.trim(),
        href: link.getAttribute("href"),
      })),
    );
  assert.deepEqual(labels.slice(0, 3), [
    { label: "Overview", href: "/app" },
    { label: "Inbox", href: "/app/inbox" },
    { label: "Tasks", href: "/app/tasks" },
  ]);
  // The Search work field is the desktop shell's only Search entry.
  assert.equal(
    await sidebar.getByRole("link", { name: "Search", exact: true }).count(),
    0,
  );
  assert.equal(await sidebar.getByRole("search").count(), 1);
  assert.equal(await sidebar.getByLabel("Search work").count(), 1);
  assert.deepEqual(labels.at(-1), {
    label: "New project",
    href: "/app/settings/projects/new",
  });
  assert.ok(
    labels
      .slice(3, -1)
      .every((entry) => entry.href?.startsWith("/app/projects/")),
  );
  assert.equal(
    await sidebar.locator('a[href="/app/inbox"] .nav-count').textContent(),
    "2",
  );
  assert.equal(
    await sidebar
      .getByRole("link", { name: "Inbox", exact: true })
      .evaluate(
        (link) =>
          document.getElementById(link.getAttribute("aria-describedby") ?? "")
            ?.textContent,
      ),
    "2 unresolved",
  );
  assert.equal(
    await sidebar.locator('nav a > svg.nav-icon[aria-hidden="true"]').count(),
    labels.length,
    "every sidebar item has a decorative icon",
  );
  // The account menu replaces the footer's Settings link and Sign out button.
  assert.equal(
    await sidebar.getByRole("link", { name: "Settings", exact: true }).count(),
    0,
  );
  await sidebar
    .getByRole("button", { name: "Operator account", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Existing operator controls" })
      .count(),
    0,
  );
  assert.equal(await page.getByText("Operator workspace").count(), 0);
  assert.equal(await page.locator("main h1").count(), 1);

  // On the Inbox route the shell count is the list's own total, and the header explains it.
  await page.goto(`${web.origin}/app/inbox`);
  await page.locator(".inbox-row").first().waitFor();
  assert.equal(await page.locator(".inbox-row").count(), 2);
  await sidebar.locator('a[href="/app/inbox"] .nav-count').waitFor();
  assert.equal(
    await sidebar.locator('a[href="/app/inbox"] .nav-count').textContent(),
    "2",
  );
  // At the sidebar shell the queue header owns the heading and summary; no page header.
  assert.equal(
    await page.locator(".inbox-summary").textContent(),
    "2 unresolved across 2 projects",
  );
  assert.equal(await page.locator(".page-header").count(), 0);
  // At the drawer shell the page header carries them, with the count badge.
  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "2 unresolved across 2 projects",
  );
  assert.equal(
    await page.locator(".page-header-count").textContent(),
    "2 unresolved",
  );
  await page.setViewportSize({ width: 1366, height: 900 });

  await page.goto(`${web.origin}/app/tasks?view=board`);
  await page.locator("main.page h1").waitFor();
  const current = await sidebar
    .locator('a[aria-current="page"]')
    .evaluateAll((links) => links.map((link) => link.textContent?.trim()));
  assert.deepEqual(current, ["Tasks"]);
  await page.goto(`${web.origin}/app/tasks`);
  // goto resolves before the shell mounts; evaluateAll does not auto-wait.
  await sidebar.locator('a[aria-current="page"]').first().waitFor();
  assert.deepEqual(
    await sidebar
      .locator('a[aria-current="page"]')
      .evaluateAll((links) => links.map((link) => link.textContent?.trim())),
    ["Tasks"],
  );
  // Overview and the task views carry their subtitle and the one primary action in the header.
  await page.goto(`${web.origin}/app`);
  await page.locator("main.page h1").waitFor();
  assert.equal(
    await page.locator(".page-header-title p").textContent(),
    "Decisions first. Work and completed results stay separate.",
  );
  assert.equal(
    await page
      .locator(".top-bar")
      .getByRole("link", { name: "New task", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page.getByRole("link", { name: "New task", exact: true }).count(),
    1,
  );
  // Connected only after a completed workspace read; nothing while the first read is pending.
  await page.locator(".top-bar-connection", { hasText: "Connected" }).waitFor();
  await page.route("**/api/operator/workspace", () => {});
  await page.reload();
  await page.locator(".top-bar").waitFor();
  assert.equal(await page.locator(".top-bar-connection").count(), 0);
  await page.unroute("**/api/operator/workspace");
  // The Settings index, whose own trail is empty, still names the current page.
  await page.goto(`${web.origin}/app/settings`);
  assert.equal(
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .locator('[aria-current="page"]')
      .textContent(),
    "Settings",
  );
  await page.goto(`${web.origin}/app`);
  await page.locator("main.page h1").waitFor();
  // Ctrl+K focuses the sidebar field; in the drawer layout it opens Search's own field.
  await page.keyboard.press("Control+k");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Search work",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+k");
  await page.waitForURL(`${web.origin}/app/search`);
  await page.waitForFunction(
    () => document.activeElement?.id === "retained-query",
  );
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${web.origin}/app`);
  await page.locator("main.page h1").waitFor();

  // A failed Inbox read shows no number rather than a stale or partial one.
  await page.route("**/api/operator/inbox*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unavailable", message: "Unavailable." },
      }),
    }),
  );
  const failed = page.waitForResponse(inboxResponse);
  await page.goto(`${web.origin}/app/settings`);
  await failed;
  await page.locator("main.page h1").waitFor();
  assert.equal(await sidebar.locator(".nav-count").count(), 0);
  await sidebar.getByRole("link", { name: "Inbox", exact: true }).waitFor();
  await captureBrowserEvidence(page, "1366-shell-inbox-count-unavailable");
});

test("page-owned refresh replaces the shell Refresh and still re-reads the workspace", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = addProject(f, "Refresh project", addProfile(f)),
    taskId = addTask(f, projectId, "Refresh task fixture");
  // Home shows Refresh tasks only after a task has started a turn.
  await startFirstTurn(f, projectId, taskId);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  const owned: [string, string][] = [
    ["/app", "Refresh tasks"],
    ["/app/tasks", "Refresh tasks"],
    [`/app/projects/${projectId}`, "Refresh tasks"],
    [`/app/tasks/${taskId}`, "Refresh task"],
    ["/app/search?query=Refresh", "Refresh results"],
  ];
  for (const [route, name] of owned) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    const button = page.getByRole("button", { name, exact: true });
    await button.waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh", exact: true }).count(),
      0,
      `${route} has only its page-owned refresh`,
    );
    const workspace = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/operator/workspace",
    );
    const inbox = page.waitForResponse(inboxResponse);
    await button.click();
    await workspace;
    await inbox;
  }
  for (const route of ["/app/inbox", "/app/settings"]) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh", exact: true }).count(),
      1,
      `${route} keeps one Refresh`,
    );
  }
  for (const route of [
    ...owned.map(([r]) => r),
    "/app/inbox",
    "/app/settings",
  ]) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(
      await page.getByText(/^Fetched /).count(),
      0,
      `${route} shows no fresh Fetched line`,
    );
  }
});

test("every route renders in the shell on desktop and phone without horizontal scroll", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const domain = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Shell lead",
    instructions: "Fixture only",
    capabilities: "Coordinate",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Shell project",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Shell task",
    outcome: "Inspect every route",
    ready: false,
  });
  domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Inspect every route",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  await seedOwnQuestion(f);
  await seedOwnQuestion(f, mixedForm, "Second task");
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  const notFound = "/app/does-not-exist";
  // [route, evidence name, top-level on a phone]
  const routes: [string, string | null, boolean][] = [
    ["/app", "overview", true],
    ["/app/inbox", "inbox", true],
    ["/app/tasks", null, true],
    ["/app/tasks?view=board", null, true],
    ["/app/search", null, true],
    [`/app/projects/${projectId}`, null, true],
    [`/app/projects/${projectId}/settings`, null, false],
    ["/app/tasks/new", null, false],
    [`/app/tasks/${taskId}`, null, false],
    ["/app/settings", "settings", true],
    ["/app/settings/runtime", null, false],
    ["/app/settings/projects/new", null, false],
    ["/app/settings/profiles/new", null, false],
    [`/app/profiles/${profileId}/settings`, null, false],
    [`/app/assignments/${assignmentId}/recovery`, null, false],
    [notFound, null, true],
  ];
  for (const [width, height] of [
    [1366, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const [route, evidence, topLevel] of routes) {
      // The service answers unknown /app paths itself, so the in-app
      // not-found screen is reached by client-side navigation.
      if (route === notFound)
        await page.evaluate((path) => {
          history.pushState({}, "", path);
          dispatchEvent(new PopStateEvent("popstate"));
        }, route);
      else await page.goto(web.origin + route);
      await page
        .locator("main.page h1")
        .waitFor()
        .catch(() => assert.fail(`${width} ${route}: no signed-in title`));
      await page.waitForLoadState("networkidle");
      const state = await page.evaluate(() => {
        const visible = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          return (
            element !== null &&
            getComputedStyle(element).display !== "none" &&
            element.getBoundingClientRect().width > 0
          );
        };
        return {
          h1: document.querySelectorAll("main h1").length,
          sidebar: visible(".sidebar"),
          variant: document
            .querySelector(".page-header")
            ?.getAttribute("data-variant"),
          menu: visible(".phone-nav [data-slot=button]"),
          back: visible(".page-header-back"),
          overflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      });
      assert.equal(state.h1, 1, `${width} ${route}: one h1`);
      assert.equal(state.overflow, false, `${width} ${route}: no scroll`);
      if (width === 1366)
        assert.equal(state.sidebar, true, `${route}: sidebar visible`);
      else {
        assert.equal(state.sidebar, false, `${route}: drawer replaces sidebar`);
        assert.equal(
          state.variant,
          topLevel ? "top-level" : "detail",
          `${route}: phone header variant`,
        );
        assert.equal(state.menu, topLevel, `${route}: menu button`);
        assert.equal(state.back, !topLevel, `${route}: Back link`);
      }
      if (width === 390 && route === "/app/inbox")
        assert.equal(
          await page.locator(".page-header-count").textContent(),
          "2 unresolved",
          "phone header count reads as text",
        );
      if (evidence) await captureBrowserEvidence(page, `${width}-${evidence}`);
      if (width === 390 && route === `/app/tasks/${taskId}`)
        await captureBrowserEvidence(page, "390-task-detail-header");
    }
    if (width === 390) {
      await page.goto(`${web.origin}/app`);
      await page.locator("main.page h1").waitFor();
      await page
        .getByRole("button", { name: "Projects and navigation", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Projects and navigation", exact: true })
        .waitFor();
      await captureBrowserEvidence(page, "390-drawer");
    }
  }
});

/** A signed-in shell over one project, for the header and navigation journeys below. */
async function startShell(
  journey: BrowserJourney,
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
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Shell project",
    leadProfileId: null,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app");
  return { web, page, projectId };
}

const shellRefresh = (page: Page) =>
  page.getByRole("button", { name: "Refresh", exact: true });

test("create forms have no shell Refresh while read views keep one, across navigation and Back", async (_t, journey) => {
  const { web, page, projectId } = await startShell(journey, {
    width: 1366,
    height: 900,
  });
  const expectRefresh = async (route: string, count: number) => {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    assert.equal(await shellRefresh(page).count(), count, route);
  };
  for (const route of [
    "/app/tasks/new",
    `/app/tasks/new?project=${projectId}`,
    "/app/settings/projects/new",
    "/app/settings/profiles/new",
  ])
    await expectRefresh(route, 0);
  for (const route of [
    "/app/settings",
    "/app/getting-started",
    "/app/settings/runtime",
    "/app/inbox",
  ])
    await expectRefresh(route, 1);

  // Client navigation re-evaluates the header: leaving a read view for a form drops Refresh,
  // Back brings it back, and the account menu's Settings returns to a read view.
  await page.goto(`${web.origin}/app/settings`);
  await page.locator("main.page h1").waitFor();
  assert.equal(await shellRefresh(page).count(), 1);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "New project", exact: true })
    .click();
  await page.waitForURL("**/app/settings/projects/new");
  assert.equal(await shellRefresh(page).count(), 0);
  await page.goBack();
  await page.waitForURL("**/app/settings");
  await shellRefresh(page).waitFor();
  assert.equal(await shellRefresh(page).count(), 1);

  await page.goto(`${web.origin}/app/tasks/new`);
  await page.locator("main.page h1").waitFor();
  assert.equal(await shellRefresh(page).count(), 0);
  await page
    .getByRole("button", { name: "Operator account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.waitForURL("**/app/settings");
  await shellRefresh(page).waitFor();
  assert.equal(await shellRefresh(page).count(), 1);
});

test("create forms have no Refresh in the phone header", async (_t, journey) => {
  const { web, page } = await startShell(journey, { width: 390, height: 844 });
  for (const route of ["/app/tasks/new", "/app/settings/projects/new"]) {
    await page.goto(web.origin + route);
    await page.locator("main.page h1").waitFor();
    assert.equal(await shellRefresh(page).count(), 0, route);
  }
  await page.goto(`${web.origin}/app/settings`);
  await page.locator("main.page h1").waitFor();
  assert.equal(await shellRefresh(page).count(), 1);
});

test("the sidebar Search work field is the one desktop Search entry", async (_t, journey) => {
  const { web, page } = await startShell(journey, { width: 1366, height: 900 });
  const field = page.getByRole("search").getByLabel("Search work");
  const form = page.locator(".sidebar form.search-work");
  assert.equal(await form.getAttribute("data-current"), null);

  // An empty submit opens Search; a query is carried in the URL.
  await field.press("Enter");
  await page.waitForURL((u) => u.pathname === "/app/search" && !u.search);
  assert.notEqual(await form.getAttribute("data-current"), null);
  assert.equal(await form.getAttribute("aria-current"), "page");
  await page.goBack();
  await page.waitForURL((u) => u.pathname === "/app");
  assert.equal(await form.getAttribute("data-current"), null);
  assert.equal(await form.getAttribute("aria-current"), null);
  await field.fill("Shared");
  await field.press("Enter");
  await page.waitForURL(
    (u) => u.pathname === "/app/search" && u.search === "?query=Shared",
  );
  assert.notEqual(await form.getAttribute("data-current"), null);

  // Keyboard access: Tab reaches the field from the top of the page, and both shortcuts focus it.
  await page.goto(`${web.origin}/app`);
  await page.locator("main.page h1").waitFor();
  await focusByTab(page, field);
  await page.locator("main.page h1").click();
  for (const shortcut of ["Meta+K", "Control+K"]) {
    await page.locator("main.page h1").click();
    await page.keyboard.press(shortcut);
    assert.equal(
      await field.evaluate((el) => el === document.activeElement),
      true,
      shortcut,
    );
  }
});

for (const width of [1024, 390])
  test(`at ${width}px the drawer keeps one Search row and the shortcut opens Search's own field`, async (_t, journey) => {
    const { web, page } = await startShell(journey, { width, height: 844 });
    await page
      .getByRole("button", { name: "Projects and navigation", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Projects and navigation",
      exact: true,
    });
    await dialog.waitFor();
    assert.equal(
      await dialog.getByRole("link", { name: "Search", exact: true }).count(),
      1,
    );
    assert.equal(await dialog.getByLabel("Search work").count(), 0);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // Closing the drawer returns focus to its trigger; the shortcut comes after that settles.
    await page.waitForFunction(
      () =>
        document.activeElement?.closest(".phone-nav") !== null &&
        document.activeElement?.tagName === "BUTTON",
    );
    await page.keyboard.press("Control+K");
    await page.waitForURL("**/app/search");
    await page.waitForFunction(
      () => document.activeElement?.id === "retained-query",
    );
    assert.equal(new URL(page.url()).origin, web.origin);
  });

for (const engine of ["chromium", "webkit"] as const)
  test(
    `approved roof-sign identity stays legible beside attention across shell layouts (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const f = await journey.start("fixture.create", () =>
        createOperatorFixture(
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
      await seedOwnQuestion(f);
      await seedOwnApproval(f);
      await seedOwnIntervention(f);
      const web = await journey.start("fixture.web", () => f.startWeb());
      browser = await journey.start("browser.launch", () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const page = await browser.newPage({
        viewport: { width: 1366, height: 900 },
      });
      journey.observe(page);
      page.setDefaultTimeout(5000);
      await page.goto(`${web.origin}/app/inbox`);
      await page.getByLabel("Password", { exact: true }).waitFor();
      await assertBrandMark(page.locator(".wordmark .workspace-mark"));
      const favicon = page.locator('link[rel="icon"]');
      assert.equal(await favicon.getAttribute("type"), "image/svg+xml");
      const icon = await page.request.get(
        new URL((await favicon.getAttribute("href"))!, page.url()).href,
      );
      assert.equal(icon.status(), 200);
      assert.equal(icon.headers()["content-type"], "image/svg+xml");
      assert.equal(icon.headers()["set-cookie"], undefined);
      assert.match(await icon.text(), /viewBox="0 0 16 16"/);
      const legacy = await page.request.get(`${web.origin}/runtime`);
      const legacyHtml = await legacy.text();
      assert.match(legacyHtml, /rel="icon"[^>]*href="\/favicon.svg"/);
      assert.match(
        legacyHtml,
        /<svg aria-hidden="true"[^>]*width="20" height="20"/,
      );
      await page.getByLabel("Password", { exact: true }).fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.locator(".inbox-row").first().waitFor();
      assert.equal(await page.locator(".inbox-row").count(), 3);
      await page
        .locator(".top-bar-connection", { hasText: "Connected" })
        .waitFor();
      for (const [width, height] of [
        [390, 844],
        [390, 480],
        [800, 768],
        [1024, 768],
        [1120, 768],
        [1121, 768],
        [1366, 900],
      ]) {
        await page.setViewportSize({ width: width!, height: height! });
        const desktop = width! > 1120;
        if (desktop) {
          await assertBrandMark(page.locator(".sidebar .workspace-mark"));
          await assertBrandMark(page.locator(".top-bar .workspace-mark"));
          const geometry = await page.evaluate(() => ({
            sidebar: document.querySelector(".sidebar")!.getBoundingClientRect()
              .width,
            bar: document.querySelector(".top-bar")!.getBoundingClientRect()
              .height,
            lockup: document
              .querySelector(".top-bar-brand")!
              .getBoundingClientRect().width,
            overflow:
              document.querySelector(".top-bar")!.scrollWidth -
              document.querySelector(".top-bar")!.clientWidth,
          }));
          assert.equal(geometry.sidebar, 232);
          assert.equal(geometry.bar, 48);
          assert.ok(
            geometry.lockup >= 51 && geometry.overflow <= 0,
            JSON.stringify(geometry),
          );
        } else {
          const trigger = page.getByRole("button", {
            name: "Projects and navigation",
            exact: true,
          });
          await trigger.click();
          const drawer = page.getByRole("dialog", {
            name: "Projects and navigation",
            exact: true,
          });
          await assertBrandMark(drawer.locator(".workspace-mark"));
          const close = drawer.getByRole("button", {
            name: "Close navigation",
            exact: true,
          });
          const rect = await close.boundingBox();
          assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= height!);
          if (width === 390 && height === 480)
            await captureBrowserEvidence(
              page,
              `${engine}-390x480-brand-drawer`,
            );
          await page.keyboard.press("Escape");
          await drawer.waitFor({ state: "detached" });
          await page.waitForFunction(
            () => document.activeElement?.closest(".phone-nav") !== null,
          );
        }
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        assert.ok(
          overflow <= 0,
          `${width}x${height} page overflow: ${overflow}`,
        );
      }
      // A settled failed workspace refresh is a warning; Inbox's separately loaded requests remain.
      await page.route("**/api/operator/workspace", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"unavailable"}',
        }),
      );
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page
        .locator(".top-bar-connection", { hasText: "Updates delayed" })
        .waitFor();
      await page.locator(".inbox-row").first().waitFor();
      assert.equal(await page.locator(".inbox-row").count(), 3);
      const kinds = await page.locator(".inbox-row").allTextContents();
      assert.ok(
        kinds.some((text) => text.includes("Question")),
        kinds.join("\n"),
      );
      assert.ok(
        kinds.some((text) => text.includes("Approval")),
        kinds.join("\n"),
      );
      assert.ok(
        kinds.some((text) => text.includes("Intervention")),
        kinds.join("\n"),
      );
      // The badge text changes before its colour transition finishes.
      await page.waitForFunction(() => {
        const badge = document.querySelector(".top-bar-connection");
        return badge && getComputedStyle(badge).color === "rgb(251, 191, 36)";
      });
      for (const kind of ["question", "approval", "intervention"]) {
        const row = page.locator(`.inbox-row[data-kind="${kind}"]`);
        assert.equal(
          await row.locator(".inbox-row-label svg[aria-hidden=true]").count(),
          1,
        );
        assert.ok(
          (await row.locator(".inbox-row-action").textContent())?.trim(),
        );
      }
      const warning = await page
        .locator(".top-bar-connection")
        .evaluate((element) => ({
          text: getComputedStyle(element).color,
          symbols: element.querySelectorAll("svg").length,
        }));
      assert.equal(warning.text, "rgb(251, 191, 36)");
      assert.equal(warning.symbols, 1);
      await captureBrowserEvidence(page, `${engine}-1366-brand-and-attention`);
    },
  );

async function assertBrandMark(mark: import("playwright").Locator) {
  await mark.waitFor({ state: "visible" });
  await mark.evaluate((element: HTMLImageElement) => element.decode());
  assert.equal(await mark.getAttribute("alt"), "");
  assert.equal(await mark.getAttribute("aria-hidden"), "true");
  assert.deepEqual(
    await mark.evaluate((element) => [
      element.getBoundingClientRect().width,
      element.getBoundingClientRect().height,
    ]),
    [20, 20],
  );
}
