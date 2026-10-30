import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CodexRuntime } from "../../src/standalone/codex.js";
import {
  codexHomeFor,
  codexLoginLink,
  PreviousCodexHomeError,
} from "../../src/standalone/codex-home.js";
import {
  closeRuntimeSafetyFixtures,
  runtimeSafetyFixture,
} from "../fixtures/runtime-safety.js";

afterEach(closeRuntimeSafetyFixtures);

/** A stand-in App Server that records its argv, isolation variables and requests, never its login. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cab-codex-home-"));
  const operatorCodex = join(root, "operator", ".codex");
  mkdirSync(operatorCodex, { recursive: true });
  const operatorAuth = join(operatorCodex, "auth.json");
  const loginContents = '{"fake":"login"}';
  writeFileSync(operatorAuth, loginContents, { mode: 0o600 });
  const report = join(root, "report.json");
  const requests = join(root, "requests.log");
  const executable = join(root, "codex.mjs");
  writeFileSync(
    executable,
    `#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync,writeFileSync}from'node:fs';
if(process.argv[2]!=='app-server')process.exit(0);
writeFileSync(${JSON.stringify(report)},JSON.stringify({argv:process.argv.slice(2),codexHome:process.env.CODEX_HOME,home:process.env.HOME}));
let next=0;
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(${JSON.stringify(requests)},m.method+'\\n');
let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='config/read')result={config:{approval_policy:'never',sandbox_mode:'workspace-write'}};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId??'started-'+(next++)},approvalPolicy:'never',sandbox:{type:'workspaceWrite'}};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}`,
  );
  chmodSync(executable, 0o700);
  const codex = codexHomeFor(join(root, "data"));
  const environment = {
    PATH: process.env.PATH,
    HOME: join(root, "operator"),
    CODEX_HOME: operatorCodex,
  };
  return {
    root,
    operatorAuth,
    loginContents,
    codex,
    environment,
    executable,
    requests: () => {
      try {
        return readFileSync(requests, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
    report: () => JSON.parse(readFileSync(report, "utf8")),
    runtime: (options: { codex?: boolean } = { codex: true }) =>
      new CodexRuntime(executable, {
        safety: runtimeSafetyFixture().safety,
        ...(options.codex ? { codex } : {}),
        spawnEnvironment: () => ({ ...environment }),
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("Codex runs under cab's home, links the operator login and keeps agent shells on the real HOME", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    await runtime.start();
    const seen = f.report();
    assert.equal(seen.codexHome, f.codex.home);
    assert.equal(seen.home, f.codex.userHome);
    for (const override of [
      "cli_auth_credentials_store=file",
      "features.multi_agent=false",
      "features.plugins=false",
      "features.skill_mcp_dependency_install=false",
      `shell_environment_policy.set.HOME=${JSON.stringify(f.environment.HOME)}`,
    ])
      assert.ok(seen.argv.includes(override), override);
    const link = join(f.codex.home, "auth.json");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), f.operatorAuth);
    assert.equal(lstatSync(f.codex.home).mode & 0o777, 0o700);
    assert.equal(lstatSync(f.codex.userHome).mode & 0o777, 0o700);
    assert.equal(readFileSync(f.operatorAuth, "utf8"), f.loginContents);
    assert.equal(await codexLoginLink(f.codex, f.environment), "ok");
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("a replaced login link makes Codex unavailable and is never overwritten or copied", async () => {
  const f = fixture();
  try {
    mkdirSync(f.codex.home, { recursive: true });
    const link = join(f.codex.home, "auth.json");
    writeFileSync(link, "regular", { mode: 0o600 });
    await assert.rejects(f.runtime().start(), /was replaced/);
    assert.equal(readFileSync(link, "utf8"), "regular");
    assert.equal(await codexLoginLink(f.codex, f.environment), "replaced");

    rmSync(link);
    symlinkSync(join(f.root, "elsewhere"), link);
    await assert.rejects(f.runtime().start(), /was replaced/);
    assert.equal(readlinkSync(link), join(f.root, "elsewhere"));
    assert.equal(readFileSync(f.operatorAuth, "utf8"), f.loginContents);
    assert.deepEqual(f.requests(), []);
  } finally {
    f.cleanup();
  }
});

test("the login link state reports a missing target without reading it", async () => {
  const f = fixture();
  try {
    assert.equal(await codexLoginLink(f.codex, f.environment), "unlinked");
    mkdirSync(f.codex.home, { recursive: true });
    symlinkSync(f.operatorAuth, join(f.codex.home, "auth.json"));
    assert.equal(await codexLoginLink(f.codex, f.environment), "ok");
    rmSync(f.operatorAuth);
    assert.equal(
      await codexLoginLink(f.codex, f.environment),
      "missing-target",
    );
  } finally {
    f.cleanup();
  }
});

test("resume is refused before any request for a thread started under the previous home", async () => {
  const f = fixture();
  const { safety } = runtimeSafetyFixture();
  // `old` has a row from before the marker existed; `unrecorded` has no row at all.
  safety.registerThreadTools("old", "e".repeat(64));
  const runtime = new CodexRuntime(f.executable, {
    safety: {
      ...safety,
      threadQualification: (threadId) => {
        const row = safety.threadQualification(threadId);
        return threadId === "old" && row ? { ...row, codexHome: null } : row;
      },
    },
    codex: f.codex,
    spawnEnvironment: () => ({ ...f.environment }),
  });
  try {
    await runtime.start();
    const started = await runtime.startThread(f.root);
    for (const threadId of ["old", "unrecorded"]) {
      await assert.rejects(runtime.resumeThread(threadId), (error) => {
        assert.ok(error instanceof PreviousCodexHomeError);
        assert.equal(
          error.message,
          "Started under the previous Codex home; restart the task",
        );
        return true;
      });
    }
    assert.ok(!f.requests().includes("thread/resume"));
    await runtime.resumeThread(started);
    assert.equal(f.requests().filter((m) => m === "thread/resume").length, 1);
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("without cab's home configured, Codex runs as before", async () => {
  const f = fixture();
  const runtime = f.runtime({});
  try {
    await runtime.start();
    const seen = f.report();
    assert.equal(seen.codexHome, f.environment.CODEX_HOME);
    assert.equal(seen.home, f.environment.HOME);
    assert.ok(!seen.argv.includes("features.multi_agent=false"));
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});
