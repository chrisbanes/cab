// Bounded live task turns through the real service, for one harness: the agent runs a fixed
// workspace script that launches headless Chromium and boots the Medium_Phone emulator.
// Two cells in fresh fixtures: dangerouslySkipSandbox off (both must fail), then on (both must
// work). Each cell also checks the admitted value, the policy actually sent to the runtime
// (Codex turn/start, Claude query options) and turn completion. Prints sanitised evidence JSON;
// reads only CLAUDE_CODE_OAUTH_TOKEN (Claude), never operator data or ~/.env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
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
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import { ClaudeRuntime } from "../../../dist/src/standalone/claude.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";
import { hostToolsScript } from "./host-tools-script.mjs";

const args = process.argv.slice(2);
const harness = args
  .find((arg) => arg.startsWith("--harness="))
  ?.slice("--harness=".length);
if (
  args.length !== 3 ||
  !args.includes("--live") ||
  !args.includes("--one-attempt") ||
  (harness !== "codex" && harness !== "claude")
) {
  process.stderr.write(
    "Refusing live execution without exactly --live --one-attempt --harness=codex|claude.\n",
  );
  process.exit(2);
}
const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const adb = join(homedir(), "Library/Android/sdk/platform-tools/adb");
if (
  (harness === "codex" ? !existsSync(codexExecutable) : !token) ||
  !existsSync(adb) ||
  !existsSync(join(homedir(), "Library/Android/sdk/emulator/emulator"))
) {
  process.stderr.write(
    "Refusing: the approved Codex launcher or CLAUDE_CODE_OAUTH_TOKEN, or the Android SDK, is absent.\n",
  );
  process.exit(2);
}
const tokenVariable = "CAB_SKIP_SANDBOX_CLAUDE_TOKEN";
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// The turn environment comes from this process; the emulator wait can exceed the Bash tool's
// 2 minute default.
process.env.BASH_DEFAULT_TIMEOUT_MS = "600000";
process.env.BASH_MAX_TIMEOUT_MS = "600000";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stage = (name) => process.stderr.write(`[skip-sandbox-live] ${name}\n`);
const serial = "emulator-5580";
const adbDevices = () => {
  try {
    return execFileSync(adb, ["devices"], {
      encoding: "utf8",
      timeout: 15_000,
    });
  } catch {
    return "";
  }
};
// Only this harness's fixed-port emulator; emulator-5554/5556 and Haze AVDs are never touched.
async function killOwnEmulator() {
  if (!adbDevices().includes(serial)) return false;
  try {
    execFileSync(adb, ["-s", serial, "emu", "kill"], { timeout: 15_000 });
  } catch {}
  const until = Date.now() + 30_000;
  while (adbDevices().includes(serial) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 1000));
  return true;
}

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  harness,
  node: process.version,
  runtime: {},
  cells: [],
  verdict: null,
  pass: false,
  failure: null,
};
const roots = [];

async function runCell(skip) {
  const marker = `skip-sandbox-live-${harness}-${skip ? "on" : "off"}`;
  const deadline = Date.now() + 20 * 60_000;
  const cell = {
    skipSandbox: skip,
    startTurnCalls: [],
    wire: [],
    refusedTurns: 0,
    task: null,
    checks: null,
    cleanup: {
      serviceStopped: false,
      emulatorKilled: false,
      fixtureRemoved: false,
    },
    failure: null,
  };
  let root;
  let service;
  try {
    stage(`${marker}: fixture`);
    if (adbDevices().includes(serial))
      throw new Error(`${serial} is already running; refusing to share it`);
    const cache = join(homedir(), ".cache");
    mkdirSync(cache, { recursive: true });
    root = realpathSync(mkdtempSync(join(cache, "cab-skip-sandbox-live-")));
    roots.push(root);
    chmodSync(root, 0o700);
    const script = join(root, "host-tools.mjs");
    writeFileSync(script, hostToolsScript());

    const claudeSdk =
      harness === "claude"
        ? await import("@anthropic-ai/claude-agent-sdk")
        : undefined;
    // Observes the options of the real turn query (not the sandbox self-test's).
    const observedSdk = claudeSdk && {
      ...claudeSdk,
      query: (input) => {
        const o = input.options ?? {};
        if (o.allowedTools?.includes("mcp__cab__*"))
          cell.wire.push({ sandbox: o.sandbox ?? null });
        return claudeSdk.query(input);
      },
    };
    service = new StandaloneService(
      join(root, "data"),
      (context, which) => {
        const runtime =
          which === "codex"
            ? new CodexRuntime(codexExecutable, context)
            : new ClaudeRuntime({
                safety: context.safety,
                claude: context.claude,
                sdk: observedSdk,
              });
        const startTurn = runtime.startTurn.bind(runtime);
        // Exactly one real turn, found by its marker; repair turns are refused.
        runtime.startTurn = (...call) => {
          if (
            !String(call[2]).includes(marker) ||
            cell.startTurnCalls.length > 0
          ) {
            cell.refusedTurns += 1;
            return Promise.reject(
              new Error("turn outside the one-turn budget"),
            );
          }
          cell.startTurnCalls.push({ policy: call[4] ?? null });
          return startTurn(...call);
        };
        if (which === "codex") {
          const request = runtime.request.bind(runtime);
          runtime.request = (method, params, ...rest) => {
            if (method === "turn/start")
              cell.wire.push({
                sandboxPolicy: params.sandboxPolicy,
                approvalPolicy: params.approvalPolicy,
              });
            return request(method, params, ...rest);
          };
        }
        return runtime;
      },
      undefined,
      {
        runtimeHarnesses: [harness],
        power: { enabled: false },
        routingClient: null,
      },
    );
    stage(`${marker}: service-start`);
    await service.start();
    const exec = (body) =>
      service
        .domain()
        .execute({ key: randomUUID(), actor: "operator", ...body });
    if (harness === "claude") {
      // The token enters this process only after the reference exists and the first generation stopped.
      exec({
        type: "claude-token.configure",
        credentialRef: `env:${tokenVariable}`,
      });
      await service.stop();
      process.env[tokenVariable] = token;
      await service.start();
      assert.equal(service.claudeTokenStatus().state, "available");
    }
    const d = service.domain();
    if (!evidence.runtime.version)
      evidence.runtime =
        harness === "codex"
          ? {
              launcherSha256: sha256(readFileSync(codexExecutable)),
              version: execFileSync(codexExecutable, ["--version"], {
                encoding: "utf8",
              }).trim(),
            }
          : {
              version: execFileSync("claude", ["--version"], {
                encoding: "utf8",
              }).trim(),
              sdk: JSON.parse(
                readFileSync(
                  new URL(
                    "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
                    import.meta.url,
                  ),
                  "utf8",
                ),
              ).version,
            };

    const profileId = randomUUID(),
      projectId = randomUUID(),
      taskId = randomUUID();
    exec({
      type: "profile.create",
      profileId,
      name: "Skip sandbox live lead",
      instructions: "Run exactly the one command you are given. Keep it short.",
      capabilities: "shell",
      ...(harness === "claude"
        ? {
            runtime: {
              harness: "claude",
              model: "sonnet",
              reasoningEffort: "low",
            },
          }
        : {}),
    });
    exec({
      type: "project.create",
      projectId,
      name: "Skip sandbox live",
      leadProfileId: profileId,
    });
    exec({
      type: "project.configure",
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      paused: false,
      dangerouslySkipSandbox: skip,
    });
    stage(`${marker}: task`);
    exec({
      type: "task.create",
      projectId,
      taskId,
      title: "Skip sandbox live",
      outcome: [
        "Disposable host tools probe.",
        `Marker: ${marker}`,
        `Run exactly this one shell command in the current directory (it can take several minutes; wait for it): ${process.execPath} ${script}`,
        "Then reply with one short sentence and end the turn. Do not call any cab tool.",
      ].join("\n"),
      ready: true,
    });
    let intent;
    while (Date.now() < deadline) {
      intent = service.list().find((i) => i.workId.endsWith(":initial"));
      if (
        intent &&
        ["completed", "held", "resolved-failed"].includes(intent.state)
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(intent, "an execution was admitted");
    const binding = await service.taskWorkspace(taskId);
    const resultFile = binding && join(binding.path, "host-tools-result.json");
    const steps =
      resultFile && existsSync(resultFile)
        ? JSON.parse(readFileSync(resultFile, "utf8"))
        : null;
    cell.task = { state: intent.state, reason: intent.reason, steps };
    const wire = cell.wire[0];
    const wired =
      harness === "codex"
        ? skip
          ? JSON.stringify(wire?.sandboxPolicy) ===
            JSON.stringify({ type: "dangerFullAccess" })
          : wire?.sandboxPolicy?.type === "workspaceWrite"
        : wire?.sandbox?.enabled === !skip;
    cell.checks = {
      turnCompleted: intent.state === "completed",
      oneTurn: cell.startTurnCalls.length === 1 && cell.wire.length === 1,
      admitted: service.dangerouslySkipSandboxFor(intent.workId) === skip,
      runtimePolicy:
        (cell.startTurnCalls[0]?.policy?.skipSandbox === true) === skip,
      wirePolicy:
        wired && (harness === "claude" || wire?.approvalPolicy === "never"),
      // A script that wrote no result never counts as the expected outcome.
      chromium:
        steps?.chromium !== undefined &&
        (skip ? steps.chromium === "ok" : steps.chromium !== "ok"),
      emulator:
        steps?.emulator !== undefined &&
        (skip ? steps.emulator === "ok" : steps.emulator !== "ok"),
    };
    stage(`${marker}: stop`);
    await service.stop();
    service = undefined;
    cell.cleanup.serviceStopped = true;
  } catch (error) {
    cell.failure = String(error?.message ?? error).slice(0, 500);
  } finally {
    try {
      await service?.stop();
    } catch (error) {
      cell.failure ??= `cleanup: ${String(error)}`;
    }
    cell.cleanup.emulatorKilled = await killOwnEmulator();
    if (root) {
      rmSync(root, { recursive: true, force: true });
      cell.cleanup.fixtureRemoved = !existsSync(root);
    }
  }
  cell.pass =
    cell.checks !== null &&
    Object.values(cell.checks).every(Boolean) &&
    cell.cleanup.fixtureRemoved &&
    cell.failure === null;
  return cell;
}

try {
  for (const skip of [false, true]) evidence.cells.push(await runCell(skip));
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
}
evidence.verdict = {
  offBlocked: evidence.cells[0]?.pass === true,
  onWorks: evidence.cells[1]?.pass === true,
};
evidence.pass =
  Object.values(evidence.verdict).every(Boolean) && evidence.failure === null;
let output = JSON.stringify(evidence, null, 2);
for (const secret of [token, ...roots, homedir()].filter(Boolean))
  output = output.replaceAll(secret, secret === homedir() ? "~" : "<redacted>");
process.stdout.write(`${output}\n`);
process.exitCode = evidence.pass ? 0 : 1;
