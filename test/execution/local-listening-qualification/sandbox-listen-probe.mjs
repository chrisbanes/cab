// One bounded probe per harness setting: can a sandboxed command bind and serve on
// 127.0.0.1, bind 0.0.0.0, reach 1.1.1.1:443 and reach a loopback listener started
// outside the sandbox? Codex runs a fixed script through `codex sandbox` (no model) with
// network access off and on; Claude runs it through the pinned SDK with cab's sandbox
// options, without and with `allowLocalBinding`. Prints sanitised JSON; reads only
// CLAUDE_CODE_OAUTH_TOKEN from the environment, never operator data or ~/.env.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  !args.includes("--live") ||
  !args.includes("--one-attempt")
) {
  process.stderr.write(
    "Refusing live sandbox probes without exactly --live --one-attempt.\n",
  );
  process.exit(2);
}
const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!existsSync(codexExecutable) || !token) {
  process.stderr.write(
    "Refusing: the approved Codex launcher or CLAUDE_CODE_OAUTH_TOKEN is absent.\n",
  );
  process.exit(2);
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Each step records `ok` or its error code; the result goes to listen-result.json.
const listenScript = (
  outsidePort,
) => `import { createConnection, createServer } from "node:net";
import { writeFileSync } from "node:fs";
const steps = {};
const code = (error) => error?.code ?? String(error?.message ?? error);
const listen = (host) => new Promise((resolve, reject) => {
  const server = createServer((socket) => socket.end("x"));
  server.once("error", reject);
  server.listen(0, host, () => resolve(server));
});
const connect = (host, port, ms) => new Promise((resolve, reject) => {
  const socket = createConnection({ host, port });
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, ms);
  let data = "";
  socket.on("data", (chunk) => { data += chunk; });
  socket.once("connect", () => { if (port === 443) { clearTimeout(timer); socket.destroy(); resolve(""); } });
  socket.once("end", () => { clearTimeout(timer); resolve(data); });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
});
try {
  const server = await listen("127.0.0.1");
  steps.listenLoopback = "ok";
  try {
    steps.serveLoopback = (await connect("127.0.0.1", server.address().port, 4000)) === "x" ? "ok" : "no-data";
  } catch (error) { steps.serveLoopback = code(error); }
  server.close();
} catch (error) { steps.listenLoopback = code(error); }
try { (await listen("0.0.0.0")).close(); steps.listenAny = "ok"; } catch (error) { steps.listenAny = code(error); }
try { await connect("1.1.1.1", 443, 4000); steps.outbound = "ok"; } catch (error) { steps.outbound = code(error); }
try {
  steps.outsideLoopback = (await connect("127.0.0.1", ${outsidePort}, 4000)) === "x" ? "ok" : "no-data";
} catch (error) { steps.outsideLoopback = code(error); }
writeFileSync("listen-result.json", JSON.stringify(steps));
`;

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  codex: {
    launcherSha256: sha256(readFileSync(codexExecutable)),
    version: execFileSync(codexExecutable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  claude: {},
  cleanup: { fixtureRemoved: false },
  failure: null,
};

function fixture(root, label, outsidePort) {
  const workspace = join(root, label, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "listen.mjs"), listenScript(outsidePort));
  return { base: join(root, label), workspace };
}

function steps(f) {
  const path = join(f.workspace, "listen-result.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function codexCase(f, networkAccess) {
  const codexHome = join(f.base, "codex-home");
  mkdirSync(codexHome);
  const result = spawnSync(
    codexExecutable,
    [
      "sandbox",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      `sandbox_workspace_write.network_access=${networkAccess}`,
      "--",
      process.execPath,
      "listen.mjs",
    ],
    {
      cwd: f.workspace,
      env: { PATH: process.env.PATH, HOME: homedir(), CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return { exit: result.status, steps: steps(f) };
}

async function claudeCase(f, allowLocalBinding) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const pkg = JSON.parse(
    readFileSync(
      new URL(
        "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const executable = execFileSync("/usr/bin/which", ["claude"], {
    encoding: "utf8",
  }).trim();
  Object.assign(evidence.claude, {
    sdk: pkg.version,
    sdkDeclaredClaudeCode: pkg.claudeCodeVersion ?? null,
    installed: execFileSync(executable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  });
  const configDir = join(f.base, "claude-config");
  mkdirSync(configDir);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 180_000);
  let bashCalls = 0;
  let resultSubtype = null;
  try {
    for await (const message of sdk.query({
      prompt: `Use the Bash tool exactly once to run this command, then reply "done": ${process.execPath} listen.mjs`,
      options: {
        cwd: f.workspace,
        pathToClaudeCodeExecutable: executable,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          CLAUDE_CODE_OAUTH_TOKEN: token,
          CLAUDE_CONFIG_DIR: configDir,
        },
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        tools: ["Bash"],
        allowedTools: ["Bash"],
        maxTurns: 3,
        abortController,
        canUseTool: async () => ({ behavior: "deny", message: "denied" }),
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: true,
          network: {
            allowedDomains: [],
            ...(allowLocalBinding ? { allowLocalBinding: true } : {}),
          },
          filesystem: { allowWrite: [f.workspace] },
        },
      },
    })) {
      if (message.type === "assistant")
        bashCalls += message.message.content.filter(
          (part) => part.type === "tool_use" && part.name === "Bash",
        ).length;
      if (message.type === "result") resultSubtype = message.subtype;
    }
  } finally {
    clearTimeout(timer);
  }
  return { bashCalls, resultSubtype, steps: steps(f) };
}

const denied = (value) => typeof value === "string" && value !== "ok";
let root;
let outside;
try {
  outside = createServer((socket) => socket.end("x"));
  await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
  const port = outside.address().port;
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = realpathSync(mkdtempSync(join(cache, "cab-listen-probe-")));
  evidence.codex.networkOff = codexCase(
    fixture(root, "codex-off", port),
    false,
  );
  evidence.codex.networkOn = codexCase(fixture(root, "codex-on", port), true);
  evidence.claude.withoutOption = await claudeCase(
    fixture(root, "claude-off", port),
    false,
  );
  evidence.claude.withOption = await claudeCase(
    fixture(root, "claude-on", port),
    true,
  );
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  outside?.close();
  if (root) {
    rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = !existsSync(root);
  }
}
const s = (result) => result?.steps ?? {};
const gates = {
  codexOffDenied:
    denied(s(evidence.codex.networkOff).listenLoopback) &&
    denied(s(evidence.codex.networkOff).outbound),
  codexOnListens:
    s(evidence.codex.networkOn).listenLoopback === "ok" &&
    s(evidence.codex.networkOn).serveLoopback === "ok" &&
    s(evidence.codex.networkOn).outbound === "ok",
  claudeWithoutOptionDenied: denied(
    s(evidence.claude.withoutOption).listenLoopback,
  ),
  claudeWithOptionListens:
    s(evidence.claude.withOption).listenLoopback === "ok" &&
    s(evidence.claude.withOption).serveLoopback === "ok" &&
    denied(s(evidence.claude.withOption).outbound),
  fixtureRemoved: evidence.cleanup.fixtureRemoved,
};
const pass = Object.values(gates).every(Boolean);
const output = JSON.stringify({ ...evidence, gates, pass }, null, 2)
  .replaceAll(token, "<redacted-token>")
  .replaceAll(root ?? "\0", "<fixture>")
  .replaceAll(homedir(), "~");
process.stdout.write(`${output}\n`);
process.exitCode = pass ? 0 : 1;
