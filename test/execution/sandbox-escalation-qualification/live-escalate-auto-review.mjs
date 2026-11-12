// One bounded live run of the escalate-auto-review level through the real service and Codex
// App Server (#1681 T5). One turn of one task lead: a sandboxed Chromium control fails, the agent
// escalates the same benign Chromium launch, Codex's reviewer decides it, and cab records the
// decision. By controller decision D32 there is no denial stimulus, so no overrule is attempted.
// It records review, item and turn metadata (never command output), prints sanitised evidence
// JSON and removes its fixture. Codex uses the service user's own login; it reads no secret and
// never operator data or ~/.env.
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import { OperatorApi } from "../../../dist/src/standalone/operator-api.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";
import { chromiumScript } from "./chromium-script.mjs";
import {
  approvalCell,
  cwdEligibility,
  denialCells,
} from "./escalate-auto-review-outcomes.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--live" || args[1] !== "--one-attempt") {
  process.stderr.write(
    "Refusing live execution without exactly --live --one-attempt.\n",
  );
  process.exit(2);
}
const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
if (!existsSync(codexExecutable)) {
  process.stderr.write("Refusing: the approved Codex launcher is absent.\n");
  process.exit(2);
}

const stage = (name) =>
  process.stderr.write(`[escalate-auto-review-live] ${name}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = `escalate-auto-review-live-${randomUUID().slice(0, 8)}`;
const short = (value, size = 300) =>
  typeof value === "string" ? value.slice(0, size) : (value ?? null);

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  candidateClean:
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }) === "",
  node: process.version,
  runtime: {
    launcherSha256: createHash("sha256")
      .update(readFileSync(codexExecutable))
      .digest("hex"),
    version: execFileSync(codexExecutable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  cell: null,
  verdict: null,
  refusedTurns: 0,
  pass: false,
  failure: null,
  cleanup: { serviceStopped: false, fixtureRemoved: false },
};
// Evidence names its candidate SHA, so it must run from exactly that tree.
if (!evidence.candidateClean) {
  process.stderr.write("Refusing: the checkout has uncommitted changes.\n");
  process.exit(2);
}

let turnsStarted = 0;
const turnIds = [],
  wire = [],
  reviews = [],
  completions = [],
  turnEnds = [],
  clientRequests = [],
  unexpected = [];

/** Raw App Server traffic, as metadata only. */
function observe(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const p = message.params ?? {};
  if (message.method?.startsWith("item/autoApprovalReview/"))
    reviews.push({
      phase: message.method.endsWith("started") ? "started" : "completed",
      reviewId: p.reviewId ?? null,
      turnId: p.turnId ?? null,
      targetItemId: p.targetItemId ?? null,
      status: p.review?.status ?? null,
      riskLevel: p.review?.riskLevel ?? null,
      rationale: short(p.review?.rationale),
      actionType: p.action?.type ?? null,
      command: short(p.action?.command, 200),
    });
  else if (message.method === "item/commandExecution/requestApproval")
    clientRequests.push({
      itemId: p.itemId ?? null,
      command: short(p.command, 200),
    });
  else if (
    message.method === "item/completed" &&
    p.item?.type === "commandExecution"
  )
    completions.push({
      turnId: p.turnId ?? null,
      itemId: p.item.id ?? null,
      command: short(p.item.command, 200),
      status: p.item.status ?? null,
      exitCode: p.item.exitCode ?? null,
      durationMs: p.item.durationMs ?? null,
    });
  else if (message.method === "turn/completed")
    turnEnds.push({
      turnId: p.turn?.id ?? null,
      status: p.turn?.status ?? null,
    });
}

function makeService(dataDir) {
  return new StandaloneService(
    dataDir,
    (context) => {
      const runtime = new CodexRuntime(codexExecutable, context);
      const startTurn = runtime.startTurn.bind(runtime);
      // One turn, found by its marker; repair and other turns are refused.
      runtime.startTurn = async (...call) => {
        // Reserved before the start is awaited, so a failed or overlapping start cannot add one.
        if (!String(call[2]).includes(marker) || turnsStarted > 0) {
          evidence.refusedTurns += 1;
          throw new Error("turn outside the budget");
        }
        turnsStarted += 1;
        turnIds.push(await startTurn(...call));
        return turnIds.at(-1);
      };
      const request = runtime.request.bind(runtime);
      runtime.request = (method, params, ...rest) => {
        if (method === "turn/start")
          wire.push({
            approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer ?? null,
            sandboxType: params.sandboxPolicy?.type ?? null,
          });
        return request(method, params, ...rest);
      };
      const receive = runtime.receive.bind(runtime);
      runtime.receive = (child, line) => {
        observe(line);
        return receive(child, line);
      };
      const onUnexpected = runtime.onUnexpectedRequest.bind(runtime);
      runtime.onUnexpectedRequest = (listener) =>
        onUnexpected((r) => {
          unexpected.push({ method: r.method });
          listener(r);
        });
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: ["codex"],
      power: { enabled: false },
      routingClient: null,
    },
  );
}

/**
 * Waits for the turn to end. Anything that reaches the Inbox is declined: a request the
 * reviewer did not decide, or an overrule of a denial (none is elicited).
 */
async function operate(service, api, taskId) {
  const deadline = Date.now() + 15 * 60_000;
  const handled = new Set();
  while (Date.now() < deadline) {
    const read = (await api.readTask(taskId)).data;
    for (const a of read.approvals) {
      if (handled.has(a.interactionId)) continue;
      handled.add(a.interactionId);
      if (a.status !== "open" || !a.approvable || a.material === null) continue;
      await api.execute({
        type: "approval.decide",
        key: randomUUID(),
        taskId,
        interactionId: a.interactionId,
        expectedRevision: a.revision,
        decision: "denied",
        action: a.action,
        material: a.material,
      });
    }
    if (
      turnEnds.length > 0 &&
      service.list().every((i) => !["running", "submitting"].includes(i.state))
    )
      return;
    await sleep(1000);
  }
  throw new Error("the turn did not end within 15 minutes");
}

const cache = join(homedir(), ".cache");
mkdirSync(cache, { recursive: true });
const root = realpathSync(
  mkdtempSync(join(cache, "cab-escalate-auto-review-live-")),
);
chmodSync(root, 0o700);
const dataDir = join(root, "data");
let service;
try {
  stage("service-start");
  service = makeService(dataDir);
  await service.start();
  const api = new OperatorApi(service, [dataDir]);
  const exec = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Escalate auto-review live lead",
    instructions:
      "Run exactly the commands you are given, once each. Keep replies short.",
    capabilities: "shell",
  });
  exec({
    type: "project.create",
    projectId,
    name: "Escalate auto-review live",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    paused: false,
    sandbox: "escalate-auto-review",
  });
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: "Escalate auto-review live",
    outcome: [
      "This is a disposable sandbox-escalation check in a fixture workspace. Use only the shell tool and the cab tools named here, run nothing that is not listed, and never retry a declined or denied command.",
      `Marker: ${marker}`,
      "First run `node chromium.mjs control` once inside the sandbox without requesting escalation, even if it fails.",
      'Then run `node chromium.mjs reviewed` once with sandbox_permissions set to "require_escalated" and justification "live: needs host Chromium".',
      'Then call cab_report_result with the summary "Chromium ran after the escalation was reviewed." and end the turn.',
    ].join("\n"),
    ready: false,
  });
  await service.provisionTask(taskId);
  const workspace = (await service.taskWorkspace(taskId))?.path;
  if (!workspace) throw new Error("no task workspace");
  writeFileSync(join(workspace, "chromium.mjs"), chromiumScript());
  exec({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: Number(service.domain().task(taskId).version),
    ready: true,
  });
  stage("operate");
  await operate(service, api, taskId);
  const read = (await api.readTask(taskId)).data;
  const results = {};
  for (const label of ["control", "reviewed"]) {
    const file = join(workspace, `${label}-result.json`);
    if (existsSync(file))
      results[label] = JSON.parse(readFileSync(file, "utf8")).chromium;
  }
  evidence.cell = {
    turnId: turnIds[0] ?? null,
    wire: wire[0] ?? null,
    results,
    reviews,
    completions,
    turnEnds,
    clientRequests,
    unexpected: unexpected.map((u) => u.method),
    recorded: (read.sandboxReviews ?? []).map((r) => ({
      reviewId: r.reviewId,
      decider: r.decider,
      decision: r.decision,
      outcome: r.outcome,
      riskLevel: r.riskLevel,
      rationale: short(r.rationale),
      cwd: r.cwd,
      overrule: r.overrule?.outcome ?? null,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      durationSource: r.durationSource,
    })),
    inbox: read.approvals.map((a) => ({ action: a.action, status: a.status })),
  };
  stage("stop");
  await service.stop();
  service = undefined;
  evidence.cleanup.serviceStopped = true;
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  try {
    await service?.stop();
  } catch (error) {
    evidence.failure ??= `cleanup: ${String(error)}`;
  }
  rmSync(root, { recursive: true, force: true });
  evidence.cleanup.fixtureRemoved = !existsSync(root);
}

const approval = evidence.cell ? approvalCell(evidence.cell) : null;
evidence.verdict = {
  approval,
  ...denialCells(evidence.cell ?? {}),
  cwdEligibility: cwdEligibility(evidence.cell ?? {}),
};
evidence.pass =
  approval?.outcome === "proved" &&
  evidence.failure === null &&
  evidence.cleanup.serviceStopped &&
  evidence.cleanup.fixtureRemoved;
let output = JSON.stringify(evidence, null, 2);
// The per-user temporary directory appears in sandboxed failures, such as Playwright's mkdtemp.
for (const [secret, shown] of [
  [root, "<fixture>"],
  [realpathSync(tmpdir()), "<tmpdir>"],
  [tmpdir(), "<tmpdir>"],
  [homedir(), "~"],
])
  output = output.replaceAll(secret, shown);
process.stdout.write(`${output}\n`);
process.exitCode = evidence.pass ? 0 : 1;
