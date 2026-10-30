import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { configure, until } from "../fixtures/completed-lead.js";
import { refusedTask } from "../fixtures/refused-task.js";
import { stubReadiness } from "../fixtures/setup-browser.js";

const test = browserSuite("ui-task-restart");

const viewports = {
  desktop: { width: 1366, height: 900 },
  phone: { width: 390, height: 844 },
};

for (const [name, viewport] of Object.entries(viewports)) {
  test(`Start again and Reset task are offered from the task page, the Inbox and Home (${name})`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const detail = await refusedTask(f);
    const inbox = await refusedTask(f);
    const home = await refusedTask(f);
    const held = await refusedTask(f);
    const reset = await refusedTask(f);
    f.seedPersistedState((db) =>
      db
        .prepare(
          "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent hold')",
        )
        .run(held.taskId),
    );
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page: Page = await browser.newPage({ viewport });
    j.observe(page);
    // Home shows its Needs you cards only once the getting-started rows pass.
    await stubReadiness(page);
    page.setDefaultTimeout(5000);
    const commands: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      const body = request.postData() ?? "";
      if (
        request.method() === "POST" &&
        /"task\.(start-again|reset)"/.test(body)
      )
        commands.push(JSON.parse(body));
    });
    await page.goto(`${web.origin}/app/tasks/${detail.taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("main.page h1").waitFor();

    const startAgain = () =>
      page.getByRole("button", { name: "Start again", exact: true });

    // Task detail: the state reads Not started, never Uncertain.
    await page.locator("[data-task-strip]").waitFor();
    await startAgain().waitFor();
    assert.equal(
      await page.locator("[data-task-strip] .task-state").innerText(),
      "Not started",
    );
    assert.equal(await page.getByText("Uncertain").count(), 0);
    assert.equal(commands.length, 0);
    await startAgain().click();
    await page.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.type, "task.start-again");
    assert.equal(commands[0]?.workId, detail.workId);
    assert.equal(
      commands[0]?.expectedVersion,
      Number(f.service.domain().task(detail.taskId).version),
    );

    // Home shows its board once a task has started a turn: let the restarted one run.
    configure(f, detail.projectId, false);
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 8 });
    await until(() => f.runtime.hasPending(1), "the restarted turn starts");

    // A hold that may be live shows its reason and the recovery, and sends nothing.
    await page.goto(`${web.origin}/app/tasks/${held.taskId}`);
    await page
      .getByText(/Start again isn't offered: an execution is unresolved/)
      .waitFor();
    assert.equal(
      await page
        .locator("[data-start-again]")
        .getByRole("link", { name: "Open recovery" })
        .getAttribute("href"),
      `/runtime/task/${held.taskId}`,
    );
    // Reset is disabled, with its reason as the tooltip.
    if (viewport.width < 760)
      await page.locator(".task-header-overflow-toggle").click();
    const disabledReset = page.getByRole("button", { name: "Reset task…" });
    assert.equal(await disabledReset.isDisabled(), true);
    assert.match(
      (await disabledReset.getAttribute("title")) ?? "",
      /the task or an assignment is held/,
    );
    assert.equal(await startAgain().count(), 0);
    assert.equal(commands.length, 1);

    // The Inbox intervention offers the same action.
    await page.goto(
      `${web.origin}/app/inbox?task=${inbox.taskId}&request=${encodeURIComponent(`intervention:${inbox.taskId}`)}`,
    );
    await startAgain().waitFor();
    await startAgain().click();
    await page.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 2);
    assert.equal(commands[1]?.workId, inbox.workId);

    // Home's Needs you card offers it in place.
    await page.goto(`${web.origin}/app`);
    const card = page.locator(
      `.overview-card[data-request-id="intervention:${home.taskId}"]`,
    );
    await card
      .getByRole("button", { name: "Start again", exact: true })
      .click();
    await card.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 3);
    assert.equal(commands[2]?.workId, home.workId);

    // Reset task confirms first, says it cannot be undone and sends once on confirm.
    await page.goto(`${web.origin}/app/tasks/${reset.taskId}`);
    await page.locator("[data-task-strip]").waitFor();
    if (viewport.width < 760)
      await page.locator(".task-header-overflow-toggle").click();
    await page.getByRole("button", { name: "Reset task…" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText(/cannot be undone/).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(commands.length, 3, "Cancel sends nothing");
    if (
      viewport.width < 760 &&
      !(await page
        .locator("details.task-header-overflow")
        .evaluate((d) => (d as HTMLDetailsElement).open))
    )
      await page.locator(".task-header-overflow-toggle").click();
    await page.getByRole("button", { name: "Reset task…" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset task", exact: true })
      .click();
    await page
      .getByText(/Reset\. The lead starts a fresh conversation/)
      .waitFor();
    assert.equal(commands.length, 4);
    assert.equal(commands[3]?.type, "task.reset");
    assert.equal(
      commands[3]?.expectedVersion,
      Number(f.service.domain().task(reset.taskId).version),
    );

    // A restarted request refused again (the task changed under it) is a new offer: the page
    // shows Start again for it, not the earlier confirmation. Made last: Home shows few cards.
    const again = await refusedTask(f);
    await page.goto(`${web.origin}/app/tasks/${again.taskId}`);
    await startAgain().click();
    await page.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 5);
    const domain = f.service.domain();
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: again.projectId,
      taskId: again.taskId,
      expectedVersion: Number(domain.task(again.taskId).version),
      outcome: "Changed again after the restart",
    } as never);
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 3 });
    await page.getByRole("button", { name: "Refresh task" }).click();
    await startAgain().waitFor();
    assert.equal(commands.length, 5);

    // A command the service recorded but whose reply was lost stays reachable and checkable
    // after a later read changes what is offered: the check resends the same keyed command.
    const loseNextReply = async (type: string, committed?: () => void) => {
      let armed = true;
      await page.route("**/api/operator/commands", async (route) => {
        if (armed && (route.request().postData() ?? "").includes(`"${type}"`)) {
          armed = false;
          await route.fetch();
          committed?.();
          await route.abort();
        } else await route.fallback();
      });
    };
    const sameKeyTwice = (type: string, taskId: string) => {
      const sent = commands.filter(
        (c) => c.type === type && c.taskId === taskId,
      );
      assert.equal(sent.length, 2, type);
      assert.equal(sent[0]?.key, sent[1]?.key, type);
    };
    const check = () =>
      page.getByRole("button", { name: "Check whether it saved" });
    // Refresh task, and wait until its read has been applied.
    const refreshTask = async (taskId: string) => {
      const read = page.waitForResponse(
        (r) =>
          r.request().method() === "GET" &&
          new RegExp(`/api/operator/tasks/${taskId}(\\?.*)?$`).test(r.url()),
      );
      await page.getByRole("button", { name: "Refresh task" }).click();
      await read;
      await page.waitForTimeout(300);
    };

    // Reset: recorded, reply lost, dialog dismissed, a read makes Reset unavailable.
    const lostReset = await refusedTask(f);
    await page.goto(`${web.origin}/app/tasks/${lostReset.taskId}`);
    await page.locator("[data-task-strip]").waitFor();
    await loseNextReply("task.reset");
    const openReset = async () => {
      if (
        viewport.width < 760 &&
        !(await page
          .locator("details.task-header-overflow")
          .evaluate((d) => (d as HTMLDetailsElement).open))
      )
        await page.locator(".task-header-overflow-toggle").click();
      await page.getByRole("button", { name: "Reset task…" }).click();
    };
    await openReset();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset task", exact: true })
      .click();
    await check().waitFor();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await refreshTask(lostReset.taskId);
    await openReset();
    await check().click();
    await page
      .getByText(/Reset\. The lead starts a fresh conversation/)
      .waitFor();
    sameKeyTwice("task.reset", lostReset.taskId);

    // Start again on the task page: recorded, reply lost, a read drops the not-started code.
    const lostStart = await refusedTask(f);
    await page.goto(`${web.origin}/app/tasks/${lostStart.taskId}`);
    await loseNextReply("task.start-again");
    await startAgain().click();
    await check().waitFor();
    await refreshTask(lostStart.taskId);
    await check().click();
    await page.getByText(/Queued again\./).waitFor();
    sameKeyTwice("task.start-again", lostStart.taskId);

    // The same in the Inbox, where a refresh drops the request from the queue.
    const lostInbox = await refusedTask(f);
    await page.goto(
      `${web.origin}/app/inbox?task=${lostInbox.taskId}&request=${encodeURIComponent(`intervention:${lostInbox.taskId}`)}`,
    );
    await loseNextReply("task.start-again");
    await startAgain().click();
    await check().waitFor();
    // The phone's detail view has no Refresh: its next poll (every 15s) is the read.
    if (viewport.width >= 760)
      await page
        .getByRole("button", { name: /^Refresh/ })
        .first()
        .click();
    await page
      .getByText(/has left the current queue/)
      .waitFor({ timeout: 20000 });
    await check().click();
    await page.getByText(/Queued again\./).waitFor();
    sameKeyTwice("task.start-again", lostInbox.taskId);

    // And in Home's card, which re-reads the Inbox as soon as the start is sent.
    const lostHome = await refusedTask(f);
    await page.goto(`${web.origin}/app`);
    const lostCard = page.locator(
      `.overview-card[data-request-id="intervention:${lostHome.taskId}"]`,
    );
    await lostCard
      .getByRole("button", { name: "Start again", exact: true })
      .waitFor();
    // The card must outlive a read that no longer lists the request: hold the Inbox read the
    // click triggers until the service has recorded the start.
    let release = () => {};
    const recorded = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/operator/inbox**", async (route) => {
      await recorded;
      await route.fallback();
    });
    const dropped = page.waitForResponse(
      async (r) =>
        r.url().includes("/api/operator/inbox") &&
        !(await r.text()).includes(`intervention:${lostHome.taskId}`),
      { timeout: 20000 },
    );
    dropped.catch(() => {});
    await loseNextReply("task.start-again", release);
    await lostCard
      .getByRole("button", { name: "Start again", exact: true })
      .click();
    await lostCard
      .getByRole("button", { name: "Check whether it saved" })
      .waitFor();
    await dropped;
    await page.waitForTimeout(300);
    await lostCard
      .getByRole("button", { name: "Check whether it saved" })
      .click();
    await lostCard.getByText(/Queued again\./).waitFor();
    sameKeyTwice("task.start-again", lostHome.taskId);
  });
}

async function openRestartPage(
  j: BrowserJourney,
  hold: { browser?: Browser },
  first: string,
) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  j.cleanup(
    (primary) => f.close(hold.browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const task = await refusedTask(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  hold.browser = await j.start("browser.launch", () => chromium.launch());
  const page = await hold.browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  await stubReadiness(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}${first.replace("TASK", task.taskId)}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  return { f, task, web, page };
}
const checkButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: "Check whether it saved" });

test("an unconfirmed Reset is still checkable from the header after leaving the task and coming back", async (_t, j) => {
  const hold: { browser?: Browser } = {};
  const { page } = await openRestartPage(j, hold, "/app/tasks/TASK");
  const sent: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      (request.postData() ?? "").includes('"task.reset"')
    )
      sent.push(request.postData() ?? "");
  });
  await page.locator("[data-task-strip]").waitFor();
  // The send never reaches the service, so Reset is still on offer when the task is reopened.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await page.getByRole("button", { name: "Reset task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Reset task", exact: true }).click();
  await checkButton(dialog).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForURL(/\/app\/inbox/);
  await page.goBack();
  await page.locator("[data-task-strip]").waitFor();
  await page.getByRole("button", { name: "Reset task…" }).click();
  await checkButton(dialog).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Reset task", exact: true })
      .count(),
    0,
    "an unconfirmed reset is checked, not sent again",
  );
  await page.unroute("**/api/operator/commands");
  await checkButton(dialog).click();
  await dialog
    .getByText(/Reset\. The lead starts a fresh conversation/)
    .waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0], "same key and body");
});

test("an unconfirmed Start again whose request was recorded is still checkable after leaving the task and coming back", async (_t, j) => {
  const hold: { browser?: Browser } = {};
  const { page } = await openRestartPage(j, hold, "/app/tasks/TASK");
  const sent: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      (request.postData() ?? "").includes('"task.start-again"')
    )
      sent.push(request.postData() ?? "");
  });
  // The service records the start but the reply is lost, which clears the not-started code.
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await checkButton(page).waitFor();
  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForURL(/\/app\/inbox/);
  await page.goBack();
  await checkButton(page).waitFor();
  await page.unroute("**/api/operator/commands");
  await checkButton(page).click();
  await page.getByText(/Queued again\./).waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0], "same key and body");
});

test("the header drops Reset task… once the task is no longer open", async (_t, j) => {
  const hold: { browser?: Browser } = {};
  const { f, page, task } = await openRestartPage(j, hold, "/app/tasks/TASK");
  await page.locator("[data-task-strip]").waitFor();
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "Reset task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Reset task", exact: true }).click();
  await checkButton(dialog).waitFor();
  await page.unroute("**/api/operator/commands");
  await checkButton(dialog).click();
  await dialog
    .getByText(/Reset\. The lead starts a fresh conversation/)
    .waitFor();
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });

  // The task finishes elsewhere; nothing about the checked reset keeps its control in the header.
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_tasks SET state = 'done', version = version + 1 WHERE id = ?",
    ).run(task.taskId);
  });
  await page.getByRole("button", { name: "Refresh task" }).click();
  await page
    .locator(".page-header .task-header-actions")
    .getByRole("link", { name: "Execution" })
    .waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("[data-task-strip] .task-state")
        ?.textContent?.includes("Not started"),
  );
  assert.equal(
    await page
      .locator(".page-header .task-header-actions")
      .getByRole("button", { name: "Reset task…" })
      .count(),
    0,
  );
});

test("Home counts a kept Start again card once in its N more total", async (_t, j) => {
  const hold: { browser?: Browser } = {};
  const { f, page, task, web } = await openRestartPage(
    j,
    hold,
    "/app/tasks/TASK",
  );
  // Home shows its Needs you cards once a task has started a turn: let this one run.
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await page.getByText(/Queued again\./).waitFor();
  configure(f, task.projectId, false);
  await f.service.configureCapacity({ key: randomUUID(), globalLimit: 8 });
  await until(() => f.runtime.hasPending(1), "the restarted turn starts");

  // Home lists interventions, which carry no time, by task id. Fix the ids up front so the
  // request added later sorts ahead of the kept (last) one without depending on random UUIDs.
  const [aheadId, ...initial] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ].sort((a, b) => a.localeCompare(b));
  const ids: string[] = [...initial];
  for (const id of initial) await refusedTask(f, id);
  const kept = initial.at(-1)!;
  const card = (taskId: string) =>
    page.locator(`.overview-card[data-request-id="intervention:${taskId}"]`);
  const overflow = page.locator(".overview-overflow");
  await page.goto(`${web.origin}/app`);
  await card(kept).waitFor();
  assert.equal(await overflow.count(), 0);
  // The send never reaches the service, so the request stays listed.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await card(kept)
    .getByRole("button", { name: "Start again", exact: true })
    .click();
  await checkButton(card(kept)).waitFor();

  const ahead = (await refusedTask(f, aheadId)).taskId;
  ids.push(ahead);
  await page
    .getByRole("button", { name: "Refresh tasks", exact: true })
    .click();
  await card(ahead).waitFor();
  // The kept card is shown beyond the first three; the count leaves it out.
  assert.equal(await card(kept).count(), 1);
  const shown = await page.locator(".overview-card").count();
  assert.ok(shown > 3, "the kept card is the fourth shown");
  assert.equal(
    (await overflow.count()) === 0
      ? 0
      : Number((await overflow.innerText()).match(/^(\d+) more/)?.[1]),
    ids.length - shown,
  );
});
