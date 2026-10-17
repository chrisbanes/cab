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

const uuid = (head: string, n: number) =>
  `${head}-${String(n).padStart(4, "0")}-4000-8000-000000000000`;
test("ids that share their first eight, twelve and sixteen characters widen until distinct", () => {
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
      "Atlas · aaaaaaaa-cccc-4000-8000-000000000003",
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
  const names = ["Atlas", "atlas", " ATLAS ", "Café", "Café", "Relay", "Solo"];
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
    const projects = Array.from({ length: 2 + random(7) }, (_, index) => {
      const prefix = prefixes[random(prefixes.length)] as string;
      return {
        // Unique by the trailing index, with adversarial shared prefixes.
        id: `${prefix.padEnd(30, "0")}${String(index).padStart(6, "0")}`,
        name: names[random(names.length)] as string,
        leadProfileId:
          random(3) === 0
            ? null
            : (profiles[random(profiles.length)] as { id: string }).id,
      };
    });
    const labels = projectLabels(projects, profiles);
    const byKey = new Map<string, typeof projects>();
    for (const p of projects) {
      const key = p.name.trim().normalize("NFC").toLowerCase();
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    for (const [, group] of byKey) {
      const texts = group.map((p) =>
        (labels.get(p.id)?.text ?? "").trim().normalize("NFC").toLowerCase(),
      );
      assert.equal(
        new Set(texts).size,
        group.length,
        JSON.stringify({ projects, texts }),
      );
      if (group.length === 1)
        assert.equal(labels.get(group[0]!.id)?.suffix, null);
    }
  }
});
