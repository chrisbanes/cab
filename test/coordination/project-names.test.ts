import assert from "node:assert/strict";
import { test } from "node:test";
import { caseFoldingDifferences } from "../../src/core/case-folding.js";
import { projectNameKey } from "../../src/core/project-names.js";

const same = (...names: string[]) => {
  const keys = new Set(names.map(projectNameKey));
  assert.equal(keys.size, 1, JSON.stringify(names));
};
const different = (a: string, b: string) =>
  assert.notEqual(projectNameKey(a), projectNameKey(b), `${a} / ${b}`);

test("case variants are the same name, including final sigma", () => {
  same("Atlas", "atlas", "ATLAS", "aTlAs");
  same("ΟΣ", "οσ", "ος", "Ος");
  same("ΑΒΓ", "αβγ");
});

test("sharp s, capital sharp s and SS are the same name", () => {
  same("Straße", "STRASSE", "strasse", "STRAẞE", "straẞe");
});

test("Kelvin sign, ligatures and Unicode composition fold with their plain forms", () => {
  same("K", "K", "k");
  same("oﬃce", "OFFICE", "office");
  same("Café", "Café", "CAFÉ", "cafÉ");
});

test("Turkish rules never apply: dotless i, dotted capital I and plain I follow Unicode default folding", () => {
  // I and i fold together; dotless ı is its own letter; İ folds to i and a combining dot.
  same("I", "i");
  different("\u0131", "I");
  different("\u0131", "i");
  same("\u0130", "i\u0307", "I\u0307");
  different("\u0130", "I");
  different("\u0130", "\u0131");
  same("ISPARTA", "isparta");
  different("\u0131sparta", "isparta");
});

test("every table entry folds like its Unicode default folding, and a name folds one code point at a time", () => {
  assert.ok(caseFoldingDifferences.size > 300);
  for (const [code, folded] of caseFoldingDifferences)
    assert.equal(
      projectNameKey(String.fromCodePoint(code)),
      folded.normalize("NFD"),
      code.toString(16),
    );
  // Sigma forms agree wherever they sit in a word: no final-sigma context.
  same("\u03a3\u0391\u03a3", "\u03c3\u03b1\u03c2", "\u03c3\u03b1\u03c3");
  // Cherokee folds to upper case, small and capital forms alike.
  same("\u13a0", "\uab70");
  same("\u00c5", "\u212b", "\u00e5", "A\u030a");
  same("\ufb01", "FI", "fi");
  same("\u017f", "s", "S");
});

test("folding is idempotent and leaves a folded key unchanged for every code point", () => {
  for (let code = 0; code < 0x110000; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const key = projectNameKey(String.fromCodePoint(code));
    if (projectNameKey(key) !== key) assert.fail(code.toString(16));
  }
});

test("trimming ignores outer space only and lookalikes or compatibility forms stay different", () => {
  same("  Atlas\t", "Atlas", " Atlas ");
  different("At las", "Atlas");
  different("Atlas", "Atlas  2");
  different("Аtlas", "Atlas");
  different("Ａtlas", "Atlas");
});

test("the key is idempotent", () => {
  for (const name of ["ΟΣ", "Straẞe", "İstanbul", "oﬃce"])
    assert.equal(projectNameKey(projectNameKey(name)), projectNameKey(name));
});
