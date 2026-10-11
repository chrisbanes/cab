import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { phone, startSettings, trail } from "./fixtures/operator-settings.js";

const test = browserSuite("ui08-settings-profiles");

test("Create profile records revision 1 with a breadcrumb, boundary aside and Cancel", async (_t, journey) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings/profiles/new",
  );
  await page
    .getByRole("heading", { level: 1, name: "Create profile" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Profiles / Create profile");
  await page.getByRole("complementary", { name: "Profile boundary" }).waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Cancel", exact: true })
      .getAttribute("href"),
    "/app/settings",
  );
  await page.getByLabel("Profile name", { exact: true }).fill("Tester");
  await page.getByLabel("Summary", { exact: true }).fill("Testing");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("PRIVATE TESTER INSTRUCTIONS");
  await page.getByLabel("Capabilities", { exact: true }).fill("Runs tests");
  await captureBrowserEvidence(page, "1366-profile-create");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await page.getByText("Recorded profile.create", { exact: false }).waitFor();
  const created = f.service
    .domain()
    .profiles()
    .find((r) => r.name === "Tester");
  assert.equal(Number(created?.version), 1);
});

test("Reviewer profile edits in place, restores and revokes, and replaces private instructions", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  const d = f.service.domain();
  await page
    .getByRole("heading", {
      level: 1,
      name: "Reviewer · profile configuration",
    })
    .waitFor();
  await page.locator(".settings-status").getByText("Revoked").waitFor();
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Review",
  );
  assert.equal(
    await page.getByLabel("Capabilities", { exact: true }).inputValue(),
    "Reviewer capabilities",
  );
  await page
    .getByRole("complementary", { name: "Effect of revocation" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Open advanced profile editor" })
      .getAttribute("href"),
    `/profile/${reviewer}`,
  );
  const read = await page.request.get(
    `${web.origin}/api/operator/profiles/${reviewer}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  assert.equal((await page.content()).includes("PRIVATE"), false);
  const save = page.getByRole("button", { name: "Save profile", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page
    .getByLabel("Capabilities", { exact: true })
    .fill("Reviews diffs and screenshots");
  const changes = page.getByRole("region", { name: "Changes to save" });
  await changes.getByText("Capabilities edited").waitFor();
  assert.equal(await save.isEnabled(), true);
  await page.getByRole("button", { name: "Restore profile" }).click();
  await changes.getByText("Restore Reviewer").waitFor();
  await captureBrowserEvidence(page, "1366-profile-revoked");
  await save.click();
  await page.locator(".settings-status").getByText("Available").waitFor();
  assert.equal(d.profile(reviewer).revoked, 0);
  assert.equal(
    d.profile(reviewer).capabilities,
    "Reviews diffs and screenshots",
  );
  await page.getByRole("button", { name: "Revoke profile" }).waitFor();
  await page.getByText("Saved Reviewer ·", { exact: false }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save profile" && b.disabled,
    ),
  );
  await page.getByRole("button", { name: "Revoke profile" }).click();
  await save.click();
  await page.locator(".settings-status").getByText("Revoked").waitFor();
  assert.equal(d.profile(reviewer).revoked, 1);
  await page.getByLabel("Replace instructions", { exact: true }).check();
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE NEW REVIEWER INSTRUCTIONS");
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText("Instructions replaced", { exact: false })
    .waitFor();
  await save.click();
  await page.getByLabel("New instructions", { exact: true }).waitFor({
    state: "detached",
  });
  assert.equal(
    d.profile(reviewer).instructions,
    "PRIVATE NEW REVIEWER INSTRUCTIONS",
  );
  assert.equal(
    d.profile(reviewer).capabilities,
    "Reviews diffs and screenshots",
  );
  assert.equal((await page.content()).includes("PRIVATE"), false);
});

test("a profile conflict keeps typed input until the latest revision is adopted", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  await page.getByLabel("Summary", { exact: true }).waitFor();
  await page.getByLabel("Summary", { exact: true }).fill("Typed summary");
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(f.service.domain().profile(reviewer).version),
    capabilities: "Changed elsewhere",
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Configuration changed.", { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Typed summary",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Current revision 3.").waitFor();
  await page
    .getByRole("button", { name: "Review latest profile revision" })
    .click();
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Typed summary",
  );
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".settings-saved") !== null,
  );
  assert.equal(f.service.domain().profile(reviewer).summary, "Typed summary");
});

test("project settings highlight the project in the sidebar; phone profile pages use Back", async (_t, journey) => {
  const { ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  await page
    .getByRole("heading", { level: 1, name: "Atlas · project configuration" })
    .waitFor();
  assert.equal(
    await page
      .locator("aside.sidebar")
      .getByRole("link", { name: "Atlas" })
      .getAttribute("aria-current"),
    "true",
  );
  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/profiles/${ids.profiles.Mira}/settings`);
  await page
    .getByRole("heading", { level: 1, name: "Mira · profile configuration" })
    .waitFor();
  await page.getByRole("link", { name: "Back to Settings" }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "Breadcrumb" }).isVisible(),
    false,
  );
  await captureBrowserEvidence(page, "390-profile");
});
