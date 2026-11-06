import assert from "node:assert/strict";
import { type Browser, chromium, type Page, webkit } from "playwright";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import { seedChangedTask } from "../fixtures/changed-task.js";
import { setFixtureGitIdentity } from "../fixtures/git-environment.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  desktop,
  noPageOverflow,
  signIn,
} from "../fixtures/operator-settings.js";
import { stubReadiness } from "../fixtures/setup-browser.js";
import { seedReviewTask } from "../fixtures/task-review.js";

setFixtureGitIdentity();

const test = browserSuite("focus-mode");
const KEY = "cab.focus-mode.v1";

async function start(
  j: BrowserJourney,
  options: {
    colorScheme?: "light" | "dark";
    engine?: "chromium" | "webkit";
    viewport?: { width: number; height: number };
    stored?: boolean;
    storageBlocked?: boolean;
    path?: string;
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
  const other = await seedReviewTask(f, "Other project", "Other task");
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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stubReadiness(page);
  if (options.stored)
    await page.addInitScript((key) => localStorage.setItem(key, "1"), KEY);
  if (options.storageBlocked)
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new Error("blocked");
      };
    });
  await signIn(page, web, options.path ?? `/app/tasks/${task.taskId}`);
  return { page, errors, task, other, web };
}

const toggle = (page: Page) =>
  page.getByRole("button", { name: "Focus mode", exact: true });
const inspector = (page: Page) => page.locator(".task-inspector");
const pane = (page: Page) => page.locator("aside[aria-label='Changes']");
const stored = (page: Page) =>
  page.evaluate((k) => localStorage.getItem(k), KEY);
const pressed = (page: Page) => toggle(page).getAttribute("aria-pressed");
const boxWidth = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, selector);
  return box.width;
};
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
const readyPage = async (page: Page) => {
  await toggle(page).waitFor();
  await inspector(page).first().waitFor();
};

test("the button hides the inspector, widens the conversation and is remembered across a reload", async (_t, j) => {
  const { page, errors } = await start(j);
  await readyPage(page);
  assert.equal(await pressed(page), "false");
  const before = await boxWidth(page, ".task-columns");
  assert.ok(before < (await boxWidth(page, ".task-overview")) - 200);
  await toggle(page).click();
  assert.equal(await pressed(page), "true");
  assert.equal(await inspector(page).count(), 0);
  assert.ok(
    Math.abs(
      (await boxWidth(page, ".task-columns")) -
        (await boxWidth(page, ".task-overview")),
    ) < 1,
  );
  assert.equal(await stored(page), "1");
  await noPageOverflow(page);
  await page.reload();
  await toggle(page).waitFor();
  assert.equal(await pressed(page), "true");
  assert.equal(await inspector(page).count(), 0);
  await toggle(page).click();
  assert.equal(await pressed(page), "false");
  await inspector(page).first().waitFor();
  assert.equal(await stored(page), null);
  assert.deepEqual(errors, []);
});

test("the backslash key toggles outside fields and not with a modifier", async (_t, j) => {
  const { page } = await start(j);
  await readyPage(page);
  await page.keyboard.press("\\");
  assert.equal(await pressed(page), "true");
  assert.equal(await stored(page), "1");
  await page.keyboard.press("\\");
  assert.equal(await pressed(page), "false");
  assert.equal(await stored(page), null);
  for (const chord of ["Control+\\", "Alt+\\", "Meta+\\"]) {
    await page.keyboard.press(chord);
    assert.equal(await pressed(page), "false", chord);
  }
});

test("editable fields keep the backslash", async (_t, j) => {
  const { page } = await start(j);
  await readyPage(page);
  const reply = page.getByLabel("Editable reply");
  await reply.click();
  await page.keyboard.press("\\");
  assert.equal(await reply.inputValue(), "\\");
  assert.equal(await pressed(page), "false");
  const search = page.getByLabel("Search work");
  await search.click();
  await page.keyboard.press("\\");
  assert.equal(await search.inputValue(), "\\");
  assert.equal(await pressed(page), "false");
});

test("leaving focus mode restores the inspector fold as it was", async (_t, j) => {
  const { page } = await start(j);
  await readyPage(page);
  const summary = page.getByText("Task details", { exact: true });
  await summary.click();
  await page.locator(".inspector-fold:not([open])").waitFor();
  await toggle(page).click();
  await toggle(page).click();
  await inspector(page).first().waitFor();
  assert.equal(await page.locator(".inspector-fold[open]").count(), 0);
  await summary.click();
  await page.locator(".inspector-fold[open]").waitFor();
  await toggle(page).click();
  await toggle(page).click();
  assert.equal(await page.locator(".inspector-fold[open]").count(), 1);
});

test("the choice carries to another task without a reload", async (_t, j) => {
  const { page, other } = await start(j);
  await readyPage(page);
  await toggle(page).click();
  // An in-app link, so the shell navigates without a reload.
  await page.evaluate((id) => {
    const a = document.createElement("a");
    a.href = `/app/tasks/${id}`;
    a.id = "to-other";
    a.textContent = "to other";
    document.body.append(a);
  }, other.taskId);
  await page.locator("#to-other").click();
  await page.waitForURL(new RegExp(other.taskId));
  await toggle(page).waitFor();
  assert.equal(await pressed(page), "true");
  assert.equal(await inspector(page).count(), 0);
});

test("a link to an inspector section shows it and the choice returns on Back", async (_t, j) => {
  const { page, task } = await start(j, { stored: true });
  await toggle(page).waitFor();
  assert.equal(await pressed(page), "true");
  assert.equal(await inspector(page).count(), 0);
  await page.evaluate((id) => {
    const a = document.createElement("a");
    a.href = `/app/tasks/${id}?section=brief`;
    a.id = "to-brief";
    a.textContent = "to brief";
    document.body.append(a);
  }, task.taskId);
  await page.locator("#to-brief").click();
  await page.locator("#brief").waitFor();
  assert.equal(await pressed(page), "false");
  assert.ok(await page.locator("#brief").isVisible());
  await page.goBack();
  await toggle(page).waitFor();
  assert.equal(await pressed(page), "true");
  assert.equal(await inspector(page).count(), 0);
  // A full load of a deep link shows its section too.
  await page.goto(
    `${page.url().split("/app/")[0]}/app/tasks/${task.taskId}?section=context`,
  );
  await page.locator("#context").waitFor();
  assert.equal(await pressed(page), "false");
  assert.equal(await stored(page), "1");
});

test("the Changes pane hides with focus mode and returns with its selection", async (_t, j) => {
  const { page } = await start(j);
  await readyPage(page);
  await page
    .locator("#review")
    .getByRole("link", { name: "Changes · 2 files", exact: true })
    .click();
  await pane(page).waitFor();
  const guide = pane(page)
    .locator(".changes-entry[aria-current='true']")
    .filter({ hasText: /guide\.md/ });
  await pane(page)
    .locator(".changes-entry", { hasText: /guide\.md/ })
    .first()
    .click();
  await guide.waitFor();
  await toggle(page).click();
  await pane(page).waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByRole("tab", { name: "Changes", exact: true })
      .getAttribute("aria-selected"),
    "false",
  );
  assert.equal(await page.locator("section#changes").count(), 1);
  await toggle(page).click();
  await pane(page).waitFor();
  assert.equal(await page.locator("section#changes").count(), 1);
  await guide.waitFor();
});

test("leaving the unmounted inspector moves focus to the button", async (_t, j) => {
  const { page } = await start(j);
  await readyPage(page);
  await page.locator(".task-inspector summary").first().focus();
  await page.keyboard.press("\\");
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Focus mode",
  );
});

test("below 1024px there is no button, the key does nothing and the inspector stays", async (_t, j) => {
  for (const width of [1023, 390]) {
    const { page } = await start(j, {
      stored: true,
      viewport: { width, height: 900 },
    });
    await inspector(page).first().waitFor();
    assert.equal(await toggle(page).count(), 0);
    await page.keyboard.press("\\");
    assert.equal(await stored(page), "1");
    assert.equal(await inspector(page).count(), 1);
    await page.close();
  }
  const { page } = await start(j, {
    stored: true,
    viewport: { width: 1024, height: 900 },
  });
  await toggle(page).waitFor();
  assert.equal(await inspector(page).count(), 0);
  await page.setViewportSize({ width: 800, height: 900 });
  await inspector(page).first().waitFor();
  await page.setViewportSize({ width: 1366, height: 900 });
  await toggle(page).waitFor();
  assert.equal(await inspector(page).count(), 0);
});

for (const colorScheme of ["light", "dark"] as const)
  test(`the pressed button reads in the ${colorScheme} theme`, async (_t, j) => {
    const { page } = await start(j, { colorScheme });
    await readyPage(page);
    const read = () =>
      toggle(page).evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
    const off = await read();
    await toggle(page).click();
    // The button's colours transition; read them once they differ from the unpressed ones.
    await page.waitForFunction(
      (was) =>
        [...document.querySelectorAll("button[aria-pressed='true']")].some(
          (el) => {
            const s = getComputedStyle(el);
            return s.backgroundColor !== was && el.textContent === "Focus mode";
          },
        ),
      off.background,
    );
    await page.waitForTimeout(300);
    const on = await read();
    assert.notEqual(on.background, off.background);
    for (const state of [off, on])
      assert.ok(
        contrast(
          await rgb(page, state.color),
          await rgb(page, state.background),
        ) >= 4.5,
        `${colorScheme} ${JSON.stringify(state)}`,
      );
    await page.keyboard.press("Tab");
    await toggle(page).focus();
    const ring = await toggle(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.boxShadow} ${s.outlineStyle}`;
    });
    assert.ok(!/^none none$/.test(ring), ring);
  });

test("blocked storage keeps the choice for the session only", async (_t, j) => {
  const { page, errors } = await start(j, { storageBlocked: true });
  await readyPage(page);
  await toggle(page).click();
  assert.equal(await inspector(page).count(), 0);
  assert.deepEqual(errors, []);
  await page.reload();
  await readyPage(page);
  assert.equal(await pressed(page), "false");
});

test(
  "the button and key toggle and persist in WebKit",
  { browserEngine: "webkit" },
  async (_t, j) => {
    const { page } = await start(j, { engine: "webkit" });
    await readyPage(page);
    await toggle(page).click();
    assert.equal(await inspector(page).count(), 0);
    await page.reload();
    await toggle(page).waitFor();
    assert.equal(await pressed(page), "true");
    await page.keyboard.press("\\");
    assert.equal(await pressed(page), "false");
  },
);
