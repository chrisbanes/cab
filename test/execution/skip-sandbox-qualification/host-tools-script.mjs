// The fixed script both host-tools qualifications run inside the agent's sandbox (or not):
// launch headless Chromium, boot Medium_Phone on a fixed console port, then kill only that emulator.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightEntry = pathToFileURL(
  join(
    new URL("../../../node_modules/playwright/", import.meta.url).pathname,
    "index.mjs",
  ),
).href;

// Each step records `ok` or its error text; the result goes to host-tools-result.json.
// A fixed console port keeps the serial (emulator-5580) distinct from any other emulator.
export const hostToolsScript =
  () => `import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const steps = {};
const text = (error) => String(error?.message ?? error).replace(/\\s+/g, " ").slice(0, 400);
const sdk = process.env.HOME + "/Library/Android/sdk";
const adb = sdk + "/platform-tools/adb";
const serial = "emulator-5580";
const adbRun = (...rest) => execFileSync(adb, ["-s", serial, ...rest], { encoding: "utf8", timeout: 10000 }).trim();
const save = () => writeFileSync("host-tools-result.json", JSON.stringify(steps));
try {
  const { chromium } = await import(${JSON.stringify(playwrightEntry)});
  const browser = await chromium.launch({ headless: true, timeout: 60000 });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>probe-title</title>");
    const title = await page.title();
    steps.chromium = title === "probe-title" ? "ok" : "unexpected-title:" + title;
  } finally { await browser.close(); }
} catch (error) { steps.chromium = text(error); }
save();
let child = null;
let stderr = "";
let exited = false;
try {
  child = spawn(sdk + "/emulator/emulator", ["-avd", "Medium_Phone", "-port", "5580", "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim"], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-400); });
  child.once("exit", (code, signal) => { exited = true; stderr += " exit=" + (code ?? signal); });
  child.once("error", (error) => { exited = true; stderr += " " + text(error); });
  const deadline = Date.now() + 300000;
  let last = "";
  while (Date.now() < deadline && steps.emulator === undefined) {
    if (exited) { steps.emulator = "emulator exited: " + text(stderr + " " + last); break; }
    try {
      if (adbRun("shell", "getprop", "sys.boot_completed") === "1") steps.emulator = "ok";
    } catch (error) { last = text(error); }
    if (steps.emulator === undefined) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  steps.emulator ??= "boot timeout: " + text(stderr + " " + last);
} catch (error) { steps.emulator = text(error); }
finally {
  if (child && !exited) {
    try { adbRun("emu", "kill"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // Fallback: only the exact child this script spawned.
    if (!exited) try { child.kill("SIGTERM"); } catch {}
  }
  save();
}
`;
