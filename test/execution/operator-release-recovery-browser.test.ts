import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  noPageOverflow,
  phone,
  startSettings,
} from "../fixtures/operator-settings.js";

const test = browserSuite("operator-release-recovery-browser");

test("Release confirms, keeps the original request on refusal and lost reply, and shows blockers", async (_t, journey) => {
  const { page, f, ids } = await startSettings(
    journey,
    "/assignments/:assignment/recovery",
  );
  const posts: Array<Record<string, unknown>> = [];
  let blockedBy: string[] = ["thread-bound"],
    refuse = true,
    recorded = false;
  // Only presentation is under test: the release rules have service coverage.
  await page.route("**/recovery-options", async (route) => {
    const body = await (await route.fetch()).json();
    const record = body.data.records[0];
    record.workId = "held-work";
    record.intentState = "held";
    record.generation.workRevision = 1;
    record.paths = [
      { path: "release", eligible: blockedBy.length === 0, blockedBy },
    ];
    body.data.records = [record];
    body.data.gaps = [];
    await route.fulfill({ json: body });
  });
  await page.route("**/api/operator/commands", async (route) => {
    posts.push(route.request().postDataJSON());
    if (refuse)
      await route.fulfill({
        status: 409,
        json: { error: { code: "conflict", message: "State changed" } },
      });
    else {
      recorded = true;
      await route.abort("failed");
    }
  });
  await page.route("**/api/operator/operations?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    assert.equal(query.get("type"), "recovery.release");
    assert.equal(query.get("key"), posts[0]?.key);
    await route.fulfill({
      json: {
        observedAt: Date.now(),
        data: recorded
          ? {
              state: "recorded",
              receipt: {
                kind: "recovery-release",
                key: posts[0]?.key,
                recorded: true,
                path: "release",
                assignmentId: ids.assignmentId,
                workId: "held-work",
                refusalId: "14f1b0e1-3597-4469-9489-c3685e36684b",
              },
            }
          : { state: "not-recorded" },
      },
    });
  });
  await page.reload();
  const panel = page.locator(".settings-panel").filter({
    has: page.getByRole("heading", {
      name: "Release a generation that never sent a turn",
      exact: true,
    }),
  });
  const release = panel.getByRole("button", { name: "Release", exact: true });
  // A blocked generation names its blockers and can't be released.
  await panel.getByText("Release blocked: thread-bound.").waitFor();
  assert.equal(await release.isDisabled(), true);

  blockedBy = [];
  await page.reload();
  await panel.getByText(/Eligible: no thread or turn was saved/).waitFor();
  await release.click();
  const dialog = page.getByRole("alertdialog");
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await cancel.waitFor();
  assert.equal(
    await cancel.evaluate((e) => e === document.activeElement),
    true,
  );
  await captureBrowserEvidence(page, "1366-release-confirm");
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(posts.length, 0, "cancel sends nothing");

  await release.click();
  await dialog.getByRole("button", { name: "Confirm release" }).click();
  await panel.getByText(/Release refused \(conflict\)/).waitFor();
  assert.equal(posts.length, 1);
  assert.deepEqual(
    { ...posts[0], key: undefined },
    {
      type: "recovery.release",
      key: undefined,
      assignmentId: ids.assignmentId,
      workId: "held-work",
      workRevision: 1,
      requestSequence: posts[0]?.requestSequence,
    },
  );
  await panel.getByRole("button", { name: "Check original receipt" }).click();
  refuse = false;
  await panel.getByRole("button", { name: "Retry original release" }).click();
  await panel.getByText(/Outcome unknown/).waitFor();
  assert.deepEqual(posts[1], posts[0], "the retry resends the same request");
  await panel.getByRole("button", { name: "Check original receipt" }).click();
  await panel.getByText(/Released\. Writer and capacity are free/).waitFor();
  assert.equal(posts.length, 2);
  assert.equal(f.runtime.turns, 0, "release starts nothing");
  await page.setViewportSize(phone);
  await panel.scrollIntoViewIfNeeded();
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-release-recorded");
});
