import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { normalizePlan } from "../../src/standalone/agent-plan.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { desktop, phone, signIn } from "../fixtures/operator-settings.js";
import { choiceForm } from "../fixtures/question-data.js";
import { finishOwnWork, startOwnWork } from "../fixtures/questions.js";
import { stubReadiness } from "../fixtures/setup-browser.js";
import { openTaskTab } from "../fixtures/task-tabs.js";

const test = browserSuite("task-conversation");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
// A whole second, so seeded records order by their key rather than by the wall clock.
const second = 1_700_000_000;
const t0 = second * 1000;
const earlier = 60;

/**
 * One task: a lead with captured text (Markdown, a script literal), three commands (one
 * failing, with retained output), a file change, two gaps, an operator message and an open
 * question and approval; a completed worker with a result and a nested delegate; and enough
 * older entries that the newest page leaves some above it.
 */
async function seed(f: Fixture, filler = earlier) {
  const started = await startOwnWork(f, "Command menu", "Atlas");
  const { a, work } = started;
  for (const [tool, args] of [
    ["cab_ask_question", { form: choiceForm }],
    [
      "cab_request_approval",
      {
        action: "Create a pull request. No merge or deployment.",
        target: "acme/atlas · main ← command-menu",
        material: { scope: "fixture" },
      },
    ],
  ] as const) {
    const call = await f.runtime.callTool({
      threadId: work.threadId!,
      turnId: work.turnId!,
      callId: randomUUID(),
      tool,
      arguments: args,
    });
    assert.equal(call.success, true, call.text);
  }
  await finishOwnWork(f, started);
  const d = f.service.domain();
  const worker = randomUUID(),
    nested = randomUUID(),
    elder = randomUUID(),
    waiter = randomUUID();
  for (const [assignmentId, brief, requester] of [
    [worker, "Review keyboard support", a.assignmentId],
    [nested, "Check focus return", worker],
    [elder, "Audit the older notes", a.assignmentId],
    [waiter, "Cover toolbar launch", a.assignmentId],
  ] as const)
    d.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      taskId: a.taskId,
      assignmentId,
      profileId: a.profileId,
      brief,
      resultDestination: "requester",
      requesterAssignmentId: requester,
    });
  f.seedPersistedState((db) => {
    for (const id of [nested, elder])
      db.prepare(
        "UPDATE domain_assignments SET state='completed' WHERE id=?",
      ).run(id);
  });
  const result = a.result("Keyboard support ready", undefined, worker);
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "UPDATE domain_assignments SET state='completed' WHERE id=?",
    ).run(worker);
    let clock = t0;
    const bind = (assignmentId: string, workId: string) => ({
      workId,
      taskId: a.taskId,
      assignmentId,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      workRevision: 1,
      threadId: `thread-${workId}`,
      turnId: `turn-${workId}`,
    });
    const lead = bind(a.assignmentId, "work-conv-lead");
    const history = new ConversationHistoryStore(db, () => clock);
    const diagnostics = new ExecutionDiagnosticsStore(db, { now: () => clock });
    const say = (
      binding: ReturnType<typeof bind>,
      itemId: string,
      text: string,
    ) =>
      history.record(
        binding,
        {
          kind: "completed",
          threadId: binding.threadId,
          turnId: binding.turnId,
          itemId,
          text,
        },
        [],
      );
    // Older filler, so the newest page of 50 leaves entries above it.
    for (let n = 0; n < filler; n++) {
      clock = t0 - (filler - n) * 1000;
      say(lead, `filler-${n}`, `Earlier note ${n}`);
    }
    // An assignment delegated and heard from before all of that filler.
    clock = t0 - (filler + 5) * 1000;
    db.prepare(
      "INSERT INTO coordination_delegations(assignmentId, delegatedAt) VALUES (?, ?)",
    ).run(elder, clock);
    clock += 1000;
    say(bind(elder, `work-conv-${elder}`), "elder", "Elder note from before.");
    clock = t0;
    say(
      lead,
      "intro",
      "First: **bold** and a [link](https://example.com/docs) <script>window.pwned = 1</script>\n\n- item one",
    );
    clock = t0 + 2000;
    history.omitItem(lead, "too-old", "item-limit");
    diagnostics.begin({
      workId: lead.workId,
      taskId: a.taskId,
      projectId: a.projectId,
      assignmentId: a.assignmentId,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "enhanced",
      eventSource: "supported",
    });
    const tool = (name: string, itemId: string, payload: object) =>
      diagnostics.record(
        lead.workId,
        "runtime",
        name,
        "info",
        itemId,
        { itemId, ...payload },
        [],
      );
    for (const [n, exitCode] of [0, 0, 1].entries()) {
      clock = t0 + 3000 + n * 100;
      tool("commandExecution/completed", `cmd-${n}`, {
        phase: "completed",
        itemType: "commandExecution",
        status: "completed",
        command: `npm run step-${n}`,
        exitCode,
        aggregatedOutput: `output of step ${n}`,
        observedAt: clock + 1500,
      });
    }
    clock = t0 + 3500;
    tool("fileChange/completed", "fc-1", {
      phase: "completed",
      itemType: "fileChange",
      status: "completed",
      paths: ["src/menu.ts", "src/menu.css"],
    });
    clock = t0 + 3550;
    tool("toolCall/completed", "rd-1", {
      phase: "completed",
      itemType: "toolCall",
      status: "completed",
      tool: "Read",
      target: "src/menu.ts",
      observedAt: clock + 2000,
    });
    db.prepare(
      `INSERT INTO diagnostic_gaps(workId,code,count,bytes,firstAt,lastAt,maxPrunedSequence)
        VALUES (?, 'expired', 3, 10, ?, ?, 2)`,
    ).run(lead.workId, t0 + 3600, t0 + 3600);
    clock = t0 + 4000;
    say(lead, "closing", "Second: all steps ran.");
    db.prepare(
      "INSERT INTO coordination_inbox_events(eventId,taskId,recipientAssignmentId,eventType,payload,createdAt) VALUES (?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      a.taskId,
      a.assignmentId,
      "operator-message",
      JSON.stringify({ message: "Please also check Escape" }),
      second + 5,
    );
    for (const [assignmentId, at, text] of [
      [worker, 6000, "Worker found the menu opens on Enter."],
      [nested, 7000, "Nested delegate confirmed focus returns."],
      [waiter, 8000, "Waiter is queued behind the review."],
    ] as const) {
      db.prepare(
        "INSERT INTO coordination_delegations(assignmentId, delegatedAt) VALUES (?, ?)",
      ).run(assignmentId, t0 + at - 500);
      clock = t0 + at;
      say(bind(assignmentId, `work-conv-${assignmentId}`), `n-${at}`, text);
    }
  });
  return { ...started.a, worker, nested, elder, waiter, result, work };
}

/** A newer captured entry on the lead's stream, shown after the next task read. */
function appendEntry(
  f: Fixture,
  s: Awaited<ReturnType<typeof seed>>,
  text: string,
) {
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    const at = Date.now();
    db.prepare(
      "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,?,?)",
    ).run(
      "work-conv-lead",
      s.taskId,
      s.assignmentId,
      "thread-work-conv-lead",
      "turn-work-conv-lead",
      `late-${at}`,
      text,
      at,
      at,
    );
  });
}

// A script click, so the page does not scroll to the header button first.
const refresh = (page: Page) =>
  page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
/** The newest conversation entry is in view, as it is when the page follows the bottom. */
const atBottom = (page: Page) =>
  page.evaluate(
    () =>
      (document.getElementById("conversation-end")?.getBoundingClientRect()
        .bottom ?? Number.POSITIVE_INFINITY) <=
      innerHeight + 1,
  );

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`the Overview is the task's conversation, pinned attention and one answer per request (${label})`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const s = await seed(f);
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({ viewport });
    j.observe(page);
    page.setDefaultTimeout(5000);
    const answers: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/operator/commands"
      )
        answers.push(request.postDataJSON());
    });
    await stubReadiness(page);
    await signIn(page, web, `/tasks/${s.taskId}`);
    const log = page.getByRole("log", { name: "Task conversation" });
    await log.getByText("Second: all steps ran.").waitFor();

    // A superseded read is not a stale conversation.
    assert.equal(await page.getByText("could not be refreshed").count(), 0);

    // 1. Header and attention card.
    await page
      .getByRole("heading", { name: "Command menu", level: 1 })
      .waitFor();
    assert.match(
      (await page.locator("[data-task-strip]").textContent()) ?? "",
      /Accountable lead · Task lead/,
    );
    const decisions = page.locator("#decisions");
    assert.equal(await decisions.locator(".decision").count(), 2);
    if (viewport === phone) {
      // A phone pins the one-line banner; it opens by default so the first screen holds the decision.
      const banner = decisions.locator(".attention-banner");
      assert.match((await banner.textContent()) ?? "", /2 decisions waiting/);
      await banner.click();
      assert.equal(
        await decisions.locator(".decision").first().isVisible(),
        false,
      );
      assert.equal(
        await decisions.evaluate((e) => getComputedStyle(e).position),
        "sticky",
      );
      await banner.click();
      await decisions.locator(".decision").first().waitFor();
    } else
      assert.equal(
        await decisions.evaluate((e) => getComputedStyle(e).position),
        "sticky",
      );
    assert.deepEqual(
      await page
        .getByRole("tablist", { name: "Task sections" })
        .getByRole("tab")
        .allTextContents(),
      ["Overview", "Files", "Changes", "Review", "Execution"],
      "the conversation replaced the History tab",
    );

    // The approval is decided in the card (its link keeps this entry); the conversation entry follows.
    await decisions
      .getByRole("link", { name: "Review material & decide" })
      .click();
    const approval = decisions.locator(".approval-review");
    await approval
      .getByRole("button", { name: "Approve this exact material" })
      .click();
    await log
      .locator("[data-interaction-id]", { hasText: "Approval" })
      .getByText("Approved", { exact: true })
      .first()
      .waitFor();
    assert.equal(answers.filter((c) => c.type === "approval.decide").length, 1);

    // 2. Markdown renders without executing; Raw text shows the source.
    const intro = log.locator(".conv-agent", { hasText: "First:" });
    assert.equal(
      await intro.locator("strong", { hasText: "bold" }).textContent(),
      "bold",
    );
    // Links are shown as text, never opened from the conversation.
    assert.equal(await log.locator("a[href*='example.com']").count(), 0);
    assert.equal(
      await intro.locator(".file-markdown-link").textContent(),
      "link",
    );
    assert.equal(await log.locator("script").count(), 0);
    assert.equal(await page.evaluate(() => "pwned" in window), false);
    await intro.getByRole("button", { name: "Raw text" }).click();
    assert.match(
      (await intro.locator("pre").textContent()) ?? "",
      /\*\*bold\*\*.*<script>window\.pwned = 1<\/script>/s,
    );
    await intro.getByRole("button", { name: "Formatted" }).click();
    const text = (await log.textContent()) ?? "";
    const order = [
      "First:",
      "Ran 3 commands · 1 failed · 4s",
      "Changed 2 files",
      "Second: all steps ran.",
      "Please also check Escape",
    ].map((part) => text.indexOf(part));
    assert.ok(
      order.every((n) => n >= 0),
      `parts present ${order}`,
    );
    assert.deepEqual(
      order,
      [...order].sort((x, y) => x - y),
      "entries read in key order",
    );

    // 3. Tool activity: grouped commands with output on request, file changes, gaps.
    const outputReads: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/timeline/output/"))
        outputReads.push(request.url());
    });
    assert.equal(
      outputReads.length,
      0,
      "no output is read before it is asked for",
    );
    await log
      .getByRole("button", { name: "Ran 3 commands · 1 failed · 4s" })
      .click();
    const failing = log.locator("li", { hasText: "npm run step-2" });
    assert.match((await failing.textContent()) ?? "", /exit 1/);
    await failing.getByRole("button", { name: "Show output" }).click();
    await failing.getByText("output of step 2").waitFor();
    assert.equal(outputReads.length, 1);
    // Fetched output is read again when the visibility revision changes, so redaction cannot lag.
    const timelineUrl = "**/api/operator/tasks/*/timeline?limit=50";
    await page.route(timelineUrl, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.visibilityRevision = "f".repeat(64);
      await route.fulfill({ response, json });
    });
    await refresh(page);
    await page.waitForFunction(
      () => document.querySelectorAll(".conv-commands pre").length > 0,
    );
    for (let i = 0; i < 50 && outputReads.length < 2; i++)
      await page.waitForTimeout(100);
    assert.equal(outputReads.length, 2);
    await page.unroute(timelineUrl);
    // The group closes and opens again, whichever of its commands holds the open state.
    const group = log.getByRole("button", {
      name: "Ran 3 commands · 1 failed · 4s",
    });
    await group.click();
    assert.equal(await group.getAttribute("aria-expanded"), "false");
    await group.click();
    assert.equal(await group.getAttribute("aria-expanded"), "true");
    // Durations, changed paths and the allowlisted target read in the conversation.
    assert.match((await failing.textContent()) ?? "", /exit 1 · 1s/);
    const changed = log.locator(".conv-tools", { hasText: "Changed 2 files" });
    assert.deepEqual(await changed.locator("li").allTextContents(), [
      "src/menu.ts",
      "src/menu.css",
    ]);
    await log
      .getByText("Tool · Read · src/menu.ts · completed · 2s", { exact: true })
      .waitFor();
    const opener = log.getByRole("button", { name: "Open in Changes" });
    const changesTab = page.getByRole("tab", { name: "Changes", exact: true });
    const pane = page.locator("aside[aria-label='Changes']");
    const url = page.url();
    const focusMode = page.getByRole("button", {
      name: "Focus mode",
      exact: true,
    });
    if (viewport === desktop) await focusMode.click();
    await opener.click();
    if (viewport === desktop) {
      // Wide screens open the pane beside the conversation, with focus inside it.
      await pane.waitFor();
      // Asking for Changes leaves focus mode.
      assert.equal(await focusMode.getAttribute("aria-pressed"), "false");
      assert.equal(page.url(), url);
      assert.equal(await changesTab.getAttribute("aria-selected"), "false");
      assert.equal(
        await pane.evaluate((el) => el === document.activeElement),
        true,
      );
      await pane.getByRole("button", { name: "Close", exact: true }).click();
      await pane.waitFor({ state: "detached" });
      await opener.waitFor();
      await page.waitForFunction(
        () =>
          document.activeElement?.textContent === "Open in Changes" &&
          document.activeElement.closest("[data-record-id]") !== null,
      );
      await opener.click();
      await pane
        .getByRole("button", { name: "Open full width", exact: true })
        .click();
      await pane.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.id === "task-tab-changes",
      );
    }
    assert.equal(await changesTab.getAttribute("aria-selected"), "true");
    await openTaskTab(page, "Overview");
    const gap = log.locator(".conv-gap", { hasText: "Older items" });
    await gap.getByRole("button", { name: "Details" }).click();
    assert.match(
      (await gap.locator("dl").textContent()) ?? "",
      /work-conv-lead/,
    );
    assert.ok(
      (await log.locator(".conv-gap", { hasText: "Tool activity" }).count()) >
        0,
    );

    // 4. The delegation names its profile, assignment and harness, and nests the grandchild.
    const delegation = log.locator(`[data-record-id="delegation:${s.worker}"]`);
    const head = delegation.getByRole("button").first();
    assert.equal(await head.getAttribute("aria-expanded"), "false");
    assert.match((await head.textContent()) ?? "", /Codex/);
    await head.click();
    await delegation
      .getByText("Worker found the menu opens on Enter.")
      .waitFor();
    const child = delegation.locator(
      `[data-record-id="delegation:${s.nested}"]`,
    );
    await child.getByRole("button").first().click();
    await child.getByText("Nested delegate confirmed focus returns.").waitFor();

    // 5. One answer per request, from the conversation; the draft moves with the form.
    const question = log.locator("[data-interaction-id][data-status]", {
      hasText: "Question",
    });
    await question.getByRole("button", { name: "Answer question" }).click();
    const response = question.getByRole("region", {
      name: "Exact question response",
    });
    await response.getByRole("radio", { name: /^Team owners/ }).check();
    await decisions.getByText("Answering in the conversation.").waitFor();
    await decisions
      .getByRole("button", { name: "Answer here instead" })
      .click();
    const inCard = decisions.getByRole("region", {
      name: "Exact question response",
    });
    assert.equal(
      await inCard.getByRole("radio", { name: /^Team owners/ }).isChecked(),
      true,
      "the unfinished choice moved with the form",
    );
    assert.equal(
      await page
        .getByRole("region", { name: "Exact question response" })
        .count(),
      1,
    );
    await question.getByRole("button", { name: "Answer here instead" }).click();
    await response.getByRole("button", { name: "Submit answer" }).click();
    await question.getByText("Answered", { exact: true }).first().waitFor();
    await decisions
      .getByText("No longer waiting; see the conversation.")
      .waitFor();
    const recorded = answers.filter((c) => c.type === "question.form.answer");
    assert.equal(recorded.length, 1);
    assert.equal(
      f.service.coordinationView().readTask(s.taskId).questions.length,
      1,
    );

    // 6. Following the bottom, and Jump to latest.
    await page.evaluate(() =>
      scrollTo(0, document.documentElement.scrollHeight),
    );
    appendEntry(f, s, "Fresh while at the bottom");
    await refresh(page);
    await log.getByText("Fresh while at the bottom").waitFor();
    assert.equal(await atBottom(page), true, "stays at the bottom");

    const reply = page.getByLabel("Editable reply");
    await reply.fill("An unfinished reply");
    const anchor = log.getByRole("button", {
      name: "Ran 3 commands · 1 failed · 4s",
    });
    await page.evaluate(() => scrollTo(0, 0));
    await anchor.scrollIntoViewIfNeeded();
    const y = () => anchor.evaluate((el) => el.getBoundingClientRect().top);
    const before = await y();
    appendEntry(f, s, "Fresh while reading");
    await refresh(page);
    const jump = page.getByRole("button", { name: /jump to latest/i });
    await jump.waitFor();
    assert.ok(Math.abs((await y()) - before) <= 2, "reading position held");
    assert.equal(await anchor.getAttribute("aria-expanded"), "true");
    assert.equal(await reply.inputValue(), "An unfinished reply");
    await jump.click();
    await log.getByText("Fresh while reading").waitFor();
    assert.equal(await atBottom(page), true);
    assert.equal(await reply.inputValue(), "An unfinished reply");

    // 7. Load earlier prepends without moving what is in view.
    const load = page.getByRole("button", {
      name: "Load earlier",
      exact: true,
    });
    await load.scrollIntoViewIfNeeded();
    const firstShown = () =>
      log.locator(".conv-entry").evaluateAll((entries) => {
        const e = entries.find((x) => x.getBoundingClientRect().bottom > 120);
        return e
          ? { text: e.textContent, top: e.getBoundingClientRect().top }
          : null;
      });
    const shown = await firstShown();
    assert.ok(shown?.text);
    const entries = await log.locator(".conv-entry").count();
    await load.evaluate((button) => (button as HTMLButtonElement).click());
    await log
      .getByText("Earlier note 0", { exact: true })
      .waitFor({ state: "attached" });
    assert.ok((await log.locator(".conv-entry").count()) > entries);
    const held = await log
      .locator(".conv-entry", { hasText: shown.text.slice(0, 40) })
      .first()
      .evaluate((e) => e.getBoundingClientRect().top);
    assert.ok(Math.abs(held - shown.top) <= 2, "visible entry held");

    // 8. Search targets still reveal their inspector cards: a closed card opens, even on a phone.
    await page.goto(`${web.origin}/tasks/${s.taskId}?section=brief`);
    await page.locator("#brief > details[open]").waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Shared brief" }).isVisible(),
      true,
    );
    await page.goto(
      `${web.origin}/tasks/${s.taskId}?section=review&result=${s.result.resultId}`,
    );
    const latest = page
      .locator("#review")
      .getByText("Keyboard support ready", { exact: true });
    await latest.waitFor();
    assert.equal(await latest.isVisible(), true);
    await page.goto(`${web.origin}/tasks/${s.taskId}?section=context`);
    await page.locator("#context > details[open]").waitFor();
    assert.equal(await page.locator("#context h3").isVisible(), true);
  });
}

const inView = (target: Locator) =>
  target.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  });
/** Records each scroll to an element and when each conversation record first rendered. */
function trackLanding() {
  const landing = {
    scrolls: [] as unknown[],
    seen: {} as Record<string, number>,
  };
  Object.assign(window, { __landing: landing });
  const stamp = (e: Element) => ({
    t: Math.round(performance.now()),
    id: e.id,
    recordId: e.closest("[data-record-id]")?.getAttribute("data-record-id"),
    scrollY: Math.round(scrollY),
  });
  const scroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    landing.scrolls.push(stamp(this));
    return scroll.apply(this, args);
  };
  new MutationObserver(() => {
    for (const e of document.querySelectorAll("[data-record-id]")) {
      const id = e.getAttribute("data-record-id") ?? "";
      landing.seen[id] ??= Math.round(performance.now());
    }
  }).observe(document, { childList: true, subtree: true });
}
/** Waits for a link's scroll to settle on its target; a miss reports what the scroll found. */
async function landsOn(
  j: BrowserJourney,
  page: Page,
  target: Locator,
  label: string,
) {
  for (let i = 0; i < 50 && !(await inView(target)); i++)
    await page.waitForTimeout(100);
  if (await inView(target)) return;
  const diagnostic = await page.evaluate(() => ({
    viewport: { height: innerHeight, width: innerWidth },
    scrollY,
    expanded: [
      ...document.querySelectorAll("[data-record-id^='delegation:']"),
    ].map((e) => [
      e.getAttribute("data-record-id"),
      e.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"),
    ]),
    landing: (window as unknown as { __landing?: unknown }).__landing,
  }));
  const rect = await target
    .evaluate((e) => e.getBoundingClientRect().toJSON())
    .catch(() => null);
  await j.capture(page, "link-not-landed");
  assert.fail(`${label}: ${JSON.stringify({ rect, ...diagnostic })}`);
}
async function openFixture(
  j: BrowserJourney,
  filler = earlier,
  viewport: typeof desktop = desktop,
) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const s = await seed(f, filler);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await stubReadiness(page);
  await page.addInitScript(trackLanding);
  return { f, s, web, page };
}

test("the conversation and the composer heading are readable on first load when the header fills the first screen", async (_t, j) => {
  const { s, web, page } = await openFixture(j, earlier, {
    width: 1280,
    height: 800,
  });
  await signIn(page, web, `/tasks/${s.taskId}`);
  await page.getByRole("log", { name: "Task conversation" }).waitFor();
  for (const name of ["Conversation", "Reply"]) {
    const heading = page.getByRole("heading", { name, exact: true });
    await heading.scrollIntoViewIfNeeded();
    const uncovered = await heading.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + 4, box.y + box.height / 2);
      return hit === element || element.contains(hit);
    });
    assert.equal(uncovered, true, `${name} heading is not covered`);
  }
  assert.equal(await page.title(), "Task · cab");
});

test("every former History link lands at its place in the conversation", async (_t, j) => {
  const { f, s, web, page } = await openFixture(j);
  await signIn(page, web, `/tasks/${s.taskId}`);
  const log = page.getByRole("log", { name: "Task conversation" });
  await log.getByText("Second: all steps ran.").waitFor();
  const question = f.service.coordinationView().readTask(s.taskId).questions[0];
  assert.ok(question);
  const delegation = (id: string) =>
    log.locator(`[data-record-id="delegation:${id}"]`);
  const open = async (id: string) =>
    assert.equal(
      await delegation(id)
        .getByRole("button", { expanded: true })
        .first()
        .count(),
      1,
      `delegation ${id} is expanded`,
    );
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/timeline?")) reads.push(request.url());
  });

  // The conversation's newest entry, however the former History link was written.
  for (const link of ["#history", "?section=history", "#conversation"]) {
    await page.goto(`${web.origin}/tasks/${s.taskId}${link}`);
    await log.getByText("Second: all steps ran.").waitFor();
    for (let i = 0; i < 50 && !(await atBottom(page)); i++)
      await page.waitForTimeout(100);
    assert.equal(await atBottom(page), true, link);
    assert.equal(await page.getByRole("tab", { name: "History" }).count(), 0);
  }

  // Captured context sits in the inspector.
  await page.goto(`${web.origin}/tasks/${s.taskId}?section=context`);
  await page.locator("#context > details[open]").waitFor();

  // An assignment opens its delegation, and those above it.
  for (const link of [
    `?assignment=${s.worker}`,
    `?assignment=${s.worker}#history`,
  ]) {
    await page.goto(`${web.origin}/tasks/${s.taskId}${link}`);
    await landsOn(j, page, delegation(s.worker), link);
    await open(s.worker);
  }
  await page.goto(`${web.origin}/tasks/${s.taskId}?assignment=${s.nested}`);
  await landsOn(j, page, delegation(s.nested), "a nested delegation");
  await open(s.worker);
  await open(s.nested);

  // The lead's own place is the conversation.
  await page.goto(
    `${web.origin}/tasks/${s.taskId}?assignment=${s.assignmentId}`,
  );
  await landsOn(j, page, page.locator("#conversation-heading"), "the lead");

  // A request is reached in the conversation when the link names it.
  await page.goto(
    `${web.origin}/tasks/${s.taskId}?request=${question.interactionId}#history`,
  );
  await landsOn(
    j,
    page,
    log.locator(`[data-interaction-id="${question.interactionId}"]`),
    "a request in the conversation",
  );

  // An assignment older than the loaded window: earlier pages are read until it is found.
  reads.length = 0;
  await page.goto(`${web.origin}/tasks/${s.taskId}?assignment=${s.elder}`);
  await landsOn(
    j,
    page,
    delegation(s.elder),
    "an assignment older than the window",
  );
  await open(s.elder);
  await log.getByText("Elder note from before.").waitFor();
  assert.ok(
    reads.some((url) => url.includes("before=")),
    "read an earlier page",
  );
  assert.equal(await page.getByText("is older than the part").count(), 0);

  // An open assignment whose entries are all on an older page has a placeholder at first;
  // the link still reads the earlier page rather than stopping there.
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='pending' WHERE id=?")
      .run(s.elder),
  );
  reads.length = 0;
  await page.goto(`${web.origin}/tasks/${s.taskId}?assignment=${s.elder}`);
  await log.getByText("Elder note from before.").waitFor();
  await landsOn(
    j,
    page,
    delegation(s.elder),
    "an open assignment older than the window",
  );
  assert.ok(
    reads.some((url) => url.includes("before=")),
    "read an earlier page",
  );
});

test("a link to a nested delegation lands even when the frame callback runs before the render", async (_t, j) => {
  const { s, web, page } = await openFixture(j);
  // The frame callback now runs before React's scheduled render, as it can on a loaded machine.
  await page.addInitScript(() => {
    window.requestAnimationFrame = (callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 0;
    };
  });
  await signIn(page, web, `/tasks/${s.taskId}`);
  const log = page.getByRole("log", { name: "Task conversation" });
  await log.getByText("Second: all steps ran.").waitFor();
  await page.goto(`${web.origin}/tasks/${s.taskId}?assignment=${s.nested}`);
  const delegation = (id: string) =>
    log.locator(`[data-record-id="delegation:${id}"]`);
  await landsOn(j, page, delegation(s.nested), "a nested delegation");
  for (const id of [s.worker, s.nested])
    assert.equal(
      await delegation(id)
        .getByRole("button", { expanded: true })
        .first()
        .count(),
      1,
      `delegation ${id} is expanded`,
    );
});

test("a link to a record beyond the ten-page bound stops at the conversation's top with Load earlier", async (_t, j) => {
  // 560 older notes put the elder delegation 11 pages below the newest.
  const { s, web, page } = await openFixture(j, 560);
  await signIn(page, web, `/tasks/${s.taskId}`);
  const log = page.getByRole("log", { name: "Task conversation" });
  await log.getByText("Second: all steps ran.").waitFor();
  const earlierReads: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/timeline?") &&
      request.url().includes("before=")
    )
      earlierReads.push(request.url());
  });
  await page.goto(`${web.origin}/tasks/${s.taskId}?assignment=${s.elder}`);
  const notice = page
    .getByRole("status")
    .filter({ hasText: "is older than the part" });
  await notice.waitFor();
  assert.match(
    (await notice.textContent()) ?? "",
    /^The conversation of .* is older than the part of the conversation loaded so far\.$/,
  );
  await landsOn(
    j,
    page,
    page.locator("#conversation-heading"),
    "the conversation's top",
  );
  assert.equal(earlierReads.length, 10, "ten earlier pages at most");
  await page
    .getByRole("button", { name: "Load earlier", exact: true })
    .waitFor();
  assert.equal(
    await log.locator(`[data-record-id="delegation:${s.elder}"]`).count(),
    0,
  );
  // Load earlier carries on, and the delegation appears once its page does.
  await page.getByRole("button", { name: "Load earlier", exact: true }).click();
  await log.locator(`[data-record-id="delegation:${s.elder}"]`).waitFor();
  assert.equal(
    await notice.count(),
    0,
    "the notice goes once the record is loaded",
  );
});

test("a delegate is replied to from its sub-conversation header through the shared composer, and an unconfirmed send keeps its draft and key", async (_t, j) => {
  const { f, s, web, page } = await openFixture(j);
  const sent: Array<{
    type: string;
    key: string;
    body?: string;
    recipients?: { assignmentId: string }[];
    raw: string;
  }> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      sent.push({ ...request.postDataJSON(), raw: request.postData() ?? "" });
  });
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/operator/operations?"))
      reads.push(`${sent.length}`);
  });
  await signIn(page, web, `/tasks/${s.taskId}`);
  const log = page.getByRole("log", { name: "Task conversation" });
  await log.getByText("Second: all steps ran.").waitFor();
  // The older direct form is gone: Reply is the only entry, and it never holds a second composer.
  const waiter = log.locator(`[data-record-id="delegation:${s.waiter}"]`);
  await waiter.getByRole("button").first().click();
  assert.equal(await waiter.locator("form.assignment-message").count(), 0);
  await waiter.getByRole("button", { name: /^Reply to / }).click();
  // Reply selects exactly that assignment, replacing the default lead.
  const box = page.getByLabel("Editable reply");
  assert.equal(await page.locator(".recipient-chip").count(), 1);
  assert.equal(
    await page
      .locator(`.recipient-chip[data-assignment-id="${s.waiter}"]`)
      .count(),
    1,
  );
  assert.equal(await box.evaluate((e) => e === document.activeElement), true);
  const send = page.getByRole("button", { name: "Send comment" });

  // The reply never reaches the service: the draft stays, and the check reads the receipt first.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await box.fill("Also cover toolbar launch.");
  await send.click();
  await page.getByRole("button", { name: "Check whether it saved" }).waitFor();
  assert.equal(await box.inputValue(), "Also cover toolbar launch.");
  assert.equal(sent.length, 1);
  await page.unroute("**/api/operator/commands");
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  await page.getByText(/^Comment sent to /).waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.raw, sent[0]?.raw, "same key and body");
  assert.deepEqual(reads, ["1"], "the receipt is read before the retry");
  assert.equal(sent[0]?.type, "task.comment.send");
  assert.deepEqual(
    sent[0]?.recipients?.map((r) => r.assignmentId),
    [s.waiter],
  );
  const view = f.service.coordinationView().readTask(s.taskId);
  assert.equal(
    view.messages.filter(
      (m) => m.recipientAssignmentId === s.waiter && m.sharedCommentId,
    ).length,
    1,
    "one comment, one delivery",
  );
  assert.equal(view.comments.length, 1);
  assert.equal(await box.inputValue(), "");
  // The conversation shows the comment once, at the task root, not inside the delegation.
  // The notice comes from the receipt; the timeline shows the comment after its own re-read.
  await log.getByText("Also cover toolbar launch.").waitFor();
  assert.equal(await log.getByText("Also cover toolbar launch.").count(), 1);
  assert.equal(await waiter.getByText("Also cover toolbar launch.").count(), 0);
});

for (const colorScheme of ["light", "dark"] as const)
  test(`tool durations, targets and changed paths are legible in the ${colorScheme} theme`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const s = await seed(f, 2);
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({ viewport: desktop, colorScheme });
    j.observe(page);
    page.setDefaultTimeout(5000);
    await stubReadiness(page);
    await signIn(page, web, `/tasks/${s.taskId}`);
    const log = page.getByRole("log", { name: "Task conversation" });
    await log.getByText("Second: all steps ran.").waitFor();
    await log
      .getByRole("button", { name: "Ran 3 commands · 1 failed · 4s" })
      .click();
    for (const locator of [
      log.getByRole("button", { name: /Ran 3 commands/ }),
      log.locator(".conv-commands li", { hasText: "exit 1 · 1s" }).first(),
      log.locator(".conv-paths code").first(),
      log.getByText("Tool · Read · src/menu.ts"),
    ]) {
      await locator.waitFor();
      const { color, background } = await locator.evaluate((element) => {
        let node: Element | null = element;
        let background = "rgba(0, 0, 0, 0)";
        while (node) {
          background = getComputedStyle(node).backgroundColor;
          if (background !== "rgba(0, 0, 0, 0)") break;
          node = node.parentElement;
        }
        return { color: getComputedStyle(element).color, background };
      });
      assert.notEqual(color, background, `${colorScheme} text is distinct`);
    }
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`the lead's plan card appears only with a plan, works from the keyboard and a plan line shows the current plan (${colorScheme})`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const started = await startOwnWork(f, "Plan card", "Atlas");
    await finishOwnWork(f, started);
    const { a } = started;
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({ viewport: desktop, colorScheme });
    j.observe(page);
    page.setDefaultTimeout(5000);
    await stubReadiness(page);
    await signIn(page, web, `/tasks/${a.taskId}`);
    await page.getByRole("log", { name: "Task conversation" }).waitFor();
    const heading = page.getByRole("heading", { name: "Agent's plan" });
    assert.equal(await heading.count(), 0, "no card without a plan");

    f.seedPersistedState((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      const plan = normalizePlan([
        { text: "Read the menu code", status: "completed" },
        { text: "Add keyboard support", status: "in_progress" },
        { text: "Write the tests", status: "pending" },
      ]);
      assert.ok(plan);
      new ConversationHistoryStore(db).recordPlan(
        {
          workId: "work-plan-lead",
          taskId: a.taskId,
          assignmentId: a.assignmentId,
          assignmentVersion: 1,
          instructionsRevision: 1,
          profileRevision: 1,
          conversationRevision: 1,
          workRevision: 1,
          threadId: "thread-plan",
          turnId: "turn-plan",
        },
        plan,
        [],
      );
    });
    await refresh(page);
    await heading.waitFor();
    const card = page.locator("section.plan-card");
    assert.match(
      (await card.textContent()) ?? "",
      /working plan, not a requirement or the brief/,
    );
    const reply = page.getByRole("heading", { name: "Reply", exact: true });
    const [cardBox, replyBox] = await Promise.all([
      card.boundingBox(),
      reply.boundingBox(),
    ]);
    assert.ok(cardBox && replyBox && cardBox.y < replyBox.y, "above Reply");
    const steps = card.locator(".plan-steps li");
    assert.deepEqual(
      (await steps.allTextContents()).map((t) => t.replace(/\s+/g, " ")),
      [
        "✓ DoneRead the menu code",
        "◐ In progressAdd keyboard support",
        "○ PendingWrite the tests",
      ],
    );
    // Step text is legible against the card in this theme.
    const contrast = await steps.first().evaluate((li) => {
      const card = li.closest("section") as HTMLElement;
      return [
        getComputedStyle(li).color,
        getComputedStyle(card).backgroundColor,
      ];
    });
    assert.notEqual(contrast[0], contrast[1]);

    // Keyboard: Tab reaches the toggle; Enter collapses, Space expands.
    const toggle = card.getByRole("button", {
      name: "Agent's plan · 1/3 done",
    });
    await card.locator(".metadata").evaluate((e) => {
      e.setAttribute("tabindex", "-1");
      (e as HTMLElement).focus();
    });
    await page.keyboard.press("Tab");
    assert.equal(
      await toggle.evaluate((e) => e === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await steps.count(), 0);
    await page.keyboard.press("Space");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await steps.count(), 3);

    // The conversation's plan line reveals the current plan.
    const line = page
      .getByRole("log", { name: "Task conversation" })
      .getByRole("button", { name: "Plan updated · 1/3 done" });
    await line.click();
    assert.equal(await line.getAttribute("aria-expanded"), "true");
    const current = page.locator(".plan-current");
    assert.match((await current.textContent()) ?? "", /^Current plan of /);
    assert.equal(await current.locator(".plan-steps li").count(), 3);
  });
