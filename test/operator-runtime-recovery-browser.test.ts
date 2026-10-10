import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { holdPills } from "../web/src/settings-view.js";
import {
  noPageOverflow,
  phone,
  startSettings,
  trail,
} from "./fixtures/operator-settings.js";

const test = browserSuite("ui08-settings-runtime");

test("Runtime saves a lowered capacity from a change list and lists recovery destinations", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/settings/runtime",
  );
  await page
    .getByRole("heading", { level: 1, name: "Runtime capacity and recovery" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Runtime");
  await page
    .getByText(/\d+ of \d+ active turns in use; projects default to 2\./)
    .waitFor();
  const save = page.getByRole("button", { name: "Save capacity", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.getByLabel("Set capacity override for Relay").waitFor();
  await page
    .getByText("Usage 1 / effective limit 2 · Project paused", { exact: false })
    .waitFor();
  await page
    .getByText(
      "may belong to a held execution; pausing or saving capacity does not release it",
      {
        exact: false,
      },
    )
    .waitFor();
  const global = page.getByLabel("Global active-turn cap", { exact: true });
  const before = await global.inputValue();
  await global.fill("1");
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText(`Global active-turn cap: ${before} → 1`)
    .waitFor();
  await save.click();
  await page
    .locator(".settings-saved")
    .getByText("Recorded capacity limits: global 1", { exact: false })
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save capacity" && b.disabled,
    ),
  );
  assert.equal(await global.inputValue(), "1");
  assert.equal(f.runtime.turns, 0);
  const card = page.locator("article", { hasText: "Restore webhook delivery" });
  await card.getByText("Execution hold recorded").waitFor();
  assert.equal(
    await card.getByRole("link", { name: "Task detail" }).getAttribute("href"),
    `/app/tasks/${ids.taskId}`,
  );
  assert.equal(
    await card
      .getByRole("link", { name: "Task controls" })
      .getAttribute("href"),
    `/runtime/task/${ids.taskId}`,
  );
  assert.equal(
    await card
      .getByRole("link", { name: "Worker: recovery evidence" })
      .getAttribute("href"),
    `/app/assignments/${ids.assignmentId}/recovery`,
  );
  await captureBrowserEvidence(page, "1366-runtime");
});

test("Assignment recovery is read-only, shows the uncertainty alert and five independent holds", async (_t, journey) => {
  const { ids, page, web } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
  );
  await page
    .getByRole("heading", { level: 1, name: "Assignment recovery evidence" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Runtime / Assignment recovery");
  const read = (await (
    await page.request.get(
      `${web.origin}/api/operator/assignments/${ids.assignmentId}/recovery`,
    )
  ).json()) as { data: { holds: Parameters<typeof holdPills>[0] } };
  assert.equal(read.data.holds.uncertainty, true);
  await page.getByText("Execution may still be active.").waitFor();
  const pills = await page
    .locator(".settings-pill")
    .evaluateAll((es) => es.map((e) => e.textContent));
  assert.deepEqual(
    pills,
    holdPills(read.data.holds).map((h) => `${h.label}${h.value}`),
  );
  await page.getByText("Revisions and actual admitted generation").waitFor();
  await page
    .getByText("1 older recovery record omitted", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Inspect execution" })
      .getAttribute("href"),
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
  );
  const hrefs = await page
    .getByRole("complementary", {
      name: "Advanced destinations · desktop-first",
    })
    .getByRole("link")
    .evaluateAll((es) => es.map((e) => e.getAttribute("href")));
  assert.deepEqual(hrefs, [
    `/runtime/assignment/${ids.assignmentId}`,
    `/runtime/task/${ids.taskId}`,
    `/coordination/assignment/${ids.assignmentId}`,
    `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
    `/coordination/task/${ids.taskId}`,
    `/assignment/${ids.assignmentId}`,
  ]);
  assert.equal(await page.locator("main form").count(), 0);
  assert.deepEqual(await page.locator("main button").allInnerTexts(), [
    "Refresh",
  ]);
  assert.equal((await page.content()).includes("PRIVATE"), false);
  await captureBrowserEvidence(page, "1366-recovery");
});

test("phone recovery shows Recovery, current holds and the next step", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/assignments/:assignment/recovery",
    phone,
  );
  await page.getByRole("heading", { level: 1, name: "Recovery" }).waitFor();
  await page.getByRole("link", { name: "Back to Runtime" }).waitFor();
  await page.getByRole("complementary", { name: "Current holds" }).waitFor();
  await page.getByRole("region", { name: "Next step" }).waitFor();
  const height = await page
    .getByRole("link", { name: "Inspect execution" })
    .evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(height >= 44, `Inspect execution is ${height}px`);
  assert.equal(await page.getByText("Copy desktop link").count(), 0);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-recovery");
});
