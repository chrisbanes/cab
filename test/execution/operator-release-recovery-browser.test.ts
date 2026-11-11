import assert from "node:assert/strict";
import type { Page } from "playwright";
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
const startAgainPanel = (page: Page) =>
  page.locator("section.settings-panel", {
    has: page.getByRole("heading", { name: "Start again", exact: true }),
  });
type Ids = Awaited<ReturnType<typeof startSettings>>["ids"];

/**
 * The recovery and task reads as a held turn cab released (or is still releasing) presents
 * them; the service rules behind them are covered in `held-turn-release.test.ts`.
 */
async function routeRelease(page: Page, ids: Ids, state: { pending: boolean }) {
  const workId = `assignment:${ids.assignmentId}:released`;
  await page.route(
    "**/api/operator/assignments/*/recovery-options",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.restart = state.pending
        ? {
            eligible: false,
            blockedBy: ["execution-unresolved"],
            releasePending: {
              workId,
              interruptState: "acknowledged",
              releasesBy: Date.UTC(2026, 10, 11, 14, 30),
            },
          }
        : { eligible: true, blockedBy: [], releasePending: null };
      await route.fulfill({ response, json: body });
    },
  );
  const taskRead = (url: URL) =>
    url.pathname === `/api/operator/tasks/${ids.taskId}`;
  await page.route(taskRead, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (!state.pending) {
      body.data.startAgain = {
        available: true,
        assignmentId: ids.assignmentId,
        workId,
      };
      body.data.execution = {
        ...body.data.execution,
        state: "not-started",
        reasonCodes: ["held-turn-released"],
      };
    }
    await route.fulfill({ response, json: body });
  });
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/operator/commands", async (route) => {
    const command = JSON.parse(route.request().postData() ?? "{}");
    if (command.type !== "task.start-again") return route.fallback();
    sent.push(command);
    await route.fulfill({
      json: {
        kind: "start-again",
        key: command.key,
        recorded: true,
        taskId: ids.taskId,
        assignmentId: ids.assignmentId,
        refusedWorkId: workId,
        workId: `${workId}:restart`,
      },
    });
  });
  return { workId, sent };
}

test("the recovery page shows a pending release, then the shared Start again decision", async (_t, journey) => {
  const { page, ids } = await startSettings(
    journey,
    "/assignments/:assignment/recovery",
  );
  const state = { pending: true };
  const { workId, sent } = await routeRelease(page, ids, state);
  await page.reload();
  const panel = startAgainPanel(page);
  await panel
    .getByText(/Interrupting the held turn; expected to be released by/)
    .waitFor();
  assert.equal(
    await panel.getByRole("button", { name: "Start again" }).count(),
    0,
  );
  // No evidence inputs or receipt forms remain.
  assert.equal(await page.locator("main input, main textarea").count(), 0);

  state.pending = false;
  await page.reload();
  await panel.getByRole("button", { name: "Start again" }).waitFor();
  await panel.getByText("Your decision · released").waitFor();
  const start = panel.getByRole("button", { name: "Start again" });
  await start.focus();
  await page.keyboard.press("Enter");
  await panel.getByText("Queued again.", { exact: false }).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.workId, workId);
  assert.equal(sent[0]?.taskId, ids.taskId);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "1366-recovery-start-again");
});

test("phone recovery keeps Start again reachable without horizontal scroll", async (_t, journey) => {
  const { page, ids } = await startSettings(
    journey,
    "/assignments/:assignment/recovery",
    phone,
  );
  await routeRelease(page, ids, { pending: false });
  await page.reload();
  const start = startAgainPanel(page).getByRole("button", {
    name: "Start again",
  });
  await start.waitFor();
  const height = await start.evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(height >= 44, `Start again is ${height}px`);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-recovery-start-again");
});

test("a held turn with no saved turn ID explains its wait without the Start again decision", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/assignments/:assignment/recovery",
  );
  // As after a lost turn/start reply: the thread is saved, the turn is not.
  await page.route(
    "**/api/operator/assignments/*/recovery-options",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      assert.ok(body.data.records.length > 0);
      body.data.records = body.data.records.map(
        (r: Record<string, unknown>) => ({
          ...r,
          intentState: "held",
          threadId: "thread-saved",
          turnId: null,
        }),
      );
      body.data.restart = {
        eligible: false,
        blockedBy: ["execution-unresolved"],
        releasePending: null,
      };
      await route.fulfill({ response, json: body });
    },
  );
  await page.reload();
  const panel = startAgainPanel(page);
  await panel.getByText(/quiet time won't release it/).waitFor();
  // Its "nothing ran" decision would contradict a turn that may still be running.
  assert.equal(await panel.getByText(/nothing ran|Your decision/).count(), 0);
  assert.equal(await panel.getByText(/30 minutes pass/).count(), 0);
});
