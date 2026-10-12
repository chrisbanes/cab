import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createFakeGh, fakeGhToken } from "./fixtures/fake-gh.js";
import { commandRequest, setupJourney } from "./fixtures/setup-browser.js";
const test = browserSuite("ui06-discovery-credential");

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
  const status = await page.evaluate(async () =>
    (await fetch("/api/operator/discovery")).text(),
  );
  assert.match(status, /"source":"env"/);
  assert.equal(status.includes("FIXTURE_DISCOVERY"), false);
  assert.equal(
    (await page.locator("body").innerText()).includes("FIXTURE_DISCOVERY"),
    false,
  );
  // An unknown outcome keeps the attempt until the exact submission is reconciled.
  await page.route("**/api/operator/commands", (route) => route.abort());
  try {
    await row.getByRole("button", { name: "Clear", exact: true }).click();
    await row
      .getByRole("button", { name: "Reconcile exact submission" })
      .waitFor();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await row.getByRole("button", { name: "Reconcile exact submission" }).click();
  await row.getByText("GitHub discovery credential · not configured").waitFor();
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
      .getByRole("button", { name: "Reconcile exact submission" })
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
      .getByRole("button", { name: "Reconcile exact submission" })
      .waitFor();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await page
    .getByRole("button", { name: "Reconcile exact submission" })
    .click();
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
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
