import assert from "node:assert/strict";
import { webkit, type Locator } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  noPageOverflow,
  phone,
  startSettings,
  unpairedBadges,
} from "../fixtures/operator-settings.js";

const test = browserSuite("operator-settings-layout-browser");

/** A paused project is idle, not attention: one symbol beside the word. */
async function assertPausedBadgeIdle(scope: Locator) {
  const paused = scope.getByText("Paused", { exact: true });
  assert.equal(await paused.locator('svg[aria-hidden="true"]').count(), 1);
  const classes = (await paused.getAttribute("class")) ?? "";
  assert.ok(classes.includes("text-(--idle)"), classes);
  assert.ok(!classes.includes("text-(--attn)"), classes);
}

test("Settings index lists projects, profiles, routing and runtime from their own reads", async (_t, journey) => {
  const { ids, page } = await startSettings(journey, "/app/settings");
  const main = page.locator("main");
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
  const projects = main.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Projects", exact: true }),
  });
  await projects.getByText("3 projects · 1 paused", { exact: false }).waitFor();
  await projects.getByText("Lead: Mira").waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Configure Atlas", exact: true })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}/settings`,
  );
  await projects
    .getByText("acme/atlas · main · checkout configured", { exact: false })
    .waitFor();
  await projects.getByText("S-1 acme/atlas").waitFor();
  await projects.getByText("S-3 GitHub Project PVT_atlas · inactive").waitFor();
  // Relay and Fieldnotes link no repository; only Atlas has a GitHub source.
  assert.equal(await projects.getByText("None · repository-free").count(), 2);
  assert.equal(await projects.getByText("No GitHub source").count(), 2);
  await projects
    .getByText(
      "Discovery and readiness never grant repository access; each is listed separately.",
    )
    .waitFor();
  const profiles = main.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Profiles", exact: true }),
  });
  await profiles.getByText("7 profiles · 1 revoked").waitFor();
  assert.equal(await profiles.locator(".settings-row").count(), 7);
  await profiles.getByText("Review · revision 2").waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Edit Reviewer", exact: true })
      .getAttribute("href"),
    `/app/profiles/${ids.profiles.Reviewer}/settings`,
  );
  const routing = main.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Routing", exact: true }),
  });
  await routing
    .getByText("Enabled · 3 candidates · reference configured")
    .waitFor();
  assert.equal(await routing.getByText("Disabled · no candidates").count(), 2);
  assert.equal(
    await page
      .getByRole("link", { name: "Open routing for Relay", exact: true })
      .getAttribute("href"),
    `/app/projects/${ids.relay}/settings?tab=routing`,
  );
  await main
    .getByText("1 task with a recorded execution hold", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Open runtime", exact: true })
      .getAttribute("href"),
    "/app/settings/runtime",
  );
  const text = await page.locator("body").innerText();
  for (const secret of ["PRIVATE", "FIXTURE_GITHUB", "atlas-checkout"])
    assert.equal(text.includes(secret), false, secret);
  // Every state badge on the index pairs a symbol with its word; counts and labels do not.
  assert.deepEqual(await unpairedBadges(main), []);
  await assertPausedBadgeIdle(projects);
  const revoked = profiles.getByText("Revoked", { exact: true });
  assert.ok(
    ((await revoked.getAttribute("class")) ?? "").includes("text-(--attn)"),
  );
  await assertPausedBadgeIdle(
    page.getByRole("navigation", { name: "Operator navigation" }),
  );
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "1366-sidebar-paused-project");
  await captureBrowserEvidence(page, "1366-settings");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  assert.equal(await refresh.count(), 1);
  const workspace = page.waitForResponse((r) =>
      r.url().endsWith("/api/operator/workspace"),
    ),
    configuration = page.waitForResponse((r) =>
      r.url().endsWith(`/api/operator/projects/${ids.atlas}/configuration`),
    );
  await refresh.click();
  await Promise.all([workspace, configuration]);
});

test("a failed project configuration read marks only that row unavailable", async (_t, journey) => {
  const { ids, page, web } = await startSettings(
    journey,
    "/app/settings/runtime",
  );
  const route = `**/api/operator/projects/${ids.atlas}/configuration`;
  await page.route(route, (r) => r.fulfill({ status: 500, body: "{}" }));
  try {
    await page.goto(`${web.origin}/app/settings`);
    await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
    await page.getByRole("button", { name: "Retry Atlas" }).first().waitFor();
    await page.getByText("Lead: Jonas").waitFor();
    await page.getByText("None · repository-free").first().waitFor();
    // Relay and Fieldnotes only: the failed Atlas read is never shown as repository-free.
    assert.equal(await page.getByText("None · repository-free").count(), 2);
  } finally {
    await page.unroute(route);
  }
  await page.getByRole("button", { name: "Retry Atlas" }).first().click();
  await page.getByText("Lead: Mira").waitFor();
});

test("Settings index is one column with 44px targets on a phone", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings", phone);
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
  await page.getByText("7 profiles · 1 revoked").waitFor();
  await page.getByText("Lead: Mira").waitFor();
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  await noPageOverflow(page);
  const columns = await page
    .locator(".settings-index")
    .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  assert.equal(columns, 1);
  const short = await page
    .locator(".settings-page a, .settings-page button")
    .evaluateAll((es) =>
      es
        .filter((e) => e.getBoundingClientRect().height < 44)
        .map((e) => e.textContent),
    );
  assert.deepEqual(short, []);
  await captureBrowserEvidence(page, "390-settings");
  await page
    .getByRole("button", { name: "Projects and navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Projects and navigation" });
  await assertPausedBadgeIdle(drawer);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-drawer-paused-project");
});

test(
  "Settings index renders in WebKit",
  { browserEngine: "webkit" },
  async (_t, journey) => {
    const { page } = await startSettings(
      journey,
      "/app/settings",
      undefined,
      () => webkit.launch(),
    );
    await page.getByText("3 projects · 1 paused", { exact: false }).waitFor();
  },
);
