// One bounded live Codex pair through the real service: a turn admitted with command network
// access off, then one admitted after the operator enables it. Prints sanitised evidence JSON;
// never reads operator data or ~/.env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";
import { MacProcessTerminationVerifier } from "../../../dist/src/standalone/termination.js";
import { tmpdir } from "../../../dist/test/fixtures/temp.js";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
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
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const deadline = Date.now() + 15 * 60_000;
const command =
  "/usr/bin/curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ > net-result.txt 2>&1; echo \" exit=$?\" >> net-result.txt";

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
  startTurnCalls: [],
  refusedTurns: 0,
  tasks: {},
  pass: false,
  cleanup: { serviceStopped: false, processExit: null, fixtureRemoved: false },
  failure: null,
};
const stage = (name) => process.stderr.write(`[network-live] ${name}\n`);

let root;
let service;
let runtime;
let phase;
try {
  stage("fixture");
  root = mkdtempSync(join(tmpdir(), "ensemble-network-live-"));
  chmodSync(root, 0o700);
  const dataDir = join(root, "data");
  service = new StandaloneService(
    dataDir,
    (context) => {
      runtime = new CodexRuntime(codexExecutable, context);
      const startTurn = runtime.startTurn.bind(runtime);
      // Exactly one real turn per phase, found by its marker. The lead's automatic repair
      // turn (it reports no result) is refused here, so at most two turns ever start.
      runtime.startTurn = (...call) => {
        const forwarded = evidence.startTurnCalls.length;
        const marker = `net-live-${phase}`;
        if (
          phase === undefined ||
          !String(call[2]).includes(marker) ||
          evidence.startTurnCalls.some((c) => c.phase === phase)
        ) {
          evidence.refusedTurns += 1;
          return Promise.reject(new Error("turn outside the two-turn budget"));
        }
        if (forwarded >= 2)
          return Promise.reject(new Error("two-turn budget exhausted"));
        evidence.startTurnCalls.push({ phase, policy: call[4] ?? null });
        return startTurn(...call);
      };
      return runtime;
    },
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  stage("service-start");
  await service.start();
  const processIdentity = await runtime.processIdentity?.();

  const d = service.domain();
  const exec = (body) =>
    d.execute({ key: randomUUID(), actor: "operator", ...body });
  const profileId = randomUUID(),
    projectId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Network live lead",
    instructions: "Run exactly the one command you are given. Keep it short.",
    capabilities: "shell",
  });
  exec({
    type: "project.create",
    projectId,
    name: "Network live",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });

  const seen = new Set();
  const runTask = async (label) => {
    stage(`task-${label}`);
    phase = label;
    const taskId = randomUUID();
    exec({
      type: "task.create",
      projectId,
      taskId,
      title: `Network live ${label}`,
      outcome: [
        "Disposable network probe.",
        `Marker: net-live-${label}`,
        `Run exactly this one shell command in the current directory: ${command}`,
        "Then reply with one short sentence and end the turn. Do not call any Ensemble tool.",
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
    let intent;
    while (Date.now() < deadline) {
      intent = service
        .list()
        .find((i) => i.workId.includes(":") && !seen.has(i.id));
      if (
        intent &&
        ["completed", "held", "resolved-failed"].includes(intent.state)
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(intent, `${label}: an execution was admitted`);
    seen.add(intent.id);
    const workspace = await service.taskWorkspace(taskId);
    const file = workspace && join(workspace.path, "net-result.txt");
    evidence.tasks[label] = {
      intentId: intent.id,
      state: intent.state,
      result:
        file && existsSync(file) ? readFileSync(file, "utf8").trim() : null,
      recorded: null,
    };
  };

  await runTask("off");
  const version = Number(d.project(projectId).version);
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: version,
    commandNetworkAccess: true,
  });
  await runTask("on");

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
  } else evidence.cleanup.processExit = "unproved: no process identity";

  const db = new DatabaseSync(join(dataDir, "standalone.sqlite"), {
    readOnly: true,
  });
  for (const task of Object.values(evidence.tasks)) {
    const row = db
      .prepare(
        "SELECT enabled FROM execution_intent_network_access WHERE intentId = ?",
      )
      .get(task.intentId);
    task.recorded = row ? row.enabled === 1 : null;
  }
  db.close();

  const { off, on } = evidence.tasks;
  const calls = evidence.startTurnCalls;
  evidence.pass =
    off.state === "completed" &&
    on.state === "completed" &&
    off.recorded === false &&
    on.recorded === true &&
    calls.length === 2 &&
    calls[0].phase === "off" &&
    calls[0].policy === null &&
    calls[1].phase === "on" &&
    calls[1].policy?.networkAccess === true &&
    typeof off.result === "string" &&
    !off.result.includes("200") &&
    !off.result.endsWith("exit=0") &&
    on.result === "200 exit=0";
} catch (error) {
  evidence.failure = String(error?.message ?? error);
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
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exitCode = evidence.pass && !evidence.failure ? 0 : 1;
