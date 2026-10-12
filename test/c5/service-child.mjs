// The #827 journey service: built in-process by live-journeys.mjs, or run as a
// forked child for the crash facet, where the parent drives it over IPC.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BudgetExhausted, reserveTurnInFile } from "./harness.mjs";

export const TOKEN_VARIABLE = "ENSEMBLE_C5_CLAUDE_TOKEN";

/** Starts the real service with ledger-wrapped Codex and Claude runtimes and the token reference. */
export async function startJourneyService({ dataDir, launcher, ledgerFile }) {
  const { StandaloneService, createRuntime } = await import(
    "../../dist/src/standalone/service.js"
  );
  const { CodexRuntime } = await import("../../dist/src/standalone/codex.js");
  const observed = {
    turns: [],
    refused: [],
    calls: [],
    workspaces: [],
    runtimes: {},
  };
  const wrap = (runtime, harness) => {
    observed.runtimes[harness] = runtime;
    const startTurn = runtime.startTurn.bind(runtime);
    runtime.startTurn = async (threadId, workspace, prompt, settings) => {
      try {
        reserveTurnInFile(harness, ledgerFile);
      } catch (error) {
        if (error instanceof BudgetExhausted)
          observed.refused.push({ harness, reason: error.message });
        throw error;
      }
      if (!observed.workspaces.includes(workspace))
        observed.workspaces.push(workspace);
      const turnId = await startTurn(threadId, workspace, prompt, settings);
      observed.turns.push({ harness, threadId, turnId, at: Date.now() });
      return turnId;
    };
    const onToolCall = runtime.onToolCall.bind(runtime);
    runtime.onToolCall = (listener) =>
      onToolCall(async (call) => {
        const entry = {
          harness,
          tool: call.tool,
          threadId: call.threadId,
          turnId: call.turnId,
          success: null,
        };
        observed.calls.push(entry);
        const result = await listener(call);
        entry.success = result.success;
        return result;
      });
    return runtime;
  };
  const service = new StandaloneService(
    dataDir,
    (context, harness) =>
      wrap(
        harness === "codex"
          ? new CodexRuntime(launcher, context)
          : createRuntime(context, harness),
        harness,
      ),
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  await service.start();
  if (service.domain().claudeTokenReference() === null) {
    // A reference configured after start is honoured only after a restart.
    service.domain().execute({
      type: "claude-token.configure",
      actor: "operator",
      key: randomUUID(),
      credentialRef: `env:${TOKEN_VARIABLE}`,
    });
    await service.stop();
    await service.start();
  }
  const token = service.claudeTokenStatus();
  if (token.state !== "available") {
    await service.stop();
    throw new Error(`Claude token reference is ${token.state}`);
  }
  return { service, observed };
}

const PROBE =
  "env | cut -d= -f1 > env-names.txt; env > env-full.txt; ps -E -o command= -p $PPID > ps-parent.txt 2>&1 || echo ps-error > ps-parent.txt";

/** Lead outcome text per facet; the worker brief is carried inside the lead's instructions. */
export function facetOutcome(facet, { workerProfileId, nonce }) {
  const shellOnly = (command) =>
    [
      "Disposable Ensemble qualification probe.",
      `Run exactly one Bash command, verbatim: ${command}`,
      "Then reply with one short sentence and end the turn. Do not call any Ensemble tool.",
    ].join("\n");
  if (facet === "scrub") return shellOnly(PROBE);
  if (facet === "stop" || facet === "crash") return shellOnly("sleep 120");
  const brief =
    facet === "claude-only"
      ? `Call ensemble_ask_question with question "C5 check: reply ready". After the answer arrives, call ensemble_report_result with summary C5_RESULT_${nonce}. Use no other tools.`
      : `Call ensemble_report_result with summary C5_RESULT_${nonce}. Use no other tools.`;
  return [
    "Disposable Ensemble coordination probe. Use only the Ensemble tools named here; no shell, file, browser or network tools.",
    `Worker profile ID: ${workerProfileId}.`,
    `As lead, call ensemble_delegate exactly once with profileId set to the Worker profile ID literal above and this brief, verbatim: ${brief}`,
    "Immediately after that call returns, end the turn.",
    "When the worker's result is delivered, call ensemble_request_completion with reviewedResultIds containing exactly that result ID, then end the turn.",
  ].join("\n");
}

/** Profiles, project and ready task on a disposable repository; returns ids and the workspace. */
export async function setupJourney(service, { facet, model, repository }) {
  const exec = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
  const claude = { harness: "claude", model, reasoningEffort: "low" };
  const leadProfileId = randomUUID(),
    workerProfileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    nonce = randomUUID().slice(0, 8);
  exec({
    type: "profile.create",
    profileId: leadProfileId,
    name: "C5 lead",
    instructions: "Follow the task instructions exactly and briefly.",
    capabilities: "task coordination, shell",
    runtime: facet === "mixed" ? { harness: "codex" } : claude,
  });
  exec({
    type: "profile.create",
    profileId: workerProfileId,
    name: "C5 worker",
    instructions: "Follow the brief exactly and briefly.",
    capabilities: "reporting",
    runtime: claude,
  });
  exec({
    type: "project.create",
    projectId,
    name: "C5 disposable journey",
    leadProfileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  exec({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workerProfileId],
  });
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: `C5 ${facet} journey`,
    outcome: facetOutcome(facet, { workerProfileId, nonce }),
    ready: false,
  });
  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  });
  const binding = await service.provisionTask(taskId, [
    { repositoryId: "c5-fixture", path: repository },
  ]);
  exec({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return {
    leadProfileId,
    workerProfileId,
    projectId,
    taskId,
    nonce,
    workspace: binding.path,
  };
}

/** What the parent may see of the child service: ids, states and holds; no payloads. */
export function snapshot(service, observed, taskId) {
  return {
    list: service.list().map(({ workId, state, threadId, turnId }) => ({
      workId,
      state,
      threadId,
      turnId,
    })),
    recovery: taskId ? service.recoveryForTask(taskId) : [],
    turns: observed.turns,
    refused: observed.refused,
    workspaces: observed.workspaces,
  };
}

async function child() {
  let current;
  const ops = {
    async start(args) {
      current = await startJourneyService(args);
      return { pid: process.pid };
    },
    setup: (args) => setupJourney(current.service, args),
    snapshot: ({ taskId }) =>
      snapshot(current.service, current.observed, taskId),
    resolve: ({ receipt }) => current.service.resolveHeldExecution(receipt),
    message: (args) =>
      current.service.coordinationView().postOperatorMessage(args),
    stopTask: ({ taskId }) => current.service.stopTask(taskId),
    async operatorRead({ workId, root }) {
      const { OperatorApi } = await import(
        "../../dist/src/standalone/operator-api.js"
      );
      const read = await new OperatorApi(current.service, [root]).readExecution(
        workId,
      );
      return { state: read.data.execution.state };
    },
    async stop() {
      await current?.service.stop();
      return true;
    },
  };
  process.on("message", async ({ id, op, args }) => {
    try {
      process.send({ id, result: await ops[op](args ?? {}) });
    } catch (error) {
      process.send({ id, error: String(error?.message ?? error) });
    }
  });
  process.send({ ready: true });
}

if (
  process.send &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  await child();
