// The fixed stimulus every escalating leg runs: launch headless Chromium through the
// repository's Playwright and write `{ chromium: "ok" | <error> }` to `<label>-result.json`.
// Chromium fails inside both harness sandboxes (docs/evidence/skip-sandbox-probe-2026-11-09.md),
// so a sandboxed control failing and the escalated leg passing shows it ran outside.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const playwrightEntry = pathToFileURL(
  join(
    new URL("../../../node_modules/playwright/", import.meta.url).pathname,
    "index.mjs",
  ),
).href;

export const chromiumScript = () => `import { writeFileSync } from "node:fs";
const label = process.argv[2] ?? "";
if (!/^[a-z-]{1,32}$/.test(label)) process.exit(2);
let chromium;
try {
  const { chromium: engine } = await import(${JSON.stringify(playwrightEntry)});
  const browser = await engine.launch({ headless: true, timeout: 60000 });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>probe-title</title>");
    chromium = (await page.title()) === "probe-title" ? "ok" : "unexpected-title";
  } finally { await browser.close(); }
} catch (error) {
  chromium = String(error?.message ?? error).replace(/\\s+/g, " ").slice(0, 300);
}
writeFileSync(label + "-result.json", JSON.stringify({ chromium }));
`;
