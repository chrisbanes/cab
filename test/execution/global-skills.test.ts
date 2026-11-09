import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  closeSync,
  openSync,
  writeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import { writeSkillPlugin } from "../fixtures/skill-plugin.js";
import { digestPlugin } from "../fixtures/legacy-harness/skill-plugins.js";
import {
  listGlobalSkills,
  inspectGlobalSkills,
  prepareGlobalSkills,
} from "../fixtures/legacy-harness/global-skills.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cab-global-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const skills = join(home, ".agents", "skills");
  const env = { HOME: home };
  const skill = (directory: string, name: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\n---\nInstructions\n`,
    );
    return directory;
  };
  return { root, home, skills, env, skill };
}

test("global discovery uses only direct children of the service user's root and follows linked installs", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await listGlobalSkills(f.env), {
    status: "missing",
    skills: [],
  });
  f.skill(join(f.skills, "direct"), "direct");
  f.skill(join(f.skills, "category", "nested"), "nested");
  const external = f.skill(join(f.root, "external"), "linked");
  symlinkSync(external, join(f.skills, "link"));
  assert.deepEqual(await listGlobalSkills(f.env), {
    status: "available",
    skills: [
      { name: "direct", available: true },
      { name: "linked", available: true },
    ],
  });
  assert.deepEqual(
    await inspectGlobalSkills({ plugins: [], global: ["linked"] }, f.env),
    { skills: ["linked"] },
  );
  assert.equal(existsSync(join(f.root, "cache")), false);
  await assert.rejects(
    inspectGlobalSkills({ plugins: [], global: ["unknown"] }, f.env),
    /Global skill unknown is unavailable/,
  );
});

test("preparation snapshots current selected resources and executables into immutable digest-addressed adapters", async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.root, "linked"), "chosen");
  mkdirSync(f.skills, { recursive: true });
  symlinkSync(source, join(f.skills, "chosen"));
  mkdirSync(join(source, "resources"));
  writeFileSync(join(source, "resources", "answer"), "one");
  writeFileSync(join(source, "run.sh"), "#!/bin/sh\ncat resources/answer\n", {
    mode: 0o755,
  });
  f.skill(join(f.skills, "unused"), "unused");
  const selection = { plugins: [], global: ["chosen"] };
  const data = join(f.root, "data");
  assert.deepEqual(await inspectGlobalSkills(selection, f.env), {
    skills: ["chosen"],
  });
  assert.equal(existsSync(data), false);
  const first = await prepareGlobalSkills(data, selection, f.env);
  assert.ok(first);
  assert.equal(first.name, "cab-global-skills");
  assert.equal(await digestPlugin(first.path, first.skills), first.digest);
  assert.equal(
    readFileSync(join(first.path, "skills/chosen/resources/answer"), "utf8"),
    "one",
  );
  assert.equal(
    statSync(join(first.path, "skills/chosen/run.sh")).mode & 0o111,
    0o111,
  );
  assert.equal(statSync(first.path).mode & 0o777, 0o700);
  assert.equal(existsSync(join(first.path, "skills/unused")), false);
  assert.equal(
    (await prepareGlobalSkills(data, selection, f.env))?.path,
    first.path,
  );
  writeFileSync(join(f.skills, "unused", "SKILL.md"), "unselected change");
  assert.equal(
    (await prepareGlobalSkills(data, selection, f.env))?.digest,
    first.digest,
  );
  writeFileSync(join(source, "resources/answer"), "two");
  const second = await prepareGlobalSkills(data, selection, f.env);
  assert.ok(second);
  assert.notEqual(second.digest, first.digest);
  assert.equal(
    readFileSync(join(first.path, "skills/chosen/resources/answer"), "utf8"),
    "one",
  );
  assert.equal(
    await prepareGlobalSkills(
      join(f.root, "unused-cache"),
      { plugins: [] },
      f.env,
    ),
    undefined,
  );
  assert.equal(existsSync(join(f.root, "unused-cache")), false);
});

test("broken links, ambiguous names and aliases are unavailable without exposing paths", async (t) => {
  const f = fixture(t);
  const real = f.skill(join(f.skills, "one"), "duplicate");
  f.skill(join(f.skills, "two"), "duplicate");
  symlinkSync(real, join(f.skills, "alias"));
  symlinkSync(join(f.root, "missing"), join(f.skills, "broken"));
  assert.deepEqual(await listGlobalSkills(f.env), {
    status: "available",
    skills: [
      { name: "broken", available: false },
      { name: "duplicate", available: false },
    ],
  });
  for (const name of ["broken", "duplicate"])
    await assert.rejects(
      inspectGlobalSkills({ plugins: [], global: [name] }, f.env),
      (error) =>
        error instanceof Error &&
        !error.message.includes(f.root) &&
        /unavailable|ambiguous/.test(error.message),
    );
});

test("case-colliding global names are refused before profile save or adapter publication", async (t) => {
  const f = fixture(t);
  f.skill(join(f.skills, "one"), "Review");
  f.skill(join(f.skills, "two"), "review");
  const selection = { plugins: [], global: ["Review", "review"] };
  assert.deepEqual(
    await inspectGlobalSkills({ plugins: [], global: ["Review"] }, f.env),
    { skills: ["Review"] },
  );
  await assert.rejects(inspectGlobalSkills(selection, f.env), /collid/i);
  const data = join(f.root, "data");
  await assert.rejects(prepareGlobalSkills(data, selection, f.env), /collid/i);
  assert.equal(existsSync(data), false);
});

test("an unreadable source root is distinct from an absent root", {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const f = fixture(t);
  mkdirSync(f.skills, { recursive: true });
  chmodSync(f.skills, 0);
  try {
    assert.deepEqual(await listGlobalSkills(f.env), {
      status: "unreadable",
      skills: [],
    });
    await assert.rejects(
      inspectGlobalSkills({ plugins: [], global: ["chosen"] }, f.env),
      /root is unreadable/,
    );
  } finally {
    chmodSync(f.skills, 0o700);
  }
});

test("selected trees reject escaping and cyclic links and special files without publishing partial adapters", async (t) => {
  for (const kind of ["outside", "cycle", "fifo"] as const)
    await t.test(kind, async (t) => {
      const f = fixture(t);
      const source = f.skill(join(f.skills, "chosen"), "chosen");
      if (kind === "outside") {
        writeFileSync(join(f.root, "secret"), "outside");
        symlinkSync(join(f.root, "secret"), join(source, "escape"));
      }
      if (kind === "cycle") symlinkSync(".", join(source, "loop"));
      if (kind === "fifo") execFileSync("mkfifo", [join(source, "pipe")]);
      const data = join(f.root, "data");
      await assert.rejects(
        prepareGlobalSkills(data, { plugins: [], global: ["chosen"] }, f.env),
        /escaping|cyclic|special/,
      );
      assert.equal(existsSync(data), false);
      await assert.rejects(
        inspectGlobalSkills({ plugins: [], global: ["chosen"] }, f.env),
      );
    });
});

test("the aggregate adapter file limit includes metadata but does not count directories as files", async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  for (let i = 0; i < 1998; i++) writeFileSync(join(source, `f${i}`), "");
  const selection = { plugins: [], global: ["chosen"] };
  assert.deepEqual(await inspectGlobalSkills(selection, f.env), {
    skills: ["chosen"],
  });
  writeFileSync(join(source, "too-many"), "");
  await assert.rejects(inspectGlobalSkills(selection, f.env), /too large/);
});

test("concurrent preparations publish one complete adapter and reject poisoned cache entries", async (t) => {
  const f = fixture(t);
  f.skill(join(f.skills, "chosen"), "chosen");
  const selection = { plugins: [], global: ["chosen"] };
  const data = join(f.root, "data");
  const prepared = await Promise.all(
    Array.from({ length: 4 }, () =>
      prepareGlobalSkills(data, selection, f.env),
    ),
  );
  assert.ok(prepared[0]);
  assert.ok(prepared.every((p) => p?.path === prepared[0]?.path));
  const outside = join(f.root, "outside");
  writeFileSync(outside, "do not change");
  const cached = join(prepared[0].path, "skills/chosen/SKILL.md");
  rmSync(cached);
  symlinkSync(outside, cached);
  await assert.rejects(
    prepareGlobalSkills(data, selection, f.env),
    /cache is unsafe/,
  );
  assert.equal(readFileSync(outside, "utf8"), "do not change");
});

test("cache directory links are refused without touching their targets", async (t) => {
  const f = fixture(t);
  f.skill(join(f.skills, "chosen"), "chosen");
  const data = join(f.root, "data");
  const outside = join(f.root, "outside");
  mkdirSync(data);
  mkdirSync(outside);
  symlinkSync(outside, join(data, "global-skill-cache"));
  await assert.rejects(
    prepareGlobalSkills(data, { plugins: [], global: ["chosen"] }, f.env),
    /cache is unsafe/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("executable permissions survive a restrictive service umask and affect adapter identity", async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  const script = join(source, "run.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
  const oldMask = process.umask(0o077);
  try {
    const selection = { plugins: [], global: ["chosen"] };
    const first = await prepareGlobalSkills(
      join(f.root, "data"),
      selection,
      f.env,
    );
    assert.ok(first);
    assert.equal(
      statSync(join(first.path, "skills/chosen/run.sh")).mode & 0o111,
      0o111,
    );
    assert.equal(
      (await prepareGlobalSkills(join(f.root, "data"), selection, f.env))
        ?.digest,
      first.digest,
    );
    chmodSync(script, 0o744);
    const modeChanged = await prepareGlobalSkills(
      join(f.root, "data"),
      selection,
      f.env,
    );
    assert.notEqual(modeChanged?.digest, first.digest);
    chmodSync(script, 0o644);
    const second = await prepareGlobalSkills(
      join(f.root, "data"),
      selection,
      f.env,
    );
    assert.notEqual(second?.digest, first.digest);
  } finally {
    process.umask(oldMask);
  }
});

test("an unreadable skill is listed unavailable and cannot be selected", {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  const skill = join(source, "SKILL.md");
  chmodSync(skill, 0);
  try {
    assert.deepEqual(await listGlobalSkills(f.env), {
      status: "available",
      skills: [{ name: "chosen", available: false }],
    });
    await assert.rejects(
      inspectGlobalSkills({ plugins: [], global: ["chosen"] }, f.env),
    );
  } finally {
    chmodSync(skill, 0o600);
  }
});

test("the adapter manifest name is reserved only while normalized global selections remain", async (t) => {
  const f = fixture(t);
  f.skill(join(f.skills, "chosen"), "chosen");
  const plugin = writeSkillPlugin(
    join(f.root, "plugin"),
    ["a"],
    "cab-global-skills",
  );
  const plugins = [{ path: plugin, skills: ["a"] }];
  assert.deepEqual(await inspectGlobalSkills({ plugins }, f.env), {
    skills: [],
  });
  await assert.rejects(
    inspectGlobalSkills({ plugins, global: ["chosen"] }, f.env),
    /reserve plugin name cab-global-skills/,
  );
});

test("contained resource links are materialized and depth and byte limits cover the whole adapter", async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  writeFileSync(join(source, "answer"), "answer");
  symlinkSync("answer", join(source, "linked-answer"));
  let deep = source;
  for (let i = 0; i < 12; i++) {
    deep = join(deep, "d");
    mkdirSync(deep);
  }
  writeFileSync(join(deep, "resource"), "deep");
  const selection = { plugins: [], global: ["chosen"] };
  const prepared = await prepareGlobalSkills(
    join(f.root, "data"),
    selection,
    f.env,
  );
  assert.ok(prepared);
  assert.equal(
    readFileSync(join(prepared.path, "skills/chosen/linked-answer"), "utf8"),
    "answer",
  );
  mkdirSync(join(deep, "too-deep"));
  await assert.rejects(inspectGlobalSkills(selection, f.env), /too deep/);
  rmSync(join(source, "d"), { recursive: true });
  writeFileSync(join(source, "big"), Buffer.alloc(9 * 1024 * 1024));
  const other = f.skill(join(f.skills, "other"), "other");
  writeFileSync(join(other, "big"), Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(
    inspectGlobalSkills({ plugins: [], global: ["chosen", "other"] }, f.env),
    /too large/,
  );
});

test("files changing during inspection are refused before an adapter is published", async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  const resource = join(source, "resource");
  writeFileSync(resource, Buffer.alloc(8 * 1024 * 1024));
  const handle = openSync(resource, "r+");
  let counter = 0;
  const writer = setInterval(
    () => writeSync(handle, Buffer.from([++counter % 256]), 0, 1, 0),
    1,
  );
  try {
    await assert.rejects(
      prepareGlobalSkills(
        join(f.root, "data"),
        { plugins: [], global: ["chosen"] },
        f.env,
      ),
      /changed while it was read/,
    );
    assert.equal(existsSync(join(f.root, "data")), false);
  } finally {
    clearInterval(writer);
    closeSync(handle);
  }
});

test("discovery marks an unsafe resource tree unavailable without materializing it", async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  writeFileSync(join(f.root, "outside"), "outside");
  symlinkSync(join(f.root, "outside"), join(source, "resource"));
  assert.deepEqual(await listGlobalSkills(f.env), {
    status: "available",
    skills: [{ name: "chosen", available: false }],
  });
  assert.equal(existsSync(join(f.root, "data")), false);
});

test("discovery refuses an unreadable relative resource", {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const f = fixture(t);
  const source = f.skill(join(f.skills, "chosen"), "chosen");
  const resource = join(source, "resource");
  writeFileSync(resource, "private");
  chmodSync(resource, 0);
  try {
    assert.deepEqual(await listGlobalSkills(f.env), {
      status: "available",
      skills: [{ name: "chosen", available: false }],
    });
  } finally {
    chmodSync(resource, 0o600);
  }
});

test("cached bytes, file modes and entry links are verified before reuse", async (t) => {
  for (const kind of ["bytes", "mode", "entry-link"] as const)
    await t.test(kind, async (t) => {
      const f = fixture(t);
      f.skill(join(f.skills, "chosen"), "chosen");
      const selection = { plugins: [], global: ["chosen"] };
      const data = join(f.root, "data");
      const cached = await prepareGlobalSkills(data, selection, f.env);
      assert.ok(cached);
      const file = join(cached.path, "skills/chosen/SKILL.md");
      if (kind === "bytes") writeFileSync(file, "corrupt");
      if (kind === "mode") chmodSync(file, 0o644);
      if (kind === "entry-link") {
        rmSync(cached.path, { recursive: true });
        const outside = join(f.root, "outside");
        mkdirSync(outside);
        symlinkSync(outside, cached.path);
      }
      await assert.rejects(prepareGlobalSkills(data, selection, f.env));
    });
});

test("two selected names cannot alias the same underlying skill file", async (t) => {
  const f = fixture(t);
  const first = f.skill(join(f.skills, "one"), "one");
  writeFileSync(join(first, "SKILL.md"), "fallback instructions");
  mkdirSync(join(f.skills, "two"));
  linkSync(join(first, "SKILL.md"), join(f.skills, "two", "SKILL.md"));
  assert.deepEqual(
    await inspectGlobalSkills({ plugins: [], global: ["one"] }, f.env),
    { skills: ["one"] },
  );
  await assert.rejects(
    inspectGlobalSkills({ plugins: [], global: ["one", "two"] }, f.env),
    /ambiguous/,
  );
});

test("cached hard-link aliases are unsafe for reuse", async (t) => {
  const f = fixture(t);
  f.skill(join(f.skills, "chosen"), "chosen");
  const selection = { plugins: [], global: ["chosen"] };
  const data = join(f.root, "data");
  const cached = await prepareGlobalSkills(data, selection, f.env);
  assert.ok(cached);
  linkSync(join(cached.path, "skills/chosen/SKILL.md"), join(f.root, "alias"));
  await assert.rejects(
    prepareGlobalSkills(data, selection, f.env),
    /cache is unsafe/,
  );
});
