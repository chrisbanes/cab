// One bounded probe per harness setting: can a sandboxed command launch headless
// Chromium and boot the Medium_Phone Android emulator on this macOS host? Codex runs a
// fixed script through `codex sandbox` (no model) with cab's workspace-write policy;
// Claude runs it through the pinned SDK with cab's sandbox options, with and without
// `sandbox: { enabled: false }`. Prints sanitised JSON; reads only
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
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
const sdkRoot = new URL(
  "../../../node_modules/@anthropic-ai/claude-agent-sdk/",
  import.meta.url,
);
const playwrightEntry = pathToFileURL(
  join(
    new URL("../../../node_modules/playwright/", import.meta.url).pathname,
    "index.mjs",
  ),
).href;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const androidSdk = join(homedir(), "Library/Android/sdk");
if (
  !existsSync(codexExecutable) ||
  !token ||
  !existsSync(join(androidSdk, "emulator/emulator")) ||
  !existsSync(join(androidSdk, "platform-tools/adb"))
) {
  process.stderr.write(
    "Refusing: the approved Codex launcher, Android SDK or CLAUDE_CODE_OAUTH_TOKEN is absent.\n",
  );
  process.exit(2);
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Each step records `ok` or its error text; the result goes to host-tools-result.json.
// A fixed console port keeps the serial (emulator-5580) distinct from any other emulator.
const hostToolsScript =
  () => `import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const steps = {};
const text = (error) => String(error?.message ?? error).replace(/\\s+/g, " ").slice(0, 400);
const sdk = process.env.HOME + "/Library/Android/sdk";
const adb = sdk + "/platform-tools/adb";
const serial = "emulator-5580";
const adbRun = (...rest) => execFileSync(adb, ["-s", serial, ...rest], { encoding: "utf8", timeout: 10000 }).trim();
const save = () => writeFileSync("host-tools-result.json", JSON.stringify(steps));
try {
  const { chromium } = await import(${JSON.stringify(playwrightEntry)});
  const browser = await chromium.launch({ headless: true, timeout: 60000 });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>probe-title</title>");
    const title = await page.title();
    steps.chromium = title === "probe-title" ? "ok" : "unexpected-title:" + title;
  } finally { await browser.close(); }
} catch (error) { steps.chromium = text(error); }
save();
let child = null;
let stderr = "";
let exited = false;
try {
  child = spawn(sdk + "/emulator/emulator", ["-avd", "Medium_Phone", "-port", "5580", "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim"], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-400); });
  child.once("exit", (code, signal) => { exited = true; stderr += " exit=" + (code ?? signal); });
  child.once("error", (error) => { exited = true; stderr += " " + text(error); });
  const deadline = Date.now() + 300000;
  let last = "";
  while (Date.now() < deadline && steps.emulator === undefined) {
    if (exited) { steps.emulator = "emulator exited: " + text(stderr + " " + last); break; }
    try {
      if (adbRun("shell", "getprop", "sys.boot_completed") === "1") steps.emulator = "ok";
    } catch (error) { last = text(error); }
    if (steps.emulator === undefined) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  steps.emulator ??= "boot timeout: " + text(stderr + " " + last);
} catch (error) { steps.emulator = text(error); }
finally {
  if (child && !exited) {
    try { adbRun("emu", "kill"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // Fallback: only the exact child this script spawned.
    if (!exited) try { child.kill("SIGTERM"); } catch {}
  }
  save();
}
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

function fixture(root, label) {
  const workspace = join(root, label, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "host-tools.mjs"), hostToolsScript());
  return { base: join(root, label), workspace };
}

function steps(f) {
  const path = join(f.workspace, "host-tools-result.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function codexCase(f) {
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
      "sandbox_workspace_write.network_access=false",
      "--",
      process.execPath,
      "host-tools.mjs",
    ],
    {
      cwd: f.workspace,
      env: { PATH: process.env.PATH, HOME: homedir(), CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 420_000,
    },
  );
  return { exit: result.status, steps: steps(f) };
}

async function claudeCase(f, sandboxEnabled) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const pkg = JSON.parse(
    readFileSync(new URL("package.json", sdkRoot), "utf8"),
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
  const timer = setTimeout(() => abortController.abort(), 480_000);
  let bashCalls = 0;
  let resultSubtype = null;
  try {
    for await (const message of sdk.query({
      prompt: `Use the Bash tool exactly once to run this command, then reply "done": ${process.execPath} host-tools.mjs`,
      options: {
        cwd: f.workspace,
        pathToClaudeCodeExecutable: executable,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          CLAUDE_CODE_OAUTH_TOKEN: token,
          CLAUDE_CONFIG_DIR: configDir,
          // The script can run ~6 minutes; the Bash tool defaults to 2.
          BASH_DEFAULT_TIMEOUT_MS: "600000",
          BASH_MAX_TIMEOUT_MS: "600000",
        },
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        tools: ["Bash"],
        allowedTools: ["Bash"],
        maxTurns: 3,
        abortController,
        canUseTool: async () => ({ behavior: "deny", message: "denied" }),
        sandbox: sandboxEnabled
          ? {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              autoAllowBashIfSandboxed: true,
              network: { allowedDomains: [] },
              filesystem: { allowWrite: [f.workspace] },
            }
          : { enabled: false },
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

let root;
try {
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = realpathSync(mkdtempSync(join(cache, "cab-host-tools-probe-")));
  evidence.codex.sandboxed = codexCase(fixture(root, "codex"));
  evidence.claude.sandboxed = await claudeCase(
    fixture(root, "claude-on"),
    true,
  );
  evidence.claude.sandboxDisabled = await claudeCase(
    fixture(root, "claude-off"),
    false,
  );
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = !existsSync(root);
  }
}
// A leg only counts when its script wrote a result; a missing file proves nothing.
const s = (result) => result?.steps ?? null;
const blocked = (r) =>
  s(r) !== null &&
  s(r).chromium !== undefined &&
  s(r).chromium !== "ok" &&
  s(r).emulator !== undefined &&
  s(r).emulator !== "ok";
const works = (r) => s(r)?.chromium === "ok" && s(r)?.emulator === "ok";
const verdict = {
  codexSandboxedBlocked: blocked(evidence.codex.sandboxed),
  claudeSandboxedBlocked: blocked(evidence.claude.sandboxed),
  claudeSandboxDisabledWorks: works(evidence.claude.sandboxDisabled),
  fixtureRemoved: evidence.cleanup.fixtureRemoved,
};
const pass = Object.values(verdict).every(Boolean) && evidence.failure === null;
const output = JSON.stringify({ ...evidence, verdict, pass }, null, 2)
  .replaceAll(token, "<redacted-token>")
  .replaceAll(root ?? "\0", "<fixture>")
  .replaceAll(homedir(), "~");
process.stdout.write(`${output}\n`);
process.exitCode = pass ? 0 : 1;
