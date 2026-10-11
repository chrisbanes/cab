import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { commandRequest, setupJourney } from "./fixtures/setup-browser.js";
const test = browserSuite("ui06-discovery-credential");

test("Settings sets, shows and clears the discovery credential reference", async (_t, journey) => {
  const { f, web, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  // An invalid reference is a field error and sends nothing.
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  await row.getByRole("button", { name: "Set", exact: true }).click();
  const input = row.getByLabel("Discovery credential reference");
  await input.fill("env:bad");
  await row.getByRole("button", { name: "Save reference" }).click();
  await row.getByText("Check this field.").waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Discovery credential reference",
  );
  assert.equal(sent, 0);
  await input.fill("env:FIXTURE_DISCOVERY");
  const request = commandRequest(page);
  await row.getByRole("button", { name: "Save reference" }).click();
  assert.deepEqual(
    (await request).postDataJSON().credentialRef,
    "env:FIXTURE_DISCOVERY",
  );
  await row
    .getByText("GitHub discovery credential · reference configured")
    .waitFor();
  await row.getByRole("button", { name: "Change", exact: true }).waitFor();
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "env:FIXTURE_DISCOVERY",
  );
  const status = await page.evaluate(async () =>
    (await fetch("/api/operator/discovery")).text(),
  );
  assert.match(status, /"configured":true/);
  assert.equal(status.includes("FIXTURE_DISCOVERY"), false);
  assert.equal(
    (await page.locator("body").innerText()).includes("FIXTURE_DISCOVERY"),
    false,
  );
  await captureBrowserEvidence(page, "1366-settings-discovery");
  // Setup reflects the configured reference.
  await page.goto(`${web.origin}/app/settings/projects/new`);
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
  await page.goto(`${web.origin}/app/settings`);
  // Unknown outcome freezes the form until the exact submission is reconciled.
  await row.getByRole("button", { name: "Change", exact: true }).click();
  await page.route("**/api/operator/commands", (route) => route.abort());
  try {
    await row.getByRole("button", { name: "Clear reference" }).click();
    await row
      .getByRole("button", { name: "Reconcile exact submission" })
      .waitFor();
    assert.equal(await input.isDisabled(), true);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await row.getByRole("button", { name: "Reconcile exact submission" }).click();
  await row.getByText("GitHub discovery credential · not configured").waitFor();
  assert.equal(f.service.domain().discoveryCredentialReference(), null);
  await page.goto(`${web.origin}/app/settings/projects/new`);
  await page
    .getByText(
      "GitHub discovery is unavailable: no discovery credential is configured",
      { exact: false },
    )
    .waitFor();
});

test("The discovery credential row fits a phone", async (_t, journey) => {
  const { page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    viewport: { width: 390, height: 844 },
  });
  const row = page.getByRole("region", { name: "GitHub discovery credential" });
  await row.getByRole("button", { name: "Set", exact: true }).click();
  await row.getByLabel("Discovery credential reference").waitFor();
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
