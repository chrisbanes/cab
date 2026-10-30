// The #827 journey service: built in-process by live-journeys.mjs, or run as a
// forked child for the crash facet, where the parent drives it over IPC.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BudgetExhausted, reserveTurnInFile } from "./harness.mjs";

export const TOKEN_VARIABLE = "CAB_C5_CLAUDE_TOKEN";

/**
 * Wraps the Claude Agent SDK so each query records the `command` it asks to spawn and the
 * `pathToClaudeCodeExecutable` it was given (#981), then spawns exactly as before.
 */
export function recordClaudeSpawns(sdk, observed) {
  return {
    ...sdk,
    query: ({ prompt, options }) =>
      sdk.query({
        prompt,
        options: {
          ...options,
          spawnClaudeCodeProcess: (spawnOptions) => {
            observed.claudeSpawns.push({
              command: spawnOptions.command,
              pathToClaudeCodeExecutable:
                options.pathToClaudeCodeExecutable ?? null,
            });
            return options.spawnClaudeCodeProcess(spawnOptions);
          },
        },
      }),
  };
}

/**
 * Starts the real service with ledger-wrapped runtimes and the token reference.
 * The token enters this process's environment only after the reference is
 * configured and the first service generation has stopped, so no runtime spawned
 * before the reference existed can inherit it.
 */
export async function startJourneyService({
  dataDir,
  launcher,
  ledgerFile,
  token,
}) {
  const { StandaloneService } = await import(
    "../../../dist/src/standalone/service.js"
  );
  const { CodexRuntime } = await import(
    "../../../dist/src/standalone/codex.js"
  );
  const { ClaudeRuntime } = await import(
    "../../../dist/src/standalone/claude.js"
  );
  const observed = {
    turns: [],
    refused: [],
    calls: [],
    workspaces: [],
    runtimes: {},
    claudeSpawns: [],
  };
  const claudeSdk = recordClaudeSpawns(
    await import("@anthropic-ai/claude-agent-sdk"),
    observed,
  );
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
        try {
          const result = await listener(call);
          entry.success = result.success;
          return result;
        } catch (error) {
          entry.success = false;
          throw error;
        }
      });
    return runtime;
  };
  const service = new StandaloneService(
    dataDir,
    (context, harness) =>
      wrap(
        harness === "codex"
          ? new CodexRuntime(launcher, context)
          : new ClaudeRuntime({
              safety: context.safety,
              claude: context.claude,
              sdk: claudeSdk,
            }),
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
  if (service.domain().claudeTokenReference() === null)
    service.domain().execute({
      type: "claude-token.configure",
      actor: "operator",
      key: randomUUID(),
      credentialRef: `env:${TOKEN_VARIABLE}`,
    });
  // The caller verifies this generation's App Server exit by exact identity.
  const priorProcesses = [
    observed.runtimes.codex?.processIdentity?.() ?? null,
  ].filter(Boolean);
  await service.stop();
  process.env[TOKEN_VARIABLE] = token;
  await service.start();
  const status = service.claudeTokenStatus();
  if (status.state !== "available") {
    await service.stop();
    throw new Error(`Claude token reference is ${status.state}`);
  }
  return { service, observed, priorProcesses };
}

export const REPORTED = "C5 probe done";

const PROBE =
  "env | cut -d= -f1 > env-names.txt; env > env-full.txt; ps -E -o command= -p $PPID > ps-parent.txt 2>&1 || echo ps-error > ps-parent.txt";

export const SLEEP = "/bin/sleep 120";

/** The probe brief: one verbatim Bash command, then a result so no repair turn follows. */
export const shellOnly = (command) =>
  [
    "Disposable cab qualification probe.",
    `Run exactly one Bash command, verbatim: ${command}`,
    // A lead turn that ends without a result gets a reporting-repair turn.
    `Then call cab_report_result exactly once with summary ${REPORTED}, and end the turn. Use no other tool.`,
  ].join("\n");

/** A subagent runs the sleeping Bash, so Stop and a crash land while it is in flight (#1336). */
export const subagentSleep = [
  "Disposable cab subagent probe.",
  `Use the Agent tool exactly once with subagent_type general-purpose. Its prompt must tell the subagent to run exactly one Bash command, verbatim and alone on a line:\n${SLEEP}\nand then reply DONE. Do not run it yourself.`,
  `Then call cab_report_result exactly once with summary ${REPORTED}, and end the turn. Use no other tool.`,
].join("\n");

/** The skill brief: invoke the enabled skill, then report. */
export const skillBrief = [
  "Disposable cab skill probe.",
  "Invoke the skill probe-skill with the Skill tool and follow its instructions exactly.",
  `Then call cab_report_result exactly once with summary ${REPORTED}, and end the turn. Use no other tool.`,
].join("\n");

/** Lead outcome text per facet; the worker brief is carried inside the lead's instructions. */
export function facetOutcome(facet, { workerProfileId, nonce }) {
  if (facet === "scrub") return shellOnly(PROBE);
  // Claude Code blocks a bare `sleep N` (N >= 25) in the foreground.
  if (facet === "stop") return shellOnly(SLEEP);
  if (facet === "claude-subagent-stop") return subagentSleep;
  if (facet === "claude-skill") return skillBrief;
  if (facet === "crash" || facet === "claude-subagent-crash")
    return `Disposable cab qualification probe. Call cab_report_result exactly once with summary ${REPORTED}, and end the turn. Use no other tool.`;
  const brief =
    facet === "claude-only"
      ? `Call cab_ask_question with question "C5 check: reply ready". After the answer arrives, call cab_report_result with summary C5_RESULT_${nonce}. Use no other tools.`
      : `Call cab_report_result with summary C5_RESULT_${nonce}. Use no other tools.`;
  return [
    "Disposable cab coordination probe. Use only the cab tools named here; no shell, file, browser or network tools.",
    `Worker profile ID: ${workerProfileId}.`,
    `As lead, call cab_delegate exactly once with profileId set to the Worker profile ID literal above and this brief, verbatim: ${brief}`,
    "Immediately after that call returns, end the turn.",
    "When the worker's result is delivered, call cab_request_completion with reviewedResultIds containing exactly that result ID, then end the turn.",
  ].join("\n");
}

/** Profiles, project and ready task on a disposable repository; returns ids and the workspace. */
export async function setupJourney(
  service,
  { facet, model, repository, skills, onProvisioned },
) {
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
    ...(skills ? { skills } : {}),
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
    name: `C5 disposable journey ${nonce}`,
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
  // The plugin's script names the workspace, which exists only after provisioning.
  onProvisioned?.(binding.path);
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
    claudeSpawns: observed.claudeSpawns,
  };
}

async function child() {
  let current;
  const ops = {
    async start(args) {
      current = await startJourneyService(args);
      return {
        priorProcesses: current.priorProcesses,
        codex: current.observed.runtimes.codex?.processIdentity?.() ?? null,
      };
    },
    setup: (args) => setupJourney(current.service, args),
    snapshot: ({ taskId }) =>
      snapshot(current.service, current.observed, taskId),
    resolve: ({ receipt }) => current.service.resolveHeldExecution(receipt),
    message: (args) =>
      current.service.coordinationView().postOperatorMessage(args),
    stopTask: ({ taskId }) => current.service.stopTask(taskId),
    // In-process read through OperatorApi; it does not exercise the HTTP
    // `execution.read` token scope.
    async operatorRead({ workId, root }) {
      const { OperatorApi } = await import(
        "../../../dist/src/standalone/operator-api.js"
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
  // A child whose parent has gone always shuts down.
  process.on("disconnect", () => {
    void Promise.resolve(current?.service.stop()).finally(() =>
      process.exit(0),
    );
  });
  process.send({ ready: true });
}

if (
  process.send &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  await child();
