import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  createReleaseDeliveryFixture,
  until,
} from "../fixtures/delivery-integration.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { taskReadiness } from "../../web/src/task-overview.js";
import { openTaskTab } from "../fixtures/task-tabs.js";
const test = browserSuite("operator-delivery-integration-browser");

for (const mode of ["reviewable-pr", "through-merge"] as const) {
  test(`${mode} assembled production browser shows exact provider truth and completion on desktop and phone`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createReleaseDeliveryFixture(mode, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    await f.register();
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });
    j.observe(page);
    page.setDefaultTimeout(5000);
    const taskPath = `/app/tasks/${f.taskId}?section=changes`;
    const openTask = async () => {
      await page.goto(web.origin + taskPath);
      await page
        .getByRole("heading", { name: "Release delivery", exact: true })
        .waitFor();
      const data = (
        await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
      ).data;
      assert.equal(
        await page.locator("main [data-task-readiness]").innerText(),
        taskReadiness(data),
      );
    };
    await page.goto(web.origin + taskPath);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Release delivery", exact: true })
      .waitFor();
    await openTask();
    const changes = page.locator("#changes");
    await expectPullRequest(changes, f.scripted.state.head);
    await changes.getByText("build: Passed", { exact: true }).waitFor();
    // Each service blocker reads as a sentence; its code is only in Details.
    const blockers = (
      await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
    ).data.delivery?.blockers;
    if (mode === "reviewable-pr")
      assert.ok(
        blockers?.includes("reviewable-pr-awaiting-current-settlement"),
        String(blockers),
      );
    for (const code of blockers ?? [])
      assert.equal(
        (await changes.innerText()).includes(code),
        false,
        `${code} shown outside Details`,
      );
    if (mode === "reviewable-pr")
      await changes
        .getByText("Waiting for the current PR head to be settled.", {
          exact: true,
        })
        .waitFor();
    assert.equal(f.scripted.state.writes, 0);
    await sharedDestinations(page, web.origin, f.taskId, f.projectId);
    await openTask();
    f.scripted.state.check = "failure";
    await changes
      .getByRole("button", {
        name: "Refresh delivery status",
        exact: true,
      })
      .click();
    await changes.getByText("build: Failed", { exact: true }).waitFor();
    assert.equal((await f.merge()).success, false);
    assert.equal(f.scripted.state.writes, 0);
    f.scripted.state.feedback = true;
    await changes
      .getByRole("button", {
        name: "Refresh delivery status",
        exact: true,
      })
      .click();
    await changes
      .getByText("Repair literal feedback C1", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await captureBrowserEvidence(page, `${mode}-phone-feedback-check`);
    await sharedDestinations(page, web.origin, f.taskId, f.projectId);
    await openTask();
    const oldHead = f.scripted.state.head;
    f.scripted.state.head = "3".repeat(40);
    await changes
      .getByRole("button", {
        name: "Refresh delivery status",
        exact: true,
      })
      .click();
    await expectPullRequest(changes, f.scripted.state.head);
    assert.equal(await changes.locator(`abbr[title="${oldHead}"]`).count(), 0);
    f.scripted.state.outage = true;
    await changes
      .getByRole("button", {
        name: "Refresh delivery status",
        exact: true,
      })
      .click();
    await changes
      .getByText(/^Last GitHub read failed; showing the read from \d\d:\d\d\.$/)
      .waitFor();
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.scripted.state.writes, 0);
    f.scripted.state.outage = false;
    f.scripted.state.check = "success";
    await changes
      .getByRole("button", {
        name: "Refresh delivery status",
        exact: true,
      })
      .click();
    await changes.getByText("build: Passed", { exact: true }).waitFor();
    await f.terminal(1);
    await f.waitTurn(2);
    if (mode === "reviewable-pr") {
      assert.equal((await f.merge()).success, false);
      await openTask();
      const handback = changes.locator(".handback-settlement");
      await handback
        .getByText("Reviewable PR handed back.", { exact: true })
        .waitFor();
      const accept = handback.getByRole("button", {
        name: "Accept handback",
        exact: true,
      });
      const close = handback.getByRole("button", {
        name: "Settle as closed",
        exact: true,
      });
      assert.equal(await accept.count(), 1);
      assert.equal(await close.count(), 1);
      // Forged or stale material through the page's own session settles nothing.
      const read = (
        await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
      ).data;
      const binding = read.delivery?.binding;
      assert.ok(read.delivery && binding);
      const csrfToken = (
        (await (
          await page.request.get(`${web.origin}/api/operator/session`)
        ).json()) as {
          csrfToken: string;
        }
      ).csrfToken;
      const settle = (
        over: Record<string, unknown>,
        token: string = csrfToken,
      ) =>
        page.request.post(`${web.origin}/api/operator/commands`, {
          headers: { origin: web.origin, "x-csrf-token": token },
          data: {
            type: "delivery.settle",
            key: randomUUID(),
            taskId: f.taskId,
            expectedTaskVersion: read.task.version,
            expectedDeliveryRevision: binding.revision,
            expectedPolicyVersion: read.delivery?.policyVersion,
            expectedHeadSha: binding.headSha,
            decision: "accepted",
            ...over,
          },
          maxRedirects: 0,
        });
      assert.equal((await settle({}, "wrong")).status(), 403);
      assert.equal(
        (
          await settle({ expectedDeliveryRevision: binding.revision + 1 })
        ).status(),
        409,
      );
      assert.equal(
        (await settle({ expectedHeadSha: "5".repeat(40) })).status(),
        409,
      );
      assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
      // The provider moves the head: the shown material is stale, so nothing settles until it is reread.
      f.scripted.state.head = "4".repeat(40);
      assert.equal((await settle({})).status(), 409);
      assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
      await page.reload();
      await expectPullRequest(changes, f.scripted.state.head);
      await accept.click();
      await handback
        .getByRole("status")
        .filter({ hasText: /^Handback accepted for head/ })
        .waitFor();
      assert.equal(
        f.service.delivery().delivery(f.taskId)?.settlement?.decision,
        "accepted",
      );
      assert.equal(f.scripted.state.writes, 0);
    } else {
      const merged = await f.merge();
      assert.equal(merged.success, true, merged.text);
      assert.equal(f.scripted.state.writes, 1);
      await openTask();
      await changes
        .getByText(
          "PR merged; task completion still requires its recorded completion workflow.",
          { exact: true },
        )
        .waitFor();
      assert.equal(f.service.domain().task(f.taskId).state, "open");
    }
    await f.terminal(2);
    await f.waitTurn(3);
    const completion = await f.call(
      "cab_request_completion",
      { reviewedResultIds: [] },
      3,
    );
    assert.equal(completion.success, true, completion.text);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    await f.terminal(3);
    await until(
      () => f.service.domain().task(f.taskId).state === "done",
      "browser Done",
    );
    await openTask();
    const persisted = f.readDb(
      (db) =>
        db
          .prepare("SELECT state FROM domain_tasks WHERE id=?")
          .get(f.taskId) as { state: string },
    );
    assert.equal(persisted.state, "done");
    await captureBrowserEvidence(page, `${mode}-phone-done`);
    await page.setViewportSize({ width: 1366, height: 900 });
    await sharedDestinations(page, web.origin, f.taskId, f.projectId, true);
    await openTask();
    await captureBrowserEvidence(page, `${mode}-desktop-done`);
    await browser.close();
    browser = undefined;
    await web.close();
    const writes = f.scripted.state.writes;
    await f.reopen();
    const reopenedWeb = await j.start("fixture.reopened-web", () =>
      f.startWeb(),
    );
    browser = await j.start("browser.reopened", () => chromium.launch());
    const reopened = await browser.newPage();
    j.observe(reopened);
    await reopened.goto(reopenedWeb.origin + taskPath);
    await reopened.getByLabel("Password").fill(reopenedWeb.password);
    await reopened
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await reopened
      .getByRole("heading", { name: "Release delivery", exact: true })
      .waitFor();
    assert.match(
      await reopened.locator("main [data-task-readiness]").innerText(),
      /^Done/,
    );
    assert.equal(f.scripted.state.writes, writes);
    assert.equal(f.runtime.turns, 0);
  });
}

/** The PR line links the PR in its own repository and shows the exact head the provider reported. */
async function expectPullRequest(changes: Locator, head: string) {
  const link = changes.getByRole("link", {
    name: "org/repo#7 (opens GitHub)",
    exact: true,
  });
  await link.waitFor();
  assert.equal(
    await link.getAttribute("href"),
    "https://github.com/org/repo/pull/7",
  );
  await changes.locator(`abbr[title="${head}"]`).first().waitFor();
}

async function sharedDestinations(
  page: Page,
  origin: string,
  taskId: string,
  projectId: string,
  done = false,
) {
  // The delivery task is not Ready, so each surface asks for Any readiness.
  for (const route of ["/app", "/app/tasks", `/app/projects/${projectId}`]) {
    await page.goto(`${origin}${route}?ready=any`);
    if (done)
      await page.getByLabel("State", { exact: true }).selectOption("Done");
    const task = page.locator(`[data-task-id="${taskId}"]`).first();
    await task
      .getByRole("link", { name: "Release delivery", exact: true })
      .waitFor();
    assert.match(await task.innerText(), /org\/repo#1/);
    if (done) assert.match(await task.innerText(), /Done/);
    if (route !== "/app") {
      await page.getByRole("button", { name: "Board", exact: true }).click();
      // The column chips exist only below the shell breakpoint; wider boards show every column.
      if ((page.viewportSize()?.width ?? 0) < 1121) {
        const bar = page.getByRole("toolbar", { name: "Board columns" });
        const status = await bar
          .getByRole("button")
          .filter({ hasText: /· 1$/ })
          .first()
          .innerText();
        await bar.getByRole("button", { name: status, exact: true }).click();
      }
      try {
        await task
          .getByRole("link", { name: "Release delivery", exact: true })
          .waitFor();
      } catch (error) {
        throw new Error(
          `Board assertion ${route}; DOM: ${(await page.locator("body").innerText()).slice(0, 5000)}`,
          { cause: error },
        );
      }
      assert.match(await task.innerText(), /org\/repo#1/);
    }
    await task
      .getByRole("link", { name: "Release delivery", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Release delivery", exact: true })
      .waitFor();
  }
  await page.goto(`${origin}/app/inbox`);
  // Routine delivery progress never invents an actionable request.
  assert.equal(
    await page.getByText("Repair literal feedback C1", { exact: true }).count(),
    0,
  );
}

test("uncertain effect and independent Stop remain visible after restart; expired session retains composer input without an effect", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createReleaseDeliveryFixture("through-merge", j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  await f.register();
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${f.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Release delivery", exact: true })
    .waitFor();
  await page.goto(`${web.origin}/app/tasks/new?project=${f.projectId}`);
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Retain the exact composer input");
  await page
    .getByLabel("Desired outcome", { exact: true })
    .fill("Retain the supplied outcome");
  const tasksBefore = f.service.domain().tasks(f.projectId).length;
  f.advanceClock(61_000);
  // Choosing the project again reads its composer options, which finds the expired session.
  await page.getByLabel("Project", { exact: true }).selectOption("");
  await page.getByLabel("Project", { exact: true }).selectOption(f.projectId);
  await page.getByLabel("Password").waitFor();
  assert.equal(f.scripted.state.writes, 0);
  assert.equal(f.service.domain().tasks(f.projectId).length, tasksBefore);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Retain the exact composer input",
  );
  assert.equal(
    await page.getByLabel("Desired outcome", { exact: true }).inputValue(),
    "Retain the supplied outcome",
  );
  f.scripted.state.unknownEffect = true;
  assert.equal((await f.merge()).success, false);
  await page.goto(`${web.origin}/app/tasks/${f.taskId}?section=changes`);
  await page
    .locator("#changes")
    .getByText(/pr.merge: uncertain/)
    .waitFor();
  assert.equal(f.scripted.state.writes, 1);
  await captureBrowserEvidence(page, "phone-uncertain-effect");
  await page.goto(`${web.origin}/runtime/task/${f.taskId}`);
  await page
    .getByRole("button", { name: "Best-effort Stop", exact: true })
    .click();
  await until(
    () => !f.service.list().some((i) => i.state === "running"),
    "Stop observed",
  );
  await browser.close();
  browser = undefined;
  await web.close();
  await f.reopen();
  const restarted = await j.start("fixture.reopened-web", () => f.startWeb());
  browser = await j.start("browser.reopened", () => chromium.launch());
  page = await browser.newPage();
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${restarted.origin}/app/tasks/${f.taskId}?section=changes`);
  await page.getByLabel("Password").fill(restarted.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator("#changes")
    .getByText(/pr.merge: uncertain/)
    .waitFor();
  // The hold line is in Overview's decision card; the strip names the state on every tab.
  await openTaskTab(page, "Overview");
  const heldLines = page
    .getByRole("list", { name: "Also held", exact: true })
    .locator("li");
  await heldLines.first().waitFor();
  const heldLabels = (await heldLines.allInnerTexts()).map(
    (line) => line.split("\n")[0],
  );
  // A Stop-only task has no separate task hold line.
  assert.deepEqual(heldLabels, [
    "Operator Stop",
    "Writer ownership",
    "Capacity",
    "Uncertainty",
  ]);
  assert.equal(
    await page.getByText(/hold — use exact recovery controls/).count(),
    0,
  );
  assert.equal(f.runtime.turns, 0);
  assert.equal(f.scripted.state.writes, 1);
  assert.equal(f.service.domain().task(f.taskId).state, "open");
  await captureBrowserEvidence(page, "desktop-restarted-stop-uncertainty");
});

test("a pull request in another repository is named by number only, never by the provider's repository id, on every surface", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createReleaseDeliveryFixture("reviewable-pr", j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  await f.register();
  await f.terminal(1);
  const providerId = "R_kgDOcross";
  f.moveBoundPullRequestToRepository(providerId);
  await f.reopen();
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${f.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Release delivery", exact: true })
    .waitFor();
  const inspector = page.locator('aside[aria-label="Task context"]');
  await inspector
    .getByText("Reviewable PR · PR #7 · open", { exact: true })
    .waitFor();
  await inspector.getByText("PR #7 · open", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: /#7/ }).count(), 0);
  await openTaskTab(page, "Changes");
  const changes = page.locator("#changes");
  await changes
    .getByText("No GitHub link: this PR's repository name was not observed.", {
      exact: false,
    })
    .waitFor();
  assert.equal(await changes.locator('a[href*="/pull/"]').count(), 0);
  // No surface of the task page names the repository: neither the id nor the source's name.
  for (const tab of ["Overview", "Changes"] as const) {
    await openTaskTab(page, tab);
    const text = await page.locator("body").innerText();
    assert.doesNotMatch(
      text,
      /R_kgDO|org\/repo#7/,
      `${tab} shows a repository name`,
    );
  }
});
