import type { Page, Request } from "playwright";

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
    __domChanges?: () => { changes: string[]; statusSeen: boolean };
  }
}

const reads = new WeakMap<Page, { open: Set<Request>; started: number }>();

/**
 * Records the net DOM changes a viewer could see, and whether a `.resource-status` alert ever
 * appeared. Added or removed nodes always count. An attribute or text value counts only when it ends
 * different from where it started: React rewrites unchanged inputs on every render, and relative
 * ages (`<time>`) legitimately tick when the fake clock advances, so neither counts.
 */
export async function watchDom(page: Page) {
  const reading = { open: new Set<Request>(), started: 0 };
  reads.set(page, reading);
  const read = (request: Request) =>
    ["fetch", "xhr"].includes(request.resourceType());
  page.on("request", (request) => {
    if (!read(request)) return;
    reading.started++;
    reading.open.add(request);
  });
  const finished = (request: Request) => {
    reading.open.delete(request);
  };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  await page.evaluate(() => {
    const original = new Map<Node, Map<string, string | null>>();
    const structural: string[] = [];
    let statusSeen = false;
    const describe = (node: Node | null) =>
      node instanceof Element
        ? `${node.tagName.toLowerCase()}.${node.className}`
        : "text";
    new MutationObserver((records) => {
      for (const record of records) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        if (target?.closest("time")) continue;
        if (record.type === "childList")
          structural.push(`childList ${describe(record.target)}`);
        else {
          const key =
            record.type === "attributes"
              ? (record.attributeName ?? "")
              : "#text";
          const first = original.get(record.target) ?? new Map();
          if (!first.has(key)) first.set(key, record.oldValue);
          original.set(record.target, first);
        }
      }
      if (document.querySelector(".resource-status")) statusSeen = true;
    }).observe(document.body, {
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
      subtree: true,
    });
    window.__domChanges = () => {
      const changes = [...structural];
      for (const [node, values] of original)
        for (const [key, before] of values) {
          const now =
            key === "#text"
              ? node.textContent
              : (node as Element).getAttribute(key);
          if (now !== before)
            changes.push(
              `${key} ${describe(node instanceof Element ? node : node.parentElement)}`,
            );
        }
      return { changes, statusSeen };
    };
  });
}

/** Waits for every started read to finish and for React to commit what they brought. */
export async function settleReads(page: Page) {
  const reading = reads.get(page);
  if (!reading) throw Error("watchDom must be installed first");
  for (let seen = -1; seen !== reading.started; ) {
    seen = reading.started;
    while (reading.open.size > 0) await new Promise((r) => setTimeout(r, 10));
    // Macrotask turns rather than timers, which the page clock controls.
    await page.evaluate(async () => {
      for (let turn = 0; turn < 20; turn++)
        await new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = resolve;
          channel.port2.postMessage(0);
        });
    });
  }
}

export function observedDom(page: Page) {
  return page.evaluate(() => window.__domChanges?.());
}
