import type { Page } from "playwright";

/** Holds the first matching response until `release()`, resolving `entered` once the request arrives. */
export async function holdResponse(page: Page, glob: string) {
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let held = false;
  await page.route(glob, async (route) => {
    const response = await route.fetch();
    if (!held) {
      held = true;
      enter();
      await gate;
    }
    await route.fulfill({ response });
  });
  return {
    entered,
    release: () => release(),
    /** Stops holding and answers later requests normally. */
    stop: () => page.unroute(glob),
  };
}

/** Answers matching requests with a 503 until `stop()`. */
export async function failResponses(page: Page, glob: string) {
  await page.route(glob, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  return { stop: () => page.unroute(glob) };
}

declare global {
  interface Window {
    __observedDom?: { mutations: number; statusSeen: boolean };
  }
}

/** Records every DOM mutation and whether a `.resource-status` alert ever appeared. */
export async function watchDom(page: Page) {
  await page.evaluate(() => {
    const log = { mutations: 0, statusSeen: false };
    window.__observedDom = log;
    new MutationObserver((records) => {
      log.mutations += records.length;
      if (document.querySelector(".resource-status")) log.statusSeen = true;
    }).observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      subtree: true,
    });
  });
}

export function observedDom(page: Page) {
  return page.evaluate(() => window.__observedDom);
}
