import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CodexRuntime } from "../../src/standalone/codex.js";
import { codexHomeFor } from "../fixtures/legacy-harness/codex-home.js";
import { PreviousHarnessHomeError } from "../../src/standalone/runtime-retention.js";
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
    runtime: () =>
      new CodexRuntime(executable, {
        safety: runtimeSafetyFixture().safety,
        spawnEnvironment: () => ({ ...environment }),
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("Codex preserves native homes and credential storage while keeping explicit execution controls", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    await runtime.start();
    const seen = f.report();
    assert.equal(seen.codexHome, f.environment.CODEX_HOME);
    assert.equal(seen.home, f.environment.HOME);
    assert.ok(seen.argv.includes("approval_policy=never"));
    assert.ok(seen.argv.includes("sandbox_mode=workspace-write"));
    assert.ok(seen.argv.includes("features.multi_agent=false"));
    for (const retired of [
      "cli_auth_credentials_store=file",
      "features.plugins=false",
      "features.skill_mcp_dependency_install=false",
    ])
      assert.ok(!seen.argv.includes(retired));
    assert.equal(readFileSync(f.operatorAuth, "utf8"), f.loginContents);
    assert.equal(existsSync(f.codex.home), false);
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("native resume refuses legacy and unknown origins before issuing any request", async () => {
  const f = fixture();
  const { safety } = runtimeSafetyFixture();
  safety.registerThreadTools("legacy", "e".repeat(64));
  const runtime = new CodexRuntime(f.executable, {
    safety: {
      ...safety,
      threadQualification(id) {
        const row = safety.threadQualification(id);
        return id === "legacy" && row ? { ...row, codexHome: "cab" } : row;
      },
    },
    spawnEnvironment: () => ({ ...f.environment }),
  });
  try {
    await runtime.start();
    const started = await runtime.startThread(f.root);
    assert.equal(safety.threadQualification(started)?.codexHome, "native");
    for (const id of ["legacy", "unknown"])
      await assert.rejects(runtime.resumeThread(id), PreviousHarnessHomeError);
    assert.ok(!f.requests().includes("thread/resume"));
    await runtime.resumeThread(started);
    assert.equal(f.requests().filter((m) => m === "thread/resume").length, 1);
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});
