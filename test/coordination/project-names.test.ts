import assert from "node:assert/strict";
import { test } from "node:test";
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

test("Turkish rules never apply: dotted capital I keeps its dot, dotless i pairs with I", () => {
  same("İ", "i̇", "İ");
  different("İ", "I");
  same("ı", "I", "i");
  same("ISPARTA", "ısparta", "isparta");
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
