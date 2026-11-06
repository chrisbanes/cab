// One bounded live task turn through the real service, for one harness: the agent runs a fixed
// Node script in its task workspace that binds and serves on 127.0.0.1 and tries 1.1.1.1:443.
// The project has local listening on, and for Codex command network access on too, because
// Codex can listen only with network access. Passes when the turn got the expected policy,
// the listener bound and served, Claude's outbound stayed denied, the turn completed and the
// fixture was removed. Prints sanitised evidence JSON; reads only CLAUDE_CODE_OAUTH_TOKEN
// (Claude), never operator data or ~/.env.
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
import { MacProcessTerminationVerifier } from "../../../dist/src/standalone/termination.js";

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
if (harness === "codex" ? !existsSync(codexExecutable) : !token) {
  process.stderr.write(
    "Refusing: the approved Codex launcher or CLAUDE_CODE_OAUTH_TOKEN is absent.\n",
  );
  process.exit(2);
}
const tokenVariable = "CAB_LOCAL_LISTENING_CLAUDE_TOKEN";
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const deadline = Date.now() + 15 * 60_000;
const marker = `local-listening-live-${harness}`;
const stage = (name) =>
  process.stderr.write(`[local-listening-live] ${name}\n`);

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  harness,
  node: process.version,
  runtime: {},
  startTurnCalls: [],
  refusedTurns: 0,
  task: null,
  checks: null,
  pass: false,
  cleanup: { serviceStopped: false, processExit: null, fixtureRemoved: false },
  failure: null,
};

// Each step records `ok` or its error code in listen-result.json in the working directory.
const listenScript = `import { createConnection, createServer } from "node:net";
import { writeFileSync } from "node:fs";
const steps = {};
const code = (error) => error?.code ?? String(error?.message ?? error);
const connect = (host, port) => new Promise((resolve, reject) => {
  const socket = createConnection({ host, port });
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 4000);
  let data = "";
  socket.on("data", (chunk) => { data += chunk; });
  socket.once("connect", () => { if (port === 443) { clearTimeout(timer); socket.destroy(); resolve(""); } });
  socket.once("end", () => { clearTimeout(timer); resolve(data); });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
});
try {
  const server = await new Promise((resolve, reject) => {
    const s = createServer((socket) => socket.end("x"));
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  steps.listenLoopback = "ok";
  try { steps.serveLoopback = (await connect("127.0.0.1", server.address().port)) === "x" ? "ok" : "no-data"; }
  catch (error) { steps.serveLoopback = code(error); }
  server.close();
} catch (error) { steps.listenLoopback = code(error); }
try { await connect("1.1.1.1", 443); steps.outbound = "ok"; } catch (error) { steps.outbound = code(error); }
writeFileSync("listen-result.json", JSON.stringify(steps));
`;

let root;
let service;
const runtimes = [];
try {
  stage("fixture");
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = realpathSync(mkdtempSync(join(cache, "cab-local-listening-live-")));
  chmodSync(root, 0o700);
  const script = join(root, "listen.mjs");
  writeFileSync(script, listenScript);

  const dataDir = join(root, "data");
  const claudeSdk =
    harness === "claude"
      ? await import("@anthropic-ai/claude-agent-sdk")
      : undefined;
  service = new StandaloneService(
    dataDir,
    (context, which) => {
      const runtime =
        which === "codex"
          ? new CodexRuntime(codexExecutable, context)
          : new ClaudeRuntime({
              safety: context.safety,
              claude: context.claude,
              sdk: claudeSdk,
            });
      runtimes.push(runtime);
      const startTurn = runtime.startTurn.bind(runtime);
      // Exactly one real turn, found by its marker; repair turns are refused.
      runtime.startTurn = (...call) => {
        if (
          !String(call[2]).includes(marker) ||
          evidence.startTurnCalls.length > 0
        ) {
          evidence.refusedTurns += 1;
          return Promise.reject(new Error("turn outside the one-turn budget"));
        }
        evidence.startTurnCalls.push({ policy: call[4] ?? null });
        return startTurn(...call);
      };
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: [harness],
      power: { enabled: false },
      routingClient: null,
    },
  );
  stage("service-start");
  await service.start();
  const exec = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
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
  evidence.runtime =
    harness === "codex"
      ? {
          launcherSha256: sha256(readFileSync(codexExecutable)),
          version: execFileSync(codexExecutable, ["--version"], {
            encoding: "utf8",
          }).trim(),
        }
      : {
          sdk: JSON.parse(
            readFileSync(
              new URL(
                "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ).version,
          claude: execFileSync("claude", ["--version"], {
            encoding: "utf8",
          }).trim(),
        };
  const processIdentity = await runtimes.at(-1)?.processIdentity?.();

  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Local listening live lead",
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
    name: "Local listening live",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
    localListening: true,
    ...(harness === "codex" ? { commandNetworkAccess: true } : {}),
  });
  stage("task");
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: "Local listening live",
    outcome: [
      "Disposable local listening probe.",
      `Marker: ${marker}`,
      `Run exactly this one shell command in the current directory: ${process.execPath} ${script}`,
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
  const resultFile = binding && join(binding.path, "listen-result.json");
  const steps =
    resultFile && existsSync(resultFile)
      ? JSON.parse(readFileSync(resultFile, "utf8"))
      : {};
  evidence.task = { state: intent.state, reason: intent.reason, steps };
  const policy = evidence.startTurnCalls[0]?.policy;
  evidence.checks = {
    turnCompleted: intent.state === "completed",
    oneTurn: evidence.startTurnCalls.length === 1,
    policy:
      harness === "claude"
        ? JSON.stringify(policy) ===
          JSON.stringify({ networkAccess: false, localListening: true })
        : policy?.networkAccess === true && policy.localListening === undefined,
    listened: steps.listenLoopback === "ok" && steps.serveLoopback === "ok",
    outboundAsConfigured: harness === "claude" ? steps.outbound !== "ok" : true,
    admittedListening:
      service.localListeningFor(intent.workId) === (harness === "claude"),
  };

  stage("stop");
  await service.stop();
  service = undefined;
  evidence.cleanup.serviceStopped = true;
  if (processIdentity) {
    const verifier = new MacProcessTerminationVerifier();
    const until = Date.now() + 10_000;
    let result;
    do {
      result = await verifier.verify(processIdentity);
      if (result.kind === "verified") break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < until);
    evidence.cleanup.processExit = result.kind;
  } else
    evidence.cleanup.processExit =
      harness === "claude"
        ? "per-turn claude process; no long-lived identity"
        : "unproved: no process identity";
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  try {
    await service?.stop();
  } catch (error) {
    evidence.failure ??= `cleanup: ${String(error)}`;
  }
  if (root) {
    rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = !existsSync(root);
  }
}
evidence.pass =
  evidence.checks !== null &&
  Object.values(evidence.checks).every(Boolean) &&
  evidence.cleanup.fixtureRemoved;
let output = JSON.stringify(evidence, null, 2);
for (const secret of [token, root, homedir()].filter(Boolean))
  output = output.replaceAll(secret, secret === homedir() ? "~" : "<redacted>");
process.stdout.write(`${output}\n`);
process.exitCode = evidence.pass && !evidence.failure ? 0 : 1;
