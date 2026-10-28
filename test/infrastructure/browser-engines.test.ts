import assert from "node:assert/strict";
import test from "node:test";
import {
  browserTestEngine,
  browserEngineTestOptions,
  selectedBrowserEngines,
} from "../fixtures/browser-engines.js";

test("browser engine selection defaults to all engines", () => {
  assert.deepEqual(selectedBrowserEngines(undefined), ["chromium", "webkit"]);
});

test("browser engine selection supports all, Chromium, and none", () => {
  assert.deepEqual(selectedBrowserEngines("all"), ["chromium", "webkit"]);
  assert.deepEqual(selectedBrowserEngines("chromium"), ["chromium"]);
  assert.deepEqual(selectedBrowserEngines("none"), []);
});

test("browser engine selection rejects unknown values clearly", () => {
  assert.throws(
    () => selectedBrowserEngines("firefox"),
    /Invalid CAB_TEST_BROWSER_ENGINE value "firefox"; expected all, chromium, or none/,
  );
});

test("browser test options default to Chromium and preserve requested skips", () => {
  assert.equal(browserTestEngine(), "chromium");
  assert.equal(browserTestEngine({ browserEngine: "webkit" }), "webkit");
  assert.deepEqual(browserEngineTestOptions("chromium", {}, "chromium"), {});
  assert.deepEqual(
    browserEngineTestOptions("webkit", { skip: "intentional" }, "chromium"),
    {
      skip: "intentional; browser engine webkit excluded by CAB_TEST_BROWSER_ENGINE",
    },
  );
  assert.equal(
    browserEngineTestOptions("chromium", { browserEngine: "chromium" }, "none")
      .skip,
    "browser engine chromium excluded by CAB_TEST_BROWSER_ENGINE",
  );
});
