import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { signOutFromSidebar } from "../fixtures/operator-account.js";
import { exhaustibleRuntime } from "../fixtures/runtime-exhaustion.js";
import { clockLabel } from "../../src/operator/clock-label.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  noPageOverflow,
  unpairedBadges,
} from "../fixtures/operator-settings.js";
import { choiceForm } from "../fixtures/question-data.js";
import { taskSchema, type TaskRead } from "../../src/operator/contracts.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  seedOwnApproval,
  seedOwnIntervention,
  seedOwnQuestion,
} from "../fixtures/questions.js";
const test = browserSuite("operator-inbox-browser");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
const projects = ["Atlas", "Relay", "Fieldnotes"];

/** Starts a fixture with `count` own questions across distinct projects and signs in at `path`. */
async function openInbox<T = undefined>(
  j: BrowserJourney,
  count: number,
  viewport: { width: number; height: number },
  path = "/app/inbox",
  extra?: (f: Fixture) => Promise<T>,
  fakeClock = false,
  runtimes?: Pick<
    ReturnType<typeof exhaustibleRuntime>,
    "factory" | "serviceOptions"
  >,
) {
  const f = await j.start("fixture.create", () =>
    runtimes
      ? (createOperatorFixture(
          null,
          undefined,
          undefined,
          j.fixtureOptions,
          runtimes.factory,
          runtimes.serviceOptions,
        ) as unknown as Promise<Fixture>)
      : createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const seeded = [];
  for (let i = 0; i < count; i++)
    seeded.push(
      await seedOwnQuestion(
        f,
        undefined,
        `Request ${i + 1}`,
        projects[i % projects.length],
      ),
    );
  const more = (await extra?.(f)) as T;
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(5000);
  // Installed before the page loads, so the Inbox's 15-second poll runs on the fake clock.
  if (fakeClock) await page.clock.install();
  await page.goto(`${web.origin}${path}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return { f: f as Fixture, page, web, seeded, more };
}

async function createdAtOf(page: Page, origin: string, title: string) {
  const inbox = (await (
    await page.request.get(`${origin}/api/operator/inbox`)
  ).json()) as {
    data: { items: Array<{ taskTitle: string; createdAt: number | null }> };
  };
  return inbox.data.items.find((item) => item.taskTitle === title)?.createdAt;
}

test("queue rows are request cards with kind, action and relative age; filters are compact; advanced controls are secondary (desktop)", async (_t, j) => {
  const { page, web } = await openInbox(j, 3, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  // The queue replaces the old heading and intro; the section keeps its name.
  assert.equal(
    await page.getByRole("heading", { name: "Action Inbox" }).count(),
    0,
  );
  assert.equal(
    await page
      .getByText("Questions, approvals and recorded interventions")
      .count(),
    0,
  );
  await page.getByRole("region", { name: "Action Inbox" }).waitFor();
  const project = page.getByLabel("Project", { exact: true }),
    kind = page.getByLabel("Request kind", { exact: true });
  assert.equal(
    await project.evaluate(
      (s) =>
        (s as HTMLSelectElement).options[(s as HTMLSelectElement).selectedIndex]
          ?.text,
    ),
    "All projects · 3",
  );
  assert.equal(
    await kind.evaluate(
      (s) =>
        (s as HTMLSelectElement).options[(s as HTMLSelectElement).selectedIndex]
          ?.text,
    ),
    "All request types · 3",
  );
  assert.deepEqual(
    await kind.evaluate((s) =>
      [...(s as HTMLSelectElement).options].map((o) => o.text),
    ),
    [
      "All request types · 3",
      "Questions · 3",
      "Approvals · 0",
      "Interventions · 0",
      "Runtime · 0",
    ],
  );
  // One group heading for questions and approvals, in server order under the filters.
  await page
    .locator(".inbox-queue .inbox-group", {
      hasText: "Questions & approvals · oldest first",
    })
    .waitFor();
  // Filters are compact controls, not full-width labelled fields.
  assert.ok((await project.boundingBox())!.width < 260);
  assert.equal(await page.locator(".inbox-filters label").count(), 0);

  // Rows created in the same second have no stable relative order, so pick by title.
  const first = rows.filter({ hasText: "Request 1" });
  // DOM text: the label is uppercased by CSS only.
  const text = (await first.textContent()) ?? "";
  for (const expected of ["Atlas", "Question", "Request 1", "Answer question"])
    assert.ok(text.includes(expected), `${expected} in ${text}`);
  assert.equal(
    await first.locator(".inbox-row-label").textContent(),
    "Question",
  );
  // The title is the question; the task and project are the subtitle.
  assert.equal(await first.locator("strong").textContent(), "Explain");
  assert.equal(
    await first.locator(".inbox-row-subtitle").textContent(),
    "Atlas / Request 1",
  );
  assert.doesNotMatch(text, /Operator answer requested/);
  const created = await createdAtOf(page, web.origin, "Request 1");
  assert.ok(created);
  assert.equal(
    await first.locator("time").getAttribute("datetime"),
    new Date(created).toISOString(),
  );
  // 106 minutes after the request reads "1h 46m".
  await page.clock.setFixedTime(created + 106 * 60_000);
  await page.reload();
  await rows.nth(2).waitFor();
  assert.ok(
    (await first.locator(".inbox-row-meta").innerText()).endsWith("1h 46m"),
  );

  // The legacy coordination index is reached from the account menu, not the queue.
  assert.equal(
    await page
      .getByRole("link", { name: "Advanced coordination controls" })
      .count(),
    0,
  );
  await captureBrowserEvidence(page, "1366-inbox-queue", { fullPage: false });
});

test("filtered-empty and all-empty states explain themselves and offer the way out (desktop)", async (_t, j) => {
  const { page } = await openInbox(j, 3, { width: 1366, height: 900 });
  await page.locator(".inbox-row").nth(2).waitFor();
  await page
    .getByLabel("Request kind", { exact: true })
    .selectOption("approval");
  await page.getByText("No matching requests.", { exact: true }).waitFor();
  await page
    .getByText(
      "Nothing matches these filters. There are still 3 unresolved items across all projects.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.locator(".inbox-row").count(), 0);
  await captureBrowserEvidence(page, "1366-inbox-filtered-empty", {
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.locator(".inbox-row").nth(2).waitFor();
  assert.equal(
    await page.getByLabel("Request kind", { exact: true }).inputValue(),
    "",
  );
});

test("an Inbox with nothing unresolved says so and links to Overview", async (_t, j) => {
  const { page } = await openInbox(j, 0, { width: 1366, height: 900 });
  await page
    .getByText("Nothing needs your attention.", { exact: true })
    .waitFor();
  await page
    .getByText(
      "Questions, approvals and execution problems will appear here. Routine progress and completed work stay in Overview.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Back to overview", exact: true })
      .getAttribute("href"),
    "/app",
  );
  assert.equal(
    await page.locator(".inbox-summary").textContent(),
    "0 unresolved across your projects",
  );
  await captureBrowserEvidence(page, "1366-inbox-empty", { fullPage: false });
});

test("queue rows are full-width touch targets without horizontal scroll (phone)", async (_t, j) => {
  const { page } = await openInbox(j, 3, { width: 390, height: 844 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  const boxes = await rows.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().toJSON()),
  );
  for (const box of boxes) {
    assert.ok(box.height >= 44, JSON.stringify(box));
    assert.ok(box.width >= 390 - 2 * 20 - 2, JSON.stringify(box));
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await captureBrowserEvidence(page, "390-inbox-queue", { fullPage: false });
});

test("phone: the Inbox header has the title and count only, and the filter row holds both filters and the one Refresh", async (_t, j) => {
  const longName =
    "Customer onboarding and billing reconciliation platform 2026";
  assert.equal(longName.length, 60);
  const { page } = await openInbox(
    j,
    3,
    { width: 390, height: 844 },
    "/app/inbox",
    (f) => seedOwnQuestion(f, undefined, "Long project request", longName),
  );
  const header = page.locator("header.page-header"),
    filters = page.locator(".inbox-filters"),
    refresh = page.getByRole("button", { name: "Refresh", exact: true }),
    rows = page.locator(".inbox-row"),
    project = page.getByLabel("Project", { exact: true }),
    kind = page.getByLabel("Request kind", { exact: true });
  await rows.nth(3).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const rect = (l: ReturnType<Page["locator"]>) =>
    l.evaluate((e) => e.getBoundingClientRect().toJSON());
  const noOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  // (1) The header holds the menu, "Inbox" and the count, and no Refresh.
  assert.equal(await header.locator("h1").textContent(), "Inbox");
  assert.equal(
    await header.locator(".page-header-count").textContent(),
    "4 unresolved",
  );
  assert.equal(await header.getByRole("button").count(), 1, "menu only");
  assert.equal(
    await header.getByRole("button", { name: "Refresh" }).count(),
    0,
  );

  // (2) The one Refresh sits in the filter row, and (3) the row is a single line.
  assert.equal(await refresh.count(), 1);
  assert.equal(
    await filters.getByRole("button", { name: "Refresh" }).count(),
    1,
  );
  const line = async () => {
    const boxes = await Promise.all([project, kind, refresh].map(rect));
    assert.ok(
      Math.max(...boxes.map((b) => b.top)) -
        Math.min(...boxes.map((b) => b.top)) <=
        1,
      JSON.stringify(boxes),
    );
    for (const b of boxes) assert.ok(b.right <= 390, JSON.stringify(boxes));
    assert.ok(await noOverflow());
  };
  await line();
  const longId = await project.evaluate(
    (e, name) =>
      [...(e as HTMLSelectElement).options].find((o) =>
        o.textContent?.startsWith(name),
      )!.value,
    longName,
  );
  await project.selectOption(longId);
  await rows.first().waitFor();
  await line();
  await project.selectOption("");
  await rows.nth(3).waitFor();

  // (4) The first request is on the first screen.
  assert.ok((await rect(rows.first())).bottom <= 844);

  // (5) Refresh is disabled while the workspace read is pending, then rereads.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/operator/workspace", async (route) => {
    await gate;
    await route.continue();
  });
  const inbox = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/inbox" && r.ok(),
  );
  await refresh.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".inbox-filters button")].every(
      (b) => (b as HTMLButtonElement).disabled,
    ),
  );
  release();
  await inbox;
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".inbox-filters button")].every(
      (b) => !(b as HTMLButtonElement).disabled,
    ),
  );
  await page.unroute("**/api/operator/workspace");

  // (6) A filter that matches nothing keeps the one Refresh.
  await kind.selectOption("approval");
  await page.getByText("No matching requests.", { exact: true }).waitFor();
  assert.equal(await refresh.count(), 1);
  assert.equal(
    await filters.getByRole("button", { name: "Refresh" }).count(),
    1,
  );
  await kind.selectOption("");
  await rows.nth(3).waitFor();

  // (7) A request's detail header has Back and Open task, and no Refresh.
  await rows.first().click();
  await page
    .getByRole("link", { name: "Back to Inbox", exact: true })
    .waitFor();
  assert.equal(
    await header.getByRole("link", { name: "Open task" }).count(),
    1,
  );
  assert.equal(await refresh.count(), 0);

  // (8) Back returns to the queue with its one Refresh.
  await page.getByRole("link", { name: "Back to Inbox", exact: true }).click();
  await rows.first().waitFor({ state: "visible" });
  assert.equal(await refresh.count(), 1);
  assert.equal(
    await filters.getByRole("button", { name: "Refresh" }).count(),
    1,
  );

  // (9) The boundary: 760 keeps it in the filter row, 761 moves it to the header.
  await page.setViewportSize({ width: 761, height: 844 });
  await header.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  assert.equal(await refresh.count(), 1);
  assert.equal(
    await filters.getByRole("button", { name: "Refresh" }).count(),
    0,
  );
  await page.setViewportSize({ width: 760, height: 844 });
  await filters.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  assert.equal(await refresh.count(), 1);
  assert.equal(
    await header.getByRole("button", { name: "Refresh" }).count(),
    0,
  );
  await page.setViewportSize({ width: 1366, height: 900 });
  await page
    .locator(".inbox-title")
    .getByRole("button", { name: "Refresh", exact: true })
    .waitFor();
  assert.equal(await refresh.count(), 1);
});

test("queue rows lead with the question or the approval's exact action, not the generic reason", async (_t, j) => {
  const { page, more } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    async (f) => ({
      question: await seedOwnQuestion(f, choiceForm, "Guide task", "Docs"),
      approval: await seedOwnApproval(f, "Release task", "Shipping"),
      held: await seedOwnIntervention(f),
    }),
  );
  const row = (id: string) =>
    page.locator(`.inbox-row[data-record-id="${id}"]`);
  const question = row(more.question.interactionId),
    approval = row(more.approval.interactionId);
  await question.waitFor();
  assert.equal(
    await question.locator("strong").textContent(),
    "Choose the guide's audience",
  );
  assert.equal(
    await question.locator(".inbox-row-subtitle").textContent(),
    "Docs / Guide task",
  );
  assert.equal(
    await approval.locator("strong").textContent(),
    "Create a pull request. No merge or deployment.",
  );
  assert.equal(
    await approval.locator(".inbox-row-subtitle").textContent(),
    "Shipping / Release task",
  );
  // An intervention has no headline: the task title leads and its reason stays.
  const held = page.locator('.inbox-row[data-kind="intervention"]');
  assert.equal(
    await held.locator("strong").textContent(),
    "Restore webhook delivery",
  );
  assert.equal(
    await held.locator(".inbox-row-subtitle").textContent(),
    "Relay",
  );
  await held.getByText("Execution ownership is uncertain").waitFor();
  const queue = await page.locator(".inbox-rows").innerText();
  assert.doesNotMatch(
    queue,
    /Operator answer requested|Review exact approval material/,
  );
});

test("the request pane leads with the question and keeps its scaffolding below the form (desktop)", async (_t, j) => {
  const { page } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnQuestion(f, choiceForm, "Guide task", "Docs"),
  );
  const detail = page.getByRole("region", { name: "Selected request" });
  await detail
    .getByRole("heading", {
      level: 2,
      name: "Choose the guide's audience",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await detail.locator(".inbox-detail-project").textContent(),
    "Docs / Guide task",
  );
  // Nothing generic precedes the form.
  assert.equal(await detail.getByText("Awaiting answer").count(), 0);
  assert.equal(await detail.getByText("Operator answer requested").count(), 0);
  assert.equal(
    await detail.getByRole("button", { name: /^Refresh/ }).count(),
    0,
  );
  const field = (await detail.locator("fieldset").last().boundingBox())!;
  for (const below of [
    detail.locator(".inbox-identity"),
    detail.getByText(/^Conversation revision \d+\.$/),
    detail.getByText(/^Preselected and recommended choices are drafts/),
    detail.getByRole("link", { name: "Question evidence", exact: true }),
  ]) {
    const box = (await below.boundingBox())!;
    assert.ok(box.y >= field.y + field.height, "below the form");
  }
  assert.match(
    (await detail.locator(".inbox-identity").textContent())!,
    /^.+ · version \d+ · \d\d:\d\d$/,
  );
});

test("phone: the options are above the sticky submit bar on first view and the evidence links follow the form", async (_t, j) => {
  const { page } = await openInbox(
    j,
    0,
    { width: 390, height: 844 },
    "/app/inbox",
    (f) => seedOwnQuestion(f, choiceForm, "Guide task", "Docs"),
  );
  await page.locator(".inbox-row").click();
  const detail = page.locator(".inbox-detail");
  await detail.getByRole("radio", { name: /^Team owners/ }).waitFor();
  const submit = (await detail.locator(".question-submit").boundingBox())!;
  for (const name of [/^Every new member/, /^Team owners/]) {
    const option = (await detail
      .locator(".question-option", { hasText: name })
      .boundingBox())!;
    assert.ok(
      option.y + option.height <= submit.y,
      `${name} above the bar: ${JSON.stringify({ option, submit })}`,
    );
  }
  const field = (await detail.locator("fieldset").last().boundingBox())!;
  for (const link of ["Task evidence", "Requesting conversation"]) {
    const box = (await detail
      .getByRole("link", { name: link, exact: true })
      .boundingBox())!;
    assert.ok(box.y >= field.y + field.height, `${link} below the form`);
  }
  await captureBrowserEvidence(page, "390-inbox-question-first-view", {
    fullPage: false,
  });
});

test("the page Refresh rereads the open request: an answer recorded elsewhere shows without an in-pane control", async (_t, j) => {
  const { f, page, more } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnQuestion(f, choiceForm, "Guide task", "Docs"),
  );
  const form = page.getByRole("region", { name: "Exact question response" });
  await form.getByRole("radio", { name: /^Team owners/ }).check();
  await form.getByText(/^Selected: .*Team owners.* · unsent$/).waitFor();
  const receipt = await new OperatorApi(f.service, [f.directory]).execute({
    type: "question.form.answer",
    key: randomUUID(),
    taskId: more.taskId,
    interactionId: more.interactionId,
    expectedRevision: 1,
    answers: { choice: { optionIds: ["members"], text: "" } },
  });
  assert.equal(receipt.kind, "coordination");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await form.getByText("Answer recorded", { exact: true }).first().waitFor();
  assert.equal(
    await form.getByRole("button", { name: "Submit answer" }).count(),
    0,
  );
  assert.equal(await form.getByRole("button", { name: /^Refresh/ }).count(), 0);
});

/** Serves the task read with an open source-owned GitHub blocker, as a contract-valid read. */
async function serveSourceHold(page: Page, taskId: string) {
  const taskUrl = `**/api/operator/tasks/${taskId}`;
  await page.route(taskUrl, async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as TaskRead;
    body.data.source = {
      identity: { provider: "github.com", nodeId: "I_1", repositoryId: "R_1" },
      repositoryName: "acme/atlas",
      number: 12,
      url: "https://github.com/acme/atlas/issues/12",
      title: "Imported task",
      body: "",
      state: "open",
      closure: null,
      readiness: {
        rule: { kind: "none" },
        outcome: "not-evaluated",
        unmet: [],
      },
      memberships: [],
      nativeBlockers: [
        {
          nodeId: "B_1",
          repositoryId: "R_2",
          repositoryName: "acme/design-system",
          number: 87,
          state: "open",
        },
      ],
      review: null,
      hold: null,
    };
    body.data.admission.eligible = false;
    body.data.admission.reasons = ["imported-blockers-blocked"];
    body.data.waits = [
      { code: "imported-blockers-blocked", fix: null, links: [] },
    ];
    taskSchema.parse(body);
    await route.fulfill({ response, json: body });
  });
  return taskUrl;
}

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

test("a wide Inbox opens the first request by itself without navigating, and keeps it through filters and polls", async (_t, j) => {
  const { page } = await openInbox(
    j,
    3,
    { width: 1366, height: 900 },
    "/app/inbox",
    undefined,
    true,
  );
  const inboxReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/operator/inbox")
      inboxReads.push(request.url());
  });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  const first = rows.first(),
    detail = page.getByRole("region", { name: "Selected request" });
  await first.waitFor();
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  await detail.getByRole("heading", { level: 2 }).waitFor();
  const firstTitle = await first.locator("strong").textContent();
  assert.equal(
    await detail.getByRole("heading", { level: 2 }).textContent(),
    firstTitle,
  );
  assert.equal(new URL(page.url()).pathname, "/app/inbox");
  assert.equal(new URL(page.url()).search, "");
  const entries = await page.evaluate(() => history.length);
  // Selection state is not navigation; the header reads Question · 1 of 3 with one Open task link.
  await detail.getByText("Question", { exact: true }).first().waitFor();
  await detail.getByText("1 of 3", { exact: true }).waitFor();
  const open = detail.getByRole("link", { name: "Open task" });
  assert.match(
    (await open.getAttribute("href"))!,
    /^\/app\/tasks\/[0-9a-f-]{36}$/,
  );
  assert.equal(
    await page.getByRole("button", { name: "Back to queue" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("link", { name: "Back to Inbox" }).count(),
    0,
  );
  // Top-level header stays on a wide layout.
  assert.equal(await page.locator("main h1").textContent(), "Inbox");
  assert.equal(
    await page.locator(".inbox-summary").textContent(),
    "3 unresolved across 3 projects",
  );

  // A poll and a filter change leave the selection where it was.
  const reads = inboxReads.length;
  const poll = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/inbox" && r.ok(),
  );
  await page.clock.runFor(15000);
  await poll;
  assert.ok(inboxReads.length > reads, "the poll read the Inbox again");
  await page
    .getByLabel("Request kind", { exact: true })
    .selectOption("question");
  await page.getByLabel("Project", { exact: true }).selectOption({ index: 1 });
  assert.equal(
    await detail.getByRole("heading", { level: 2 }).textContent(),
    firstTitle,
  );
  await page.getByLabel("Project", { exact: true }).selectOption({ index: 0 });
  await rows.nth(2).waitFor();
  assert.equal(await page.evaluate(() => history.length), entries);
  assert.equal(new URL(page.url()).search, "");

  // Choosing another row is navigation: one history entry, and the position follows.
  await rows.nth(1).click();
  await detail.getByText("2 of 3", { exact: true }).waitFor();
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(await rows.first().getAttribute("aria-pressed"), "false");
  assert.ok(new URL(page.url()).searchParams.get("request"));
  assert.equal(await page.evaluate(() => history.length), entries + 1);
  await captureBrowserEvidence(page, "1366-inbox-selected", {
    fullPage: false,
  });
});

test("the Inbox is two independent scroll regions in one viewport, with the detail header and submit area in view (desktop)", async (_t, j) => {
  const { page } = await openInbox(j, 7, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(6).waitFor();
  const queue = page.locator(".inbox-rows"),
    detail = page.locator(".inbox-detail");
  await page.getByRole("button", { name: /^Submit answers?$/ }).waitFor();
  await settle(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
    true,
    "the page itself does not scroll",
  );
  assert.equal((await page.locator(".inbox-queue").boundingBox())!.width, 340);
  const metrics = (el: typeof queue) =>
    el.evaluate((e) => ({
      client: e.clientHeight,
      scroll: e.scrollHeight,
      top: e.scrollTop,
    }));
  assert.ok((await metrics(queue)).scroll > (await metrics(queue)).client);
  assert.ok((await metrics(detail)).scroll > (await metrics(detail)).client);
  // Wheel over the queue moves only the queue.
  const queueBox = (await queue.boundingBox())!;
  await page.mouse.move(queueBox.x + queueBox.width / 2, queueBox.y + 100);
  await page.mouse.wheel(0, 300);
  await settle(page);
  assert.ok((await metrics(queue)).top > 0);
  assert.equal((await metrics(detail)).top, 0);
  // Wheel over the detail moves only the detail.
  const queueTop = (await metrics(queue)).top;
  const detailBox = (await detail.boundingBox())!;
  await page.mouse.move(detailBox.x + detailBox.width / 2, detailBox.y + 200);
  await page.mouse.wheel(0, 200);
  await settle(page);
  assert.ok((await metrics(detail)).top > 0);
  assert.equal((await metrics(queue)).top, queueTop);

  const header = page.locator(".inbox-detail-header"),
    submit = page.locator(".question-submit");
  const inView = async (label: string) => {
    const box = (await detail.boundingBox())!,
      h = (await header.boundingBox())!,
      s = (await submit.boundingBox())!;
    assert.ok(
      Math.abs(h.y - box.y) <= 1,
      `${label}: header at top ${h.y} vs ${box.y}`,
    );
    assert.ok(
      s.y + s.height <= box.y + box.height + 1,
      `${label}: submit visible`,
    );
    assert.ok(s.y >= box.y, `${label}: submit within pane`);
  };
  for (const where of [0, 0.5, 1]) {
    await detail.evaluate((e, f) => {
      e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
    }, where);
    await settle(page);
    await inView(`at ${where}`);
  }
  await captureBrowserEvidence(page, "1366-inbox-scrolled-detail", {
    fullPage: false,
  });
});

test("the last field stays reachable above the sticky submit area on a short phone", async (_t, j) => {
  const { page } = await openInbox(j, 1, { width: 390, height: 480 });
  await page.locator(".inbox-row").first().click();
  const form = page.getByRole("region", { name: "Exact question response" });
  await form.getByRole("textbox", { name: "Optional", exact: true }).waitFor();
  const detail = page.locator(".inbox-detail");
  await detail.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await settle(page);
  const last = (await form
      .getByRole("textbox", { name: "Optional", exact: true })
      .boundingBox())!,
    submit = (await form.locator(".question-submit").boundingBox())!,
    box = (await detail.boundingBox())!;
  assert.ok(last.y + last.height <= submit.y, JSON.stringify({ last, submit }));
  assert.ok(submit.y + submit.height <= box.y + box.height + 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
});

test("phone: queue to detail to queue restores the anchor and focus without selecting", async (_t, j) => {
  const { page } = await openInbox(j, 9, { width: 390, height: 844 });
  const rows = page.locator(".inbox-row");
  await rows.nth(8).waitFor();
  assert.equal(await page.locator("main h1").textContent(), "Inbox");
  assert.equal(
    await page.locator(".page-header-count").textContent(),
    "9 unresolved",
  );
  const queue = page.locator(".inbox-rows");
  assert.ok(
    (await queue.evaluate((e) => e.scrollHeight - e.clientHeight)) > 150,
    "queue is scrollable",
  );
  await queue.evaluate((e) => {
    e.scrollTop = 150;
    e.dispatchEvent(new Event("scroll"));
  });
  await settle(page);
  const before = await queue.evaluate((e) => e.scrollTop);
  // Open a row that is fully visible.
  const target = rows.nth(4);
  const targetId = await target.getAttribute("data-record-id");
  await target.click();
  const header = page.locator("header.page-header");
  await page
    .getByRole("link", { name: "Back to Inbox", exact: true })
    .waitFor();
  assert.equal(await header.locator("h1").textContent(), "Question · 5 of 9");
  assert.match(
    (await header.locator(".page-header-title p").textContent())!,
    /^(Atlas|Relay|Fieldnotes)( \d+)?$/,
  );
  assert.equal(
    await header.getByRole("link", { name: "Open task" }).count(),
    1,
  );
  assert.equal(
    await header.locator("a, button").count(),
    2,
    "Back and Open task only",
  );
  assert.equal(await page.locator(".inbox-queue").isVisible(), false);
  assert.equal(
    await page.getByRole("button", { name: "Back to queue" }).count(),
    0,
  );
  // Previous/Next and the inspector are wide-layout tools.
  assert.equal(
    await page
      .getByRole("button", { name: /^(Previous|Next) request$/ })
      .count(),
    0,
  );
  assert.equal(await page.locator(".inbox-context").count(), 0);
  await captureBrowserEvidence(page, "390-inbox-detail", { fullPage: false });

  await page.getByRole("link", { name: "Back to Inbox", exact: true }).click();
  await rows.first().waitFor({ state: "visible" });
  await settle(page);
  assert.ok(Math.abs((await queue.evaluate((e) => e.scrollTop)) - before) <= 1);
  const opened = page.locator(`.inbox-row[data-record-id="${targetId}"]`);
  assert.equal(
    await opened.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(await opened.getAttribute("aria-pressed"), "false");
  assert.equal(
    await page.locator('.inbox-row[aria-pressed="true"]').count(),
    0,
  );
  assert.equal(new URL(page.url()).search, "");
});

test("sign-out clears the Inbox filters and in-memory selection; the header is not stale after signing in", async (_t, j) => {
  const { page, web } = await openInbox(j, 3, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  await page.getByLabel("Project", { exact: true }).selectOption({ index: 1 });
  await rows.nth(0).waitFor();
  assert.equal(await rows.count(), 1);
  await rows.first().click();
  await page.getByText("1 of 1", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".inbox-summary").textContent(),
    "3 unresolved across 3 projects",
  );
  await signOutFromSidebar(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The URL still names the request, so it reopens; the filter and header start fresh.
  await rows.nth(2).waitFor();
  assert.equal(
    await page.getByLabel("Project", { exact: true }).inputValue(),
    "",
  );
  await page.getByText(/^\d of 3$/).waitFor();
  assert.equal(await page.locator("main h1").textContent(), "Inbox");
  assert.equal(
    await page.locator(".inbox-summary").textContent(),
    "3 unresolved across 3 projects",
  );
});

test("an approval shows its exact action, target and independent holds, and decides only at the retained destination", async (_t, j) => {
  const { page, more: approval } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnApproval(f),
  );
  const commands: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      commands.push(request.url());
  });
  const detail = page.getByRole("region", { name: "Selected request" });
  await page.locator(".inbox-row").click();
  // The exact action leads the pane and is stated again as the fact the decision is bound to.
  await detail
    .getByRole("heading", {
      level: 2,
      name: "Create a pull request. No merge or deployment.",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await detail.locator(".inbox-approval-facts dd").first().textContent(),
    "Create a pull request. No merge or deployment.",
  );
  await detail.getByText("acme/atlas · main ← command-menu").waitFor();
  await detail.getByText(/^version \d+$/).waitFor();
  await detail.getByText("Task lead", { exact: true }).waitFor();
  assert.equal(await detail.getByText("Approval", { exact: true }).count(), 1);
  await detail
    .getByText(
      "Your decision is bound to the action, target and version in the exact approval. Changed material requires a new review.",
      { exact: true },
    )
    .waitFor();
  const decide = detail.getByRole("link", {
    name: "Review material & decide",
    exact: true,
  });
  assert.equal(
    await decide.getAttribute("href"),
    `/coordination/task/${approval.taskId}#${approval.interactionId}`,
  );
  // Nothing on the page decides: not the request pane, not the inspector.
  assert.equal(
    await page.getByRole("button", { name: /^(approve|deny)\b/i }).count(),
    0,
  );
  assert.equal(
    await detail.getByText("Execution blocked by dependency").count(),
    0,
  );
  await captureBrowserEvidence(page, "1366-inbox-approval", {
    fullPage: false,
  });

  // A source-owned hold, served as a contract-valid task read, shows beside the decision.
  const taskUrl = await serveSourceHold(page, approval.taskId);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.reload();
  await page.locator(".inbox-row").click();
  await detail
    .getByText("Execution blocked by dependency", { exact: true })
    .waitFor();
  await detail.getByText("acme/design-system#87", { exact: true }).waitFor();
  await detail
    .getByText(
      "Source-owned hold. Approval does not clear it; execution still waits for the GitHub blocker.",
      { exact: true },
    )
    .waitFor();
  await captureBrowserEvidence(page, "1366-inbox-approval-hold", {
    fullPage: false,
  });
  await page.unroute(taskUrl);
  // A hold that is not a dependency says what it is, and that approving does not clear it.
  await page.route(taskUrl, async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as TaskRead;
    body.data.admission.eligible = false;
    body.data.admission.reasons = ["task-unready"];
    body.data.waits = [];
    taskSchema.parse(body);
    await route.fulfill({ response, json: body });
  });
  // The open approval rereads its holds when the Inbox refreshes, without reselecting it.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await detail
    .getByText("Execution held (task not ready)", { exact: true })
    .waitFor();
  await detail
    .getByText("Approving does not clear it.", { exact: true })
    .waitFor();
  assert.equal(
    await detail.getByText("Execution blocked by dependency").count(),
    0,
  );
  await page.unroute(taskUrl);
  // A failed automatic reread keeps the last holds and says they may be out of date.
  await page.route(taskUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await detail
    .getByText(
      /^Independent holds could not be refreshed; showing the last read from /,
    )
    .waitFor();
  await detail
    .getByText("Execution held (task not ready)", { exact: true })
    .waitFor();
  await page.unroute(taskUrl);

  // When the task cannot be read the holds are unknown and stay in effect.
  await page.route(taskUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  try {
    await page.reload();
    await page.locator(".inbox-row").click();
    await detail
      .getByText(
        "Independent holds could not be read; they remain in effect.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await decide.count(), 1);
  } finally {
    await page.unroute(taskUrl);
  }
  await detail.getByRole("button", { name: "Retry", exact: true }).click();
  await detail
    .getByText("Independent holds could not be read")
    .waitFor({ state: "detached" });
  assert.equal(
    commands.length,
    0,
    "no command is sent from the Inbox approval view",
  );
});

test("an intervention shows its recorded reason and links to the execution", async (_t, j) => {
  const { page, more: held } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnIntervention(f),
  );
  const detail = page.getByRole("region", { name: "Selected request" });
  await page.locator(".inbox-row").click();
  await detail.getByText("Intervention", { exact: true }).waitFor();
  await detail.getByText("Execution ownership is uncertain").waitFor();
  // The seeded intervention has no requester and no timestamp: both are omitted everywhere.
  const aside = page.getByRole("complementary", { name: "Task context" });
  await aside.waitFor();
  for (const text of [
    await page.locator(".inbox-row").innerText(),
    await detail.innerText(),
    await aside.innerText(),
  ])
    assert.doesNotMatch(text, /Age unknown|Responsibility unknown/);
  assert.equal(await aside.getByText("Requester", { exact: true }).count(), 0);
  assert.equal(await detail.locator(".inbox-identity").count(), 0);
  assert.equal(await page.locator(".inbox-row-meta").count(), 0);
  // Uncertain ownership is stated once in the request pane's headline, not again in the inspector.
  assert.equal(
    await detail.getByText("Execution ownership is uncertain").count(),
    1,
  );
  assert.equal(
    await aside.getByText("Execution ownership is uncertain").count(),
    0,
  );
  // Ownership stays held is stated once, in the request pane, as on the Home card.
  assert.equal(
    await detail.getByText("Ownership stays held", { exact: true }).count(),
    1,
  );
  for (const text of [
    await page.locator(".inbox-row").innerText(),
    await aside.innerText(),
  ])
    assert.doesNotMatch(text, /Ownership stays held/);
  const inspect = detail.getByRole("link", {
    name: "Inspect execution",
    exact: true,
  });
  assert.equal(
    await inspect.getAttribute("href"),
    `/app/tasks/${held.taskId}?section=decisions`,
  );
  await captureBrowserEvidence(page, "1366-inbox-intervention", {
    fullPage: false,
  });
  // It lands on the task's Overview with the decision card, and its hold lines, in view.
  await inspect.click();
  const card = page.locator("section#decisions");
  await card.getByRole("list", { name: "Also held", exact: true }).waitFor();
  assert.equal(
    await page
      .locator('[role="tablist"] [aria-selected="true"]')
      .evaluate((e) => e.textContent),
    "Overview",
  );
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && viewport && box.y >= 0 && box.y < viewport.height);
  assert.deepEqual(
    await card
      .getByRole("link", { name: "Recovery evidence", exact: true })
      .evaluateAll((a) => a.map((x) => x.getAttribute("href"))),
    Array(3).fill(`/app/assignments/${held.assignmentId}/recovery`),
  );
});

test("returning to the Inbox restores the request the operator chose, not the one it opened by itself", async (_t, j) => {
  const { page } = await openInbox(j, 3, { width: 1366, height: 900 });
  const rows = page.locator(".inbox-row");
  await rows.nth(2).waitFor();
  assert.equal(await rows.first().getAttribute("aria-pressed"), "true");
  const chosen = rows.nth(1),
    chosenId = await chosen.getAttribute("data-record-id");
  await chosen.click();
  await page.getByText("2 of 3", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await rows.nth(2).waitFor();
  await page.getByText("2 of 3", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(`.inbox-row[data-record-id="${chosenId}"]`)
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await rows.first().getAttribute("aria-pressed"), "false");
});

const pausedHold = "Project paused",
  pausedDetail = "Task paused. Recording answers does not resume execution.";
const seedHeldQuestions =
  (...titles: string[]) =>
  async (f: Fixture) => {
    const seeded = [];
    // seedOwnQuestion leaves each task in a paused project.
    for (const [i, title] of titles.entries())
      seeded.push(await seedOwnQuestion(f, choiceForm, title, projects[i % 3]));
    return seeded;
  };

test("an Inbox question in a paused project shows its hold in the footer, records, and keeps the hold", async (_t, j) => {
  const { page, more } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    seedHeldQuestions("Paused question", "Unread holds question"),
  );
  const form = page.getByRole("region", { name: "Exact question response" }),
    footer = form.locator(".question-submit");
  await page.locator(".inbox-row", { hasText: "Paused question" }).click();
  await footer.getByText(pausedHold, { exact: true }).waitFor();
  await footer.getByText(pausedDetail).waitFor();
  assert.equal(await footer.getByText(/Approv/).count(), 0);
  // The request status is a worded state badge with its symbol, and unclassed text is 13px body.
  // A pending request needs no badge: the form states what to do.
  await footer.getByText("Not submitted", { exact: true }).waitFor();
  assert.equal(await form.getByText("Awaiting answer").count(), 0);
  assert.deepEqual(await unpairedBadges(page.locator(".inbox-detail")), []);
  assert.equal(
    await footer
      .locator(".question-status")
      .evaluate((e) => getComputedStyle(e).fontSize),
    "13px",
  );
  await captureBrowserEvidence(page, "1366-inbox-question-hold", {
    fullPage: false,
  });
  await form.getByRole("radio", { name: /^Team owners/ }).check();
  await footer.getByRole("button", { name: "Submit answer" }).click();
  await form.locator(".question-recorded").waitFor();
  // The recorded confirmation replaces the footer; the same notices stay on it.
  const recorded = form.locator(".question-recorded");
  await recorded.getByText(pausedHold, { exact: true }).waitFor();
  await recorded.getByText(pausedDetail).waitFor();

  // A task read that fails shows no hold and does not block answering.
  const taskUrl = `**/api/operator/tasks/${more[1]!.taskId}`;
  await page.route(taskUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  try {
    await page
      .locator(".inbox-row", { hasText: "Unread holds question" })
      .click();
    await footer.getByRole("button", { name: "Submit answer" }).waitFor();
    await settle(page);
    assert.equal(await page.getByText(pausedHold).count(), 0);
    await form.getByRole("radio", { name: /^Team owners/ }).check();
    await footer.getByRole("button", { name: "Submit answer" }).click();
    await form.locator(".question-recorded").waitFor();
    assert.equal(await page.getByText(pausedHold).count(), 0);
  } finally {
    await page.unroute(taskUrl);
  }
});

test("an Inbox question beside an open approval lists the approval as a hold in the footer without gating the answer", async (_t, j) => {
  const { page, more } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    seedHeldQuestions("Question beside approval"),
  );
  // The task also has an open approval, served as a contract-valid task read.
  await page.route(
    `**/api/operator/tasks/${more[0]!.taskId}`,
    async (route) => {
      const response = await route.fetch(),
        body = (await response.json()) as TaskRead;
      body.data.waits.push({
        code: "approval",
        fix: null,
        links: [
          {
            kind: "request",
            id: randomUUID(),
            label: "Review material & decide",
          },
        ],
      });
      taskSchema.parse(body);
      await route.fulfill({ response, json: body });
    },
  );
  const form = page.getByRole("region", { name: "Exact question response" }),
    footer = form.locator(".question-submit");
  await page
    .locator(".inbox-row", { hasText: "Question beside approval" })
    .click();
  const hold = footer.getByText("Execution held (approval needs a decision)", {
    exact: true,
  });
  await hold.waitFor();
  assert.equal(await hold.count(), 1);
  assert.match(await footer.innerText(), /Answering does not clear it\./);
  assert.equal(await footer.getByText(/Approving/).count(), 0);
  await form.getByRole("radio", { name: /^Team owners/ }).check();
  assert.ok(
    await footer.getByRole("button", { name: "Submit answer" }).isEnabled(),
  );
});

test("phone: the question hold sits in the sticky submit area without covering fields, and a loading task read does not block answering", async (_t, j) => {
  const { page, more } = await openInbox(
    j,
    0,
    { width: 390, height: 844 },
    "/app/inbox",
    seedHeldQuestions("Phone question"),
  );
  const form = page.getByRole("region", { name: "Exact question response" }),
    footer = form.locator(".question-submit"),
    detail = page.locator(".inbox-detail");
  await page.locator(".inbox-row").first().click();
  await footer.getByText(pausedDetail).waitFor();
  await detail.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await settle(page);
  const last = (await form.locator(".question-option").last().boundingBox())!,
    submit = (await footer.boundingBox())!,
    box = (await detail.boundingBox())!;
  assert.ok(last.y + last.height <= submit.y, JSON.stringify({ last, submit }));
  assert.ok(
    submit.y >= box.y && submit.y + submit.height <= box.y + box.height + 1,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  // The footer grows with its notices but is not a second scroller.
  assert.deepEqual(
    await footer.evaluate((e) => ({
      overflowY: getComputedStyle(e).overflowY,
      clipped: e.scrollHeight > e.clientHeight + 1,
    })),
    { overflowY: "visible", clipped: false },
  );
  await captureBrowserEvidence(page, "390-inbox-question-hold", {
    fullPage: false,
  });

  // While the task read is still loading, answering is not gated and no hold is claimed.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taskUrl = `**/api/operator/tasks/${more[0]!.taskId}`;
  await page.route(taskUrl, async (route) => {
    await gate;
    await route.continue().catch(() => undefined);
  });
  try {
    // The reload keeps the phone on the open request.
    await page.reload();
    const submitButton = footer.getByRole("button", { name: "Submit answer" });
    await submitButton.waitFor();
    assert.equal(await submitButton.isEnabled(), true);
    assert.equal(await page.getByText(pausedHold).count(), 0);
    await form.getByRole("radio", { name: /^Team owners/ }).check();
    await submitButton.click();
    await form.locator(".question-recorded").waitFor();
  } finally {
    release();
    await page.unroute(taskUrl);
  }
});

const computed = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate(
      (el, name) => getComputedStyle(el).getPropertyValue(name),
      property,
    );

test("three panes: a grouped queue under its filters, with the overlay and indigo-edge selection, and a page that does not scroll (1366)", async (_t, j) => {
  const { page } = await openInbox(
    j,
    2,
    { width: 1366, height: 900 },
    "/app/inbox",
    async (f) => {
      await seedOwnIntervention(f);
      await seedOwnApproval(f);
    },
  );
  const rows = page.locator(".inbox-row");
  await rows.nth(3).waitFor();
  // Group headings precede their rows: interventions, then questions and approvals.
  // Requests created in the same second have no stable order, so compare the second group as a set.
  const order = await page
    .locator(".inbox-rows > *")
    .evaluateAll((els) =>
      els.map((el) =>
        el.classList.contains("inbox-group")
          ? el.textContent
          : (el as HTMLElement).dataset.kind,
      ),
    );
  assert.deepEqual(order.slice(0, 3), [
    "Intervention · 1",
    "intervention",
    "Questions & approvals · oldest first",
  ]);
  assert.deepEqual(order.slice(3).sort(), ["approval", "question", "question"]);
  assert.equal(await page.locator(".inbox-queue .inbox-filters").count(), 1);
  // The wide layout opened the first request: overlay fill and a 2px indigo left edge.
  const selected = '.inbox-row[aria-pressed="true"]';
  await page.locator(selected).waitFor();
  assert.equal(
    await computed(page, selected, "background-color"),
    "rgb(30, 34, 53)",
  );
  assert.equal(await computed(page, selected, "border-left-width"), "2px");
  assert.equal(
    await computed(page, selected, "border-left-color"),
    "rgb(99, 102, 241)",
  );
  assert.equal((await page.locator(".inbox-queue").boundingBox())!.width, 340);
  assert.equal(
    await computed(page, ".inbox-queue", "background-color"),
    "rgb(13, 15, 23)",
  );
  assert.equal(
    (await page.locator(".inbox-context").boundingBox())!.width,
    280,
  );
  // The queue header owns the only heading; there is no page header.
  assert.equal(await page.locator(".page-header").count(), 0);
  assert.deepEqual(await page.locator("main h1").allTextContents(), ["Inbox"]);
  await settle(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
    true,
    "the page itself does not scroll",
  );
  // Refresh in the queue header rereads the Inbox.
  const reread = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/inbox" && r.ok(),
  );
  await page
    .locator(".inbox-queue")
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await reread;

  // The drawer shell: two panes under the page header, which has the menu and the one h1.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator(".page-header").waitFor();
  assert.equal(await page.locator(".phone-nav").isVisible(), true);
  assert.deepEqual(await page.locator("main h1").allTextContents(), ["Inbox"]);
  assert.equal(await page.locator(".inbox-context").count(), 0);
  assert.equal((await page.locator(".inbox-queue").boundingBox())!.width, 300);
  await settle(page);
  assert.deepEqual(
    await page.evaluate(() => ({
      x: document.documentElement.scrollWidth <= innerWidth,
      y: document.documentElement.scrollHeight <= innerHeight,
    })),
    { x: true, y: true },
  );
});

test("the request pane shows kind, position, identities and a sticky response bar from one task read", async (_t, j) => {
  const { page, more: approval } = await openInbox(
    j,
    3,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnApproval(f),
    true,
  );
  await serveSourceHold(page, approval.taskId);
  const taskReads: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      `/api/operator/tasks/${approval.taskId}`
    )
      taskReads.push(request.url());
  });
  // The first workspace read can land after the first Inbox read and make the Inbox reread once
  // more, so which side of the click that reread falls on depends on load. Each Inbox read that
  // completes from the click on may bring one task reread, and nothing else may.
  let inboxReads = 0;
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/operator/inbox" && r.ok())
      inboxReads++;
  });
  const rows = page.locator(".inbox-row"),
    detail = page.getByRole("region", { name: "Selected request" });
  await rows.nth(3).waitFor();
  const inboxReadsBeforeClick = inboxReads;
  await page.locator('.inbox-row[data-kind="approval"]').click();
  await detail
    .getByText("Execution blocked by dependency", { exact: true })
    .waitFor();
  await detail.getByText(/^\d of 4$/).waitFor();
  assert.equal(await detail.getByText("Approval", { exact: true }).count(), 1);
  assert.equal(
    await detail.getByRole("link", { name: "Open task" }).getAttribute("href"),
    `/app/tasks/${approval.taskId}`,
  );
  assert.match(
    (await detail.locator(".inbox-identity").textContent())!,
    /^.+ · version \d+ · \d\d:\d\d$/,
  );
  assert.equal(
    await computed(
      page,
      ".inbox-detail .inbox-approval-facts",
      "border-top-width",
    ),
    "1px",
  );
  // What a decision covers and the one way to decide sit in the sticky bar.
  const bar = page.locator(".inbox-decision");
  await bar
    .getByText(
      "Your decision is bound to the action, target and version in the exact approval. Changed material requires a new review.",
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Review material & decide", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await bar
      .getByRole("link", { name: "Review material & decide", exact: true })
      .getAttribute("href"),
    `/coordination/task/${approval.taskId}#${approval.interactionId}`,
  );
  assert.equal(
    await page.getByRole("button", { name: /^(approve|deny)\b/i }).count(),
    0,
  );
  const pane = page.locator(".inbox-detail");
  for (const where of [0, 0.5, 1]) {
    await pane.evaluate((e, f) => {
      e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
    }, where);
    await settle(page);
    const p = (await pane.boundingBox())!,
      b = (await bar.boundingBox())!;
    assert.ok(
      Math.abs(b.y + b.height - (p.y + p.height)) <= 1,
      `bar at the pane's foot at ${where}`,
    );
  }
  await captureBrowserEvidence(page, "1366-inbox-approval-pane", {
    fullPage: false,
  });
  // One task read per selection, and at most one more per Inbox read (a poll, or a reread
  // after the workspace changes), however many parts of the page show the task.
  await settle(page);
  assert.ok(
    taskReads.length >= 1 &&
      taskReads.length - 1 <= inboxReads - inboxReadsBeforeClick,
    `${taskReads.length} task reads for ${inboxReads - inboxReadsBeforeClick} Inbox reads`,
  );
  const reread = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/operator/tasks/${approval.taskId}`,
  );
  await page.clock.runFor(15000);
  await reread;
  await settle(page);
  assert.ok(
    taskReads.length - 1 >= 1 &&
      taskReads.length - 1 <= inboxReads - inboxReadsBeforeClick,
    `${taskReads.length - 1} task rereads for ${inboxReads - inboxReadsBeforeClick} Inbox reads`,
  );

  // Previous/Next move through the filtered queue as a row click does.
  await rows.first().click();
  await detail.getByText("1 of 4", { exact: true }).waitFor();
  const previous = page.getByRole("button", { name: "Previous request" }),
    next = page.getByRole("button", { name: "Next request" });
  assert.equal(await previous.isDisabled(), true);
  const entries = await page.evaluate(() => history.length);
  await next.click();
  await detail.getByText("2 of 4", { exact: true }).waitFor();
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => history.length), entries + 1);
  assert.equal(
    new URL(page.url()).searchParams.get("request"),
    await rows.nth(1).getAttribute("data-record-id"),
  );
  await previous.click();
  await detail.getByText("1 of 4", { exact: true }).waitFor();
  await rows.last().click();
  await detail.getByText("4 of 4", { exact: true }).waitFor();
  assert.equal(await next.isDisabled(), true);

  // A question's sticky bar is its submit area.
  await page.locator('.inbox-row[data-kind="question"]').first().click();
  const submit = page.locator(".inbox-detail .question-submit");
  await submit.waitFor();
  assert.equal(
    await computed(page, ".inbox-detail .question-submit", "position"),
    "sticky",
  );
  await captureBrowserEvidence(page, "1366-inbox-question", {
    fullPage: false,
  });
});

test("the inspector lists task, lead, requester, assignment chain, holds and evidence for the selected request (1366) and is absent on the tablet", async (_t, j) => {
  const {
    page,
    web,
    more: approval,
  } = await openInbox(j, 1, { width: 1366, height: 900 }, "/app/inbox", (f) =>
    seedOwnApproval(f),
  );
  const taskUrl = await serveSourceHold(page, approval.taskId);
  const aside = page.getByRole("complementary", { name: "Task context" }),
    row = page.locator('.inbox-row[data-kind="approval"]');
  await row.click();
  await aside.getByText("Execution blocked by dependency").waitFor();
  const item = (
    (await (
      await page.request.get(`${web.origin}/api/operator/inbox`)
    ).json()) as {
      data: {
        items: Array<{
          taskId: string;
          kind: string;
          taskTitle: string;
          projectName: string;
          requesterName: string;
          conversation: string | null;
        }>;
      };
    }
  ).data.items.find((i) => i.kind === "approval")!;
  const task = taskSchema.parse(
    await (
      await page.request.get(
        `${web.origin}/api/operator/tasks/${approval.taskId}`,
      )
    ).json(),
  ).data;
  const link = aside.getByRole("link", { name: item.taskTitle });
  assert.equal(
    await link.getAttribute("href"),
    `/app/tasks/${approval.taskId}`,
  );
  await aside
    .getByText(`${item.projectName} · acme/atlas#12`, { exact: true })
    .waitFor();
  await aside
    .getByText("Next: you · review material & decide", { exact: true })
    .waitFor();
  const facts = await aside
    .locator("dl")
    .evaluate((dl) =>
      Object.fromEntries(
        [...dl.querySelectorAll("dt")].map((dt) => [
          dt.textContent,
          dt.nextElementSibling?.textContent,
        ]),
      ),
    );
  assert.equal(facts.Requester, item.requesterName);
  if (task.lead) assert.equal(facts.Lead, task.lead.name ?? "Name unavailable");
  else assert.equal(facts.Lead, "No lead configured");
  // The chain ends at the requesting assignment and starts at its root.
  assert.match(
    facts.Chain ?? "",
    new RegExp(`^(Operator|Requester unknown) → .*${item.requesterName}$`),
  );
  await aside.getByText("Holds · 1", { exact: true }).waitFor();
  await aside.getByText("acme/design-system#87", { exact: true }).waitFor();
  // Evidence is links only: no "Reported by" line.
  assert.equal(await aside.getByText(/Reported by/).count(), 0);
  assert.match(
    (await aside
      .getByRole("link", { name: "Task evidence" })
      .getAttribute("href")) ?? "",
    /#history$/,
  );
  // Evidence links appear once on the page, in the inspector.
  assert.equal(
    await page.getByRole("link", { name: "Task evidence" }).count(),
    1,
  );
  assert.equal(
    await aside.getByRole("link", { name: "Task evidence" }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("link", { name: "Requesting conversation" }).count(),
    item.conversation ? 1 : 0,
  );
  await captureBrowserEvidence(page, "1366-inbox-inspector", {
    fullPage: false,
  });

  // Selecting another request updates it.
  await page.locator('.inbox-row[data-kind="question"]').click();
  await aside.getByRole("link", { name: "Request 1" }).waitFor();
  await aside
    .getByText("Next: you · answer question", { exact: true })
    .waitFor();

  // A failed task read still shows the request's own facts and evidence, with Try again.
  await page.unroute(taskUrl);
  await page.route(taskUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await row.click();
  await aside.getByRole("button", { name: "Try again" }).waitFor();
  await aside.getByRole("link", { name: item.taskTitle }).waitFor();
  await aside.getByText(item.requesterName, { exact: true }).first().waitFor();
  assert.equal(
    await aside.getByRole("link", { name: "Task evidence" }).count(),
    1,
  );
  await page.unroute(taskUrl);

  // Below 1280px there is no inspector; the evidence links return to the request pane.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page
    .getByRole("region", { name: "Selected request" })
    .getByRole("link", { name: "Task evidence" })
    .waitFor();
  assert.equal(await aside.count(), 0);
  assert.equal(
    await page.getByRole("link", { name: "Task evidence" }).count(),
    1,
  );
});

test("the Evidence block and its links are omitted when the request has none", async (_t, j) => {
  const { page } = await openInbox(j, 1, { width: 1366, height: 900 });
  await page.route("**/api/operator/inbox", async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as {
        data: {
          items: Array<{ evidence: string; conversation: string | null }>;
        };
      };
    for (const item of body.data.items) {
      item.evidence = "";
      item.conversation = null;
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const aside = page.getByRole("complementary", { name: "Task context" });
  await page.locator(".inbox-row").click();
  await aside.getByRole("heading", { name: "Task", exact: true }).waitFor();
  // The refreshed read has landed once the inspector's evidence link is gone.
  await aside
    .getByRole("link", { name: "Task evidence" })
    .waitFor({ state: "detached" });
  assert.equal(
    await aside.getByRole("heading", { name: "Evidence" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("link", { name: "Task evidence" }).count(),
    0,
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("region", { name: "Selected request" }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Task evidence" }).count(),
    0,
  );
});

test("an intervention's inspector lists a pending approval on its task as a hold (1366)", async (_t, j) => {
  const { page, more: held } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnIntervention(f),
  );
  // The same task also has a pending approval, served as a contract-valid task read.
  await page.route(`**/api/operator/tasks/${held.taskId}`, async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as TaskRead;
    body.data.waits = [{ code: "approval", fix: null, links: [] }];
    taskSchema.parse(body);
    await route.fulfill({ response, json: body });
  });
  await page.locator('.inbox-row[data-kind="intervention"]').click();
  const aside = page.getByRole("complementary", { name: "Task context" });
  await aside.getByText("Holds · 1", { exact: true }).waitFor();
  await aside
    .getByText("Execution held (approval needs a decision)", { exact: true })
    .waitFor();
});

test("an approval's inspector keeps another open approval on its task as a hold, but not the approval in view (1366)", async (_t, j) => {
  const { page, more: approval } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnApproval(f),
  );
  const serveApprovals = (ids: string[]) =>
    page.route(`**/api/operator/tasks/${approval.taskId}`, async (route) => {
      const response = await route.fetch(),
        body = (await response.json()) as TaskRead;
      body.data.waits = [
        {
          code: "approval",
          fix: null,
          links: ids.map((id) => ({
            kind: "request",
            id,
            label: "Review material & decide",
          })),
        },
      ];
      taskSchema.parse(body);
      await route.fulfill({ response, json: body });
    });
  const aside = page.getByRole("complementary", { name: "Task context" }),
    hold = aside.getByText("Execution held (approval needs a decision)", {
      exact: true,
    });
  // The task also has another open approval: it still holds execution after this decision.
  await serveApprovals([approval.interactionId, randomUUID()]);
  await page.locator('.inbox-row[data-kind="approval"]').click();
  await hold.waitFor();
  // The request pane lists the same hold, since it is not the approval in view.
  await page
    .getByRole("region", { name: "Selected request" })
    .getByText("Execution held (approval needs a decision)", { exact: true })
    .waitFor();
  // Only the approval in view: it is not a hold on itself.
  await page.unrouteAll();
  await serveApprovals([approval.interactionId]);
  await page
    .locator(".inbox-queue")
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await hold.waitFor({ state: "detached" });
});

test("the inspector drops the next action once the answer is recorded, and always shows the lead (1366)", async (_t, j) => {
  const { page, web, more } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    seedHeldQuestions("Recorded question"),
  );
  const aside = page.getByRole("complementary", { name: "Task context" }),
    form = page.getByRole("region", { name: "Exact question response" });
  await page.locator(".inbox-row", { hasText: "Recorded question" }).click();
  await aside
    .getByText("Next: you · answer question", { exact: true })
    .waitFor();
  // Lead accountability stays visible: the lead's name, or the task views' wording.
  const lead = taskSchema.parse(
      await (
        await page.request.get(
          `${web.origin}/api/operator/tasks/${more[0]!.taskId}`,
        )
      ).json(),
    ).data.lead,
    leadValue = () =>
      aside
        .locator("dt", { hasText: /^Lead$/ })
        .evaluate((dt) => dt.nextElementSibling?.textContent),
    expectedLead = lead
      ? (lead.name ?? "Name unavailable")
      : "No lead configured";
  assert.equal(await leadValue(), expectedLead);
  await form.getByRole("radio", { name: /^Team owners/ }).check();
  await form
    .locator(".question-submit")
    .getByRole("button", { name: "Submit answer" })
    .click();
  await form.locator(".question-recorded").waitFor();
  // The retained confirmation is not the operator's next action any more.
  await aside.getByText(/^Next: you/).waitFor({ state: "detached" });
  assert.equal(await leadValue(), expectedLead);
});

test("without a task read the inspector says the source is unavailable, and an intervention has no chain (1366)", async (_t, j) => {
  const { page, more: held } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (f) => seedOwnIntervention(f),
  );
  await page.route(`**/api/operator/tasks/${held.taskId}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.locator('.inbox-row[data-kind="intervention"]').click();
  const aside = page.getByRole("complementary", { name: "Task context" });
  await aside.getByRole("button", { name: "Try again" }).waitFor();
  await aside.getByText(/ · Source unavailable$/).waitFor();
  assert.equal(
    await aside
      .locator("dt", { hasText: /^Lead$/ })
      .evaluate((dt) => dt.nextElementSibling?.textContent),
    "Unavailable",
  );
  assert.equal(await aside.locator("dt", { hasText: /^Chain$/ }).count(), 0);
});

for (const [name, viewport] of [
  ["1366", { width: 1366, height: 900 }],
  ["390", { width: 390, height: 844 }],
] as const)
  test(`a runtime item leads Intervention, opens its detail with Open runtime settings, and hides under a project filter at ${name}`, async (_t, j) => {
    const exhaustion = exhaustibleRuntime();
    const phoneLayout = viewport.width < 760;
    const { page } = await openInbox(
      j,
      2,
      viewport,
      "/app/inbox",
      (fixture) => exhaustion.exhaust(fixture.runtime),
      false,
      exhaustion,
    );
    const rows = page.locator(".inbox-row");
    await rows.nth(2).waitFor();
    const runtimeRow = rows.first();
    assert.equal(await runtimeRow.getAttribute("data-kind"), "runtime");
    const rowText = (await runtimeRow.textContent()) ?? "";
    for (const expected of [
      "Runtime",
      "Codex runtime unavailable",
      "Retries exhausted",
      "Open runtime settings",
    ])
      assert.ok(rowText.includes(expected), `${expected} in ${rowText}`);
    // Its group leads, counts it, and the sidebar total includes it.
    const groups = await page
      .locator(".inbox-queue .inbox-group")
      .allTextContents();
    assert.deepEqual(groups, [
      "Intervention · 1",
      "Questions & approvals · oldest first",
    ]);
    assert.equal(
      await page
        .locator(phoneLayout ? ".page-header-count" : ".inbox-summary")
        .textContent(),
      phoneLayout ? "3 unresolved" : "3 unresolved across 2 projects",
    );
    assert.deepEqual(
      await page
        .getByLabel("Request kind", { exact: true })
        .evaluate((select) =>
          [...(select as HTMLSelectElement).options].map((o) => o.text),
        ),
      [
        "All request types · 3",
        "Questions · 2",
        "Approvals · 0",
        "Interventions · 0",
        "Runtime · 1",
      ],
    );

    const taskReads: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/operator/tasks/")) taskReads.push(r.url());
    });
    await runtimeRow.click();
    const detail = page.getByRole("region", { name: "Selected request" });
    await detail
      .getByRole("heading", { name: "Codex runtime unavailable" })
      .waitFor();
    const url = new URL(page.url());
    assert.equal(url.searchParams.get("request"), "runtime:codex");
    assert.equal(url.searchParams.has("task"), false);
    assert.ok(url.search.includes("request=runtime%3Acodex"), url.search);

    const text = (await detail.textContent()) ?? "";
    for (const expected of [
      "Restart retries exhausted",
      "The runtime failed to start",
    ])
      assert.ok(text.includes(expected), `${expected} in ${text}`);
    const base = exhaustion.clock.wall;
    const attempts = detail.locator(".inbox-attempts li");
    assert.deepEqual(await attempts.allInnerTexts(), [
      `Attempt 1 · ${clockLabel(base - 750_000 + 30_000)} · Failed — The runtime failed to start`,
      `Attempt 2 · ${clockLabel(base - 750_000 + 150_000)} · Failed — The runtime failed to start`,
      `Attempt 3 · ${clockLabel(base)} · Failed — The runtime failed to start`,
    ]);
    const action = detail.getByRole("link", { name: "Open runtime settings" });
    assert.equal(await action.getAttribute("href"), "/app/settings/runtime");
    // The action follows the attempts in reading order and takes keyboard focus.
    assert.equal(
      await action.evaluate((a) =>
        Boolean(
          (document
            .querySelector(".inbox-attempts")
            ?.compareDocumentPosition(a) ?? 0) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
      true,
    );
    await action.focus();
    assert.equal(
      await action.evaluate((a) => document.activeElement === a),
      true,
    );

    // It has no task: nothing to open, no inspector, and no task was read.
    assert.equal(
      await page.getByRole("link", { name: "Open task" }).count(),
      0,
    );
    assert.equal(await page.locator(".inbox-context").count(), 0);
    assert.deepEqual(taskReads, []);
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-inbox-runtime`, {
      fullPage: false,
    });

    if (phoneLayout) {
      const header = page.locator("header.page-header");
      assert.equal(
        await header.locator("h1").textContent(),
        "Runtime · 1 of 3",
      );
      assert.equal(
        await header.locator("a, button").count(),
        1,
        "Back only: there is no task to open",
      );
      await page
        .getByRole("link", { name: "Back to Inbox", exact: true })
        .click();
      await rows.first().waitFor({ state: "visible" });
      await settle(page);
      assert.equal(
        await runtimeRow.evaluate((el) => document.activeElement === el),
        true,
        "Back restores focus to the row",
      );
    }

    // A project filter hides it: the item belongs to no project.
    if (!phoneLayout) {
      await page
        .getByLabel("Project", { exact: true })
        .selectOption({ index: 1 });
      await settle(page);
      assert.equal(
        await page.locator('.inbox-row[data-kind="runtime"]').count(),
        0,
      );
      assert.equal(await rows.count(), 1);
    }
  });

test("a runtime link whose item has recovered says it is unavailable and reads no task", async (_t, j) => {
  const { page, seeded } = await openInbox(
    j,
    1,
    { width: 1366, height: 900 },
    "/app/inbox?request=runtime%3Acodex",
  );
  await page.getByText("Selected request is unavailable.").waitFor();
  const taskReads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/operator/tasks/")) taskReads.push(r.url());
  });
  // Load the link again with the listener in place, so a read at load would be seen.
  await page.reload();
  await page
    .locator(`.inbox-row[data-record-id="${seeded[0]!.interactionId}"]`)
    .waitFor();
  await page.getByText("Selected request is unavailable.").waitFor();
  assert.equal(
    await page.locator('.inbox-row[data-kind="runtime"]').count(),
    0,
  );
  assert.deepEqual(taskReads, []);
});

test("an Inbox holding only an exhausted runtime counts it without naming projects", async (_t, j) => {
  const exhaustion = exhaustibleRuntime();
  const { page } = await openInbox(
    j,
    0,
    { width: 1366, height: 900 },
    "/app/inbox",
    (fixture) => exhaustion.exhaust(fixture.runtime),
    false,
    exhaustion,
  );
  await page.locator('.inbox-row[data-kind="runtime"]').waitFor();
  assert.equal(
    await page.locator(".inbox-summary").textContent(),
    "1 unresolved",
  );
});
