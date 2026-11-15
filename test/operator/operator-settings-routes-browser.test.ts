import assert from "node:assert/strict";
import type { Page, Request, Route } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  signIn,
  startSettings,
  trail,
} from "../fixtures/operator-settings.js";

/** Settings section routes, the landing, legacy addresses, navigation and page reads. */
const test = browserSuite("operator-settings-routes-browser");

/** Route, navigation label and page heading of each section, in the designed order. */
const sections = [
  ["/settings/projects", "Projects", "Projects"],
  ["/settings/runtime", "Runtime & recovery", "Runtime capacity and recovery"],
  ["/settings/agents", "Agents", "Agents"],
  ["/settings/routing", "Routing", "Routing"],
  ["/settings/github-discovery", "GitHub discovery", "GitHub discovery"],
  ["/settings/gitlab-credentials", "GitLab credentials", "GitLab credentials"],
  ["/settings/cli-credentials", "CLI credentials", "CLI credentials"],
  ["/settings/notifications", "Notifications", "Notifications"],
  ["/settings/readiness", "Readiness", "Readiness"],
] as const;

const nav = (page: Page) =>
  page.getByRole("navigation", { name: "Settings sections" });
const current = (page: Page) =>
  nav(page).locator('a[aria-current="page"]').allInnerTexts();
const h1 = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
const path = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search + url.hash;
};
const focusedText = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent ?? null);

test("each section page loads directly and on reload with one current link and its crumb", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/settings/projects");
  for (const [route, label, heading] of sections) {
    await page.goto(`${web.origin}${route}`);
    await h1(page, heading);
    assert.deepEqual(await current(page), [label], route);
    assert.equal(
      await trail(page),
      `Settings / ${route === "/settings/runtime" ? "Runtime" : label}`,
    );
    assert.equal(await page.locator("main h1").count(), 1, route);
  }
  await page.reload();
  await h1(page, "Readiness");
  assert.deepEqual(await current(page), ["Readiness"]);
  assert.deepEqual(
    await nav(page).getByRole("link").allInnerTexts(),
    sections.map(([, label]) => label),
  );
  // A misspelled section is not found rather than aliased.
  await page.goto(`${web.origin}/settings/profiles`);
  await page.getByRole("heading", { name: "Page not found" }).waitFor();
});

test("Settings lands on Projects once a turn has started, replacing its own entry", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/tasks");
  await page.goto(`${web.origin}/settings?from=menu`);
  await h1(page, "Projects");
  assert.equal(path(page), "/settings/projects?from=menu");
  // The landing replaced /settings, so Back leaves Settings without a loop.
  await page.goBack();
  await page.waitForURL(/\/tasks$/);
});

test("before the first turn Settings lands on Readiness, but an explicit section stays", async (_t, journey) => {
  const { page, web } = await startSettings(
    journey,
    "/tasks",
    desktop,
    undefined,
    {
      turnStarted: false,
    },
  );
  await page.goto(`${web.origin}/settings`);
  await h1(page, "Readiness");
  assert.equal(path(page), "/settings/readiness");
  await page.goto(`${web.origin}/settings/notifications`);
  await h1(page, "Notifications");
  await page.waitForTimeout(200);
  assert.equal(path(page), "/settings/notifications");
  await captureBrowserEvidence(page, "1366-first-run-explicit-notifications");
});

test("a failed workspace read keeps Settings with Retry and the section links", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/tasks");
  const fail = (r: Route) =>
    r.fulfill({
      status: 503,
      json: { error: { code: "unavailable", message: "x" } },
    });
  await page.route("**/api/operator/workspace", fail);
  await page.goto(`${web.origin}/settings`);
  await page.getByRole("button", { name: "Try again" }).first().waitFor();
  assert.deepEqual(
    await nav(page).getByRole("link").allInnerTexts(),
    sections.map(([, label]) => label),
  );
  assert.deepEqual(await current(page), []);
  assert.equal(path(page), "/settings");
  // A fragment set while on the landing still opens its section page.
  await page.evaluate(() => {
    location.hash = "readiness";
  });
  await h1(page, "Readiness");
  assert.equal(path(page), "/settings/readiness");
  // A page that lists the workspace shows no counts or rows without it, never "0 projects".
  for (const [route, heading] of [
    ["/settings/projects", "Projects"],
    ["/settings/agents", "Agents"],
    ["/settings/routing", "Routing"],
  ] as const) {
    await page.goto(`${web.origin}${route}`);
    await h1(page, heading);
    await page.getByRole("button", { name: "Try again" }).first().waitFor();
    assert.equal(await page.locator(".settings-panel").count(), 0, route);
    assert.equal(await page.getByText(/^0 (projects|agents)/).count(), 0);
  }
  await page.unroute("**/api/operator/workspace", fail);
  await page.getByRole("button", { name: "Try again" }).first().click();
  await page.getByRole("link", { name: "Open routing for Relay" }).waitFor();
});

test("Show archived waits for its own read instead of listing no projects", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/projects");
  await page.getByText("Lead: Mira").waitFor();
  await page.route("**/api/operator/workspace?includeArchived=true", (r) =>
    r.fulfill({
      status: 503,
      json: { error: { code: "unavailable", message: "x" } },
    }),
  );
  await page.getByLabel("Show archived").check();
  await page
    .getByText("Archived projects are unavailable. Try again.")
    .waitFor();
  assert.equal(await page.getByText(/^0 projects/).count(), 0);
  assert.equal(await page.locator("article.settings-row").count(), 0);
});

test("legacy Settings fragments open their section page, keeping the query", async (_t, journey) => {
  const { page, web } = await startSettings(
    journey,
    "/tasks",
    desktop,
    undefined,
    {
      turnStarted: false,
    },
  );
  for (const [legacy, canonical, heading] of [
    ["/settings#notifications", "/settings/notifications", "Notifications"],
    ["/settings?x=1#profiles", "/settings/agents?x=1", "Agents"],
    [
      "/settings#readiness-codex-login",
      "/settings/readiness#readiness-codex-login",
      "Readiness",
    ],
    // Unknown and malformed fragments drop, so the landing applies (Readiness before a turn).
    ["/settings#nope", "/settings/readiness", "Readiness"],
    ["/settings#%E0%A4%A", "/settings/readiness", "Readiness"],
  ] as const) {
    await page.goto("about:blank");
    await page.goto(`${web.origin}${legacy}`);
    await h1(page, heading);
    assert.equal(path(page), canonical, legacy);
    // The rewrite replaced the entry: Back returns to the blank page.
    await page.goBack();
    await page.waitForURL("about:blank");
  }
  // An in-app link to a legacy address is recorded at its section page.
  await page.goto(`${web.origin}/tasks`);
  await page.locator("main h1").waitFor();
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/settings#cli-credentials";
    a.id = "legacy";
    a.textContent = "legacy";
    document.querySelector("main")?.prepend(a);
  });
  await page.locator("#legacy").click();
  await h1(page, "CLI credentials");
  assert.equal(path(page), "/settings/cli-credentials");
});

test("signed-out legacy and /app addresses reach their section after sign-in", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/tasks");
  for (const [entry, canonical, heading] of [
    [
      "/settings#cli-credentials",
      "/settings/cli-credentials",
      "CLI credentials",
    ],
    ["/app/settings#readiness", "/settings/readiness", "Readiness"],
    ["/app/settings/notifications", "/settings/notifications", "Notifications"],
  ] as const) {
    await page.context().clearCookies();
    await page.goto("about:blank");
    await signIn(page, web, entry);
    await h1(page, heading);
    assert.equal(path(page), canonical, entry);
  }
});

test("section links push entries, focus the heading at the top, and Back and Forward return", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/projects", {
    width: 1366,
    height: 500,
  });
  await h1(page, "Projects");
  const link = (name: string) =>
    nav(page).getByRole("link", { name, exact: true });
  await page.evaluate(() => scrollTo(0, 60));
  await link("Agents").click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Agents",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    "H1",
  );
  assert.equal(await page.evaluate(() => scrollY), 0);
  await link("Readiness").click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Readiness",
  );
  await page.goBack();
  await h1(page, "Agents");
  assert.deepEqual(await current(page), ["Agents"]);
  await page.goBack();
  await h1(page, "Projects");
  await page.waitForFunction(() => scrollY === 60);
  await page.goForward();
  await h1(page, "Agents");
  assert.deepEqual(await current(page), ["Agents"]);
});

test("Back to a section restores its saved position once its reads have grown the page", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/projects", {
    width: 1366,
    height: 400,
  });
  await page.getByText("Lead: Mira").waitFor();
  await page.waitForLoadState("networkidle");
  // The bottom of the loaded page: unreachable while its rows are still loading.
  const saved = await page.evaluate(() => {
    scrollTo(0, document.documentElement.scrollHeight);
    return scrollY;
  });
  assert.ok(saved > 100, String(saved));
  const held: Route[] = [];
  const hold = (r: Route) => {
    held.push(r);
  };
  const back = async (act?: () => Promise<void>) => {
    // Clicked in script, so the page leaves from the position it was scrolled to.
    await nav(page)
      .getByRole("link", { name: "Agents", exact: true })
      .evaluate((a) => (a as HTMLElement).click());
    await h1(page, "Agents");
    await page.route("**/api/operator/projects/*/configuration", hold);
    await page.goBack();
    await h1(page, "Projects");
    await page.getByText("Loading configuration…").first().waitFor();
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    // Still loading: the shorter page cannot hold the saved position yet.
    assert.ok((await page.evaluate(() => scrollY)) < saved);
    await act?.();
    for (const r of held.splice(0)) await r.continue();
    await page.unroute("**/api/operator/projects/*/configuration", hold);
    await page.getByText("Lead: Mira").waitFor();
  };
  await back();
  await page
    .waitForFunction((y) => Math.abs(scrollY - y) < 1, saved, {
      timeout: 3000,
    })
    .catch(async () =>
      assert.fail(
        `restored to ${await page.evaluate(() => scrollY)} of ${saved}`,
      ),
    );
  // Reader input while it loads keeps the reader's position instead.
  await back(() => page.mouse.wheel(0, -40));
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  assert.ok((await page.evaluate(() => scrollY)) < saved);
});

test("both account menus mark Settings current on section and detail pages", async (_t, journey) => {
  const { page, web, ids } = await startSettings(
    journey,
    "/settings/notifications",
  );
  const settingsItem = () =>
    page.getByRole("menuitem", { name: "Settings", exact: true });
  for (const route of [
    "/settings/notifications",
    `/projects/${ids.atlas}/settings`,
    `/profiles/${ids.profiles.Mira}/settings`,
    "/settings/projects/new",
  ]) {
    await page.goto(`${web.origin}${route}`);
    await page.locator("main h1").waitFor();
    await page.getByRole("button", { name: /account$/ }).click();
    assert.equal(
      await settingsItem().getAttribute("aria-current"),
      "true",
      route,
    );
    await page.keyboard.press("Escape");
  }
  await page.goto(`${web.origin}/tasks`);
  await page.locator("main h1").waitFor();
  await page.getByRole("button", { name: /account$/ }).click();
  assert.equal(await settingsItem().getAttribute("aria-current"), null);
  await page.keyboard.press("Escape");
  // The phone drawer lists the same Settings row.
  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/settings/notifications`);
  await page
    .getByRole("button", { name: "Projects and navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Projects and navigation" });
  assert.equal(
    await drawer
      .getByRole("link", { name: "Settings", exact: true })
      .getAttribute("aria-current"),
    "true",
  );
});

test("phone Back links the parent: Settings, Projects, Agents or Runtime", async (_t, journey) => {
  const { page, web, ids } = await startSettings(
    journey,
    "/settings/notifications",
    phone,
  );
  for (const [route, label, href] of [
    ["/settings/notifications", "Settings", "/settings"],
    ["/settings/runtime", "Settings", "/settings"],
    ["/settings/projects/new", "Projects", "/settings/projects"],
    [`/projects/${ids.atlas}/settings`, "Projects", "/settings/projects"],
    ["/settings/profiles/new", "Agents", "/settings/agents"],
    [`/profiles/${ids.profiles.Mira}/settings`, "Agents", "/settings/agents"],
    [
      `/assignments/${ids.assignmentId}/recovery`,
      "Runtime",
      "/settings/runtime",
    ],
  ] as const) {
    await page.goto(`${web.origin}${route}`);
    const back = page.getByRole("link", { name: `Back to ${label}` });
    await back.waitFor();
    assert.equal(await back.getAttribute("href"), href, route);
  }
});

test("the phone section list opens from a house button and its links navigate by keyboard", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/projects", phone);
  await h1(page, "Projects");
  const trigger = page.getByRole("button", { name: "Sections · Projects" });
  const list = nav(page).locator("ul");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(
    await trigger.getAttribute("aria-controls"),
    await list.getAttribute("id"),
  );
  assert.equal(await list.isHidden(), true);
  await trigger.focus();
  await page.keyboard.press("Enter");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await page.keyboard.press(" ");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.keyboard.press(" ");
  // Arrow keys do not move between links or navigate.
  await page.keyboard.press("ArrowDown");
  assert.equal(path(page), "/settings/projects");
  assert.equal(await focusedText(page), "Sections · Projects");
  await page.keyboard.press("Tab");
  assert.equal(await focusedText(page), "Projects");
  await page.keyboard.press("Tab");
  assert.equal(await focusedText(page), "Runtime & recovery");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focusedText(page), "Projects");
  for (const height of await nav(page)
    .locator("a, button")
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height)))
    assert.ok(height >= 44, String(height));
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-settings-sections-open");
  // Activating a link navigates and the list is closed on arrival.
  await nav(page).getByRole("link", { name: "Notifications" }).focus();
  await page.keyboard.press("Enter");
  await h1(page, "Notifications");
  const next = page.getByRole("button", { name: "Sections · Notifications" });
  assert.equal(await next.getAttribute("aria-expanded"), "false");
  assert.equal(await list.isHidden(), true);
  // A tap opens and a tapped link navigates.
  await next.click();
  await nav(page).getByRole("link", { name: "Agents" }).click();
  await h1(page, "Agents");
});

test("crossing 760px moves focus from a hidden control to its counterpart", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/routing", {
    width: 800,
    height: 844,
  });
  await h1(page, "Routing");
  // From the persistent list to a phone: a focused link gives focus to the button.
  await nav(page).getByRole("link", { name: "Agents" }).focus();
  await page.setViewportSize({ width: 759, height: 844 });
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Sections · Routing",
  );
  assert.equal(await nav(page).locator("ul").isHidden(), true);
  // From the phone button to the persistent list: focus goes to the current link.
  await page.setViewportSize({ width: 760, height: 844 });
  await page.waitForFunction(() =>
    document.activeElement?.matches('a[aria-current="page"]'),
  );
  assert.equal(await focusedText(page), "Routing");
  assert.equal(
    await page.getByRole("button", { name: /^Sections/ }).count(),
    0,
  );
});

/** Section-owned reads: shared shell reads (session, workspace, tasks, Inbox, events) are left out. */
function recordReads(page: Page) {
  const reads: string[] = [];
  const shared =
    /^\/api\/operator\/(?:session|workspace$|task-list|inbox|events|live)/;
  const on = (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/operator/")) return;
    if (request.method() !== "GET") return;
    const read = url.pathname + url.search;
    if (!shared.test(read)) reads.push(read.replace(/[0-9a-f-]{36}/g, ":id"));
  };
  page.on("request", on);
  return {
    reads,
    stop: () => page.off("request", on),
  };
}

test("each section page reads only what it shows", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/tasks");
  const config = "/api/operator/projects/:id/configuration";
  const expected: Record<string, string[]> = {
    "/settings/projects": [
      config,
      config,
      config,
      "/api/operator/runtime",
      "/api/operator/source-observations",
    ],
    "/settings/runtime": ["/api/operator/runtime"],
    "/settings/agents": [],
    "/settings/routing": [config, config, config],
    "/settings/github-discovery": ["/api/operator/discovery"],
    "/settings/gitlab-credentials": ["/api/operator/code-host-credentials"],
    "/settings/cli-credentials": ["/api/operator/credentials"],
    "/settings/notifications": ["/api/operator/notifications"],
    "/settings/readiness": [
      "/api/operator/discovery",
      "/api/operator/readiness",
    ],
  };
  for (const [route, , heading] of sections) {
    await page.goto("about:blank");
    const recorder = recordReads(page);
    await page.goto(`${web.origin}${route}`);
    await h1(page, heading);
    await page.waitForLoadState("networkidle");
    recorder.stop();
    assert.deepEqual(recorder.reads.sort(), expected[route], route);
  }
  // Show archived adds only the archived workspace read.
  await page.goto(`${web.origin}/settings/projects`);
  await page.getByText("Lead: Mira").waitFor();
  await page.waitForLoadState("networkidle");
  const archived = recordReads(page);
  const workspace = page.waitForRequest((r) =>
    r.url().endsWith("/api/operator/workspace?includeArchived=true"),
  );
  await page.getByLabel("Show archived").check();
  await workspace;
  await page.waitForLoadState("networkidle");
  archived.stop();
  assert.deepEqual(
    archived.reads.filter((r) => !r.endsWith("/configuration")),
    ["/api/operator/workspace?includeArchived=true"],
  );
  // Header Refresh re-reads only the mounted page's own resources.
  await page.goto(`${web.origin}/settings/notifications`);
  await h1(page, "Notifications");
  await page.waitForLoadState("networkidle");
  const refreshed = recordReads(page);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForLoadState("networkidle");
  refreshed.stop();
  assert.deepEqual(refreshed.reads, ["/api/operator/notifications"]);
});

test("leaving Projects mid-read aborts its configuration reads and late replies stay away", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/notifications");
  await h1(page, "Notifications");
  const held: Route[] = [];
  const hold = (r: Route) => {
    held.push(r);
  };
  await page.route("**/api/operator/projects/*/configuration", hold);
  const aborted: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().endsWith("/configuration")) aborted.push(r.url());
  });
  await nav(page).getByRole("link", { name: "Projects", exact: true }).click();
  await h1(page, "Projects");
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Loading configuration…"),
  );
  await nav(page).getByRole("link", { name: "Agents", exact: true }).click();
  await h1(page, "Agents");
  await page.waitForFunction(() => true);
  await page.unroute("**/api/operator/projects/*/configuration", hold);
  for (const r of held) await r.continue().catch(() => {});
  await page.waitForTimeout(200);
  assert.ok(aborted.length > 0, "configuration reads were aborted");
  assert.equal(await page.getByText("Lead: Mira").count(), 0);
  assert.equal(await page.getByText("Repository access").count(), 0);
});

test("unfinished credential input is kept across sections and nothing is sent", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/gitlab-credentials");
  const commands: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) commands.push(r.url());
  });
  const gitlab = page.getByRole("region", { name: "GitLab credentials" });
  await gitlab.getByRole("button", { name: "Add GitLab host" }).click();
  await gitlab.getByLabel("GitLab host").fill("gitlab.draft.example");
  await nav(page).getByRole("link", { name: "Notifications" }).click();
  await h1(page, "Notifications");
  await nav(page).getByRole("link", { name: "GitHub discovery" }).click();
  await h1(page, "GitHub discovery");
  await page.getByRole("button", { name: /^(Set|Change)$/ }).click();
  await page.getByLabel("Environment variable · advanced").check();
  await nav(page).getByRole("link", { name: "GitLab credentials" }).click();
  await h1(page, "GitLab credentials");
  assert.equal(
    await gitlab.getByLabel("GitLab host").inputValue(),
    "gitlab.draft.example",
  );
  await nav(page).getByRole("link", { name: "GitHub discovery" }).click();
  await h1(page, "GitHub discovery");
  assert.equal(
    await page.getByLabel("Environment variable · advanced").isChecked(),
    true,
  );
  assert.deepEqual(commands, []);
});
