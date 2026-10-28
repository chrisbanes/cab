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
import {
  commandRequest,
  settleGhRead,
  setupJourney,
} from "../fixtures/setup-browser.js";
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
    await row
      .getByText("GitHub discovery credential · not configured")
      .waitFor();
    assert.equal(
      await row.getByRole("button", { name: /Use GitHub CLI login/ }).count(),
      0,
    );
    assert.equal(await row.getByText(/keychain/).count(), 0);
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
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  assert.equal(
    await row.getByRole("button", { name: /Use GitHub CLI login/ }).count(),
    0,
  );
  assert.equal(await row.getByText(/keychain/).count(), 0);
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
  // Step 3 starts collapsed and the offer is already one activation away.
  await settleGhRead(page, () => page.reload());
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
  await use.waitFor();
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
  // Both of setup's reads have landed before anything is asserted absent.
  await settleGhRead(page, () => page.reload());
  await page.getByRole("button", { name: "Add a repository" }).waitFor();
  // Collapsed, it keeps the existing line and offers nothing.
  await page
    .getByText(
      "Optional. Without a repository the project is repository-free; adding one also offers GitHub discovery.",
    )
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Use GitHub CLI login/ }).count(),
    0,
  );
  assert.equal(await page.getByText(/keychain/).count(), 0);
  await page.getByRole("button", { name: "Add a repository" }).click();
  await page.getByRole("link", { name: "Set discovery credential" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Use GitHub CLI login/ }).count(),
    0,
  );
  assert.equal(await page.getByText(/keychain/).count(), 0);
});

test("The discovery credential row fits a phone", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
    viewport: { width: 390, height: 844 },
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  // The closed row with its one-click offer fits and keeps full-height targets.
  await row.getByRole("button", { name: /Use GitHub CLI login/ }).waitFor();
  await page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  assert.deepEqual(
    await row
      .locator("button")
      .evaluateAll((els) =>
        els
          .map((el) => el.getBoundingClientRect().height)
          .filter((h) => h > 0 && h < 44),
      ),
    [],
  );
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

const keychainNote = /If agents can reach this Mac's keychain/;
const settingsOffer = (page: Page, login = "octo") =>
  credentialRow(page).getByRole("button", {
    name: `Use GitHub CLI login (@${login})`,
  });

test("Settings offers the signed-in GitHub CLI login in one click", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = credentialRow(page);
  const posts = commandPosts(page);
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  await settingsOffer(page).waitFor();
  await row.getByRole("button", { name: "Set", exact: true }).waitFor();
  await row.getByText(keychainNote).waitFor();
  assert.equal(await row.getByLabel("GitHub CLI · recommended").count(), 0);
  // One press records the login; the form never opens.
  await settingsOffer(page).click();
  await row
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  await savedOutcome(page);
  assert.deepEqual(
    posts.map((c) => ({ type: c.type, credentialRef: c.credentialRef })),
    [{ type: "discovery.configure", credentialRef: "gh:github.com" }],
  );
  assert.equal(
    await row.getByRole("button", { name: /Use GitHub/ }).count(),
    0,
  );
  assert.equal(await row.getByText(keychainNote).count(), 0);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(fakeGhToken),
    false,
  );
  // Focus lands on Change, and Readiness agrees without a reload.
  await row.getByRole("button", { name: "Change", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Change",
  );
  await readinessRow(page).getByText("Pass", { exact: true }).waitFor();
  await captureBrowserEvidence(page, "1366-settings-discovery-gh-offer");
  // A later save through the form replaces the one-click confirmation with its own.
  await row.getByRole("button", { name: "Change", exact: true }).click();
  await row.getByLabel("Environment variable · advanced").check();
  await row.getByLabel("Variable name").fill("FIXTURE_Y");
  await row.getByRole("button", { name: "Save reference" }).click();
  await row
    .getByText(/GitHub discovery credential · environment variable/)
    .waitFor();
  await savedOutcome(page);
  await row.getByRole("button", { name: "Change", exact: true }).click();
  await row.getByLabel("GitHub CLI · recommended").check();
  await row.getByRole("button", { name: "Use this login" }).click();
  await row.getByText(/GitHub CLI · @octo/).waitFor();
  await savedOutcome(page);
  // Clear is the reverse path and brings the offer back, with one confirmation.
  await row.getByRole("button", { name: "Clear", exact: true }).click();
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  await settingsOffer(page).waitFor();
  await savedOutcome(page);
  // Set stays available for the environment variable.
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByLabel("Environment variable · advanced").check();
  await row.getByLabel("Variable name").fill("FIXTURE_X");
  await row.getByRole("button", { name: "Save reference" }).click();
  await row
    .getByText(
      "GitHub discovery credential · environment variable · no value in the service environment",
    )
    .waitFor();
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "env:FIXTURE_X",
  );
});

test("Settings holds Set while the one-click save is pending", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = credentialRow(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await settingsOffer(page).click();
    await row.getByRole("button", { name: "Saving…" }).waitFor();
    assert.equal(
      await row.getByRole("button", { name: "Set", exact: true }).isDisabled(),
      true,
    );
  } finally {
    release();
  }
  await row
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  await page.unroute("**/api/operator/commands");
  await row.getByRole("button", { name: "Change", exact: true }).waitFor();
  assert.equal(
    await row.getByRole("button", { name: "Change", exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("Settings reconciles an unknown one-click outcome", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = credentialRow(page);
  const check = row.getByRole("button", { name: "Check whether it saved" });
  // The service records the command but its response is lost.
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  try {
    await settingsOffer(page).click();
    await check.waitFor();
    assert.equal(await settingsOffer(page).count(), 0);
    assert.equal(await row.getByLabel("GitHub CLI · recommended").count(), 0);
    // No other credential write starts before the check: it resends the original command.
    assert.equal(
      await row.getByRole("button", { name: "Set", exact: true }).isDisabled(),
      true,
    );
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await check.click();
  await row
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  await savedOutcome(page);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

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
  await row.getByText(keychainNote).waitFor();
  assert.equal(await row.locator(".identifier").count(), 0);

  // Run again only reads: the readiness checks and the detected login, no command; the
  // offer is still there afterwards.
  const requests: string[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/api/"))
      requests.push(`${r.method()} ${pathname}`);
  });
  await page.getByRole("button", { name: "Run again" }).click();
  await page.waitForFunction(
    () => !document.body.innerText.includes("Refreshing"),
  );
  await page.waitForLoadState("networkidle");
  assert.deepEqual(requests.sort(), [
    "GET /api/operator/discovery",
    "GET /api/operator/readiness",
  ]);
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
  assert.equal(await row.getByText(keychainNote).count(), 0);
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
    assert.equal(await row.getByText(keychainNote).count(), 0, state);
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
    credentialRef: "env:CAB_MISSING_DISCOVERY_VARIABLE",
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

test("Readiness keeps the fix line when the discovery read fails", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = readinessRow(page);
  await offerButton(page).waitFor();
  await page.route("**/api/operator/discovery", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    }),
  );
  await page.getByRole("button", { name: "Run again" }).click();
  await row.locator(".identifier").waitFor();
  assert.equal(await row.locator(".identifier").innerText(), fixLine);
  assert.equal(await row.getByRole("button").count(), 0);
});

test("Readiness finishes an offer sent before the page was left and re-entered", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = readinessRow(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    await held;
    await route.continue();
  });
  await offerButton(page).click();
  // The page is left and re-entered while the save is still in flight.
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.waitForURL("**/app/tasks");
  await page.goBack();
  await row.waitFor();
  release();
  await row.getByText("Pass", { exact: true }).waitFor();
  await credentialRow(page)
    .getByText("GitHub CLI · @octo · read-only use")
    .waitFor();
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("Readiness leaves focus alone when the reader moved on before the offer finished", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = readinessRow(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    await held;
    await route.continue();
  });
  await offerButton(page).focus();
  await page.keyboard.press("Enter");
  // The reader tabs on to another control while the save is pending.
  await page.getByRole("link", { name: "Create project" }).focus();
  release();
  await row.getByText("Pass", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Create project",
  );
});

const elsewhereNote =
  "A discovery credential save elsewhere isn't confirmed yet. Check it there first.";
const checkSaved = (scope: Page | ReturnType<typeof credentialRow>) =>
  scope.getByRole("button", { name: "Check whether it saved" });
/** Records each command, then drops its reply so the page cannot tell it was saved. */
const dropCommandReplies = (page: Page) =>
  page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });

test("A Settings one-click save that is not confirmed holds the Readiness offer", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const posts = commandPosts(page);
  await offerButton(page).waitFor();
  await dropCommandReplies(page);
  try {
    await settingsOffer(page).click();
    await checkSaved(credentialRow(page)).waitFor();
    // Readiness reads the credential as unconfigured, but the save may have landed.
    assert.equal(await offerButton(page).getAttribute("aria-disabled"), "true");
    await readinessRow(page).getByText(elsewhereNote).waitFor();
    await offerButton(page).click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await checkSaved(credentialRow(page)).click();
  await readinessRow(page).getByText("Pass", { exact: true }).waitFor();
  assert.equal(await readinessRow(page).getByText(elsewhereNote).count(), 0);
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("A Readiness one-click save that is not confirmed holds the Settings credential controls", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = credentialRow(page);
  const posts = commandPosts(page);
  await offerButton(page).waitFor();
  await dropCommandReplies(page);
  try {
    await offerButton(page).click();
    await checkSaved(readinessRow(page)).waitFor();
    assert.equal(
      await settingsOffer(page).getAttribute("aria-disabled"),
      "true",
    );
    assert.equal(
      await row.getByRole("button", { name: "Set", exact: true }).isDisabled(),
      true,
    );
    await row.getByText(elsewhereNote).waitFor();
    await settingsOffer(page).click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await checkSaved(readinessRow(page)).click();
  await readinessRow(page).getByText("Pass", { exact: true }).waitFor();
  await row
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  assert.equal(await row.getByText(elsewhereNote).count(), 0);
  assert.equal(
    await row.getByRole("button", { name: "Change", exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("A Settings form save that is not confirmed holds the Readiness offer", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const row = credentialRow(page);
  const posts = commandPosts(page);
  await offerButton(page).waitFor();
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByLabel("GitHub CLI · recommended").check();
  await dropCommandReplies(page);
  try {
    await row.getByRole("button", { name: "Use this login" }).click();
    await checkSaved(row).waitFor();
    assert.equal(await offerButton(page).getAttribute("aria-disabled"), "true");
    await readinessRow(page).getByText(elsewhereNote).waitFor();
    await offerButton(page).click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await checkSaved(row).click();
  await readinessRow(page).getByText("Pass", { exact: true }).waitFor();
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("A Settings one-click save that is not confirmed holds the setup offer", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    ghExecutable: gh.executable,
  });
  const posts = commandPosts(page);
  await settingsOffer(page).waitFor();
  // The request never reaches the service, so setup still reads discovery as unconfigured.
  await page.route("**/api/operator/commands", (route) => route.abort());
  const use = page.getByRole("button", {
    name: "Use GitHub CLI login (@octo)",
  });
  try {
    await settingsOffer(page).click();
    await checkSaved(credentialRow(page)).waitFor();
    // In-app navigation keeps the unsettled draft; a reload would discard it.
    await page.getByRole("link", { name: "Create project" }).click();
    await use.waitFor();
    assert.equal(await use.getAttribute("aria-disabled"), "true");
    await page.getByText(elsewhereNote).waitFor();
    await use.click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
    await page.goBack();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await checkSaved(credentialRow(page)).click();
  await credentialRow(page)
    .getByText(
      "GitHub discovery credential · GitHub CLI · @octo · read-only use",
    )
    .waitFor();
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});
