import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  noPageOverflow,
  phone,
  startSettings,
} from "./fixtures/operator-settings.js";
import { commandRequest } from "./fixtures/setup-browser.js";

const test = browserSuite("ui826-claude-token");
const NAME = "FIXTURE_CLAUDE_TOKEN",
  VALUE = "fixture-claude-token-value-5521";

/** Restores the fixture variable after each test. */
function environment(t: { after: (fn: () => void) => void }) {
  const previous = process.env[NAME];
  t.after(() => {
    if (previous === undefined) delete process.env[NAME];
    else process.env[NAME] = previous;
  });
}

test("Settings sets, shows and clears the Claude token reference without showing it", async (t, journey) => {
  environment(t);
  delete process.env[NAME];
  const { f, web, page } = await startSettings(journey, "/app/settings");
  const row = page.getByRole("region", { name: "Claude subscription token" });
  await row.getByText("Claude subscription token · not configured").waitFor();
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  await row.getByRole("button", { name: "Set", exact: true }).click();
  const input = row.getByLabel("Claude token reference");
  await row.getByText("claude setup-token", { exact: false }).waitFor();
  await input.fill("env:bad");
  await row.getByRole("button", { name: "Save reference" }).click();
  await row.getByText("Check this field.").waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Claude token reference",
  );
  assert.equal(sent, 0);
  await input.fill(`env:${NAME}`);
  const request = commandRequest(page);
  await row.getByRole("button", { name: "Save reference" }).click();
  assert.equal((await request).postDataJSON().credentialRef, `env:${NAME}`);
  await row
    .getByText(
      "Claude subscription token · reference configured · no value in the service environment",
    )
    .waitFor();
  assert.equal(f.service.domain().claudeTokenReference(), `env:${NAME}`);
  // A value set after the service started is available to the next turn.
  process.env[NAME] = VALUE;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await row
    .getByText("Claude subscription token · reference configured · available")
    .waitFor();
  const status = await page.evaluate(async () =>
    (await fetch("/api/operator/claude-token")).text(),
  );
  assert.match(status, /"state":"available"/);
  for (const text of [status, await page.locator("body").innerText()]) {
    assert.equal(text.includes(NAME), false);
    assert.equal(text.includes(VALUE), false);
  }
  await captureBrowserEvidence(page, "1366-settings-claude-token");
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
  await row.getByText("Claude subscription token · not configured").waitFor();
  assert.equal(f.service.domain().claudeTokenReference(), null);
  await page.goto(`${web.origin}/app/settings`);
  await row.getByText("Claude subscription token · not configured").waitFor();
});

test("A Claude token already in the service environment needs a restart, and the row fits a phone", async (t, journey) => {
  environment(t);
  process.env[NAME] = VALUE;
  const { f, page } = await startSettings(journey, "/app/settings", phone);
  f.service.domain().execute({
    type: "claude-token.configure",
    actor: "operator",
    key: crypto.randomUUID(),
    credentialRef: `env:${NAME}`,
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const row = page.getByRole("region", { name: "Claude subscription token" });
  await row
    .getByText(
      "Claude subscription token · reference configured · restart the service to use it",
    )
    .waitFor();
  await row.getByRole("button", { name: "Change", exact: true }).click();
  await row.getByLabel("Claude token reference").waitFor();
  await noPageOverflow(page);
  const small = await row
    .locator("button, input")
    .evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect().height)
        .filter((h) => h > 0 && h < 44),
    );
  assert.deepEqual(small, []);
  assert.equal((await page.locator("body").innerText()).includes(VALUE), false);
  await captureBrowserEvidence(page, "390-settings-claude-token");
});
