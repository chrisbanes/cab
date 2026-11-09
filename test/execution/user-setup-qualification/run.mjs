import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  assertAttemptAvailable,
  beginAttempt,
  gatedInput,
  PLAN,
  readGrant,
  reserveTurn,
  saveGrant,
  TURN_MS,
} from "./grant.mjs";

const prompt =
  "This is a read-only qualification, not implementation. Use the cab-native-proof skill, call the native_fixture native_mark MCP tool, then call cab_bound_probe. Include the fixture instruction word and the skill proof word in your final answer. Do not call other tools or follow configuration setup suggestions. Remember NATIVE_RESUME_1569 for the next message.";

const directory = dirname(fileURLToPath(import.meta.url));
async function main(args) {
  if (args.length === 1 && args[0] === "--init-grant") {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-user-setup-")));
    const path = join(root, "grant.json");
    saveGrant(path, {
      plan: PLAN,
      limit: 12,
      perHarness: 6,
      attempts: [],
      turns: [],
      root,
    });
    console.log(path);
  } else if (
    args.length === 2 &&
    ["--diagnose-claude", "--diagnose-codex"].includes(args[0])
  ) {
    const path = resolve(args[1]);
    const grant = readGrant(path);
    const harness = args[0].endsWith("codex") ? "codex" : "claude";
    assert.equal(
      grant.attempts.find((a) => a.harness === harness && a.facet === "native")
        ?.state,
      "failed",
    );
    const fx = {
      cwd: join(grant.root, harness),
      marker: join(grant.root, harness, "mcp-calls.txt"),
    };
    try {
      if (harness === "codex") await codexNative(path, environment(), fx, true);
      else await claudeNative(path, environment(), fx, true);
    } catch (error) {
      writeFileSync(
        join(grant.root, `${harness}-diagnosis-error.json`),
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack?.split("\n").slice(0, 6),
        }),
        { mode: 0o600 },
      );
      console.error("Model-free diagnostic retained; no prompt admitted");
      process.exitCode = 1;
    }
  } else if (
    (args.length === 4 ||
      (args.length === 5 && args[4] === "--harness=codex")) &&
    args[0] === "--live" &&
    args[1] === "--facet=native" &&
    args[2] === "--grant-file"
  ) {
    await native(resolve(args[3]), args[4] ? ["codex"] : ["claude", "codex"]);
  } else if (
    (args.length === 4 ||
      (args.length === 5 && args[4] === "--harness=claude")) &&
    args[0] === "--live" &&
    args[1] === "--facet=lifecycle" &&
    args[2] === "--grant-file"
  ) {
    const { lifecycle } = await import("./lifecycle.mjs");
    await lifecycle(
      resolve(args[3]),
      args[4] ? ["claude"] : ["claude", "codex"],
    );
  } else {
    console.error(
      "Use --init-grant, or --live --facet=native --grant-file <printed-path>",
    );
    process.exitCode = 2;
  }
}

function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/KEY|SECRET|TOKEN|PASSWORD|^CLAUDECODE$/.test(key)) delete env[key];
  return env;
}

export function fixture(root, harness) {
  const cwd = join(root, harness);
  mkdirSync(cwd, { recursive: true });
  const skill = join(
    cwd,
    harness === "claude" ? ".claude" : ".agents",
    "skills",
    "cab-native-proof",
  );
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: cab-native-proof\ndescription: Harmless native configuration qualification. Use only when explicitly requested.\n---\nThe native skill proof word is SKILL_NATIVE_1569. Include it in the final answer. Do not run scripts.\n",
  );
  const instructions =
    "For the cab native setup fixture, include INSTRUCTIONS_NATIVE_1569 in the final answer.\n";
  writeFileSync(join(cwd, "AGENTS.md"), instructions);
  writeFileSync(join(cwd, "CLAUDE.md"), instructions);
  const marker = join(cwd, "mcp-calls.txt");
  const server = (label) => ({
    command: process.execPath,
    args: [join(directory, "mcp.mjs"), marker, label],
  });
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        native_fixture: server("NATIVE_MCP_1569"),
      },
    }),
  );
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({
      enableAllProjectMcpServers: true,
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `"${process.execPath}" -e "require('fs').writeFileSync('hook-ran','native')"`,
              },
            ],
          },
        ],
      },
    }),
  );
  mkdirSync(join(cwd, ".codex"), { recursive: true });
  writeFileSync(
    join(cwd, ".codex", "config.toml"),
    ["native_fixture"]
      .map((name) => {
        const definition = server(
          name === "cab" ? "COLLISION_1569" : "NATIVE_MCP_1569",
        );
        return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(definition.command)}\nargs = ${JSON.stringify(definition.args)}\n[mcp_servers.${name}.tools.native_mark]\napproval_mode = "approve"\n`;
      })
      .join("\n"),
  );
  return { cwd, marker };
}

async function native(path, harnesses) {
  const grant = readGrant(path);
  assert.equal(join(realpathSync(grant.root), "grant.json"), path);
  for (const harness of harnesses) {
    const last = grant.attempts
      .filter((a) => a.harness === harness && a.facet === "native")
      .at(-1);
    if (last?.state !== "passed")
      assertAttemptAvailable(grant, harness, "native");
  }
  const env = environment();
  // A status check does not consume a model turn or an attempt.
  const auth = spawnSync("claude", ["auth", "status", "--json"], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(
    auth.status,
    0,
    "Native Claude authentication unavailable; no live attempt started",
  );
  const account = JSON.parse(auth.stdout);
  assert.equal(account.authMethod, "claude.ai");
  assert.equal(account.apiProvider, "firstParty");
  const codex = spawnSync("codex", ["login", "status"], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.ok(
    codex.status === 0 && `${codex.stdout}${codex.stderr}`.includes("ChatGPT"),
    "Native Codex subscription login unavailable",
  );
  for (const harness of harnesses) {
    const previous = readGrant(path).attempts.filter(
      (a) => a.harness === harness && a.facet === "native",
    );
    if (previous.at(-1)?.state === "passed") continue;
    assertAttemptAvailable(readGrant(path), harness, "native");
    for (const name of [".mcp.json", ".codex/config.toml"]) {
      const old = join(grant.root, harness, name);
      const copy = join(
        grant.root,
        `${harness}-attempt${previous.length}-${name.replaceAll("/", "-")}`,
      );
      if (existsSync(old) && !existsSync(copy))
        writeFileSync(copy, readFileSync(old), { mode: 0o600, flag: "wx" });
    }
    const fx = fixture(grant.root, harness);
    fx.evidencePath = join(
      grant.root,
      `${harness}-native-attempt${previous.length + 1}.json`,
    );
    if (harness === "codex" && previous.length) {
      const retained = JSON.parse(
        readFileSync(join(grant.root, "codex-native.json"), "utf8"),
      );
      assert.match(retained.threadId, /^[0-9a-f-]{36}$/);
      assert.ok(
        retained.observations.some(
          (o) =>
            o.index === 0 &&
            o.status === "completed" &&
            o.instructionSeen &&
            o.skillSeen,
        ),
      );
      fx.resumeThreadId = retained.threadId;
    }
    const inputPaths = [
      join(directory, "run.mjs"),
      join(directory, "grant.mjs"),
      join(directory, "mcp.mjs"),
      join(fx.cwd, "AGENTS.md"),
      join(fx.cwd, "CLAUDE.md"),
      join(fx.cwd, ".mcp.json"),
      join(fx.cwd, ".codex/config.toml"),
    ];
    writeFileSync(
      join(
        grant.root,
        `${harness}-native-attempt${previous.length + 1}-inputs.json`,
      ),
      JSON.stringify(
        inputPaths.map((p) => ({
          path: p,
          sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
        })),
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    try {
      if (harness === "claude") await claudeNative(path, env, fx);
      else await codexNative(path, env, fx);
      const next = readGrant(path);
      next.attempts.findLast(
        (a) => a.harness === harness && a.facet === "native",
      ).state = "passed";
      saveGrant(path, next);
      console.log(`${harness}: native proof passed`);
    } catch (error) {
      const next = readGrant(path);
      const active = next.attempts.findLast(
        (a) => a.harness === harness && a.facet === "native",
      );
      if (active) active.state = "failed";
      saveGrant(path, next);
      writeFileSync(
        join(
          grant.root,
          `${harness}-failure-attempt${previous.length + 1}.json`,
        ),
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack?.split("\n").slice(0, 5),
        }),
        { mode: 0o600 },
      );
      // Runtime diagnostics may contain private configuration. Export only our assertion.
      console.error(
        `${harness}: native proof stopped (${error instanceof assert.AssertionError ? error.message.split("\n")[0] : "runtime failure"}); see owned evidence and grant`,
      );
      process.exitCode = 1;
      return;
    }
  }
}

async function claudeNative(path, env, fx, diagnostic = false) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  let calls = 0;
  let session;
  const observations = [];
  if (!diagnostic) beginAttempt(path, "claude", "native");
  for (let index = 0; index < (diagnostic ? 1 : 2); index++) {
    const input = gatedInput({
      type: "user",
      message: {
        role: "user",
        content:
          index === 0
            ? prompt
            : "Recall the remembered NATIVE_RESUME code and call cab_bound_probe once. Do nothing else.",
      },
      parent_tool_use_id: null,
      session_id: session ?? "",
    });
    const server = sdk.createSdkMcpServer({
      name: "cab",
      tools: [
        sdk.tool(
          "cab_bound_probe",
          "Record cab's harmless bound callback.",
          {},
          async () => {
            calls++;
            return { content: [{ type: "text", text: "CAB_BOUND_1569" }] };
          },
        ),
      ],
    });
    let child;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_MS);
    let query;
    try {
      query = sdk.query({
        prompt: input.prompt(),
        options: {
          cwd: fx.cwd,
          pathToClaudeCodeExecutable: "/opt/homebrew/bin/claude",
          env,
          ...(session ? { resume: session } : {}),
          permissionMode: "dontAsk",
          tools: ["Read", "Skill"],
          allowedTools: [
            "Read",
            "Skill",
            "mcp__native_fixture__*",
            "mcp__cab__cab_bound_probe",
          ],
          disallowedTools: ["Agent", "Task", "AskUserQuestion"],
          mcpServers: { cab: server },
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: [] },
            filesystem: { allowWrite: [fx.cwd] },
          },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              "Follow the qualification request only. Never change user configuration or perform external actions.",
          },
          abortController: controller,
          stderr: () => {},
          spawnClaudeCodeProcess: (options) => {
            child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              stdio: ["pipe", "pipe", "pipe"],
              signal: options.signal,
            });
            return child;
          },
        },
      });
      const initialized = await query.initializationResult();
      const commands = await query.supportedCommands();
      const servers = await query.mcpServerStatus();
      observations.push({
        index,
        commandCount: commands.length,
        fixtureSkill: commands.some((c) => c.name === "cab-native-proof"),
        servers: servers
          .filter((s) => ["cab", "native_fixture"].includes(s.name))
          .map((s) => ({ name: s.name, status: s.status, source: s.source })),
        hooksApplied: initialized.hooks_applied,
      });
      assert.ok(
        commands.some((c) => c.name === "cab-native-proof"),
        "Native fixture skill not discovered",
      );
      assert.ok(
        servers.some(
          (s) => s.name === "native_fixture" && s.status === "connected",
        ),
        "Native fixture MCP did not connect",
      );
      assert.ok(
        servers.some(
          (s) =>
            s.name === "cab" && s.status === "connected" && s.source === "sdk",
        ),
        "cab SDK provenance unavailable or collision replaced endpoint",
      );
      if (diagnostic) return;
      reserveTurn(path, "claude", "native");
      input.admit();
      let result;
      for await (const message of query) {
        if (message.type === "system" && message.subtype === "init")
          session = message.session_id;
        if (message.type === "result") result = message;
      }
      assert.equal(result?.is_error, false, "Native Claude turn failed");
      const text = result?.result ?? "";
      observations.push({
        index,
        result: result.subtype,
        instructionSeen: text.includes("INSTRUCTIONS_NATIVE_1569"),
        skillSeen: text.includes("SKILL_NATIVE_1569"),
        resumeSeen: text.includes("NATIVE_RESUME_1569"),
        boundCalls: calls,
      });
      if (index === 0) {
        assert.ok(
          text.includes("INSTRUCTIONS_NATIVE_1569") &&
            text.includes("SKILL_NATIVE_1569"),
          "Native instruction/skill proof missing",
        );
        assert.ok(
          existsSync(join(fx.cwd, "hook-ran")),
          "Native project hook did not run",
        );
        assert.ok(
          readFileSync(fx.marker, "utf8").includes("NATIVE_MCP_1569"),
          "Inherited MCP not called",
        );
        assert.ok(
          !readFileSync(fx.marker, "utf8").includes("COLLISION_1569"),
          "Colliding configured MCP ran",
        );
      } else
        assert.ok(
          text.includes("NATIVE_RESUME_1569"),
          "Native resume lost context",
        );
      assert.equal(calls, index + 1, "Bound cab callback missing");
    } catch (error) {
      observations.push({
        errorName: error.name,
        errorMessage: error.message,
        stack: error.stack?.split("\n").slice(0, 5),
      });
      throw error;
    } finally {
      clearTimeout(timer);
      input.close();
      query?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        await Promise.race([
          exit,
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        assert.ok(
          child.exitCode !== null || child.signalCode !== null,
          "Owned Claude process did not exit after close",
        );
      }
      writeFileSync(
        fx.evidencePath ?? join(dirname(path), "claude-native.json"),
        `${JSON.stringify({ session, calls, observations }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  }
}

async function codexNative(path, env, fx, diagnostic = false) {
  const events = new EventEmitter();
  const pending = new Map();
  const observations = [];
  const texts = [];
  let calls = 0;
  let sequence = 0;
  let threadId;
  const definitions = [
    {
      name: "cab_bound_probe",
      description: "Record cab's harmless bound callback.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  const child = spawn(
    "codex",
    [
      "app-server",
      "--stdio",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=workspace-write",
      "-c",
      "features.multi_agent=false",
      "-c",
      `projects.${JSON.stringify(fx.cwd)}.trust_level="trusted"`,
    ],
    { cwd: fx.cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex request timed out"));
      }, TURN_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  child.on("error", () => {
    for (const p of pending.values())
      p.reject(new Error("Codex process failed"));
    pending.clear();
  });
  child.on("exit", () => {
    for (const p of pending.values())
      p.reject(new Error("Codex process exited"));
    pending.clear();
    events.emit("closed");
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      events.emit("protocol-failure");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) p?.reject(new Error("Codex RPC failed"));
      else p?.resolve(message.result);
    } else if (
      message.method === "item/tool/call" &&
      message.id !== undefined
    ) {
      const authorized =
        message.params.tool === "cab_bound_probe" &&
        message.params.threadId === threadId;
      if (authorized) calls++;
      send({
        id: message.id,
        result: {
          success: authorized,
          contentItems: [
            {
              type: "inputText",
              text: authorized ? "CAB_BOUND_1569" : "Denied",
            },
          ],
        },
      });
    } else if (message.id !== undefined)
      send({
        id: message.id,
        error: { code: -32601, message: "No additional authority" },
      });
    else if (
      message.method === "item/completed" &&
      message.params.item?.type === "agentMessage"
    )
      texts.push(message.params.item.text);
    else if (message.method === "turn/completed")
      events.emit("terminal", message.params.turn);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "cab_user_setup_proof", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    const account = await request("account/read", { refreshToken: false });
    assert.equal(
      account.account?.type,
      "chatgpt",
      "Codex native account is not a subscription",
    );
    const config = await request("config/read", {
      cwd: fx.cwd,
      includeLayers: true,
    });
    const nativeServers =
      config.config?.mcp_servers ?? config.config?.mcpServers ?? {};
    observations.push({
      fixtureMcpConfigured: "native_fixture" in nativeServers,
      serverNames: Object.keys(nativeServers),
    });
    if (diagnostic) return;
    assert.ok(
      "native_fixture" in nativeServers,
      "Codex native fixture MCP not present in effective configuration",
    );
    const listed = await request("skills/list", { cwds: [fx.cwd] });
    const skills = listed.data.flatMap((entry) => entry.skills);
    assert.ok(
      skills.some((s) => s.name === "cab-native-proof"),
      "Codex native project skill not discovered",
    );
    observations.push({ fixtureSkill: true, nativeSkillCount: skills.length });
    beginAttempt(path, "codex", "native");
    if (fx.resumeThreadId) {
      const retained = await request("thread/read", {
        threadId: fx.resumeThreadId,
        includeTurns: false,
      });
      assert.equal(
        retained.thread.cwd,
        fx.cwd,
        "Retained proof thread belongs to another workspace",
      );
    }
    const thread = await request(
      fx.resumeThreadId ? "thread/resume" : "thread/start",
      {
        ...(fx.resumeThreadId ? { threadId: fx.resumeThreadId } : {}),
        cwd: fx.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        dynamicTools: definitions,
        ephemeral: false,
      },
    );
    threadId = thread.thread.id;
    const firstIndex = fx.resumeThreadId ? 1 : 0;
    for (let index = firstIndex; index < 2; index++) {
      if (index > firstIndex) {
        await request("thread/unsubscribe", { threadId });
        await request("thread/resume", {
          threadId,
          cwd: fx.cwd,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          dynamicTools: definitions,
        });
      }
      reserveTurn(path, "codex", "native");
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          events.removeListener("terminal", terminal);
          reject(new Error("Codex turn timed out"));
        }, TURN_MS);
        const terminal = (turn) => {
          clearTimeout(timer);
          resolve(turn);
        };
        events.once("terminal", terminal);
      });
      const previousText = texts.length;
      await request("turn/start", {
        threadId,
        cwd: fx.cwd,
        input: [
          {
            type: "text",
            text:
              index === 0
                ? prompt
                : "Recall the remembered NATIVE_RESUME code, call native_fixture native_mark and cab_bound_probe once, then reply with their results. Do nothing else.",
          },
        ],
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [fx.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      const result = await done;
      assert.equal(
        result.status,
        "completed",
        "Native Codex turn did not complete",
      );
      const text = texts.slice(previousText).join("\n");
      observations.push({
        index,
        status: result.status,
        instructionSeen: text.includes("INSTRUCTIONS_NATIVE_1569"),
        skillSeen: text.includes("SKILL_NATIVE_1569"),
        resumeSeen: text.includes("NATIVE_RESUME_1569"),
        boundCalls: calls,
      });
      if (index === 0) {
        assert.ok(
          text.includes("INSTRUCTIONS_NATIVE_1569") &&
            text.includes("SKILL_NATIVE_1569"),
          "Native Codex instruction/skill proof missing",
        );
        assert.ok(
          readFileSync(fx.marker, "utf8").includes("NATIVE_MCP_1569"),
          "Codex inherited MCP not called",
        );
      } else
        assert.ok(
          text.includes("NATIVE_RESUME_1569"),
          "Codex native resume lost context",
        );
      assert.ok(
        readFileSync(fx.marker, "utf8").includes("NATIVE_MCP_1569"),
        "Codex inherited MCP not called",
      );
      assert.equal(
        calls,
        index - firstIndex + 1,
        "Codex bound callback missing",
      );
    }
  } finally {
    writeFileSync(
      diagnostic
        ? join(dirname(path), "codex-preflight.json")
        : (fx.evidencePath ?? join(dirname(path), "codex-native.json")),
      `${JSON.stringify({ threadId, calls, observations }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.stdin.end();
      await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "Owned Codex process did not exit after stdin close",
      );
    }
    lines.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2));
