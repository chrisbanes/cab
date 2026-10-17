import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readinessCheckHref,
  SETTINGS_SECTIONS,
  settingsSectionHref,
  settingsSectionOrder,
} from "../../web/src/settings-sections.js";

const designed = [
  "projects",
  "runtime",
  "profiles",
  "routing",
  "github-discovery",
  "cli-credentials",
  "readiness",
];

test("first run orders Readiness first and established installs keep the designed order", () => {
  assert.deepEqual(settingsSectionOrder(false), [
    "readiness",
    "projects",
    "runtime",
    "profiles",
    "routing",
    "github-discovery",
    "cli-credentials",
  ]);
  assert.deepEqual(settingsSectionOrder(true), designed);
  assert.deepEqual(settingsSectionOrder(undefined), designed);
});

test("section hrefs are the Settings path with the section fragment", () => {
  for (const { id } of SETTINGS_SECTIONS)
    assert.equal(settingsSectionHref(id), `/app/settings#${id}`);
  assert.equal(
    readinessCheckHref("claude-executable"),
    "/app/settings#readiness-claude-executable",
  );
});
