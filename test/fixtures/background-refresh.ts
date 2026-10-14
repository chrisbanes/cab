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
    __observedDom?: { changes: string[]; statusSeen: boolean };
  }
}

/**
 * Records DOM mutations that could change what the viewer sees, and whether a `.resource-status`
 * alert ever appeared. Relative ages (`<time>`) legitimately tick when the fake clock advances, and
 * React rewrites unchanged attributes and text on re-render, so those records are ignored.
 */
export async function watchDom(page: Page) {
  await page.evaluate(() => {
    const log = { changes: [] as string[], statusSeen: false };
    window.__observedDom = log;
    new MutationObserver((records) => {
      for (const record of records) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        if (target?.closest("time")) continue;
        if (
          record.type === "attributes" &&
          target?.getAttribute(record.attributeName ?? "") === record.oldValue
        )
          continue;
        if (
          record.type === "characterData" &&
          record.target.textContent === record.oldValue
        )
          continue;
        log.changes.push(
          `${record.type} ${target?.tagName.toLowerCase()}.${target?.className} ${record.attributeName ?? ""}`,
        );
      }
      if (document.querySelector(".resource-status")) log.statusSeen = true;
    }).observe(document.body, {
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
      subtree: true,
    });
  });
}

export function observedDom(page: Page) {
  return page.evaluate(() => window.__observedDom);
}
