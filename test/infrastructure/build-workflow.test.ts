import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { tmpdir } from "../fixtures/temp.js";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const { scripts } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cab-build-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  return directory;
}

function npm(directory: string, task: string) {
  assert.ok(process.env.npm_execpath, "Run through the pinned npm process");
  return exec(process.execPath, [process.env.npm_execpath, "run", task], {
    cwd: directory,
    timeout: 15000,
  });
}

test("check overlaps independent tasks and waits for all of them before testing", async (t) => {
  const directory = await fixture(t);
  const tasks = ["build:service", "typecheck:web", "build:web", "check:style"];
  await writeFile(
    join(directory, "worker.mjs"),
    `import { existsSync, writeFileSync } from "node:fs";
const name = process.argv[2];
writeFileSync(name + ".ready", "");
const deadline = Date.now() + 5000;
while (!${JSON.stringify(tasks)}.every(task => existsSync(task + ".ready"))) {
  if (Date.now() > deadline) throw Error("Tasks did not overlap");
  await new Promise(resolve => setTimeout(resolve, 10));
}
writeFileSync(name + ".done", "");
`,
  );
  await writeFile(
    join(directory, "tests.mjs"),
    `import assert from "node:assert/strict";
import { existsSync } from "node:fs";
for (const task of ${JSON.stringify(tasks)}) assert.ok(existsSync(task + ".done"), task);
`,
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      scripts: {
        check: scripts.check,
        "check:static": scripts["check:static"],
        ...Object.fromEntries(
          tasks.map((task) => [task, `node worker.mjs ${task}`]),
        ),
        "typecheck:service": 'node -e "process.exit(99)"',
        "test:built": "node tests.mjs",
      },
    }),
  );
  await npm(directory, "check");
});

test("a failed static task fails check without starting tests", async (t) => {
  const directory = await fixture(t);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      scripts: {
        check: scripts.check,
        "check:static": scripts["check:static"],
        "build:service": 'node -e "process.exit(23)"',
        "typecheck:web": "node -e 0",
        "build:web": "node -e 0",
        "check:style": "node -e 0",
        "test:built":
          "node -e \"require('node:fs').writeFileSync('tested', '')\"",
      },
    }),
  );
  await assert.rejects(npm(directory, "check"), { code: 1 });
  await assert.rejects(readFile(join(directory, "tested")), { code: "ENOENT" });
});

test("incremental builds survive no-emit checks, type errors and deleting dist", async (t) => {
  const directory = await fixture(t);
  await cp(join(root, "tsconfig.json"), join(directory, "tsconfig.json"));
  await mkdir(join(directory, "src"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", scripts }),
  );
  const source = join(directory, "src/probe.ts");
  const output = join(directory, "dist/src/probe.js");
  await writeFile(source, 'export const value: string = "first";');
  await npm(directory, "typecheck:service");
  await assert.rejects(readFile(output), { code: "ENOENT" });
  await npm(directory, "build:service");
  assert.match(await readFile(output, "utf8"), /first/);
  await writeFile(source, "export const value: string = 123;");
  await assert.rejects(npm(directory, "build:service"), {
    code: 2,
    stdout: /TS2322/,
  });
  await assert.rejects(npm(directory, "typecheck:service"), {
    code: 1,
    stdout: /TS2322/,
  });
  await writeFile(source, 'export const value: string = "second";');
  await npm(directory, "typecheck:service");
  await npm(directory, "build:service");
  assert.match(await readFile(output, "utf8"), /second/);
  await rm(join(directory, "dist"), { recursive: true });
  await npm(directory, "build:service");
  assert.match(await readFile(output, "utf8"), /second/);
});
