import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runServiceEntry } from "../../../src/standalone/cli.js";
import { CodexRuntime, type Runtime } from "../../../src/standalone/codex.js";
import { ClaudeRuntime } from "../../../src/standalone/claude.js";
import type { ExecutionHarness } from "../../../src/standalone/execution-harness.js";
import { StandaloneService } from "../../../src/standalone/service.js";
import { signalSdk } from "./sdk.js";
import { events, record, until } from "./trace.js";

const [root, harnessName, mode] = process.argv.slice(2);
if (!root || (harnessName !== "codex" && harnessName !== "claude"))
  throw new Error("Invalid fixture arguments");
const harness: ExecutionHarness = harnessName;
const trace = join(root, "trace.jsonl");
const data = join(root, "data");
const executable = join(root, "fake-runtime");
writeFileSync(
  executable,
  `#!${process.execPath}\nimport ${JSON.stringify(fileURLToPath(new URL("./fake-child.js", import.meta.url)))};\n`,
  { mode: 0o700 },
);
const hash = createHash("sha256")
  .update(readFileSync(executable))
  .digest("hex");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.prependOnceListener(signal, () =>
    record(trace, "service-signal", { signal }),
  );
record(trace, "service-start", { ppid: process.ppid });
// Scripted SDK can become idle without a real listener; retain the fixture driver.
const keepAlive = setInterval(() => {}, 60000);
let service!: StandaloneService;
await runServiceEntry(["serve", data], () => {
  service = new StandaloneService(
    data,
    (context) => {
      const safety = {
        ...context.safety,
        recordTerminal: (
          input: Parameters<typeof context.safety.recordTerminal>[0],
        ) => {
          record(trace, "adapter-terminal", input);
          return context.safety.recordTerminal(input);
        },
      };
      const runtime: Runtime =
        harness === "codex"
          ? new CodexRuntime(executable, {
              safety,
              qualifiedExecutableHash: hash,
              spawnEnvironment: () => ({
                PATH: process.env.PATH,
                SIGNAL_TRACE: trace,
                SIGNAL_RESUME: mode === "restart" ? "1" : "0",
                SIGNAL_SILENT:
                  mode === "silent" || mode === "repeat" ? "1" : "0",
              }),
            })
          : new ClaudeRuntime({
              safety,
              claude: {
                configDirectory: join(root, "claude"),
                turnEnvironment: () => ({
                  env: { PATH: process.env.PATH, SIGNAL_TRACE: trace },
                  token: "offline-fixture",
                }),
              },
              sdk: signalSdk(trace, executable, mode === "restart"),
              resolveExecutable: async () => executable,
              sandboxSelfTest: async () => true,
              exitTimeoutMs: 500,
            });
      const onAnomaly = runtime.onTerminalAnomaly?.bind(runtime);
      if (onAnomaly)
        runtime.onTerminalAnomaly = (listener) =>
          onAnomaly((anomaly) => {
            record(trace, "adapter-anomaly", anomaly);
            listener(anomaly);
          });
      const interrupt = runtime.interruptTurn.bind(runtime);
      runtime.interruptTurn = async (thread, turn) => {
        record(trace, "adapter-interrupt", { thread, turn });
        await interrupt(thread, turn);
        record(trace, "adapter-ack");
      };
      const stop = runtime.stop.bind(runtime);
      runtime.stop = async () => {
        record(trace, "adapter-stop");
        await stop();
        record(trace, "adapter-stopped");
      };
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: [harness],
      power: { enabled: false },
      routingClient: null,
      supervisor: { shutdownWaitMs: 700 },
    },
  );
  const start = service.start.bind(service);
  service.start = async () => {
    record(trace, "startup-barrier");
    if (mode === "startup")
      await new Promise((resolve) => setTimeout(resolve, 300));
    await start();
    if (mode === "startup") return;
    if (mode === "restart") {
      await until(
        () =>
          service
            .list()
            .some(
              (item) =>
                item.workId.startsWith("shutdown:") &&
                item.state === "completed",
            ),
        "successor settled",
      );
      record(trace, "restart-settled", service.list());
      return;
    }
    const tasks = await seed(service, [harness]);
    const task = tasks[0];
    if (!task) throw new Error("Missing seeded task");
    await until(
      () =>
        service
          .list()
          .some(
            (i) =>
              i.workId === task.workId &&
              i.state === "running" &&
              Boolean(i.turnId),
          ) && events(trace).some((e) => e.event === "child-active"),
      "active bound turn",
    );
    const bindingDb = new DatabaseSync(join(data, "standalone.sqlite"), {
      readOnly: true,
    });
    record(
      trace,
      "bound-identity",
      bindingDb
        .prepare("SELECT * FROM execution_recovery_identities WHERE workId = ?")
        .get(task.workId),
    );
    bindingDb.close();
    record(
      trace,
      "bound-ready",
      service.list().find((i) => i.workId === task.workId),
    );
  };
  const stop = service.stop.bind(service);
  service.stop = async () => {
    record(trace, "service-stop-entry");
    // Intentional fault ordering: child SIGINT precedes drain, irrespective of scheduling.
    if (
      mode === "fault" &&
      events(trace).some(
        (e) =>
          e.event === "service-signal" &&
          (e.detail as { signal: string }).signal === "SIGINT",
      )
    ) {
      await until(
        () => events(trace).some((e) => e.event === "child-SIGINT"),
        "fault signal receipt",
      );
      if (harness === "claude")
        await until(
          () => events(trace).some((e) => e.event === "adapter-anomaly"),
          "intentional pre-drain child exit",
        );
    }
    await stop();
    const db = new DatabaseSync(join(data, "standalone.sqlite"), {
      readOnly: true,
    });
    const snapshot = {
      intents: db
        .prepare(
          "SELECT workId, state, threadId, turnId, workspace FROM execution_intents",
        )
        .all(),
      resolutions: db
        .prepare("SELECT * FROM execution_shutdown_resolutions")
        .all(),
      writers: db.prepare("SELECT * FROM task_writer_admissions").all(),
      capacity: db
        .prepare("SELECT * FROM execution_capacity_reservations")
        .all(),
    };
    db.close();
    // Successful production resolution implies its callbacksEnded check passed;
    // this fixture issues no cab tool callbacks (no private service fields inspected).
    if (snapshot.resolutions.length)
      record(trace, "callbacks-ended-inferred-from-resolution");
    record(trace, "durable-resolution", snapshot);
  };
  return service;
});
clearInterval(keepAlive);
record(trace, "service-ended");

async function seed(service: StandaloneService, harnesses: ExecutionHarness[]) {
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
  const lead = randomUUID();
  const workers = {
    codex: randomUUID(),
    claude: randomUUID(),
  };
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Lead",
    instructions: "lead",
    capabilities: "code",
    runtime:
      harnesses[0] === "codex"
        ? { harness: "claude", model: "opus", reasoningEffort: "high" }
        : { harness: "codex" },
  });
  execute({
    type: "profile.create",
    profileId: workers.codex,
    name: "Codex worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "profile.create",
    profileId: workers.claude,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: "opus", reasoningEffort: "high" },
  });
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Shutdown",
    leadProfileId: lead,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [workers.codex, workers.claude],
  });
  const tasks: { taskId: string; workId: string; harness: ExecutionHarness }[] =
    [];
  for (const harness of harnesses) {
    const taskId = randomUUID();
    const assignmentId = randomUUID();
    execute({
      type: "task.create",
      projectId,
      taskId,
      title: `${harness} task`,
      outcome: "Restart safely",
      ready: false,
    });
    await service.provisionTask(taskId);
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId: workers[harness],
      brief: "build",
      resultDestination: "operator",
      requesterAssignmentId: null,
    });
    execute({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    tasks.push({
      taskId,
      workId: `assignment:${assignmentId}:initial`,
      harness,
    });
  }
  return tasks;
}
