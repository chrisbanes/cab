import { test as nodeTest, type TestFn, type TestOptions } from "node:test";

export type BrowserEngine = "chromium" | "webkit";
export type BrowserEngineSelection = "all" | "chromium" | "none";
export type BrowserTestOptions = TestOptions & {
  browserEngine?: BrowserEngine;
};

export function browserTestEngine(
  options: BrowserTestOptions = {},
): BrowserEngine {
  return options.browserEngine ?? "chromium";
}

/** Resolve and validate the runner's browser-engine selection. Local runs default to all. */
export function selectedBrowserEngines(value = "all"): BrowserEngine[] {
  switch (value) {
    case "all":
      return ["chromium", "webkit"];
    case "chromium":
      return ["chromium"];
    case "none":
      return [];
    default:
      throw Error(
        `Invalid CAB_TEST_BROWSER_ENGINE value ${JSON.stringify(value)}; expected all, chromium, or none`,
      );
  }
}

export function browserEngineEnabled(
  engine: BrowserEngine,
  value = process.env.CAB_TEST_BROWSER_ENGINE ?? "all",
): boolean {
  return selectedBrowserEngines(value).includes(engine);
}

export function browserEngineTestOptions(
  engine: BrowserEngine,
  options: BrowserTestOptions = {},
  value = process.env.CAB_TEST_BROWSER_ENGINE ?? "all",
): TestOptions {
  if (browserEngineEnabled(engine, value)) {
    const { browserEngine: _browserEngine, ...nodeOptions } = options;
    return nodeOptions;
  }
  const reason = `browser engine ${engine} excluded by CAB_TEST_BROWSER_ENGINE`;
  const skip =
    options.skip === true
      ? true
      : options.skip
        ? `${options.skip}; ${reason}`
        : reason;
  const { browserEngine: _browserEngine, ...nodeOptions } = options;
  return { ...nodeOptions, skip };
}

export function browserTest(name: string, action: TestFn): Promise<void>;
export function browserTest(
  name: string,
  options: BrowserTestOptions,
  action: TestFn,
): Promise<void>;
export function browserTest(
  name: string,
  optionsOrAction: BrowserTestOptions | TestFn,
  action?: TestFn,
): Promise<void> {
  const options = typeof optionsOrAction === "function" ? {} : optionsOrAction;
  const run = typeof optionsOrAction === "function" ? optionsOrAction : action;
  if (!run) throw Error("Browser test callback is required");
  const browserEngine = browserTestEngine(options);
  return nodeTest(name, browserEngineTestOptions(browserEngine, options), run);
}
