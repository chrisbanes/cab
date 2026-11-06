import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { themeBlocks } from "../fixtures/theme-tokens.js";
import {
  parseThemeChoice,
  rememberedTheme,
  resolveTheme,
} from "../../web/src/theme.js";

test("System follows the OS while Light and Dark ignore it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  for (const prefersDark of [true, false]) {
    assert.equal(resolveTheme("light", prefersDark), "light");
    assert.equal(resolveTheme("dark", prefersDark), "dark");
  }
});

test("only an explicit Light or Dark is a remembered choice", () => {
  assert.equal(parseThemeChoice("light"), "light");
  assert.equal(parseThemeChoice("dark"), "dark");
  for (const value of [null, "", "auto", "system", 1])
    assert.equal(parseThemeChoice(value), "system");
  assert.equal(rememberedTheme(), "system");
});

test("the design tokens table matches both token blocks", () => {
  const { light, dark } = themeBlocks();
  // Themed values are hex colours and the menu shadow; aliases and spacing stay once on :root.
  const names = (map: Map<string, string>) =>
    [...map]
      .filter(
        ([name, value]) => value.startsWith("#") || name === "--menu-shadow",
      )
      .map(([name]) => name)
      .sort();
  assert.deepEqual(names(light), names(dark), "tokens declared in both themes");
  const doc = readFileSync(
    new URL("../../../design/DESIGN.md", import.meta.url),
    "utf8",
  );
  const rows = new Map<string, [string, string]>();
  for (const [, name, darkValue, lightValue] of doc.matchAll(
    /^\| `(--[\w-]+)` \| `([^`]+)` \| `([^`]+)` \|/gm,
  ))
    rows.set(name as string, [darkValue as string, lightValue as string]);
  for (const name of names(light)) {
    const row = rows.get(name);
    assert.ok(row, `${name} has a DESIGN.md row`);
    assert.equal(
      row[0].toLowerCase(),
      dark.get(name)?.toLowerCase(),
      `${name} dark`,
    );
    assert.equal(
      row[1].toLowerCase(),
      light.get(name)?.toLowerCase(),
      `${name} light`,
    );
  }
});
