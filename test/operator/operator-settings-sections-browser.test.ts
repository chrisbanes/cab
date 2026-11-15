import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { desktop, startSettings } from "../fixtures/operator-settings.js";

/** Landing on a Readiness check or Add Claude once its page's own read is fresh. */
const test = browserSuite("operator-settings-sections-browser");

/** A new document at `url`, as a bookmark or typed address would open it. */
async function coldGoto(page: Page, url: string) {
  await page.goto("about:blank");
  await page.goto(url);
}

/** Two animation frames: whatever the app scheduled for the next frame has run. */
const nextFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );

/** Waits until focus is on this heading and asserts it is wholly on screen. */
async function landed(page: Page, text: string) {
  await page.waitForFunction(
    (name) =>
      /^H[23]$/.test(document.activeElement?.tagName ?? "") &&
      document.activeElement?.textContent?.trim() === name,
    text,
  );
  await nextFrames(page);
  const box = await page.evaluate(() => {
    const b = document.activeElement?.getBoundingClientRect();
    return b ? { top: b.top, bottom: b.bottom, height: innerHeight } : null;
  });
  assert.ok(
    box && box.top >= 0 && box.bottom <= box.height,
    JSON.stringify(box),
  );
}

/** The text of a focused section or check heading, or null. */
const focusedHeading = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a && /^H[23]$/.test(a.tagName) ? a.textContent : null;
  });

const unavailable = (r: Route) =>
  r.fulfill({
    status: 503,
    json: { error: { code: "unavailable", message: "x" } },
  });

/** Holds every readiness read until `release`. */
function holdReadiness(page: Page) {
  const held: Route[] = [];
  let onHeld = () => {};
  const route = async (r: Route) => {
    held.push(r);
    onHeld();
  };
  return {
    start: () => page.route("**/api/operator/readiness", route),
    arrived: () =>
      new Promise<void>((done) => {
        if (held.length) done();
        else onHeld = done;
      }),
    async release() {
      for (const r of held.splice(0)) await r.continue();
      await page.unroute("**/api/operator/readiness", route);
    },
  };
}

/** Runs Readiness again without pointer or key input, which would count as the reader's. */
const runAgain = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Run again")
      ?.click(),
  );

const check = "/settings/readiness#readiness-claude-executable";

test("a check link lands on its heading once Readiness has read, and again on reload", async (_t, journey) => {
  // A short window puts the check below the fold, so landing has to scroll.
  const { page, web } = await startSettings(journey, "/settings/projects", {
    width: 1366,
    height: 500,
  });
  await coldGoto(page, `${web.origin}${check}`);
  await landed(page, "Claude executable");
  await page.reload();
  await landed(page, "Claude executable");
  await captureBrowserEvidence(page, "1366-readiness-check-landed");
});

test("a delayed read lands on arrival; a failed one waits for Retry", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/settings/projects");
  const hold = holdReadiness(page);
  await hold.start();
  await coldGoto(page, `${web.origin}${check}`);
  await hold.arrived();
  await nextFrames(page);
  assert.equal(await focusedHeading(page), null);
  await hold.release();
  await landed(page, "Claude executable");

  // An initial failure shows Unavailable with Retry and keeps the landing pending.
  await page.route("**/api/operator/readiness", unavailable);
  await coldGoto(page, `${web.origin}${check}`);
  await page.getByText("Readiness checks are unavailable").waitFor();
  assert.equal(await focusedHeading(page), null);
  await page.unroute("**/api/operator/readiness", unavailable);
  await runAgain(page);
  await landed(page, "Claude executable");
});

test("reader input while the read is loading keeps their position", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/settings/projects", {
    width: 1366,
    height: 500,
  });
  for (const act of [
    () => page.mouse.wheel(0, 40),
    () => page.keyboard.press("Tab"),
  ]) {
    const hold = holdReadiness(page);
    await hold.start();
    await coldGoto(page, `${web.origin}${check}`);
    await hold.arrived();
    await act();
    await hold.release();
    await page.getByRole("article", { name: "Claude executable" }).waitFor();
    await nextFrames(page);
    await nextFrames(page);
    assert.equal(await focusedHeading(page), null);
  }
});

test("an unknown check leaves the page heading and top", async (_t, journey) => {
  // The read always carries every known check, so only an unknown id has no target.
  const { page, web } = await startSettings(journey, "/settings/projects");
  await coldGoto(page, `${web.origin}/settings/readiness#readiness-nope`);
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await focusedHeading(page), null);
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.equal(new URL(page.url()).hash, "#readiness-nope");
});

test("a stale read after a failed refresh does not land until a fresh read", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/readiness", {
    width: 1366,
    height: 500,
  });
  await page.getByRole("article", { name: "Claude executable" }).waitFor();
  await page.route("**/api/operator/readiness", unavailable);
  await runAgain(page);
  await page
    .getByText("Refresh failed. Showing the last fetched data.")
    .waitFor();
  await page.evaluate(() => {
    location.hash = "readiness-claude-executable";
  });
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await focusedHeading(page), null);
  await page.unroute("**/api/operator/readiness", unavailable);
  await runAgain(page);
  await landed(page, "Claude executable");
});

test("Back to a landed entry restores its saved position even when the check renders later", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/settings/projects", {
    width: 1366,
    height: 500,
  });
  await coldGoto(page, `${web.origin}${check}`);
  await landed(page, "Claude executable");
  await page.evaluate(() => scrollTo(0, 40));
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Agents", exact: true })
    .click();
  await page.getByRole("heading", { level: 1, name: "Agents" }).waitFor();
  const hold = holdReadiness(page);
  await hold.start();
  await page.goBack();
  await hold.arrived();
  await nextFrames(page);
  await hold.release();
  await page.getByRole("article", { name: "Claude executable" }).waitFor();
  await nextFrames(page);
  await nextFrames(page);
  // The saved entry is restored, not landed again: the link it left from has focus.
  assert.equal(await focusedHeading(page), null);
  assert.ok((await page.evaluate(() => scrollY)) <= 40);
});

test("a background refresh does not take focus back to the check", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/settings/projects");
  await coldGoto(page, `${web.origin}${check}`);
  await landed(page, "Claude executable");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.focus();
  const read = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/readiness"),
  );
  await refresh.press("Enter");
  await read;
  await nextFrames(page);
  assert.equal(await focusedHeading(page), null);
});

test("Add Claude lands once Runtime has read", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/settings/projects", {
    width: desktop.width,
    height: 400,
  });
  await coldGoto(page, `${web.origin}/settings/runtime#add-claude`);
  await landed(page, "Add Claude");
  await coldGoto(page, `${web.origin}/settings/runtime#unknown`);
  await page.getByRole("heading", { name: "Add Claude" }).waitFor();
  await nextFrames(page);
  assert.equal(await focusedHeading(page), null);
});

test("Home checklist Settings actions open their section pages", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/", desktop, undefined, {
    turnStarted: false,
  });
  const card = page.getByRole("region", { name: "Get cab running" });
  const action = (row: string, name: string) =>
    card
      .getByRole("listitem", { name: row, exact: true })
      .getByRole("link", { name });
  await card.waitFor();
  const heading = (name: string) =>
    page.waitForFunction(
      (n) =>
        document.activeElement?.tagName === "H1" &&
        document.activeElement.textContent === n,
      name,
    );

  await action("Runtime", "Open readiness check").click();
  await heading("Readiness");
  assert.equal(new URL(page.url()).pathname, "/settings/readiness");
  await page.goBack();

  await action("GitHub", "Set discovery credential").click();
  await heading("GitHub discovery");
  assert.equal(new URL(page.url()).pathname, "/settings/github-discovery");
  await page.goBack();

  await action("Claude (optional)", "Add Claude").click();
  await landed(page, "Add Claude");
  assert.ok(page.url().endsWith("/settings/runtime#add-claude"), page.url());

  // A Claude that cannot run opens its own check, not the whole page.
  await page.route("**/api/operator/readiness", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    for (const c of body.data.checks)
      if (c.id === "claude-executable")
        Object.assign(c, {
          status: "fail",
          reason: "Claude Code did not run.",
          fix: "Install Claude Code.",
        });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${web.origin}/`);
  await card.waitFor();
  await action("Claude (optional)", "Open readiness check").click();
  await landed(page, "Claude executable");
  assert.ok(page.url().endsWith(check), page.url());
});

test("Back to a route with a fragment and no saved position still scrolls to the top", async (_t, journey) => {
  const { page } = await startSettings(journey, "/tasks");
  await page.locator("main.page h1").waitFor();
  await page.evaluate(() => {
    const { scrollY: _s, ...state } = history.state;
    history.pushState(
      { ...state, navKey: crypto.randomUUID() },
      "",
      "/tasks#elsewhere",
    );
    history.back();
  });
  await nextFrames(page);
  const calls = await page.evaluate(async () => {
    const calls: unknown[][] = [];
    const original = window.scrollTo.bind(window) as (...a: unknown[]) => void;
    Object.assign(window, {
      scrollTo: (...a: unknown[]) => {
        calls.push(a);
        original(...a);
      },
    });
    history.forward();
    const frames = () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    await frames();
    await frames();
    return calls;
  });
  assert.deepEqual(calls, [[0, 0]]);
});
