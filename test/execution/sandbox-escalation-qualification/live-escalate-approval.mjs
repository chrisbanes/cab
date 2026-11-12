// One bounded live run of the escalate-approval level through the real service and Codex App
// Server (#1679). Three turns of one task lead, on one thread:
//   approve:   a sandboxed Chromium control fails, the agent escalates the same command, the
//              operator approves it through the operator API, and it runs outside the sandbox;
//   decline:   after a service restart (so the thread is resumed with its persisted policy),
//              a follow-up turn escalates and the operator declines it;
//   interrupt: a further turn escalates, nobody answers, and the operator stops the task, to
//              observe whether Codex resolves the pending request afterwards.
// It records approval, resolution and completion metadata (never command output), prints
// sanitised evidence JSON and removes its fixture. Codex uses the service user's own login; it
// reads no secret and never operator data or ~/.env.
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
import { OperatorApi } from "../../../dist/src/standalone/operator-api.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";
import { chromiumScript } from "./chromium-script.mjs";
import {
  approvalCallbacks,
  approveCell,
  declineCell,
  interruptCell,
} from "./escalate-approval-outcomes.mjs";

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
  process.stderr.write(`[escalate-approval-live] ${name}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = randomUUID().slice(0, 8);
const markers = {
  approve: `escalate-live-approve-${suffix}`,
  decline: `escalate-live-decline-${suffix}`,
  interrupt: `escalate-live-interrupt-${suffix}`,
};
const preamble =
  "This is a disposable sandbox-escalation check in a fixture workspace. Use only the shell tool and the cab tools named here, run nothing that is not listed, and never retry a declined command.";
const escalate = (label) =>
  `run \`node chromium.mjs ${label}\` once with sandbox_permissions set to "require_escalated" and justification "live: needs host Chromium"`;

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  runtime: {
    launcherSha256: createHash("sha256")
      .update(readFileSync(codexExecutable))
      .digest("hex"),
    version: execFileSync(codexExecutable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  cells: {},
  callbacks: null,
  refusedTurns: 0,
  verdict: null,
  pass: false,
  failure: null,
  cleanup: { servicesStopped: false, fixtureRemoved: false },
};

let cell = "approve";
const turns = [],
  wire = [],
  resumes = [],
  requests = [],
  resolutions = [],
  completions = [],
  turnEnds = [],
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
  if (message.method === "item/commandExecution/requestApproval")
    requests.push({
      cell,
      id: message.id,
      itemId: p.itemId,
      hasApprovalId: Object.hasOwn(p, "approvalId"),
      command: typeof p.command === "string" ? p.command.slice(0, 200) : null,
      keys: Object.keys(p).sort(),
    });
  else if (message.method === "serverRequest/resolved")
    resolutions.push({ cell, requestId: p.requestId, at: Date.now() });
  else if (
    message.method === "item/completed" &&
    p.item?.type === "commandExecution"
  )
    completions.push({
      cell,
      itemId: p.item.id,
      status: p.item.status ?? null,
      exitCode: p.item.exitCode ?? null,
      durationMs: p.item.durationMs ?? null,
    });
  else if (message.method === "turn/completed")
    turnEnds.push({ cell, status: p.turn?.status ?? null, at: Date.now() });
}

function makeService(dataDir) {
  return new StandaloneService(
    dataDir,
    (context) => {
      const runtime = new CodexRuntime(codexExecutable, context);
      const startTurn = runtime.startTurn.bind(runtime);
      // One turn per cell, found by its marker; repair and other turns are refused.
      runtime.startTurn = (...call) => {
        if (
          !String(call[2]).includes(markers[cell]) ||
          turns.some((t) => t.cell === cell)
        ) {
          evidence.refusedTurns += 1;
          return Promise.reject(new Error("turn outside the budget"));
        }
        turns.push({ cell, policy: call[4] ?? null });
        return startTurn(...call);
      };
      const request = runtime.request.bind(runtime);
      runtime.request = async (method, params, ...rest) => {
        if (method === "turn/start")
          wire.push({
            cell,
            approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer ?? null,
            sandboxType: params.sandboxPolicy?.type ?? null,
          });
        if (method !== "thread/resume") return request(method, params, ...rest);
        try {
          const result = await request(method, params, ...rest);
          resumes.push({
            cell,
            ok: true,
            approvalPolicy: result?.approvalPolicy,
          });
          return result;
        } catch (error) {
          resumes.push({
            cell,
            ok: false,
            error: String(error?.message ?? error).slice(0, 200),
          });
          throw error;
        }
      };
      const receive = runtime.receive.bind(runtime);
      runtime.receive = (child, line) => {
        observe(line);
        return receive(child, line);
      };
      const onUnexpected = runtime.onUnexpectedRequest.bind(runtime);
      runtime.onUnexpectedRequest = (listener) =>
        onUnexpected((r) => {
          unexpected.push({ cell, method: r.method });
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

const labelOf = (command) =>
  /chromium\.mjs ([a-z-]+)/.exec(command ?? "")?.[1] ?? null;

/**
 * Answers this cell's escalations as the operator would through the API, until the cell's turn
 * ends: approve `escalated`, decline `declined` (and anything unexpected), and leave `held` for
 * a Stop.
 */
async function operate(service, api, taskId, labels, onHeld) {
  const deadline = Date.now() + 15 * 60_000;
  const handled = new Set();
  while (Date.now() < deadline) {
    const read = (await api.readTask(taskId)).data;
    for (const a of read.approvals) {
      if (a.action !== "sandbox.escalate" || handled.has(a.interactionId))
        continue;
      handled.add(a.interactionId);
      const label = labelOf(a.material?.command);
      labels.set(a.interactionId, label);
      if (a.status !== "open" || !a.approvable) continue;
      if (label === "held") {
        await onHeld?.();
        continue;
      }
      await api.execute({
        type: "approval.decide",
        key: randomUUID(),
        taskId,
        interactionId: a.interactionId,
        expectedRevision: a.revision,
        decision: label === "escalated" ? "approved" : "denied",
        action: a.action,
        material: a.material,
      });
    }
    if (
      turnEnds.some((t) => t.cell === cell) &&
      service.list().every((i) => !["running", "submitting"].includes(i.state))
    )
      return;
    await sleep(1000);
  }
  throw new Error(`${cell}: the turn did not end within 15 minutes`);
}

async function collect(service, api, taskId, labels, workspace) {
  const read = (await api.readTask(taskId)).data;
  const results = {};
  for (const label of ["control", "escalated", "declined", "held"]) {
    const file = join(workspace, `${label}-result.json`);
    if (existsSync(file))
      results[label] = JSON.parse(readFileSync(file, "utf8")).chromium;
  }
  return {
    results,
    escalations: (read.sandboxEscalations ?? []).map((e) => ({
      label: labels.get(e.interactionId) ?? null,
      decider: e.decider,
      decision: e.decision,
      outcome: e.outcome,
      exitCode: e.exitCode,
      durationMs: e.durationMs,
      durationSource: e.durationSource,
    })),
    wire: wire.find((w) => w.cell === cell) ?? null,
    resume: resumes.find((r) => r.cell === cell) ?? null,
    turnState: turnEnds.filter((t) => t.cell === cell).at(-1)?.status ?? null,
    held: service.list().some((i) => i.state === "held"),
    unmatchedResolutions: unexpected.filter(
      (u) => u.cell === cell && u.method === "unmatched-native-resolution",
    ).length,
    unexpected: unexpected.filter((u) => u.cell === cell).map((u) => u.method),
    requests: requests.filter((r) => r.cell === cell),
    completions: completions.filter((c) => c.cell === cell),
    resolutions: resolutions.filter((r) => r.cell === cell).length,
  };
}

const cache = join(homedir(), ".cache");
mkdirSync(cache, { recursive: true });
const root = realpathSync(
  mkdtempSync(join(cache, "cab-escalate-approval-live-")),
);
chmodSync(root, 0o700);
const dataDir = join(root, "data");
let service;
try {
  stage("approve: service-start");
  service = makeService(dataDir);
  await service.start();
  let api = new OperatorApi(service, [dataDir]);
  const exec = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Escalate approval live lead",
    instructions:
      "Run exactly the commands you are given, once each. Keep replies short.",
    capabilities: "shell",
  });
  exec({
    type: "project.create",
    projectId,
    name: "Escalate approval live",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: Number(service.domain().project(projectId).version),
    paused: false,
    sandbox: "escalate-approval",
  });
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: "Escalate approval live",
    outcome: [
      preamble,
      `Marker: ${markers.approve}`,
      "First run `node chromium.mjs control` once inside the sandbox without requesting escalation, even if it fails.",
      `Then ${escalate("escalated")}.`,
      'Then call cab_report_result with the summary "Chromium ran after the escalation was answered." and end the turn.',
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
  const labels = new Map();
  stage("approve: operate");
  await operate(service, api, taskId, labels);
  evidence.cells.approve = await collect(
    service,
    api,
    taskId,
    labels,
    workspace,
  );

  stage("decline: restart");
  await service.stop();
  service = makeService(dataDir);
  await service.start();
  api = new OperatorApi(service, [dataDir]);
  const message = async (text) => {
    const read = (await api.readTask(taskId)).data;
    const lead = read.assignments.find(
      (a) => a.assignmentId === read.leadAssignmentId,
    );
    if (!lead) throw new Error("no lead assignment");
    await api.execute({
      type: "message",
      key: randomUUID(),
      taskId,
      recipientAssignmentId: lead.assignmentId,
      expectedAssignmentVersion: lead.version,
      message: text,
    });
  };
  cell = "decline";
  await message(
    [
      preamble,
      `Marker: ${markers.decline}`,
      `${escalate("declined")[0].toUpperCase()}${escalate("declined").slice(1)}. If it is declined, do not retry it.`,
      'Then call cab_report_result with the summary "The declined command did not run." and end the turn.',
    ].join("\n"),
  );
  stage("decline: operate");
  await operate(service, api, taskId, labels);
  evidence.cells.decline = await collect(
    service,
    api,
    taskId,
    labels,
    workspace,
  );

  cell = "interrupt";
  await message(
    [
      preamble,
      `Marker: ${markers.interrupt}`,
      `${escalate("held")[0].toUpperCase()}${escalate("held").slice(1)}, and wait for the answer.`,
    ].join("\n"),
  );
  let stoppedAt = null;
  stage("interrupt: operate");
  await operate(service, api, taskId, labels, async () => {
    if (stoppedAt !== null) return;
    stoppedAt = Date.now();
    await api.execute({ type: "task.stop", key: randomUUID(), taskId });
  });
  // A late resolution after the turn ends still counts.
  await sleep(10_000);
  const interrupted = await collect(service, api, taskId, labels, workspace);
  evidence.cells.interrupt = {
    ...interrupted,
    stopped: stoppedAt !== null,
    resolvedAfterInterrupt:
      stoppedAt === null
        ? null
        : resolutions.some((r) => r.cell === "interrupt" && r.at >= stoppedAt),
  };
  stage("stop");
  await service.stop();
  service = undefined;
  evidence.cleanup.servicesStopped = true;
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

const approve = evidence.cells.approve
  ? approveCell(evidence.cells.approve)
  : null;
const decline = evidence.cells.decline
  ? declineCell(evidence.cells.decline)
  : null;
evidence.callbacks = approvalCallbacks(requests);
evidence.verdict = {
  approve,
  decline,
  interrupt: evidence.cells.interrupt
    ? interruptCell(evidence.cells.interrupt)
    : null,
};
evidence.pass =
  approve?.proved === true &&
  decline?.proved === true &&
  evidence.failure === null &&
  evidence.cleanup.fixtureRemoved;
let output = JSON.stringify(evidence, null, 2);
for (const [secret, shown] of [
  [root, "<fixture>"],
  [homedir(), "~"],
])
  output = output.replaceAll(secret, shown);
process.stdout.write(`${output}\n`);
process.exitCode = evidence.pass ? 0 : 1;
