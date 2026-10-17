import assert from "node:assert/strict";
import { test } from "node:test";
import { projectNameKey } from "../../src/core/project-names.js";
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

const uuid = (head: string, n: number) =>
  `${head}-${String(n).padStart(4, "0")}-4000-8000-000000000000`;
test("ids that share their first eight, twelve and sixteen characters widen only the labels that still clash", () => {
  const projects = [
    {
      id: "aaaaaaaa-bbbb-4000-8000-000000000001",
      name: "Atlas",
      leadProfileId: null,
    },
    {
      id: "aaaaaaaa-bbbb-4000-8000-000000000002",
      name: "Atlas",
      leadProfileId: null,
    },
    {
      id: "aaaaaaaa-cccc-4000-8000-000000000003",
      name: "Atlas",
      leadProfileId: null,
    },
  ];
  const labels = projectLabels(projects, []);
  assert.deepEqual(
    projects.map((p) => labels.get(p.id)?.text),
    [
      "Atlas · aaaaaaaa-bbbb-4000-8000-000000000001",
      "Atlas · aaaaaaaa-bbbb-4000-8000-000000000002",
      "Atlas · aaaaaaaa-ccc",
    ],
  );
  const twelve = projectLabels(
    [
      {
        id: "aaaaaaaa-bbbb-4000-8000-000000000001",
        name: "Atlas",
        leadProfileId: null,
      },
      {
        id: "aaaaaaaa-cccc-4000-8000-000000000002",
        name: "Atlas",
        leadProfileId: null,
      },
    ],
    [],
  );
  assert.equal(
    twelve.get("aaaaaaaa-bbbb-4000-8000-000000000001")?.suffix?.text,
    "aaaaaaaa-bbb",
  );
});

test("a lead named like another project's id prefix cannot make two labels equal", () => {
  const projects = [
    {
      id: "11111111-0000-4000-8000-000000000001",
      name: "Atlas",
      leadProfileId: id(8),
    },
    {
      id: "11111111-0000-4000-8000-000000000002",
      name: "Atlas",
      leadProfileId: id(9),
    },
    {
      id: "22222222-0000-4000-8000-000000000003",
      name: "Atlas",
      leadProfileId: null,
    },
  ];
  const labels = projectLabels(projects, [
    { id: id(8), name: "Mira" },
    { id: id(9), name: "22222222" },
  ]);
  const texts = projects.map((p) => labels.get(p.id)?.text);
  assert.equal(new Set(texts).size, 3);
  assert.equal(texts[0], "Atlas · Mira");
  assert.notEqual(texts[1], texts[2]);
});

test("a lead named exactly like another project's full id still yields distinct labels", () => {
  const other = "33333333-0000-4000-8000-000000000001";
  const labels = projectLabels(
    [
      { id: other, name: "Atlas", leadProfileId: null },
      {
        id: "44444444-0000-4000-8000-000000000002",
        name: "Atlas",
        leadProfileId: id(8),
      },
    ],
    [{ id: id(8), name: other }],
  );
  assert.equal(new Set([...labels.values()].map((l) => l.text)).size, 2);
});

test("every duplicate-name group is distinct and a unique name has no suffix, for adversarial ids, names and leads", () => {
  let seed = 12345;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const names = [
    "Atlas",
    "atlas",
    " ATLAS ",
    "Caf\u00e9",
    "Cafe\u0301",
    "Relay",
    "Solo",
    "\u039f\u03a3",
    "\u03bf\u03c3",
    "\u03bf\u03c2",
    "Stra\u00dfe",
    "STRASSE",
    "\u0130",
    "I",
    "\u0131",
    "Atlas \u00b7 Mira",
    "Atlas \u00b7 1a2b3c4d",
    "Atlas \u00b7 aaaaaaaa",
    "atlas \u00b7 mira",
  ];
  const leadNames = ["Mira", "mira", "Jonas", "22222222", "aaaaaaaa", null];
  const prefixes = [
    "aaaaaaaa",
    "aaaaaaaa-bbbb",
    "22222222",
    "aaaaaaaa-bbbb-4000",
  ];
  for (let round = 0; round < 300; round++) {
    const profiles = leadNames.map((name, index) => ({
      id: uuid("99999999", index),
      name,
    }));
    const pairPrefixes = Array.from(
      { length: 4 },
      () => prefixes[random(prefixes.length)] as string,
    );
    const projects = Array.from({ length: 2 + random(7) }, (_, index) => {
      const base = `${(pairPrefixes[index >> 1] as string).padEnd(30, "0")}${String(index >> 1).padStart(6, "a")}`;
      return {
        // Unique raw ids: shared adversarial prefixes, and pairs that differ only by case.
        id: index % 2 ? base.toUpperCase() : base,
        name: names[random(names.length)] as string,
        leadProfileId:
          random(3) === 0
            ? null
            : (profiles[random(profiles.length)] as { id: string }).id,
      };
    });
    const labels = projectLabels(projects, profiles);
    // Every label in the workspace is distinct, across groups and against plain names, and
    // does not depend on input order.
    const reversed = projectLabels(
      [...projects].reverse(),
      [...profiles].reverse(),
    );
    for (const p of projects)
      assert.equal(reversed.get(p.id)?.text, labels.get(p.id)?.text);
    const finals = projects.map((p) =>
      projectNameKey(labels.get(p.id)?.text ?? ""),
    );
    assert.equal(
      new Set(finals).size,
      projects.length,
      JSON.stringify({ projects, finals }),
    );
    const sizes = new Map<string, number>();
    for (const p of projects) {
      const key = projectNameKey(p.name);
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
    // A unique name stays plain, and an unshared name never gains a lead suffix.
    for (const p of projects) {
      const suffix = labels.get(p.id)?.suffix;
      if (sizes.get(projectNameKey(p.name)) === 1)
        assert.equal(suffix, null, p.name);
      else assert.ok(suffix, p.name);
    }
  }
});

test("names that differ only by Unicode case folding share a group, and a unique fold has no suffix", () => {
  const projects = [
    { id: id(1), name: "\u039f\u03a3", leadProfileId: mira.id },
    { id: id(2), name: "\u03bf\u03c3", leadProfileId: jonas.id },
    { id: id(3), name: "Stra\u00dfe", leadProfileId: mira.id },
    { id: id(4), name: "STRASSE", leadProfileId: jonas.id },
    { id: id(5), name: "\u0130", leadProfileId: mira.id },
    { id: id(6), name: "I", leadProfileId: mira.id },
  ];
  assert.deepEqual(texts(projects), [
    "\u039f\u03a3 \u00b7 Mira",
    "\u03bf\u03c3 \u00b7 Jonas",
    "Stra\u00dfe \u00b7 Mira",
    "STRASSE \u00b7 Jonas",
    "\u0130",
    "I",
  ]);
});

test("a generated label that equals another project's plain name moves, and the plain name stays", () => {
  const projects = [
    { id: id(1), name: "Atlas", leadProfileId: mira.id },
    { id: id(2), name: "Atlas", leadProfileId: jonas.id },
    { id: id(3), name: "Atlas \u00b7 Mira", leadProfileId: null },
  ];
  const labels = projectLabels(projects, profiles);
  assert.deepEqual(
    projects.map((p) => labels.get(p.id)?.text),
    ["Atlas \u00b7 11111111", "Atlas \u00b7 Jonas", "Atlas \u00b7 Mira"],
  );
  assert.equal(labels.get(id(3))?.suffix, null);
});

test("generated labels from different groups cannot match, and a plain name matching a full-id label gets its own id", () => {
  const first = {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Atlas",
    leadProfileId: null,
  };
  const second = { ...first, id: "11111111-2222-4333-8444-555555555556" };
  const plain = {
    id: id(5),
    name: `Atlas \u00b7 ${second.id}`,
    leadProfileId: null,
  };
  const labels = projectLabels([first, second, plain], []);
  const texts = [first, second, plain].map((p) => labels.get(p.id)?.text);
  assert.equal(new Set(texts.map((t) => projectNameKey(t ?? ""))).size, 3);
  assert.equal(labels.get(first.id)?.text, `Atlas \u00b7 ${first.id}`);
  assert.equal(labels.get(second.id)?.text, `Atlas \u00b7 ${second.id}`);
  assert.equal(labels.get(plain.id)?.text, `${plain.name} \u00b7 ${plain.id}`);
});

test("a project literally named like the unavailable placeholder keeps its plain name", () => {
  const labels = projectLabels(
    [
      { id: id(1), name: null, leadProfileId: null },
      { id: id(2), name: "Name unavailable", leadProfileId: null },
    ],
    [],
  );
  assert.equal(labels.get(id(2))?.text, "Name unavailable");
  assert.equal(labels.get(id(1))?.text, "Name unavailable \u00b7 11111111");
});

test("ids that differ only by letter case are numbered by raw id order after the full id", () => {
  const lower = "abcdef12-0001-4000-8000-00000000abcd";
  const upper = lower.toUpperCase();
  const projects = [
    { id: lower, name: "Atlas", leadProfileId: null },
    { id: upper, name: "atlas", leadProfileId: null },
  ];
  const expected = [`Atlas \u00b7 ${lower} #2`, `atlas \u00b7 ${upper} #1`];
  for (const order of [projects, [...projects].reverse()]) {
    const labels = projectLabels(order, []);
    assert.deepEqual(
      projects.map((p) => labels.get(p.id)?.text),
      expected,
    );
    assert.equal(labels.get(upper)?.suffix?.kind, "id");
  }
  // A plain name that already looks like the numbered label still ends up distinct.
  const plain = {
    id: id(7),
    name: `Atlas \u00b7 ${lower} #2`,
    leadProfileId: null,
  };
  const labels = projectLabels([...projects, plain], []);
  const keys = [...projects, plain].map((p) =>
    projectNameKey(labels.get(p.id)?.text ?? ""),
  );
  assert.equal(new Set(keys).size, 3);
  assert.equal(labels.get(plain.id)?.text.startsWith(plain.name), true);
});
