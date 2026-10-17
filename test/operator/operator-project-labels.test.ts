import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLabels } from "../../src/operator/project-labels.js";

const id = (n: number, tail = "0000-4000-8000-000000000000") =>
  `${String(n).repeat(8)}-${tail}`;
const project = (
  n: number,
  name: string | null,
  leadProfileId: string | null,
) => ({
  id: id(n),
  name,
  leadProfileId,
});
const mira = { id: id(8), name: "Mira" };
const jonas = { id: id(9), name: "Jonas" };
const profiles = [
  mira,
  jonas,
  { id: id(7), name: "Mira" },
  { id: id(6), name: null },
];
const texts = (projects: ReturnType<typeof project>[], leads = profiles) => {
  const labels = projectLabels(projects, leads);
  return projects.map((p) => labels.get(p.id)?.text);
};

test("a unique project name has no suffix", () => {
  const labels = projectLabels([project(1, "Atlas", mira.id)], profiles);
  assert.deepEqual(labels.get(id(1)), {
    name: "Atlas",
    suffix: null,
    text: "Atlas",
  });
});

test("same-named projects with different leads are told apart by the lead", () => {
  assert.deepEqual(
    texts([project(1, "Atlas", mira.id), project(2, "Atlas", jonas.id)]),
    ["Atlas · Mira", "Atlas · Jonas"],
  );
});

test("same-named projects with the same lead fall back to the first eight characters of the id", () => {
  const labels = projectLabels(
    [project(1, "Atlas", mira.id), project(2, "Atlas", mira.id)],
    profiles,
  );
  assert.deepEqual(labels.get(id(1))?.suffix, { kind: "id", text: "11111111" });
  assert.deepEqual(labels.get(id(2))?.suffix, { kind: "id", text: "22222222" });
  assert.equal(labels.get(id(2))?.text, "Atlas · 22222222");
});

test("different lead profiles that share a name fall back to the id", () => {
  assert.deepEqual(
    texts([project(1, "Atlas", mira.id), project(2, "Atlas", id(7))]),
    ["Atlas · 11111111", "Atlas · 22222222"],
  );
});

test("a missing, unknown or unnamed lead falls back to the id", () => {
  assert.deepEqual(
    texts([
      project(1, "Atlas", null),
      project(2, "Atlas", id(5)),
      project(3, "Atlas", id(6)),
    ]),
    ["Atlas · 11111111", "Atlas · 22222222", "Atlas · 33333333"],
  );
});

test("a lead that is unique in the group is named even when others fall back", () => {
  assert.deepEqual(
    texts([
      project(1, "Atlas", mira.id),
      project(2, "Atlas", mira.id),
      project(3, "Atlas", jonas.id),
    ]),
    ["Atlas · 11111111", "Atlas · 22222222", "Atlas · Jonas"],
  );
});

test("names group ignoring case, spacing and Unicode composition, but not lookalikes", () => {
  assert.deepEqual(
    texts([project(1, "Atlas", mira.id), project(2, "atlas ", jonas.id)]),
    ["Atlas · Mira", "atlas  · Jonas"],
  );
  assert.deepEqual(
    texts([project(1, "Café", mira.id), project(2, "Café", jonas.id)]),
    ["Café · Mira", "Café · Jonas"],
  );
  assert.deepEqual(
    texts([project(1, "Atlas", mira.id), project(2, "Аtlas", mira.id)]),
    ["Atlas", "Аtlas"],
  );
});

test("unavailable names group together", () => {
  assert.deepEqual(
    texts([project(1, null, mira.id), project(2, null, mira.id)]),
    ["Name unavailable · 11111111", "Name unavailable · 22222222"],
  );
});

test("labels do not depend on the order of the input", () => {
  const all = [
    project(1, "Atlas", mira.id),
    project(2, "Atlas", mira.id),
    project(3, "Atlas", jonas.id),
    project(4, "Relay", mira.id),
  ];
  const expected = [...projectLabels(all, profiles)].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const order of [
    [3, 2, 1, 0],
    [1, 3, 0, 2],
    [2, 0, 3, 1],
  ]) {
    const shuffled = order.flatMap((index) => all[index] ?? []);
    assert.deepEqual(
      [...projectLabels(shuffled, [...profiles].reverse())].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
      expected,
    );
  }
});
