import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { createFakeGh, fakeGhToken } from "../fixtures/fake-gh.js";
import {
  outcomeMessages,
  savedOutcome,
} from "../fixtures/operator-settings.js";
import { commandRequest, setupJourney } from "../fixtures/setup-browser.js";
const test = browserSuite("operator-discovery-credential-browser");

test("Settings uses the GitHub CLI login, then clears it", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, web, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  // Cancel closes the form without a command.
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByText("Signed in to github.com as @octo").waitFor();
  await row.getByRole("button", { name: "Cancel" }).click();
  await row.getByRole("button", { name: "Set", exact: true }).waitFor();
  assert.equal(sent, 0);
  await row.getByRole("button", { name: "Set", exact: true }).click();
  assert.equal(
    await row.getByLabel("GitHub CLI · recommended").isChecked(),
    true,
  );
  const request = commandRequest(page);
  await row.getByRole("button", { name: "Use this login" }).click();
  assert.equal((await request).postDataJSON().credentialRef, "gh:github.com");
  await row
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  // The form closes on save and the row it returns to confirms it.
  await savedOutcome(page);
  assert.equal(await row.locator('[data-slot="action-outcome"]').count(), 1);
  assert.equal(
    await row.getByRole("button", { name: "Use this login" }).count(),
    0,
  );
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(fakeGhToken),
    false,
  );
  await captureBrowserEvidence(page, "1366-settings-discovery-gh");
  // Setup lists repositories read with the gh login.
  await page.goto(`${web.origin}/app/settings/projects/new`);
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
  await page.goto(`${web.origin}/app/settings`);
  // Clear is the reverse path.
  const clear = commandRequest(page);
  await row.getByRole("button", { name: "Clear", exact: true }).click();
  assert.equal((await clear).postDataJSON().credentialRef, null);
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  await savedOutcome(page);
  assert.equal(f.service.domain().discoveryCredentialReference(), null);
});

test("Settings shows each GitHub CLI detection state without an action", async (_t, journey) => {
  const gh = createFakeGh("not-signed-in");
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  for (const [state, copy] of [
    ["not-signed-in", "gh not signed in · run gh auth login"],
    ["unreadable", "gh login unreadable from the service"],
  ] as const) {
    gh.set(state);
    await page.reload();
    await row.getByRole("button", { name: "Set", exact: true }).click();
    await row.getByText(copy).waitFor();
    assert.equal(
      await row.getByRole("button", { name: "Use this login" }).isDisabled(),
      true,
    );
  }
});

test("Settings reports a missing gh as not installed", async (_t, journey) => {
  // The fixture's default gh path does not exist.
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByText("gh not installed").waitFor();
  assert.equal(
    await row.getByRole("button", { name: "Use this login" }).isDisabled(),
    true,
  );
});

test("Settings sets an environment variable by name and reconciles an unknown clear", async (_t, journey) => {
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByLabel("Environment variable · advanced").check();
  const input = row.getByLabel("Variable name");
  // An invalid name is a field error and sends nothing.
  await input.fill("lower");
  await row.getByRole("button", { name: "Save reference" }).click();
  await row
    .getByText("Use upper-case letters, digits and underscores", {
      exact: false,
    })
    .waitFor();
  assert.equal(sent, 0);
  await input.fill("FIXTURE_DISCOVERY");
  const request = commandRequest(page);
  await row.getByRole("button", { name: "Save reference" }).click();
  assert.equal(
    (await request).postDataJSON().credentialRef,
    "env:FIXTURE_DISCOVERY",
  );
  await row
    .getByText("GitHub discovery credential · environment variable", {
      exact: false,
    })
    .waitFor();
  await savedOutcome(page);
  const status = await page.evaluate(async () =>
    (await fetch("/api/operator/discovery")).text(),
  );
  assert.match(status, /"source":"env"/);
  assert.equal(status.includes("FIXTURE_DISCOVERY"), false);
  assert.equal(
    (await page.locator("body").innerText()).includes("FIXTURE_DISCOVERY"),
    false,
  );
  // An unknown outcome keeps the attempt until the exact request is checked.
  await page.route("**/api/operator/commands", (route) => route.abort());
  const attempt = commandRequest(page);
  try {
    await row.getByRole("button", { name: "Clear", exact: true }).click();
    await row.getByRole("button", { name: "Check whether it saved" }).waitFor();
    assert.equal(await outcomeMessages(page).count(), 1);
    assert.equal(await outcomeMessages(page).getAttribute("role"), "alert");
    assert.equal(await outcomeMessages(page).getByRole("button").count(), 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandRequest(page);
  await row.getByRole("button", { name: "Check whether it saved" }).click();
  assert.equal(
    (await replay).postDataJSON().key,
    (await attempt).postDataJSON().key,
  );
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  await savedOutcome(page);
  assert.equal(f.service.domain().discoveryCredentialReference(), null);
});

test("Setup offers the detected GitHub CLI login in one step", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    ghExecutable: gh.executable,
  });
  const use = page.getByRole("button", {
    name: "Use GitHub CLI login (@octo)",
  });
  await use.waitFor();
  await page
    .getByText("Signed in to github.com as @octo with the GitHub CLI", {
      exact: false,
    })
    .waitFor();
  await page.getByRole("link", { name: "Set discovery credential" }).waitFor();
  const request = commandRequest(page);
  await use.click();
  assert.deepEqual(
    {
      type: (await request).postDataJSON().type,
      credentialRef: (await request).postDataJSON().credentialRef,
    },
    { type: "discovery.configure", credentialRef: "gh:github.com" },
  );
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
  // The save is confirmed like the Settings row, not left to the list reappearing.
  await savedOutcome(page);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  await captureBrowserEvidence(page, "1366-setup-use-gh-login");
});

test("Setup reconciles an unknown GitHub CLI login outcome", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    ghExecutable: gh.executable,
  });
  const use = page.getByRole("button", {
    name: "Use GitHub CLI login (@octo)",
  });
  // The service records the command but its response is lost, so a re-read sees it configured.
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  try {
    await use.click();
    await page
      .getByRole("button", { name: "Check whether it saved" })
      .waitFor();
    assert.equal(await use.count(), 0);
    // Leaving and returning re-reads discovery as configured; reconciliation stays offered.
    await page.getByRole("link", { name: "Set discovery credential" }).click();
    await page.locator("main.page h1", { hasText: "Settings" }).waitFor();
    await page.getByRole("link", { name: "New project" }).click();
    await page
      .getByText(
        "Discovered from GitHub · 3 repositories visible to the credential",
      )
      .waitFor();
    await page
      .getByRole("button", { name: "Check whether it saved" })
      .waitFor();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
  await savedOutcome(page);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("Setup offers no gh action when gh is not signed in", async (_t, journey) => {
  const gh = createFakeGh("not-signed-in");
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    discovery: false,
    ghExecutable: gh.executable,
  });
  await page.getByRole("link", { name: "Set discovery credential" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Use GitHub CLI login/ }).count(),
    0,
  );
});

test("The discovery credential row fits a phone", async (_t, journey) => {
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    viewport: { width: 390, height: 844 },
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByLabel("Environment variable · advanced").check();
  await row.getByLabel("Variable name").waitFor();
  await page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  const small = await row
    .locator("button, input")
    .evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect().height)
        .filter((h) => h > 0 && h < 44),
    );
  assert.deepEqual(small, []);
});

const fixLine = "Run `gh auth login`, or Settings → discovery credential";
const readinessRow = (page: Page) =>
  page.getByRole("article", { name: "GitHub discovery" });
const offerButton = (page: Page, login = "octo") =>
  readinessRow(page).getByRole("button", {
    name: `Use GitHub CLI login (@${login})`,
  });
const credentialRow = (page: Page) =>
  page.getByRole("region", { name: "GitHub discovery credential" });
/** Command requests the page sends, oldest first. */
function commandPosts(page: Page) {
  const posts: { type: string; key: string; credentialRef: unknown }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON());
  });
  return posts;
}

test("Readiness offers the detected GitHub CLI login and Run again changes nothing", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = readinessRow(page);
  const posts = commandPosts(page);
  await row.getByText("Not configured", { exact: true }).waitFor();
  await row.getByText("No GitHub discovery credential is configured").waitFor();
  await offerButton(page).waitFor();
  assert.equal(await row.locator(".identifier").count(), 0);

  // Run again only reads: no command, and the offer is still there afterwards.
  const reads: string[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname === "/api/operator/readiness")
      reads.push(`${r.method()} ${pathname}`);
  });
  await page.getByRole("button", { name: "Run again" }).click();
  await page.waitForFunction(
    () => !document.body.innerText.includes("Refreshing"),
  );
  assert.deepEqual(reads, ["GET /api/operator/readiness"]);
  assert.equal(posts.length, 0);
  await offerButton(page).waitFor();

  // Activating twice sends one command; the offer is exactly the existing configure.
  await offerButton(page).dblclick();
  await row.getByText("Pass", { exact: true }).waitFor();
  assert.equal(posts.length, 1);
  assert.deepEqual(
    { type: posts[0]?.type, credentialRef: posts[0]?.credentialRef },
    { type: "discovery.configure", credentialRef: "gh:github.com" },
  );
  assert.equal(await row.locator(".identifier").count(), 0);
  assert.equal(await row.getByRole("button").count(), 0);
  // Without a reload the credential row in its own section agrees.
  await credentialRow(page)
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(fakeGhToken),
    false,
  );

  // Clear is the counterpart: Readiness goes back to Not configured with the offer, and
  // the returned offer works from the keyboard and leaves focus on the row.
  await credentialRow(page)
    .getByRole("button", { name: "Clear", exact: true })
    .click();
  await row.getByText("Not configured", { exact: true }).waitFor();
  await offerButton(page).focus();
  await page.keyboard.press("Enter");
  await row.getByText("Pass", { exact: true }).waitFor();
  assert.equal(posts.length, 3);
  assert.equal(
    new Set(posts.map((p) => p.key)).size,
    3,
    "each offer is its own request",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "GitHub discovery",
  );
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  await captureBrowserEvidence(page, "1366-readiness-gh-offer");
});

test("Readiness keeps the existing fix line unless a gh login is signed in", async (_t, journey) => {
  const gh = createFakeGh("not-signed-in");
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = readinessRow(page);
  const posts = commandPosts(page);
  for (const state of ["not-signed-in", "unreadable"] as const) {
    gh.set(state);
    await page.reload();
    await row.getByText("Not configured", { exact: true }).waitFor();
    assert.equal(await row.locator(".identifier").innerText(), fixLine);
    assert.equal(await row.getByRole("button").count(), 0, state);
  }
  // Let both discovery reads finish, so only Run again can pick up the new login.
  await page.waitForLoadState("networkidle");
  // Signing in elsewhere shows up on Run again, which re-reads the detected login.
  gh.set("signed-in");
  await page.getByRole("button", { name: "Run again" }).click();
  await offerButton(page).waitFor();
  assert.equal(await row.locator(".identifier").count(), 0);
  assert.equal(posts.length, 0);
});

test("Readiness keeps the fix line when gh is not installed", async (_t, journey) => {
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
  });
  const row = readinessRow(page);
  await row.getByText("Not configured", { exact: true }).waitFor();
  assert.equal(await row.locator(".identifier").innerText(), fixLine);
  assert.equal(await row.getByRole("button").count(), 0);
});

test("Readiness keeps the fix line for a configured but unreadable credential", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  f.service.domain().execute({
    type: "discovery.configure",
    actor: "operator",
    key: randomUUID(),
    credentialRef: "env:ENSEMBLE_MISSING_DISCOVERY_VARIABLE",
  });
  await page.reload();
  const row = readinessRow(page);
  await row.getByText("Fail", { exact: true }).waitFor();
  assert.equal(await row.locator(".identifier").innerText(), fixLine);
  assert.equal(await row.getByRole("button").count(), 0);
  // The credential row keeps Change; the login is never offered over a configured reference.
  await credentialRow(page).getByRole("button", { name: "Change" }).waitFor();
});

test("Readiness reconciles an unknown GitHub CLI login outcome", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = readinessRow(page);
  const posts = commandPosts(page);
  await offerButton(page).waitFor();
  // The service records the command but its response is lost.
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  try {
    await offerButton(page).click();
    await row.getByRole("button", { name: "Check whether it saved" }).waitFor();
    assert.equal(await offerButton(page).count(), 0);
    // Leaving and returning keeps the unknown outcome and offers nothing to resend.
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await page.waitForURL("**/app/tasks");
    await page.goBack();
    await row.getByRole("button", { name: "Check whether it saved" }).waitFor();
    assert.equal(await offerButton(page).count(), 0);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await row.getByRole("button", { name: "Check whether it saved" }).click();
  await row.getByText("Pass", { exact: true }).waitFor();
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  // Checking resends the original request, never a new one.
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(await row.getByRole("button").count(), 0);
});
