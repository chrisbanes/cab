import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CodexRuntime } from "../../src/standalone/codex.js";
import { codexHomeFor } from "../../src/standalone/codex-home.js";
import { SkillScopeError } from "../../src/standalone/codex-skills.js";
import {
  closeRuntimeSafetyFixtures,
  runtimeSafetyFixture,
} from "../fixtures/runtime-safety.js";
import { writeSkillPlugin } from "../fixtures/skill-plugin.js";

afterEach(closeRuntimeSafetyFixtures);

type Request = { method: string; params: Record<string, unknown> };

/** A stand-in App Server that records every request and lists the skills the test gives it. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-codex-skills-")));
  const operatorCodex = join(root, "operator", ".codex");
  mkdirSync(operatorCodex, { recursive: true });
  writeFileSync(join(operatorCodex, "auth.json"), "{}", { mode: 0o600 });
  const requests = join(root, "requests.jsonl");
  const listing = join(root, "skills.json");
  writeFileSync(listing, "[]");
  const executable = join(root, "codex.mjs");
  writeFileSync(
    executable,
    `#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync,readFileSync}from'node:fs';
if(process.argv[2]!=='app-server')process.exit(0);
let next=0;
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(${JSON.stringify(requests)},JSON.stringify({method:m.method,params:m.params})+'\\n');
let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='config/read')result={config:{approval_policy:'never',sandbox_mode:'workspace-write'}};
if(m.method==='thread/unsubscribe')result={status:'unsubscribed'};
if(m.method==='skills/list')result={data:[{cwd:m.params.cwds[0],skills:JSON.parse(readFileSync(${JSON.stringify(listing)},'utf8')),errors:[]}]};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId??'started-'+(next++)},approvalPolicy:'never',sandbox:{type:'workspaceWrite'}};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}`,
  );
  chmodSync(executable, 0o700);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const system = ["imagegen", "skill-creator"].map((name) => ({
    name,
    path: join(
      root,
      "data",
      "codex",
      "home",
      "skills",
      ".system",
      name,
      "SKILL.md",
    ),
    scope: "system",
  }));
  const plugin = (name: string, skills: string[]) =>
    writeSkillPlugin(join(root, name), skills, name);
  /** What App Server would list: the bundled skills plus every skill under the given plugins. */
  const list = (...plugins: string[]) =>
    writeFileSync(
      listing,
      JSON.stringify([
        ...system,
        ...plugins.flatMap((dir) =>
          ["probe-skill", "other-skill"].map((name) => ({
            name,
            path: join(dir, "skills", name, "SKILL.md"),
            scope: "user",
          })),
        ),
      ]),
    );
  return {
    root,
    workspace,
    system,
    plugin,
    list,
    sent: (): Request[] =>
      readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Request),
    runtime: () =>
      new CodexRuntime(executable, {
        safety: runtimeSafetyFixture().safety,
        codex: codexHomeFor(join(root, "data")),
        spawnEnvironment: () => ({
          PATH: process.env.PATH,
          HOME: join(root, "operator"),
          CODEX_HOME: operatorCodex,
        }),
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const disabledPaths = (request: Request | undefined) => {
  const config = request?.params.config as
    | { skills?: { config?: Array<{ path: string; enabled: boolean }> } }
    | undefined;
  const entries = config?.skills?.config ?? [];
  assert.ok(entries.every((entry) => entry.enabled === false));
  return entries.map((entry) => entry.path).sort();
};
const skillFile = (plugin: string, name: string) =>
  join(plugin, "skills", name, "SKILL.md");

const settings = (plugin: string, skills: string[]) => ({
  model: null,
  reasoningEffort: null,
  skills: { plugins: [{ path: plugin, skills }] },
});

test("a thread enabling one skill of a plugin disables the plugin's other skills and the bundled ones, on start and on resume", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const plugin = f.plugin("plugin-a", ["probe-skill", "other-skill"]);
    f.list(plugin);
    await runtime.start();
    const threadId = await runtime.startThread(
      f.workspace,
      [],
      settings(plugin, ["probe-skill"]),
    );
    const sent = f.sent();
    assert.deepEqual(
      sent.find((r) => r.method === "skills/extraRoots/set")?.params,
      { extraRoots: [join(plugin, "skills")] },
    );
    const expected = [
      skillFile(plugin, "other-skill"),
      ...f.system.map((s) => s.path),
    ].sort();
    assert.deepEqual(
      disabledPaths(sent.find((r) => r.method === "thread/start")),
      expected,
    );
    assert.ok(
      !disabledPaths(sent.find((r) => r.method === "thread/start")).includes(
        skillFile(plugin, "probe-skill"),
      ),
    );
    await runtime.resumeThread(
      threadId,
      [],
      settings(plugin, ["probe-skill"]),
      f.workspace,
    );
    assert.deepEqual(
      disabledPaths(f.sent().find((r) => r.method === "thread/resume")),
      expected,
    );
    // A loaded thread ignores config on resume, so it is unsubscribed first.
    const methods = f.sent().map((r) => r.method);
    const resumeAt = methods.indexOf("thread/resume");
    assert.equal(methods[resumeAt - 1], "thread/unsubscribe");
    assert.equal(f.sent()[resumeAt - 1]?.params.threadId, threadId);
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("threads of different profiles on one App Server see only their own plugins", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const a = f.plugin("plugin-a", ["probe-skill", "other-skill"]);
    const b = f.plugin("plugin-b", ["probe-skill", "other-skill"]);
    f.list(a);
    await runtime.start();
    await runtime.startThread(f.workspace, [], settings(a, ["probe-skill"]));
    f.list(a, b);
    await runtime.startThread(f.workspace, [], settings(b, ["other-skill"]));
    // A profile that enables none still never sees either plugin, and keeps the bundled skills.
    await runtime.startThread(f.workspace, []);
    const sent = f.sent();
    const roots = sent
      .filter((r) => r.method === "skills/extraRoots/set")
      .map((r) => r.params.extraRoots);
    assert.deepEqual(roots, [
      [join(a, "skills")],
      [join(a, "skills"), join(b, "skills")].sort(),
    ]);
    const starts = sent.filter((r) => r.method === "thread/start");
    const forB = disabledPaths(starts[1]);
    assert.ok(forB.includes(skillFile(b, "probe-skill")));
    assert.ok(!forB.includes(skillFile(b, "other-skill")));
    assert.ok(forB.includes(skillFile(a, "probe-skill")));
    assert.ok(forB.includes(skillFile(a, "other-skill")));
    assert.deepEqual(
      disabledPaths(starts[2]),
      [a, b]
        .flatMap((dir) =>
          ["probe-skill", "other-skill"].map((n) => skillFile(dir, n)),
        )
        .sort(),
    );
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("a profile without skills on a server that never loaded plugins sends no skills call and no skills config", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    await runtime.start();
    const threadId = await runtime.startThread(f.workspace, []);
    await runtime.resumeThread(threadId, [], undefined, f.workspace);
    const methods = f.sent().map((r) => r.method);
    assert.ok(!methods.includes("skills/extraRoots/set"));
    assert.ok(!methods.includes("skills/list"));
    assert.ok(!methods.includes("thread/unsubscribe"));
    for (const request of f.sent().filter((r) => /^thread\//.test(r.method)))
      assert.equal(request.params.config, undefined);
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("a restarted App Server gets the plugin roots again", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const plugin = f.plugin("plugin-a", ["probe-skill", "other-skill"]);
    f.list(plugin);
    await runtime.start();
    await runtime.startThread(
      f.workspace,
      [],
      settings(plugin, ["probe-skill"]),
    );
    await runtime.stop();
    await runtime.start();
    await runtime.startThread(
      f.workspace,
      [],
      settings(plugin, ["probe-skill"]),
    );
    assert.equal(
      f.sent().filter((r) => r.method === "skills/extraRoots/set").length,
      2,
    );
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("a thread resumed after another profile's plugin joined the process disables it too", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const a = f.plugin("plugin-a", ["probe-skill", "other-skill"]);
    const b = f.plugin("plugin-b", ["probe-skill", "other-skill"]);
    f.list(a);
    await runtime.start();
    const threadId = await runtime.startThread(
      f.workspace,
      [],
      settings(a, ["probe-skill"]),
    );
    f.list(a, b);
    await runtime.startThread(f.workspace, [], settings(b, ["probe-skill"]));
    await runtime.resumeThread(
      threadId,
      [],
      settings(a, ["probe-skill"]),
      f.workspace,
    );
    const resumed = disabledPaths(
      f.sent().find((r) => r.method === "thread/resume"),
    );
    for (const name of ["probe-skill", "other-skill"])
      assert.ok(resumed.includes(skillFile(b, name)), name);
    assert.ok(!resumed.includes(skillFile(a, "probe-skill")));
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("an enabled skill that Codex does not list stops the thread instead of running without it", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const plugin = f.plugin("plugin-a", ["probe-skill", "other-skill"]);
    f.list(); // App Server loads none of the plugin's skills
    await runtime.start();
    await assert.rejects(
      runtime.startThread(f.workspace, [], settings(plugin, ["probe-skill"])),
      /could not be loaded by Codex/,
    );
    assert.ok(!f.sent().some((r) => r.method === "thread/start"));
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("a plugin removed after admission stops the thread with a reason that names no path", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const plugin = f.plugin("plugin-a", ["probe-skill"]);
    rmSync(plugin, { recursive: true });
    await runtime.start();
    await assert.rejects(
      runtime.startThread(f.workspace, [], settings(plugin, ["probe-skill"])),
      (error: Error) =>
        error instanceof SkillScopeError && !error.message.includes(plugin),
    );
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

test("concurrent thread starts for different profiles each scope against one root set", async () => {
  const f = fixture();
  const runtime = f.runtime();
  try {
    const a = f.plugin("plugin-a", ["probe-skill", "other-skill"]);
    const b = f.plugin("plugin-b", ["probe-skill", "other-skill"]);
    f.list(a, b);
    await runtime.start();
    await Promise.all([
      runtime.startThread(f.workspace, [], settings(a, ["probe-skill"])),
      runtime.startThread(f.workspace, [], settings(b, ["probe-skill"])),
    ]);
    const scoped = f
      .sent()
      .map((r) => r.method)
      .filter((m) =>
        ["skills/extraRoots/set", "skills/list", "thread/start"].includes(m),
      );
    assert.deepEqual(scoped, [
      "skills/extraRoots/set",
      "skills/list",
      "thread/start",
      "skills/extraRoots/set",
      "skills/list",
      "thread/start",
    ]);
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});
