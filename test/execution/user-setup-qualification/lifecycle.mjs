import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertAttemptAvailable,
  beginAttempt,
  readGrant,
  reserveTurn,
  saveGrant,
  TURN_MS,
} from "./grant.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, deadline, label) {
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const complete =
  "This is a disposable native harness qualification. Do not change files or use external integrations, skills, subagents or background work. Call cab_report_result exactly once with summary NATIVE_LIFECYCLE_DONE_1569, then end the turn. Do not complete the assignment or task.";
const sleep =
  "This is a disposable native harness qualification. Use the ordinary sandboxed shell tool to run /bin/sleep 120 synchronously. Do not use background execution, subagents, external integrations or other commands. The operator will interrupt it. Do not call cab_report_result before the command ends.";

/** One fixed four-turn lifecycle, using production service/runtime and the retained grant. */
export async function lifecycle(path, harnesses = ["claude", "codex"]) {
  const { StandaloneService } = await import(
    "../../../dist/src/standalone/service.js"
  );
  const { CodexRuntime } = await import(
    "../../../dist/src/standalone/codex.js"
  );
  const { ClaudeRuntime, releaseClaudeTemporaryBase } = await import(
    "../../../dist/src/standalone/claude.js"
  );
  const { captureProcessIdentity, MacProcessTerminationVerifier } =
    await import("../../../dist/src/standalone/termination.js");
  const verifier = new MacProcessTerminationVerifier();
  assert.ok(
    await captureProcessIdentity(process.pid),
    "Exact process identity access is required before lifecycle dispatch",
  );
  const same = (a, b) =>
    a?.processId === b?.processId &&
    a?.processStartedAt === b?.processStartedAt &&
    a?.bootId === b?.bootId;
  async function signal(identity, kind) {
    const live = await captureProcessIdentity(Number(identity.processId));
    if (!live) return;
    assert.ok(
      same(live, identity),
      "Owned process identity changed; refusing signal",
    );
    process.kill(Number(identity.processId), kind);
  }
  async function gone(identity) {
    return (await verifier.verify(identity)).kind === "verified";
  }
  async function end(identity) {
    if (await gone(identity)) return;
    await signal(identity, "SIGTERM");
    try {
      await until(
        () => gone(identity),
        Date.now() + 5000,
        "owned process exit",
      );
    } catch {
      await signal(identity, "SIGKILL");
      await until(
        () => gone(identity),
        Date.now() + 5000,
        "owned process forced exit",
      );
    }
  }
  async function descendants(identity) {
    assert.ok(
      same(await captureProcessIdentity(Number(identity.processId)), identity),
    );
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([Number(identity.processId)]);
    for (let prior = -1; prior !== owned.size; ) {
      prior = owned.size;
      for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
    }
    owned.delete(Number(identity.processId));
    return (
      await Promise.all([...owned].map((pid) => captureProcessIdentity(pid)))
    ).filter(Boolean);
  }
  for (const harness of harnesses) {
    let grant = readGrant(path);
    assert.ok(
      ["claude", "codex"].every((h) =>
        grant.attempts.some(
          (a) =>
            a.harness === h && a.facet === "native" && a.state === "passed",
        ),
      ),
      "Both native proofs are required",
    );
    assertAttemptAvailable(grant, harness, "lifecycle");
    const previous = grant.attempts.filter(
      (a) => a.harness === harness && a.facet === "lifecycle",
    );
    const root = resolve(
      grant.root,
      "lifecycle",
      previous.length ? `${harness}-attempt${previous.length + 1}` : harness,
    );
    assert.ok(root.startsWith(`${resolve(grant.root)}/`));
    assert.ok(
      !existsSync(root),
      "Retain existing lifecycle evidence; do not overwrite an attempt",
    );
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const evidence = {
      harness,
      startedAt: new Date().toISOString(),
      turns: [],
      callbacks: [],
      processes: [],
      checks: {},
      cleanup: [],
    };
    const inputFiles = [
      "src/standalone/service.ts",
      "src/standalone/codex.ts",
      "src/standalone/claude.ts",
      "src/standalone/state.ts",
      "src/standalone/runtime-retention.ts",
      "test/execution/user-setup-qualification/lifecycle.mjs",
    ];
    evidence.inputs = Object.fromEntries(
      inputFiles.map((file) => [
        file,
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]),
    );
    const workspaces = new Set(),
      timers = new Map(),
      commands = new Set(),
      ownedProcesses = new Map();
    let service,
      runtime,
      pendingCallbacks = 0;
    const retainIdentity = (identity) => {
      if (identity) {
        ownedProcesses.set(JSON.stringify(identity), identity);
        evidence.processes.push(identity);
      }
    };
    const factory = (context) => {
      runtime =
        harness === "codex"
          ? new CodexRuntime(undefined, context)
          : new ClaudeRuntime({
              safety: context.safety,
              claude: context.claude,
            });
      const start = runtime.startTurn.bind(runtime),
        wait = runtime.waitForTurn.bind(runtime),
        onTool = runtime.onToolCall.bind(runtime),
        diagnostic = runtime.onDiagnosticEvent?.bind(runtime);
      runtime.onDiagnosticEvent = (listener) =>
        diagnostic?.((event) => {
          if (
            event.kind === "item" &&
            event.itemType === "commandExecution" &&
            event.phase === "started" &&
            typeof event.command === "string" &&
            event.command.includes("sleep 120")
          )
            commands.add(event.turnId);
          listener(event);
        });
      runtime.onToolCall = (listener) =>
        onTool(async (call) => {
          pendingCallbacks++;
          const entry = {
            tool: call.tool,
            threadId: call.threadId,
            turnId: call.turnId,
            ended: false,
            success: false,
          };
          evidence.callbacks.push(entry);
          try {
            const result = await listener(call);
            entry.success = result.success;
            return result;
          } finally {
            entry.ended = true;
            pendingCallbacks--;
          }
        });
      runtime.startTurn = async (threadId, workspace, prompt, ...args) => {
        reserveTurn(path, harness, "lifecycle");
        workspaces.add(workspace);
        const entry = {
          threadId,
          turnId: null,
          startedAt: Date.now(),
          terminal: null,
        };
        evidence.turns.push(entry);
        const timer = setTimeout(() => {
          entry.expired = true;
          void runtime.stop().catch(() => {});
        }, TURN_MS).unref();
        try {
          const turnId = await start(threadId, workspace, prompt, ...args);
          entry.turnId = turnId;
          timers.set(turnId, timer);
          return turnId;
        } catch (error) {
          clearTimeout(timer);
          throw error;
        }
      };
      runtime.waitForTurn = async (threadId, turnId) => {
        try {
          const status = await wait(threadId, turnId);
          const entry = evidence.turns.find((t) => t.turnId === turnId);
          if (entry) entry.terminal = status;
          return status;
        } finally {
          clearTimeout(timers.get(turnId));
          timers.delete(turnId);
        }
      };
      return runtime;
    };
    const make = () =>
      new StandaloneService(join(root, "data"), factory, undefined, {
        runtimeHarnesses: [harness],
        power: { enabled: false },
        routingClient: null,
      });
    const command = (body) =>
      service
        .domain()
        .execute({ key: randomUUID(), actor: "operator", ...body });
    const records = (taskId) => service.recoveryForTask(taskId);
    async function newTask(projectId, title, outcome) {
      const taskId = randomUUID();
      command({
        type: "task.create",
        projectId,
        taskId,
        title,
        outcome,
        ready: false,
      });
      const binding = await service.provisionTask(taskId);
      workspaces.add(binding.path);
      command({
        type: "task.configure",
        projectId,
        taskId,
        expectedVersion: 1,
        ready: true,
      });
      return taskId;
    }
    async function running(taskId) {
      return until(
        () =>
          records(taskId).find(
            (r) =>
              r.intent.state === "running" &&
              r.processIdentity &&
              commands.has(r.intent.turnId),
          ),
        Date.now() + TURN_MS,
        "bound synchronous sleep",
      );
    }
    async function completed(taskId) {
      return until(
        () => records(taskId).find((r) => r.intent.state === "completed"),
        Date.now() + TURN_MS,
        "completed turn",
      );
    }
    function followUp(taskId, record, message) {
      return service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId,
        recipientAssignmentId: record.binding.assignmentId,
        expectedAssignmentVersion: Number(
          service.domain().assignment(record.binding.assignmentId).version,
        ),
        message,
      });
    }
    beginAttempt(path, harness, "lifecycle");
    const phase = readGrant(path).phaseWindows.lifecycle;
    const phaseDeadline = phase.startedAt + phase.durationMs;
    let phaseExpired = false;
    const phaseTimer = setTimeout(
      () => {
        phaseExpired = true;
        void service?.stop().catch(() => {});
      },
      Math.max(1, phaseDeadline - Date.now()),
    ).unref();
    try {
      service = make();
      await service.start();
      assert.equal(
        service.harnessStatuses().find((s) => s.harness === harness)?.state,
        "available",
        "Requested native runtime unavailable",
      );
      const profileId = randomUUID(),
        projectId = randomUUID();
      command({
        type: "profile.create",
        profileId,
        name: "Native qualification",
        instructions:
          "Follow the bounded qualification request only. No external mutations or delegation.",
        capabilities: "qualification",
        runtime:
          harness === "claude"
            ? { harness, model: null, reasoningEffort: null }
            : { harness },
      });
      command({
        type: "project.create",
        projectId,
        name: "Native qualification",
        leadProfileId: profileId,
      });
      command({
        type: "project.configure",
        projectId,
        expectedVersion: 1,
        paused: false,
      });
      const stopTask = await newTask(projectId, "Native Stop", sleep);
      const stopRecord = await running(stopTask);
      retainIdentity(stopRecord.processIdentity);
      const stopChildren = await descendants(stopRecord.processIdentity);
      stopChildren.forEach(retainIdentity);
      const beforeStop = evidence.turns.length;
      const stopped = await service.stopTask(stopTask);
      const outcome = stopped.outcomes.find(
        (o) => o.workId === stopRecord.workId,
      );
      assert.ok(
        outcome?.terminal === "observed" ||
          records(stopTask).some(
            (r) => r.intent.state === "held" && r.holds.writer,
          ),
        "Stop must observe terminal or retain ownership",
      );
      await until(
        () => pendingCallbacks === 0,
        Date.now() + 5000,
        "ended Stop callbacks",
      );
      // Runtime-owned tool processes must end; retained identities never authorise signalling a reused PID.
      for (const identity of stopChildren) {
        if (await gone(identity)) continue;
        const command = execFileSync(
          "/bin/ps",
          ["-p", identity.processId, "-o", "comm="],
          { encoding: "utf8" },
        ).trim();
        if (command.endsWith("/sleep") || command === "sleep")
          await end(identity);
      }
      await delay(1000);
      assert.equal(evidence.turns.length, beforeStop, "Stop must not resubmit");
      evidence.checks.stop = {
        outcome,
        held: records(stopTask).map((r) => r.holds),
        noResubmission: true,
      };
      const taskId = await newTask(projectId, "Native recovery", complete);
      const seed = await completed(taskId);
      retainIdentity(seed.processIdentity);
      assert.equal(evidence.turns.length, 2);
      assert.ok(
        evidence.callbacks.some(
          (c) =>
            c.tool === "cab_report_result" &&
            c.success &&
            c.ended &&
            c.turnId === seed.intent.turnId,
        ),
      );
      await followUp(taskId, seed, sleep);
      const interrupted = await running(taskId);
      retainIdentity(interrupted.processIdentity);
      const children = await descendants(interrupted.processIdentity);
      children.forEach(retainIdentity);
      // Deliberate runtime crash is the fault under test, after exact identity capture.
      await signal(interrupted.processIdentity, "SIGKILL");
      for (const identity of children) await end(identity);
      await until(
        () => gone(interrupted.processIdentity),
        Date.now() + 10_000,
        "crashed runtime exit",
      );
      await until(
        () =>
          records(taskId).find(
            (r) => r.workId === interrupted.workId && r.intent.state === "held",
          ),
        Date.now() + 10_000,
        "uncertainty hold",
      );
      await service.stop();
      service = make();
      await service.start();
      const held = records(taskId).find((r) => r.workId === interrupted.workId);
      assert.equal(held?.intent.state, "held");
      assert.ok(
        held.holds.writer && held.holds.capacity && held.holds.uncertainty,
      );
      await delay(1000);
      assert.equal(
        evidence.turns.length,
        3,
        "Restart must not resubmit held work",
      );
      await until(
        () => pendingCallbacks === 0,
        Date.now() + 5000,
        "ended crash callbacks",
      );
      await service.recoverBoundTurnExecution({
        key: randomUUID(),
        assignmentId: held.binding.assignmentId,
        receipt: {
          kind: "bound-turn",
          workId: held.workId,
          workRevision: held.generation.workRevision,
          requestSequence: held.generation.requestSequence,
          threadId: held.intent.threadId,
          turnId: held.intent.turnId,
          processIdentity: held.processIdentity,
          termination: { kind: "process-exit" },
          effects: "settled",
          workspace: "preserved",
        },
      });
      assert.equal(
        evidence.turns.length,
        3,
        "Recovery alone must not submit a model turn",
      );
      await followUp(taskId, held, complete);
      const resumed = await until(
        () =>
          records(taskId).find(
            (r) =>
              r.workId !== seed.workId &&
              r.workId !== held.workId &&
              r.intent.state === "completed",
          ),
        Math.min(phaseDeadline, Date.now() + TURN_MS),
        "explicit recovery continuation",
      );
      assert.equal(
        resumed.intent.threadId,
        seed.intent.threadId,
        "Recover the last completed native conversation",
      );
      assert.equal(evidence.turns.length, 4);
      assert.equal(pendingCallbacks, 0);
      assert.ok(
        evidence.callbacks.some(
          (c) =>
            c.tool === "cab_report_result" &&
            c.success &&
            c.ended &&
            c.turnId === resumed.intent.turnId,
        ),
      );
      evidence.checks.recovery = {
        held: held.holds,
        explicitContinuation: true,
        sameThread: true,
        noBlindResubmission: true,
      };
      assert.ok(evidence.turns.every((t) => !t.expired));
      retainIdentity(resumed.processIdentity);
      assert.ok(!phaseExpired, "Lifecycle window expired");
      evidence.state = "passed";
    } catch (error) {
      evidence.state = "failed";
      evidence.failure = {
        name: error.name,
        message: error.message.split("\n")[0],
      };
      process.exitCode = 1;
    } finally {
      clearTimeout(phaseTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      try {
        retainIdentity(await runtime?.processIdentity?.());
        await service?.stop();
      } catch {
        evidence.cleanup.push({ service: "unverified" });
        evidence.state = "failed";
        process.exitCode = 1;
      }
      for (const identity of ownedProcesses.values()) {
        try {
          await end(identity);
          evidence.cleanup.push({ identity, exited: await gone(identity) });
        } catch {
          evidence.cleanup.push({ identity, exited: false });
          evidence.state = "failed";
          process.exitCode = 1;
        }
      }
      for (const workspace of workspaces)
        if (harness === "claude") await releaseClaudeTemporaryBase(workspace);
      grant = readGrant(path);
      const attempt = grant.attempts.findLast(
        (a) => a.harness === harness && a.facet === "lifecycle",
      );
      attempt.state = evidence.state;
      attempt.endedAt = Date.now();
      saveGrant(path, grant);
      writeFileSync(
        join(root, "evidence.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(
        `${harness}: lifecycle ${evidence.state}; retained ${join(root, "evidence.json")}`,
      );
    }
    if (evidence.cleanup.some((entry) => entry.exited !== true)) break;
  }
}
