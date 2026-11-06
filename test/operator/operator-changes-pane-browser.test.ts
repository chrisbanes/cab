import assert from "node:assert/strict";
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
  webkit,
} from "playwright";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import { seedChangedTask } from "../fixtures/changed-task.js";
import { setFixtureGitIdentity } from "../fixtures/git-environment.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  desktop,
  noPageOverflow,
  signIn,
} from "../fixtures/operator-settings.js";
import { stubReadiness } from "../fixtures/setup-browser.js";

setFixtureGitIdentity();

const test = browserSuite("changes-pane");

async function start(
  j: BrowserJourney,
  options: {
    colorScheme?: "light" | "dark";
    engine?: "chromium" | "webkit";
    viewport?: { width: number; height: number };
    storageBlocked?: boolean;
  } = {},
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
  const task = await seedChangedTask(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () =>
    (options.engine === "webkit" ? webkit : chromium).launch(),
  );
  const page = await browser.newPage({
    viewport: options.viewport ?? desktop,
    colorScheme: options.colorScheme ?? "light",
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await stubReadiness(page);
  if (options.storageBlocked)
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new Error("blocked");
      };
    });
  // A captured file change naming a file in the comparison, one outside it and one outside the workspace.
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    const store = new ExecutionDiagnosticsStore(db, { now: () => t0 });
    store.begin({
      workId: "work-paths",
      taskId: task.taskId,
      projectId: task.projectId,
      assignmentId: task.assignmentId,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "enhanced",
      eventSource: "supported",
    });
    store.record(
      "work-paths",
      "runtime",
      "fileChange/completed",
      "info",
      "fc-paths",
      {
        itemId: "fc-paths",
        itemType: "fileChange",
        status: "completed",
        paths: ["guide.md", "missing.md", "outside workspace"],
      },
      [],
    );
  });
  await signIn(page, web, `/tasks/${task.taskId}`);
  return { page, ...task };
}

const t0 = 1_700_000_000_000;
const filePath = (page: Page, name: string) =>
  page.getByRole("log", { name: "Task conversation" }).getByRole("button", {
    name,
    exact: true,
  });

const resultLink = (page: Page) =>
  page
    .locator("#review")
    .getByRole("link", { name: "Changes · 2 files", exact: true });
const pane = (page: Page) => page.locator("aside[aria-label='Changes']");
const changesTab = (page: Page) =>
  page.getByRole("tab", { name: "Changes", exact: true });
const separator = (page: Page) =>
  page.getByRole("separator", { name: "Resize conversation and changes" });
const focused = (target: Locator) =>
  target.evaluate((el) => el === document.activeElement);
const width = async (target: Locator) => {
  const box = await target.boundingBox();
  assert.ok(box);
  return box.width;
};
const value = async (page: Page) =>
  Number(await separator(page).getAttribute("aria-valuenow"));
const openPane = async (page: Page) => {
  await resultLink(page).click();
  await pane(page).waitFor();
};
const closePane = (page: Page) =>
  pane(page).getByRole("button", { name: "Close", exact: true }).click();
const computed = (target: Locator, property: string) =>
  target.evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p),
    property,
  );

for (const colorScheme of ["light", "dark"] as const) {
  test(`the result link opens a bounded Changes pane at every wide width (${colorScheme})`, async (_t, j) => {
    const { page } = await start(j, { colorScheme });
    for (const w of [1024, 1121, 1366]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.reload();
      await resultLink(page).waitFor();
      const url = page.url();
      await openPane(page);
      assert.equal(page.url(), url);
      assert.equal(
        await changesTab(page).getAttribute("aria-selected"),
        "false",
      );
      assert.equal(await page.locator(".task-inspector").count(), 0);
      assert.equal(await page.locator("section#changes").count(), 1);
      assert.ok((await width(page.locator("#split-conversation"))) >= 479.5);
      assert.ok((await width(page.locator("#split-changes"))) >= 319.5);
      await noPageOverflow(page);
      assert.equal(await computed(pane(page), "position"), "sticky");
      assert.equal(
        await computed(page.locator("#decisions"), "position"),
        "sticky",
      );
      assert.equal(
        await computed(page.locator("#task-changes-split"), "overflow"),
        "visible",
      );
      await pane(page)
        .locator(".changes-entry")
        .filter({ hasText: /guide\.md/ })
        .click();
      await page.getByLabel("Diff hunk 1").first().waitFor();
      // The rail stacks above the diff, which keeps a readable width beside the conversation.
      assert.ok((await width(page.locator(".changes-reading-area"))) >= 280);
      if (w === 1366)
        await j.capture(page, `changes-pane-${colorScheme}`, false);
    }
    const line = await separator(page).evaluate(
      (el) => getComputedStyle(el, "::after").backgroundColor,
    );
    assert.notEqual(line, "rgba(0, 0, 0, 0)");
  });
}

test("below 1024px the result link and the pane buttons keep to the tab", async (_t, j) => {
  const { page } = await start(j, { viewport: { width: 1023, height: 900 } });
  await resultLink(page).click();
  await page.waitForURL(/section=changes&result=/);
  assert.equal(await changesTab(page).getAttribute("aria-selected"), "true");
  assert.equal(await pane(page).count(), 0);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(page.url().split("?")[0] ?? "");
  await resultLink(page).click();
  await pane(page).waitFor();
});

test("Close restores the inspector and Open full width keeps the selection", async (_t, j) => {
  const { page } = await start(j);
  await openPane(page);
  await page.waitForFunction(() =>
    document.activeElement?.matches("aside[aria-label='Changes']"),
  );
  await closePane(page);
  await page.locator(".task-inspector").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.closest("#review") !== null,
  );
  assert.equal(await pane(page).count(), 0);
  await openPane(page);
  await pane(page)
    .locator(".changes-entry")
    .filter({ hasText: /guide\.md/ })
    .click();
  await pane(page)
    .getByRole("button", { name: "Open full width", exact: true })
    .click();
  assert.equal(await changesTab(page).getAttribute("aria-selected"), "true");
  assert.equal(await pane(page).count(), 0);
  assert.equal(await page.locator("section#changes").count(), 1);
  assert.equal(
    await page
      .locator(".changes-entry")
      .filter({ hasText: /guide\.md/ })
      .getAttribute("aria-current"),
    "true",
  );
  assert.equal(await focused(changesTab(page)), true);
});

test("the reply draft survives opening and closing the pane", async (_t, j) => {
  const { page } = await start(j);
  const draft = page.locator("section.reply-card textarea").first();
  await draft.fill("Keep this draft");
  await openPane(page);
  assert.equal(await draft.inputValue(), "Keep this draft");
  await closePane(page);
  await page.locator(".task-inspector").waitFor();
  assert.equal(await draft.inputValue(), "Keep this draft");
});

test("Escape dismisses what is open inside the pane before the pane", async (_t, j) => {
  const { page } = await start(j);
  await openPane(page);
  await pane(page)
    .locator(".changes-entry")
    .filter({ hasText: /guide\.md/ })
    .click();
  await pane(page)
    .getByRole("button", { name: /^(Before |After )?line \d+, guide\.md;/i })
    .first()
    .click();
  await pane(page)
    .getByRole("button", { name: "Add review comment" })
    .first()
    .click();
  const editor = pane(page).getByRole("textbox").first();
  await editor.waitFor();
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal(await pane(page).count(), 1);
  await pane(page).getByRole("button", { name: "Open full width" }).focus();
  await page.keyboard.press("Escape");
  await pane(page).waitFor({ state: "detached" });
});

test("navigation to a tab or the inspector shows it without the pane, and reload opens the normal layout", async (_t, j) => {
  const { page, taskId } = await start(j);
  const follow = async (href: string) => {
    await page.evaluate((h) => {
      const a = document.createElement("a");
      a.href = h;
      a.id = "test-link";
      a.textContent = "go";
      document.body.append(a);
    }, href);
    await page.locator("#test-link").click();
    await page.locator("#test-link").evaluate((a) => a.remove());
  };
  await openPane(page);
  await follow(`/tasks/${taskId}?section=changes`);
  assert.equal(await changesTab(page).getAttribute("aria-selected"), "true");
  assert.equal(await pane(page).count(), 0);
  assert.equal(await page.locator("section#changes").count(), 1);
  await page.goto(page.url().split("?")[0] ?? "");
  await openPane(page);
  await follow(`/tasks/${taskId}?section=review#review`);
  await page.locator(".task-inspector").waitFor();
  assert.equal(await pane(page).count(), 0);
  await openPane(page);
  const before = page.url();
  await page.reload();
  await resultLink(page).waitFor();
  assert.equal(await pane(page).count(), 0);
  assert.equal(await page.locator(".task-inspector").count(), 1);
  assert.equal(page.url(), before);
});

test("Tab order runs from the pane to the handle and into the conversation", async (_t, j) => {
  const { page } = await start(j);
  await openPane(page);
  await pane(page).getByRole("button", { name: "Open full width" }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(separator(page)), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.closest("#split-conversation") !== null,
    ),
    true,
  );
});

test("the split resizes from the keyboard within its minimums and keeps its width", async (_t, j) => {
  const { page } = await start(j);
  await openPane(page);
  await separator(page).focus();
  const v0 = await value(page);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await value(page), v0 - 5);
  await page.keyboard.press("ArrowRight");
  assert.equal(await value(page), v0);
  await page.keyboard.press("ArrowLeft");
  const kept = await value(page);
  await page.keyboard.press("Home");
  assert.ok((await width(page.locator("#split-conversation"))) >= 479.5);
  await page.keyboard.press("End");
  assert.ok((await width(page.locator("#split-changes"))) >= 319.5);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const chosen = await value(page);
  await closePane(page);
  await openPane(page);
  assert.ok(Math.abs((await value(page)) - chosen) < 0.5, `${kept}`);
  await page.reload();
  await openPane(page);
  assert.ok(Math.abs((await value(page)) - chosen) < 0.5);
});

test("a corrupt saved width opens the pane at the default", async (_t, j) => {
  const { page } = await start(j);
  await page.evaluate(() =>
    localStorage.setItem(
      "react-resizable-panels:cab.changes-pane.v1:split-conversation:split-changes",
      "null",
    ),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openPane(page);
  await separator(page).waitFor();
  assert.deepEqual(errors, []);
});

test("blocked storage opens the pane at the default width and still resizes", async (_t, j) => {
  const { page } = await start(j, { storageBlocked: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openPane(page);
  await separator(page).focus();
  const v0 = await value(page);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await value(page), v0 - 5);
  assert.deepEqual(errors, []);
});

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]) =>
  0.2126 * channel(r ?? 0) +
  0.7152 * channel(g ?? 0) +
  0.0722 * channel(b ?? 0);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};
/** Any CSS colour as sRGB bytes, resolved by drawing it. */
const rgb = (page: Page, css: string) =>
  page.evaluate((c) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) throw Error("no canvas");
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, css);

for (const colorScheme of ["light", "dark"] as const) {
  test(`the focused handle meets 3:1 against its surroundings (${colorScheme})`, async (_t, j) => {
    const { page } = await start(j, { colorScheme });
    await openPane(page);
    await separator(page).focus();
    await page.keyboard.press("ArrowLeft");
    const line = await separator(page).evaluate(
      (el) => getComputedStyle(el, "::after").backgroundColor,
    );
    const page0 = await computed(page.locator("body"), "background-color");
    const surface = await computed(pane(page), "background-color");
    for (const against of [page0, surface])
      assert.ok(
        contrast(await rgb(page, line), await rgb(page, against)) >= 3,
        `${line} on ${against}`,
      );
  });
}

test(
  "the pane opens, resizes, keeps its width and returns focus in WebKit",
  { browserEngine: "webkit" },
  async (_t, j) => {
    const { page } = await start(j, { engine: "webkit" });
    await openPane(page);
    await separator(page).focus();
    const v0 = await value(page);
    await page.keyboard.press("ArrowLeft");
    const chosen = await value(page);
    assert.notEqual(chosen, v0);
    await page.reload();
    await openPane(page);
    assert.ok(Math.abs((await value(page)) - chosen) < 0.5);
    await closePane(page);
    await page.waitForFunction(
      () => document.activeElement?.closest("#review") !== null,
    );
  },
);

for (const colorScheme of ["light", "dark"] as const)
  test(`a changed file in the conversation opens in the pane at 1280px (${colorScheme})`, async (_t, j) => {
    const { page } = await start(j, {
      colorScheme,
      viewport: { width: 1280, height: 900 },
    });
    const url = page.url();
    // The path outside the workspace is text, not a button.
    assert.equal(await filePath(page, "outside workspace").count(), 0);
    await page
      .locator(".conv-paths", { hasText: "outside workspace" })
      .waitFor();
    // A path the comparison does not hold leaves a notice and no selection.
    await filePath(page, "missing.md").click();
    await pane(page).waitFor();
    await pane(page)
      .getByText(
        "missing.md is not in this comparison. Refresh to compare again.",
      )
      .waitFor();
    assert.equal(await pane(page).locator("[aria-current='true']").count(), 0);
    await closePane(page);
    await filePath(page, "guide.md").click();
    await pane(page).waitFor();
    assert.equal(page.url(), url);
    await pane(page)
      .locator(".changes-entry[aria-current='true']")
      .filter({ hasText: /guide\.md/ })
      .waitFor();
    await pane(page).getByLabel("Diff hunk 1").first().waitFor();
    // Close returns focus to the path that opened the pane.
    await closePane(page);
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-path") === "guide.md",
    );
  });

test("a changed file in the conversation opens in the Changes tab at 800px", async (_t, j) => {
  const { page } = await start(j, { viewport: { width: 800, height: 900 } });
  await filePath(page, "guide.md").click();
  assert.equal(await changesTab(page).getAttribute("aria-selected"), "true");
  assert.equal(await pane(page).count(), 0);
  await page
    .locator(".changes-entry[aria-current='true']")
    .filter({ hasText: /guide\.md/ })
    .waitFor();
});

test("a changed file in the conversation leaves focus mode and opens the pane", async (_t, j) => {
  const { page } = await start(j);
  await page.keyboard.press("\\");
  await page.locator(".task-inspector").waitFor({ state: "detached" });
  await filePath(page, "guide.md").click();
  await pane(page).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Focus mode", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
});
