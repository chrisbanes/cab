import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedRetainedReviewWindow } from "../fixtures/task-review.js";
import { openOverviewCard, openTaskTab } from "../fixtures/task-tabs.js";
import { searchRecords } from "../fixtures/shell-search.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
// Retained-history seeding shares the startup deadline with web/browser launch.
// These journeys assert no deadline of their own, so every budget is wide
// headroom for a loaded runner: with 24 concurrent copies on 10 cores, setup
// passed 40 s, the journey 60 s, one re-render of 272 records 30 s (about 1 s
// unloaded) and browser.close 10 s.
const retentionJourneyLimits = {
  startupMs: 90000,
  executionMs: 150000,
  overallMs: 200000,
  cleanupStepMs: 30000,
};
const retentionActionMs = 30000;
const test = browserSuite(
  "operator-retention-access-browser",
  retentionJourneyLimits,
);
async function retainedJourney(j: BrowserJourney, counterpart: boolean) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const journeyStarted = performance.now();
  let currentStage = "fixture-ready";
  let lastReading: unknown = null;
  const stage = (name: string) => {
    currentStage = name;
    try {
      if (j.diagnostics.length < 40)
        j.diagnostics.push(
          JSON.stringify({
            stage: name,
            elapsedMs: Math.round(performance.now() - journeyStarted),
          }),
        );
    } catch {
      /* Diagnostics must not replace the primary action failure. */
    }
  };
  const deadlineDiagnostic = setTimeout(() => {
    try {
      if (j.diagnostics.length < 40)
        j.diagnostics.push(
          JSON.stringify({
            stage: "execution-deadline-approaching",
            currentStage,
            elapsedMs: Math.round(performance.now() - journeyStarted),
            lastKnownReading: lastReading,
          }),
        );
    } catch {
      /* Cached diagnostics require no live browser call at the deadline. */
    }
  }, retentionJourneyLimits.executionMs - 1000);
  deadlineDiagnostic.unref();
  j.cleanup(async () => {
    clearTimeout(deadlineDiagnostic);
  }, "diagnostic-timer.clear");
  stage("fixture-ready");
  const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
      "base64",
    ),
    artifactId = randomUUID();
  const a = await seedRetainedReviewWindow(f, [
    {
      artifactId,
      label: "Ancient artifact",
      role: "evidence",
      revision: 1,
      availability: "available",
      file: {
        relativePath: "ancient.png",
        mime: "image/png",
        size: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
      },
    },
  ]);
  const headA = "a".repeat(40),
    headB = "b".repeat(40);
  const observation = {
    repositoryId: "R1",
    nodeId: "P_OLD",
    number: 1,
    baseRef: "main",
    headRef: "cb/review",
    headSha: headA,
    baseSha: "c".repeat(40),
    state: "OPEN" as const,
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash" as const],
  };
  f.service.delivery().registerPrWithinTransaction(
    {
      projectId: a.projectId,
      taskId: a.taskId,
      taskVersion: Number(f.service.domain().task(a.taskId).version),
      assignmentId: a.assignmentId,
      assignmentVersion: Number(
        f.service.domain().assignment(a.assignmentId).version,
      ),
      workId: a.old.workId,
      workRevision: 1,
      conversationRevision: 1,
    },
    observation,
    a.assignmentId,
  );
  // Simulate retained pre-fix metadata; parsing remains compatible, links do not.
  f.seedPersistedState((db) => {
    const row = db
      .prepare("SELECT recordJson FROM task_review_results WHERE resultId=?")
      .get(a.old.resultId) as { recordJson: string };
    const record = JSON.parse(row.recordJson);
    record.metadata.changes = {
      files: [],
      commits: [],
      findings: [],
      reference: "data:text/html,unsafe",
    };
    record.metadata.validations = [
      {
        label: "Historical check",
        scope: "Recorded fixture",
        provenance: "Reported only",
        outcome: "failed",
        checkedHead: headA,
      },
    ];
    db.prepare(
      "UPDATE task_review_results SET recordJson=? WHERE resultId=?",
    ).run(JSON.stringify(record), a.old.resultId);
  });
  const workspace = await f.service.taskWorkspace(a.taskId);
  assert.ok(workspace);
  await writeFile(join(workspace.path, "ancient.png"), png);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  const readingRequests: { event: string; stream: string; status?: number }[] =
    [];
  const trace = (entry: { event: string; stream: string; status?: number }) => {
    if (readingRequests.length === 32) readingRequests.shift();
    readingRequests.push(entry);
  };
  const readingStream = (url: string) => {
    const u = new URL(url);
    return u.pathname === `/api/operator/tasks/${a.taskId}`
      ? "task"
      : u.pathname === `/api/operator/tasks/${a.taskId}/timeline`
        ? `timeline:before=${u.searchParams.get("before") ?? "newest"}`
        : null;
  };
  page.on("request", (request) => {
    const stream = readingStream(request.url());
    if (stream) trace({ event: "request", stream });
  });
  page.on("response", (response) => {
    const stream = readingStream(response.url());
    if (stream) trace({ event: "response", stream, status: response.status() });
  });
  if (counterpart) {
    const clockStart = new Date("2026-10-04T00:00:00Z");
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  } else await page.clock.install();
  page.setDefaultTimeout(retentionActionMs);
  await page.goto(`${web.origin}/app/search`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await searchRecords(page, "Ancient decision", {
    historical: true,
    type: "decision",
  });
  await page
    .locator(`[data-search-record="${a.old.resultId}:decision:0"] a`)
    .click();
  await page.getByText("Ancient review result", { exact: true }).waitFor();
  await page
    .locator("#review .criterion-row", { hasText: "Ancient criterion" })
    .getByText("C1 · Supported by recorded evidence")
    .waitFor();
  assert.ok(page.url().includes(`result=${a.old.resultId}`));
  assert.ok(page.url().includes(`source=${a.source.sourceId}`));
  await page
    .getByText("Matches the current pull request head", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Recorded change reference", exact: true })
      .count(),
    0,
  );
  // The recorded change reference is listed on Changes.
  await openTaskTab(page, "Changes");
  await page
    .getByText("No available recorded change reference.", { exact: true })
    .waitFor();
  await openTaskTab(page, "Overview");
  assert.equal(
    (
      await page.request.get(
        `${web.origin}/api/operator/tasks/${a.taskId}?resultId=invalid`,
      )
    ).status(),
    400,
  );
  assert.equal(
    (
      await page.request.get(
        `${web.origin}/api/operator/assignments/${a.assignmentId}/history?beforeOmissionSequence=0`,
      )
    ).status(),
    400,
  );
  if (!counterpart) {
    const preview = page.getByRole("img", {
      name: "evidence: Ancient artifact",
      exact: true,
    });
    await preview.scrollIntoViewIfNeeded();
    await preview.waitFor();
    await page.waitForFunction(
      () =>
        (
          document.querySelector(
            'img[alt="evidence: Ancient artifact"]',
          ) as HTMLImageElement | null
        )?.naturalWidth === 1,
    );
    assert.equal(
      await preview.evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
      1,
    );
    await page
      .locator("#review .criterion-row", { hasText: "Ancient criterion" })
      .getByText("C1 · Supported by recorded evidence")
      .scrollIntoViewIfNeeded();
    await captureBrowserEvidence(page, "1366-exact-old-review", {
      fullPage: false,
    });
  }
  await page.getByLabel("Editable reply").fill("Retained exact old draft");
  // The conversation pages back through every retained turn omission, newest page first.
  const log = page.getByRole("log", { name: "Task conversation" });
  const omissionRecords = log.locator(".conv-gap", {
    hasText: "capture buffer",
  });
  const loadEarlier = page.getByRole("button", {
    name: "Load earlier",
    exact: true,
  });
  await loadEarlier.waitFor();
  while ((await loadEarlier.count()) > 0) {
    const before = await log.locator("[data-record-id]").count();
    await loadEarlier.evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll("[role=log] [data-record-id]").length > n ||
        // The button reads "Loading earlier…" while the page is read; only its absence ends paging.
        !Array.from(document.querySelectorAll("button")).some((b) =>
          ["Load earlier", "Loading earlier…"].includes(b.textContent ?? ""),
        ),
      before,
    );
  }
  assert.equal(await omissionRecords.count(), 271);
  assert.equal(
    new Set(
      await omissionRecords.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-record-id")),
      ),
    ).size,
    271,
  );
  // The oldest retained turn omission is the reading position kept through every update below.
  const oldId = await omissionRecords.first().getAttribute("data-record-id");
  assert.ok(oldId);
  const oldRecord = log.locator(`[data-record-id="${oldId}"]`);
  await oldRecord.scrollIntoViewIfNeeded();
  await oldRecord.getByRole("button", { name: /^Details/ }).focus();
  const y = await oldRecord.evaluate((el) => el.getBoundingClientRect().top);
  const inspectReading = ({
    oldId,
    expectedY,
  }: {
    oldId: string;
    expectedY: number;
  }) => {
    const items = [
      ...document.querySelectorAll("[role=log] .conv-agent"),
    ].filter((e) => e.textContent?.includes("Only retained item"));
    const omissions = [
      ...document.querySelectorAll("[role=log] .conv-gap"),
    ].filter((e) => e.textContent?.includes("capture buffer"));
    const old = document.querySelector(`[data-record-id="${oldId}"]`);
    const draft = (
      document.querySelector("#workspace-reply") as HTMLTextAreaElement | null
    )?.value;
    const top = old?.getBoundingClientRect().top;
    const focused = old?.querySelector("button") === document.activeElement;
    const snapshot = {
      items: items.length,
      omissions: omissions.length,
      uniqueOmissions: new Set(
        omissions.map((el) => el.getAttribute("data-record-id")),
      ).size,
      draft,
      top,
      focused,
    };
    return {
      ...snapshot,
      expectedY,
      delta: top === undefined ? null : top - expectedY,
      activeId: document.activeElement?.id ?? null,
      activeRecord:
        document.activeElement
          ?.closest("[data-record-id]")
          ?.getAttribute("data-record-id") ?? null,
      reading: history.state?.taskWorkspaceReading ?? null,
    };
  };
  const readingArgs = { oldId, expectedY: y };
  const readingDiagnostic = async (phase: string, expectedY = y) => {
    lastReading = await page.evaluate(inspectReading, {
      ...readingArgs,
      expectedY,
    });
    j.diagnostics.push(
      JSON.stringify({
        phase,
        snapshot: lastReading,
        requests: [...readingRequests],
      }),
    );
  };
  const waitReading = async (phase: string) => {
    try {
      await page.waitForFunction(({ oldId, expectedY }) => {
        const items = [
          ...document.querySelectorAll("[role=log] .conv-agent"),
        ].filter((e) => e.textContent?.includes("Only retained item"));
        const omissions = [
          ...document.querySelectorAll("[role=log] .conv-gap"),
        ].filter((e) => e.textContent?.includes("capture buffer"));
        const old = document.querySelector(`[data-record-id="${oldId}"]`);
        const draft = (
          document.querySelector(
            "#workspace-reply",
          ) as HTMLTextAreaElement | null
        )?.value;
        const top = old?.getBoundingClientRect().top;
        return (
          items.length === 1 &&
          omissions.length === 272 &&
          new Set(omissions.map((el) => el.getAttribute("data-record-id")))
            .size === 272 &&
          draft === "Retained exact old draft" &&
          top !== undefined &&
          Math.abs(top - expectedY) < 4 &&
          old?.querySelector("button") === document.activeElement
        );
      }, readingArgs);
    } catch (error) {
      await readingDiagnostic(`${phase}-failed`);
      throw error;
    }
    await readingDiagnostic(phase);
    return page.evaluate(inspectReading, readingArgs);
  };
  const next = a.result("Newest retained result", {
    sourceId: f.service.taskReview().sources(a.taskId).at(-1)!.sourceId,
  });
  f.seedPersistedState((db) => {
    const capture = new ConversationHistoryStore(db);
    const binding = {
      taskId: a.taskId,
      assignmentId: a.assignmentId,
      workId: next.workId,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      workRevision: 272,
      threadId: next.workId,
      turnId: next.workId,
    };
    capture.recordEarlyBufferLimit(binding);
    const oldBinding = {
      ...binding,
      workId: a.old.workId,
      workRevision: 1,
      threadId: a.old.workId,
      turnId: a.old.workId,
    };
    capture.record(
      oldBinding,
      {
        kind: "completed",
        itemId: "single-item",
        text: "Only retained item",
        threadId: a.old.workId,
        turnId: a.old.workId,
      },
      [],
    );
  });
  f.service
    .delivery()
    .observePrWithinTransaction(a.taskId, { ...observation, headSha: headB });
  await readingDiagnostic("before-header");
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  const singleItem = log.locator(".conv-agent", {
    hasText: "Only retained item",
  });
  await singleItem.waitFor();
  await readingDiagnostic("header-attached");
  let snapshot = await waitReading("header-settled");
  if (!counterpart) {
    // Drive the real production timer: its poll keeps the validated conversation shown while it
    // revalidates. A one-time route on the task read can finish last, and Playwright then sees no
    // routes left and continues a held request itself; this lowest-priority pass-through keeps the
    // route list non-empty.
    await page.route(`**/api/operator/**`, (route) => route.fallback());
    let releaseTask!: () => void;
    const heldTask = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const taskEntered = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === `/api/operator/tasks/${a.taskId}`,
    );
    await page.route(
      `**/api/operator/tasks/${a.taskId}?*`,
      async (route) => {
        await heldTask;
        await route.continue();
      },
      { times: 1 },
    );
    let releaseTimeline!: () => void;
    const heldTimeline = new Promise<void>((resolve) => {
      releaseTimeline = resolve;
    });
    const timelineEntered = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/operator/tasks/${a.taskId}/timeline`,
    );
    await page.route(
      `**/api/operator/tasks/${a.taskId}/timeline**`,
      async (route) => {
        await heldTimeline;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await page.clock.fastForward(15000);
      await taskEntered;
      assert.equal(
        await singleItem.count(),
        1,
        "a pending timer poll keeps the validated conversation visible",
      );
      await readingDiagnostic("timer-pending");
    } finally {
      releaseTask();
    }
    try {
      await timelineEntered;
      assert.equal(await singleItem.count(), 1);
      await readingDiagnostic("overlap-timeline-pending");
      await page.clock.fastForward(15000);
    } finally {
      releaseTimeline();
    }
    snapshot = await waitReading("timer-settled");
    stage("timer-settled");
    assert.equal(snapshot.items, 1);
    assert.equal(snapshot.omissions, 272);
    assert.equal(snapshot.uniqueOmissions, 272);
    assert.equal(snapshot.draft, "Retained exact old draft");
    assert.ok(snapshot.top !== undefined && Math.abs(snapshot.top - y) < 4);
    assert.equal(snapshot.focused, true);
    stage("reading-probe-complete");
    return;
  }
  assert.ok(snapshot);
  stage("validation-label-begin");
  await page
    .getByText("Checked an earlier head than the current pull request head", {
      exact: false,
    })
    .waitFor();
  stage("validation-label-complete");
  assert.equal(snapshot.items, 1);
  assert.equal(snapshot.omissions, 272);
  assert.equal(snapshot.uniqueOmissions, 272);
  assert.equal(snapshot.draft, "Retained exact old draft");
  assert.ok(snapshot.top !== undefined && Math.abs(snapshot.top - y) < 4);
  assert.equal(snapshot.focused, true);
  stage("validation-scroll-begin");
  await openOverviewCard(page, "evidence");
  await page
    .locator("#result-evidence")
    .getByText("Historical check:", { exact: false })
    .scrollIntoViewIfNeeded();
  stage("validation-scroll-complete");
  stage("validation-capture-begin");
  await captureBrowserEvidence(page, "1366-validation-head-state", {
    fullPage: false,
  });
  stage("validation-capture-complete");
  stage("conversation-scroll-begin");
  await oldRecord.scrollIntoViewIfNeeded();
  stage("conversation-scroll-complete");
  stage("conversation-capture-begin");
  await captureBrowserEvidence(page, "1366-conversation-omission-pages", {
    fullPage: false,
  });
  stage("conversation-capture-complete");
  await page.setViewportSize({ width: 390, height: 844 });
  stage("phone-scroll-begin");
  await oldRecord.scrollIntoViewIfNeeded();
  stage("phone-scroll-complete");
  stage("phone-capture-begin");
  await captureBrowserEvidence(page, "390-conversation-omission-pages", {
    fullPage: false,
  });
  stage("phone-capture-complete");
  const phoneReadingY = await oldRecord.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  let releaseHeadTimeline!: () => void, headTimelineEntered!: () => void;
  const headTimeline = new Promise<void>((resolve) => {
    releaseHeadTimeline = resolve;
  });
  const headTimelineArrival = new Promise<void>((resolve) => {
    headTimelineEntered = resolve;
  });
  await page.route(
    `**/api/operator/tasks/${a.taskId}/timeline**`,
    async (route) => {
      headTimelineEntered();
      await headTimeline;
      await route.continue();
    },
    { times: 1 },
  );
  stage("bound-head-read-begin");
  f.service.delivery().recordPrReadFailure(a.taskId);
  try {
    await page
      .getByRole("button", { name: "Refresh task", exact: true })
      .evaluate((el) => (el as HTMLButtonElement).click());
    await headTimelineArrival;
    await page
      .locator("#result-evidence")
      .getByText(/Historical check:.*Head comparison unknown/)
      .waitFor({ state: "attached" });
    // An explicit Refresh keeps the validated conversation while the new read is pending.
    const gap = await page.evaluate(
      ({ oldId }) => ({
        items: [...document.querySelectorAll("[role=log] .conv-agent")].filter(
          (e) => e.textContent?.includes("Only retained item"),
        ).length,
        omissions: document.querySelectorAll("[role=log] .conv-gap").length,
        old: document.querySelectorAll(`[data-record-id="${oldId}"]`).length,
        draft: (
          document.querySelector(
            "#workspace-reply",
          ) as HTMLTextAreaElement | null
        )?.value,
      }),
      readingArgs,
    );
    assert.equal(gap.items, 1);
    assert.ok(gap.omissions >= 272);
    assert.equal(gap.old, 1);
    assert.equal(gap.draft, "Retained exact old draft");
    j.diagnostics.push(
      JSON.stringify({
        phase: "bound-head-label-ready-timeline-held",
        snapshot: gap,
        requests: [...readingRequests],
      }),
    );
  } finally {
    releaseHeadTimeline();
  }
  try {
    await page.waitForFunction(
      ({ oldId }) => {
        const items = [
            ...document.querySelectorAll("[role=log] .conv-agent"),
          ].filter((e) => e.textContent?.includes("Only retained item")),
          omissions = [
            ...document.querySelectorAll("[role=log] .conv-gap"),
          ].filter((e) => e.textContent?.includes("capture buffer")),
          old = document.querySelector(`[data-record-id="${oldId}"]`),
          summary = old?.querySelector("button");
        return (
          items.length === 1 &&
          omissions.length === 272 &&
          new Set(omissions.map((el) => el.getAttribute("data-record-id")))
            .size === 272 &&
          (
            document.querySelector(
              "#workspace-reply",
            ) as HTMLTextAreaElement | null
          )?.value === "Retained exact old draft" &&
          summary?.isConnected
        );
      },
      { ...readingArgs, expectedY: phoneReadingY },
    );
  } catch (error) {
    await readingDiagnostic(
      "bound-head-timeline-settlement-failed",
      phoneReadingY,
    );
    throw error;
  }
  await readingDiagnostic("bound-head-timeline-settled", phoneReadingY);
  assert.equal(
    await page
      .locator("#review")
      .getByText(/Stale validation;/)
      .count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Retained exact old draft",
  );
  stage("bound-head-read-complete");
  stage("intentional-scroll-begin");
  const oldSummary = oldRecord.getByRole("button", { name: /^Details/ });
  await oldSummary.scrollIntoViewIfNeeded();
  await oldSummary.focus();
  assert.equal(
    await oldSummary.evaluate((el) => el === document.activeElement),
    true,
  );
  stage("intentional-scroll-complete");
  let releaseIntentionalTimeline!: () => void;
  const intentionalTimeline = new Promise<void>((resolve) => {
    releaseIntentionalTimeline = resolve;
  });
  const intentionalEntered = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname ===
      `/api/operator/tasks/${a.taskId}/timeline`,
  );
  await page.route(
    `**/api/operator/tasks/${a.taskId}/timeline**`,
    async (route) => {
      await intentionalTimeline;
      await route.continue();
    },
    { times: 1 },
  );
  stage("intentional-timer-begin");
  try {
    await page.clock.fastForward(15000);
    await intentionalEntered;
    assert.equal(await singleItem.count(), 1);
    await page.getByLabel("Editable reply").focus();
    await readingDiagnostic("intentional-control-focus-pending");
    await page.clock.fastForward(15000);
  } finally {
    releaseIntentionalTimeline();
  }
  try {
    await page.waitForFunction(
      () =>
        document.activeElement?.id === "workspace-reply" &&
        [...document.querySelectorAll("[role=log] .conv-agent")].filter((e) =>
          e.textContent?.includes("Only retained item"),
        ).length === 1 &&
        [...document.querySelectorAll("[role=log] .conv-gap")].filter((e) =>
          e.textContent?.includes("capture buffer"),
        ).length === 272 &&
        (
          document.querySelector(
            "#workspace-reply",
          ) as HTMLTextAreaElement | null
        )?.value === "Retained exact old draft",
    );
  } catch (error) {
    await readingDiagnostic("intentional-control-focus-failed");
    throw error;
  }
  await readingDiagnostic("intentional-control-focus-settled");
  stage("journey-complete");
}

test("historical Search opens exact old evidence and pages all retained omission turns with refresh and reading state", async (_t, j) =>
  retainedJourney(j, false));
test("retained omission pages, phone head observations and intentional focus remain exact after refresh", async (_t, j) =>
  retainedJourney(j, true));
