// One bounded live Codex turn through the real service, then the CLI7 reads through the
// built CLI on loopback. Prints sanitised evidence JSON; never reads operator data or ~/.env.
// With --codex-settings the lead profile sets a model and reasoning effort taken from the
// runtime's own model list, and the run passes only when the runtime reports those values.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../../dist/src/standalone/operator.js";
import { OperatorApi } from "../../../dist/src/standalone/operator-api.js";
import { OperatorAuth } from "../../../dist/src/standalone/operator-auth.js";
import {
  OperatorWebBoundary,
  OperatorWebBundle,
} from "../../../dist/src/standalone/operator-web.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";
import { MacProcessTerminationVerifier } from "../../../dist/src/standalone/termination.js";
import { tmpdir } from "../../../dist/test/fixtures/temp.js";

const args = process.argv.slice(2);
const settingsMode = args.includes("--codex-settings");
if (
  args.length !== (settingsMode ? 3 : 2) ||
  !args.includes("--live") ||
  !args.includes("--one-attempt")
) {
  process.stderr.write(
    "Refusing live Codex execution without exactly --live --one-attempt.\n",
  );
  process.exit(2);
}
const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
if (!existsSync(codexExecutable)) {
  process.stderr.write("Refusing: the approved Codex launcher is absent.\n");
  process.exit(2);
}
const run = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sentinel = `cli7-sentinel-${randomBytes(12).toString("hex")}`;
process.env.CLI7_SENTINEL_TOKEN = sentinel;
const deadline = Date.now() + (settingsMode ? 10 : 15) * 60_000;
const cliEntry = resolve("dist/src/cli/main.js");

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  codex: {
    launcher: codexExecutable,
    launcherSha256: sha256(readFileSync(codexExecutable)),
    version: execFileSync(codexExecutable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  startTurnCalls: 0,
  configured: null,
  execution: null,
  surfaces: {},
  sentinel: { cliOutputs: null, databaseBytes: null },
  cleanup: { serviceStopped: false, processExit: null, fixtureRemoved: false },
  failure: null,
};
const stage = (name) => process.stderr.write(`[cli7-live] ${name}\n`);

let root;
let service;
let http;
let auth;
let runtime;
let submittedPrompt;
try {
  stage("fixture");
  root = mkdtempSync(join(tmpdir(), "cab-cli7-live-"));
  chmodSync(root, 0o700);
  const dataDir = join(root, "data");
  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "assets"), { recursive: true });
  writeFileSync(join(bundle, "index.html"), "<html></html>");
  writeFileSync(join(bundle, "assets", "main.js"), "");
  const authFile = join(root, "auth");
  await OperatorAuth.initialize(authFile, randomBytes(24).toString("hex"));

  service = new StandaloneService(
    dataDir,
    (context) => {
      runtime = new CodexRuntime(codexExecutable, context);
      const startTurn = runtime.startTurn.bind(runtime);
      // One turn start at most; the prompt forwarded is what the digest must match.
      runtime.startTurn = (threadId, workspace, prompt, settings) => {
        evidence.startTurnCalls += 1;
        if (evidence.startTurnCalls > 1)
          return Promise.reject(new Error("one-attempt budget exhausted"));
        submittedPrompt = prompt;
        return startTurn(threadId, workspace, prompt, settings);
      };
      return runtime;
    },
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  stage("service-start");
  await service.start();
  const processIdentity = await runtime.processIdentity?.();
  let configured;
  if (settingsMode) {
    stage("supported-settings");
    // The catalogue is read in the background after start; a model with a low effort is cheap.
    const settingsDeadline = Date.now() + 60_000;
    while (!runtime.supportedSettings() && Date.now() < settingsDeadline)
      await new Promise((r) => setTimeout(r, 250));
    const supported = runtime.supportedSettings();
    assert.ok(supported, "the runtime reported its supported models");
    const model = Object.keys(supported)
      .filter((name) => name !== "default" && supported[name].length > 0)
      .at(-1);
    assert.ok(model, "the runtime lists a model with reasoning efforts");
    configured = { model, reasoningEffort: supported[model][0] };
    evidence.configured = configured;
  }

  auth = await OperatorAuth.open({ authFile, origin: "http://127.0.0.1:1" });
  http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
    credentials: service.operatorCredentials(),
    web: new OperatorWebBoundary(
      await OperatorWebBundle.open(bundle),
      new OperatorApi(service, [root]),
    ),
  });
  const port = await http.start();
  const origin = `http://127.0.0.1:${port}`;

  stage("task");
  const d = service.domain();
  const exec = (body) =>
    d.execute({ key: randomUUID(), actor: "operator", ...body });
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "CLI7 live lead",
    instructions: "CLI7_PROFILE_INSTRUCTIONS: keep the turn short.",
    capabilities: "shell",
    ...(configured ? { runtime: { harness: "codex", ...configured } } : {}),
  });
  exec({
    type: "project.create",
    projectId,
    name: "CLI7 live diagnostics",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
    instructions: "CLI7_PROJECT_INSTRUCTIONS: disposable fixture.",
  });
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: "CLI7 live diagnostic turn",
    outcome: [
      "Disposable diagnostics probe.",
      "Run exactly one shell command: printenv CLI7_SENTINEL_TOKEN || echo cli7-unset",
      "Then reply with one short sentence and end the turn. Do not call any cab tool.",
    ].join("\n"),
    ready: false,
  });
  await service.provisionTask(taskId);
  exec({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });

  stage("turn");
  let intent;
  while (Date.now() < deadline) {
    intent = service.list().find((i) => i.workId.includes(":"));
    if (
      intent &&
      ["completed", "held", "resolved-failed"].includes(intent.state)
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(intent, "an execution was admitted");
  const workId = intent.workId;
  const store = service.executionDiagnostics();
  await new Promise((r) => setTimeout(r, 500));
  evidence.execution = {
    state: intent.state,
    reasonPresent: intent.reason !== null,
    threadBound: Boolean(intent.threadId),
    turnBound: Boolean(intent.turnId),
  };

  stage("cli-reads");
  const token = service
    .operatorCredentials()
    .issue({ name: "cli7-live", scope: "read", expiresInDays: 1 }).token;
  const cliDir = join(root, "cli");
  mkdirSync(cliDir, { mode: 0o700 });
  const tokenFile = join(cliDir, "token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const outputs = [];
  const cli = async (argv) => {
    try {
      const r = await run(process.execPath, [cliEntry, ...argv], {
        env: {
          PATH: process.env.PATH,
          HOME: cliDir,
          CAB_CLI_CONFIG_DIR: cliDir,
        },
        timeout: 120_000,
      });
      outputs.push(r.stdout, r.stderr);
      return { code: 0, out: r.stdout };
    } catch (error) {
      outputs.push(error.stdout ?? "", error.stderr ?? "");
      return { code: error.code, out: error.stdout ?? "" };
    }
  };
  let r = await cli([
    "auth",
    "login",
    "--connection",
    "live",
    "--url",
    origin,
    "--token-file",
    tokenFile,
  ]);
  assert.equal(r.code, 0);
  const json = async (argv) => {
    const res = await cli([...argv, "--output", "json"]);
    assert.equal(res.code, 0, argv.join(" "));
    return JSON.parse(res.out);
  };
  const list = await json(["execution", "list", "--task", taskId]);
  const get = await json(["execution", "get", workId]);
  const inputs = await json([
    "execution",
    "inputs",
    workId,
    "--compare-current",
  ]);
  const logs = await json(["logs", "--execution", workId, "--limit", "200"]);
  r = await cli([
    "logs",
    "--execution",
    workId,
    "--follow",
    "--max-duration",
    "30",
    "--output",
    "jsonl",
  ]);
  const follow = r.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  const items = logs.data.items;
  const runtimeTypes = [
    ...new Set(
      items
        .filter((i) => i.kind === "runtime")
        .map((i) => i.name.split("/")[0]),
    ),
  ];
  evidence.surfaces = {
    listed: list.data.executions.map((e) => e.capture),
    identity: {
      taskMatches: get.data.execution.taskId === taskId,
      assignmentPresent: Boolean(get.data.execution.assignmentId),
      threadBound: get.data.execution.threadId !== null,
      turnBound: get.data.execution.turnId !== null,
      bound: get.data.identity,
    },
    settings: get.data.settings?.map((s) => ({
      name: s.name,
      source: s.source,
      present: s.value !== null,
      // Model names are service configuration, not operator data.
      ...(settingsMode &&
      [
        "profile.model",
        "profile.reasoningEffort",
        "model",
        "reasoningEffort",
      ].includes(s.name)
        ? { value: s.value }
        : {}),
    })),
    inputs: {
      provenance: inputs.data.provenance,
      segments: inputs.data.segments.map((s) => ({
        name: s.name,
        state: s.state,
        redacted: s.redacted,
      })),
      submittedDigestMatches:
        submittedPrompt !== undefined &&
        inputs.data.submitted?.sha256 === sha256(submittedPrompt) &&
        inputs.data.submitted?.bytes === Buffer.byteLength(submittedPrompt),
      comparison: inputs.data.comparison?.instructions.map((c) => ({
        name: c.name,
        sameRevision: c.sameRevision,
      })),
    },
    events: {
      count: items.length,
      kinds: [...new Set(items.map((i) => i.kind))],
      runtimeItemTypes: runtimeTypes,
      commandExecutionObserved: runtimeTypes.includes("commandExecution"),
      commandOutputRedacted: items.some(
        (i) =>
          i.name === "commandExecution/completed" &&
          JSON.stringify(i.payload).includes("[redacted]"),
      ),
      toolCalls: items.filter((i) => i.kind === "tool").length,
      service: items.filter((i) => i.kind === "service").map((i) => i.name),
      gaps: logs.data.gaps.map((g) => g.code),
      health: get.data.health,
    },
    follow: {
      records: [...new Set(follow.map((l) => l.type))],
      end: follow.at(-1)?.reason ?? null,
    },
    storeHealth: store.health(),
  };
  if (settingsMode) {
    const reported = (name) =>
      evidence.surfaces.settings?.find(
        (s) => s.name === name && s.source === "runtime-reported",
      )?.value;
    evidence.surfaces.profileRuntime = (
      await json(["profile", "get", profileId])
    ).data.runtime;
    assert.equal(intent.state, "completed", "the turn completed");
    assert.deepEqual(evidence.surfaces.profileRuntime, {
      harness: "codex",
      ...configured,
    });
    assert.equal(reported("model"), configured.model);
    assert.equal(reported("reasoningEffort"), configured.reasoningEffort);
  }
  evidence.sentinel.cliOutputs = outputs.some((o) => o.includes(sentinel))
    ? "present"
    : "absent";

  stage("stop");
  await http.stop();
  http = undefined;
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
  } else evidence.cleanup.processExit = "unproved: no process identity";
  const dbBytes = ["standalone.sqlite", "standalone.sqlite-wal"]
    .map((f) => join(dataDir, f))
    .filter(existsSync)
    .map((f) => readFileSync(f));
  evidence.sentinel.databaseBytes = dbBytes.some((b) => b.includes(sentinel))
    ? "present"
    : "absent";
} catch (error) {
  evidence.failure = String(error?.message ?? error).replaceAll(
    sentinel,
    "[sentinel]",
  );
} finally {
  try {
    await http?.stop();
    await service?.stop();
    auth?.close?.();
  } catch (error) {
    evidence.failure ??= `cleanup: ${String(error)}`;
  }
  if (root) {
    rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = !existsSync(root);
  }
  delete process.env.CLI7_SENTINEL_TOKEN;
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exitCode =
  evidence.failure ||
  evidence.sentinel.cliOutputs !== "absent" ||
  evidence.sentinel.databaseBytes !== "absent"
    ? 1
    : 0;
