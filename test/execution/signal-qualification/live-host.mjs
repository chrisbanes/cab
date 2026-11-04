// Owned service child for live-signals only. Importing this module never starts it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  Journal,
  LIMITS,
  bounded,
  fenceAdapters,
  reasonOf,
  trace,
} from "./live-control.mjs";

/**
 * First delivery stays long so the turn is still running when signalled; a resumed successor
 * already holds the request and must stay well inside the 120 s turn deadline.
 */
export const SIGNAL_BRIEF =
  "Disposable repository-free qualification. Use no shell, file, network, delegation or other tools. Write a long original story (about 1500 words), then call cab_report_result once with summary SIGNAL QUALIFICATION DONE and end the turn. If this conversation already contains this request (you are continuing after an interruption), do not write or finish the story: reply with one sentence, call cab_report_result once with summary SIGNAL QUALIFICATION DONE, and end the turn.";
export const CONTINUATION_MESSAGE =
  "Explicit continuation: call cab_report_result once with summary CONTINUATION DONE and end this existing conversation. No other tools.";
let leaving = false;
/** `offline` swaps only the runtime executable/SDK for the model-free fixtures; it never accepts a live grant. */
export async function host(config, offline = false) {
  const { root, harness, generation, journalFile, grant } = config;
  assert.ok(process.send && ["codex", "claude"].includes(harness));
  if (offline)
    assert.ok(
      grant.authorizedLive === false &&
        grant.offlineFixture === true &&
        isAbsolute(config.offline?.executable ?? "") &&
        config.offline.executable.startsWith(`${config.sessionRoot}/`),
      "offline fixture host refused",
    );
  else
    assert.ok(
      grant.authorizedLive === true && config.offline === undefined,
      "root live allowance missing",
    );
  // Claude's env token reference must be excluded from the runtime snapshot taken at
  // service start, then readable at turn time; Codex hosts never see the value.
  const tokenName = grant.claudeTokenRef?.startsWith("env:")
    ? grant.claudeTokenRef.slice(4)
    : undefined;
  const token = tokenName ? process.env[tokenName] : undefined;
  if (tokenName) delete process.env[tokenName];
  let tokenRestored = false;
  const restoreToken = (stage) => {
    if (tokenRestored || token === undefined) return;
    process.env[tokenName] = token;
    tokenRestored = true;
    log("claude-token-restored", { stage });
  };
  // Driver death closes IPC: stop through the same service signal path.
  process.once("disconnect", () => {
    if (!leaving) process.kill(process.pid, "SIGTERM");
  });
  const journal = new Journal(journalFile);
  assert.equal(journal.entries()[0].identity.grantId, grant.grantId);
  assert.deepEqual(grant.limits, LIMITS);
  assert.equal(realpathSync(root), root);
  assert.ok(root.startsWith(`${realpathSync(config.sessionRoot)}/`));
  const log = (event, detail) =>
    trace(join(root, "trace.jsonl"), event, detail);
  if (offline) {
    // Fixture children append to an existing trace; the runtime env inherits this path.
    process.env.SIGNAL_TRACE = join(root, "fixture-trace.jsonl");
    // Optional per-generation fake turn script (e.g. complete, then hold), read by both fakes.
    if (config.offline.turns)
      process.env.SIGNAL_TURNS = config.offline.turns.join(",");
    writeFileSync(process.env.SIGNAL_TRACE, "", { flag: "a", mode: 0o600 });
  }
  const readyDeadline = Math.min(journal.deadline, config.readyDeadline);
  const fence = fenceAdapters(journal, { caseId: config.caseId });
  const { StandaloneService } = await import(
    "../../../dist/src/standalone/service.js"
  );
  const { CodexRuntime } = await import(
    "../../../dist/src/standalone/codex.js"
  );
  const { ClaudeRuntime } = await import(
    "../../../dist/src/standalone/claude.js"
  );
  const { captureProcessIdentity } = await import(
    "../../../dist/src/standalone/termination.js"
  );
  const { runServiceEntry } = await import(
    "../../../dist/src/standalone/cli.js"
  );
  const { OperatorAuth } = await import(
    "../../../dist/src/standalone/operator-auth.js"
  );
  const { OperatorApi } = await import(
    "../../../dist/src/standalone/operator-api.js"
  );
  const { LocalOperatorHttp } = await import(
    "../../../dist/src/standalone/operator.js"
  );
  const { OperatorWebBundle, OperatorWebBoundary } = await import(
    "../../../dist/src/standalone/operator-web.js"
  );
  const { main: cliMain } = await import("../../../dist/src/cli/main.js");
  const { identity, ownedRoot } = await import("./live-signals.mjs");
  ownedRoot(config.sessionRoot, config.marker);
  let runtime,
    http,
    auth,
    origin,
    cliToken,
    cliTokenFile,
    loseObservation = false;
  const active = new Set();
  // Claude's durable binding (process recorded before prompt release), per thread for the turn in flight.
  const bound = new Map();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.prependOnceListener(signal, () =>
      log("signal-receipt", { signal }),
    );
  const noteProcess = async (pid) => {
    const captured = await captureProcessIdentity(pid);
    assert.ok(captured, "runtime identity unavailable");
    const owned = identity(pid);
    assert.equal(owned.ppid, process.pid, "adapter child ownership");
    // Durable before IPC: the driver's close() reads these rows if IPC is lost.
    log("adapter-process", owned);
    process.send({ event: "owned-runtime", identity: owned });
    return captured;
  };
  const service = new StandaloneService(
    join(root, "data"),
    (context) => {
      const safety = {
        ...context.safety,
        recordTerminal: (input) => {
          log("terminal", {
            threadId: input.threadId,
            turnId: input.turnId,
            status: input.status,
          });
          return context.safety.recordTerminal(input);
        },
        ...(context.safety.recordTurnProcess
          ? {
              recordTurnProcess: (input) => {
                const recorded = context.safety.recordTurnProcess(input);
                if (recorded) {
                  log("turn-process-recorded", {
                    threadId: input.threadId,
                    processIdentity: input.processIdentity,
                  });
                  bound.set(input.threadId, input.processIdentity);
                }
                return recorded;
              },
            }
          : {}),
      };
      // The factory runs after the service's start-time environment snapshot and before any
      // dispatch, including a restarted generation's shutdown successor. Restore here only
      // when the reference (and so its exclusion) is already configured: "empty" means a
      // configured reference whose variable is absent; "not-configured" waits for start.
      if (harness === "claude" && token !== undefined) {
        const probe = context.claude.turnEnvironment();
        if ("unavailable" in probe && probe.code === "empty")
          restoreToken("factory-reference-configured");
      }
      runtime =
        harness === "codex"
          ? new CodexRuntime(
              offline ? config.offline.executable : grant.codexExecutable,
              {
                ...context,
                // Offline fixtures never link cab's Codex home to the operator's login.
                ...(offline ? { codex: undefined } : {}),
                safety,
                captureProcessIdentity: noteProcess,
              },
            )
          : new ClaudeRuntime({
              safety,
              claude: context.claude,
              sdk: fencedSdk,
              captureProcessIdentity: noteProcess,
              ...(offline
                ? {
                    resolveExecutable: async () => config.offline.executable,
                    sandboxSelfTest: async () => true,
                  }
                : {}),
            });
      fence.runtime(runtime, harness, generation, readyDeadline);
      const fencedStart = runtime.startTurn;
      runtime.startTurn = (thread, ...args) => {
        bound.delete(thread);
        return fencedStart(thread, ...args);
      };
      const interrupt = runtime.interruptTurn.bind(runtime);
      runtime.interruptTurn = async (threadId, turnId) => {
        log("protocol-interrupt", { threadId, turnId });
        await bounded(
          () => interrupt(threadId, turnId),
          Math.min(journal.deadline, Date.now() + LIMITS.cleanupMs),
          "interrupt",
        );
        log("interrupt-ack", { threadId, turnId });
      };
      const onTool = runtime.onToolCall.bind(runtime);
      runtime.onToolCall = (listener) =>
        onTool(async (call) => {
          log("callback-enter", {
            threadId: call.threadId,
            turnId: call.turnId,
            callId: call.callId,
            tool: call.tool,
          });
          try {
            return await listener(call);
          } finally {
            log("callback-ended", {
              threadId: call.threadId,
              turnId: call.turnId,
              callId: call.callId,
            });
          }
        });
      const conversation = runtime.onConversationEvent?.bind(runtime);
      if (conversation)
        runtime.onConversationEvent = (listener) =>
          conversation((event) => {
            if (event.kind === "started" || event.kind === "delta") {
              if (!active.has(`${event.threadId}:${event.turnId}`))
                log("active-bound", {
                  threadId: event.threadId,
                  turnId: event.turnId,
                });
              active.add(`${event.threadId}:${event.turnId}`);
            }
            listener(event);
          });
      const wait = runtime.waitForTurn.bind(runtime);
      runtime.waitForTurn = (thread, turn) => {
        const deadline = Math.min(journal.deadline, Date.now() + LIMITS.turnMs);
        if (loseObservation)
          return bounded(
            async () => {
              // Claude has no early text event: its durable binding is the activity point.
              while (
                !active.has(`${thread}:${turn}`) &&
                !(harness === "claude" && bound.has(thread))
              )
                await new Promise((r) => setTimeout(r, 20));
              throw Error(
                "injected-observation-loss; actual adapter process remains owned",
              );
            },
            deadline,
            "uncertain-observation",
          );
        return bounded(() => wait(thread, turn), deadline, "terminal");
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
  const rawSdk =
    harness !== "claude"
      ? null
      : offline
        ? (
            await import(
              "../../../dist/test/execution/signal-qualification/sdk.js"
            )
          ).signalSdk(
            join(root, "fixture-trace.jsonl"),
            config.offline.executable,
            // Restarted generations settle, as a successor does.
            generation > 0,
            // Upper bound of the observed 0.48-0.85 s CLI boot (issue-822 probes).
            { saveDelayMs: 850 },
            config.offline.turns,
          )
        : await import("@anthropic-ai/claude-agent-sdk");
  const fencedSdk = rawSdk
    ? fence.sdk({
        ...rawSdk,
        query: (input) =>
          rawSdk.query({
            ...input,
            options: {
              ...input.options,
              spawnClaudeCodeProcess: (options) => {
                const child = input.options.spawnClaudeCodeProcess(options);
                child.once("spawn", () => {
                  try {
                    const owned = identity(child.pid);
                    child.once("exit", (code, signal) =>
                      log("adapter-child-exit", { ...owned, code, signal }),
                    );
                    assert.equal(owned.ppid, process.pid);
                    // Durable first (settings reads included): close() reads these rows.
                    log("adapter-process", owned);
                    process.send({ event: "owned-runtime", identity: owned });
                  } catch {
                    child.kill("SIGTERM");
                    process.send({
                      event: "failed",
                      reason: "spawn-identity-unavailable",
                    });
                  }
                });
                return child;
              },
            },
          }),
      })
    : null;
  const command = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
  const prompt = SIGNAL_BRIEF;
  const idsFile = join(root, "ids.json");
  // Uncertain journeys continue an existing conversation: only a completed task lead can be
  // resumed (a completed worker refuses messages), so there the case harness is the lead and
  // runs the seed. Clean cases keep a worker and an opposite-harness lead that never runs.
  const uncertain = config.kind === "uncertain";
  const SEED_OUTCOME =
    "Call cab_report_result exactly once with summary SEED DONE, then end the turn. No other tools.";
  const seed = async () => {
    const ids = {
      projectId: randomUUID(),
      taskId: randomUUID(),
      assignmentId: randomUUID(),
      profileId: randomUUID(),
      leadId: randomUUID(),
      inboxTaskId: randomUUID(),
      inboxAssignmentId: randomUUID(),
    };
    for (const [profileId, name, target] of [
      [ids.profileId, "Signal worker", harness],
      uncertain
        ? [ids.leadId, "Signal lead", harness]
        : [ids.leadId, "Unused lead", harness === "codex" ? "claude" : "codex"],
    ])
      command({
        type: "profile.create",
        profileId,
        name,
        instructions: "Follow the assigned brief only.",
        capabilities: "reporting",
        runtime:
          target === "codex"
            ? { harness: target }
            : {
                harness: target,
                model: grant.claudeModel,
                // The model-free fixture advertises only "high".
                reasoningEffort: offline ? "high" : "low",
              },
      });
    command({
      type: "project.create",
      projectId: ids.projectId,
      name: "Disposable signal qualification",
      leadProfileId: ids.leadId,
    });
    command({
      type: "project.configure",
      projectId: ids.projectId,
      expectedVersion: 1,
      paused: false,
    });
    command({
      type: "routing.configure",
      projectId: ids.projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [ids.profileId],
    });
    for (const [taskId, assignmentId, inbox] of [
      [ids.taskId, ids.assignmentId, false],
      [ids.inboxTaskId, ids.inboxAssignmentId, true],
    ]) {
      command({
        type: "task.create",
        projectId: ids.projectId,
        taskId,
        title: inbox ? "Stopped inbox preservation" : "Signal qualification",
        outcome:
          uncertain && !inbox ? SEED_OUTCOME : "Bounded qualification only",
        ready: false,
      });
      await service.provisionTask(taskId);
      if (!(uncertain && !inbox))
        command({
          type: "assignment.create",
          actor: "agent",
          projectId: ids.projectId,
          taskId,
          assignmentId,
          profileId: ids.profileId,
          brief: prompt,
          resultDestination: "operator",
          requesterAssignmentId: null,
        });
      if (inbox) await service.stopTask(taskId);
      else
        command({
          type: "task.configure",
          projectId: ids.projectId,
          taskId,
          expectedVersion: 1,
          ready: true,
        });
    }
    if (uncertain) {
      // The scheduler creates and dispatches the ready task's lead; read, never create, it.
      const lead = await bounded(
        async () => {
          while (true) {
            const binding = service
              .domain()
              .leadBindings()
              .find((b) => b.taskId === ids.taskId);
            const work = binding
              ? service
                  .list()
                  .find((r) => r.workId.includes(String(binding.assignmentId)))
              : undefined;
            if (work) return { id: String(binding.assignmentId), work };
            await new Promise((r) => setTimeout(r, 20));
          }
        },
        Math.min(journal.deadline, Date.now() + LIMITS.readyMs),
        "lead dispatch",
      );
      ids.assignmentId = lead.id;
      ids.workId = lead.work.workId;
    } else ids.workId = `assignment:${ids.assignmentId}:initial`;
    writeFileSync(idsFile, JSON.stringify(ids), { mode: 0o600 });
    return ids;
  };
  const keychain = new Map();
  const cli = async (args) => {
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    let out = "";
    stdout.on("data", (c) => {
      out += c;
    });
    stderr.resume();
    const code = await bounded(
      () =>
        cliMain(args, {
          env: {
            CAB_CLI_CONFIG_DIR: join(root, `cli-${generation}`),
            CAB_LOCAL_STATE: join(root, "no-discovery"),
          },
          stdout,
          stderr,
          stdin: new PassThrough(),
          platform: "darwin",
          now: Date.now,
          keychain: () => ({
            get: async (account) => {
              assert.ok(keychain.has(account));
              return keychain.get(account);
            },
            set: async (account, value) => {
              keychain.set(account, value);
            },
            delete: async (account) => {
              keychain.delete(account);
            },
          }),
          fetch: (input, init) => {
            assert.equal(
              new URL(input).origin,
              origin,
              "non-disposable CLI endpoint",
            );
            return fetch(input, init);
          },
        }),
      Math.min(journal.deadline, Date.now() + LIMITS.readyMs),
      "CLI",
    );
    // Do not export CLI output/diagnostics: only validated JSON envelopes and exit code.
    let data;
    try {
      data = JSON.parse(out);
    } catch {
      data = null;
    }
    return { code, data };
  };
  // The CLI's fixed error-code token only; its message may quote input.
  const cliCode = (result) => {
    const code = result.data?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9-]{0,48}$/.test(code)
      ? code
      : "unknown";
  };
  const runCli = (args) =>
    cli([...args, "--connection", "owned", "--output", "json"]);
  const message = async (taskId, assignmentId, body, name) => {
    const file = join(root, name);
    writeFileSync(file, body, { mode: 0o600 });
    const result = await runCli([
      "task",
      "message",
      taskId,
      "--to",
      assignmentId,
      "--expected-version",
      String(service.domain().assignment(assignmentId).version),
      "--message-file",
      file,
    ]);
    assert.equal(result.code, 0, `CLI message refused: ${cliCode(result)}`);
    return result;
  };
  // Feedback to the task lead: an ordinary message while it is pending or running, a
  // follow-up that resumes its existing conversation once it has completed.
  // The route is traced and checked before anything is sent, so a wrong one spends no turn.
  const feedLead = async (ids, body, name, expected) => {
    const lead = service.domain().assignment(ids.assignmentId);
    const route = lead.state === "completed" ? "follow-up" : "message";
    log("lead-feedback-route", {
      name,
      route,
      expected,
      leadState: lead.state,
      leadVersion: lead.version,
    });
    assert.equal(
      route,
      expected,
      `${name}: lead feedback route ${route}, expected ${expected}`,
    );
    if (route === "message")
      return message(ids.taskId, ids.assignmentId, body, name);
    const file = join(root, name);
    writeFileSync(file, body, { mode: 0o600 });
    const result = await runCli([
      "task",
      "follow-up",
      ids.taskId,
      "--expected-version",
      String(lead.version),
      "--message-file",
      file,
    ]);
    assert.equal(result.code, 0, `CLI follow-up refused: ${cliCode(result)}`);
    return result;
  };
  const operations = {
    seed,
    inspect: () => {
      fence.check();
      const ids = JSON.parse(readFileSync(idsFile));
      return {
        list: service.list(),
        recovery: service.recoveryForTask(ids.taskId),
        active: [...active],
        stopped: service.isTaskStopped(ids.taskId),
        paused: Boolean(service.domain().project(ids.projectId).paused),
      };
    },
    inbox: async () => {
      const ids = JSON.parse(readFileSync(idsFile));
      await message(
        ids.inboxTaskId,
        ids.inboxAssignmentId,
        "Pending stopped inbox identity; do not resume this task.",
        "inbox.txt",
      );
    },
    followup: async () => {
      loseObservation = true;
      const ids = JSON.parse(readFileSync(idsFile));
      // Resumes the completed seed conversation.
      await feedLead(ids, prompt, "followup.txt", "follow-up");
    },
    holds: async () => {
      const ids = JSON.parse(readFileSync(idsFile));
      await service.stopTask(ids.taskId);
      const project = service.domain().project(ids.projectId);
      command({
        type: "project.configure",
        projectId: ids.projectId,
        expectedVersion: project.version,
        paused: true,
      });
    },
    get: async () => {
      const ids = JSON.parse(readFileSync(idsFile));
      return runCli(["recovery", "get", ids.assignmentId]);
    },
    prepare: async () => {
      const ids = JSON.parse(readFileSync(idsFile));
      const held = service
        .recoveryForTask(ids.taskId)
        .find((r) => r.intent.state === "held");
      assert.ok(held);
      const file = join(root, "receipt-evidence.json");
      writeFileSync(
        file,
        JSON.stringify({
          schema: "cab.cli.recovery-evidence/v1",
          receipt: {
            termination: { kind: "process-exit" },
            effects: "settled",
            workspace: "preserved",
          },
        }),
        { mode: 0o600 },
      );
      return runCli([
        "recovery",
        "prepare",
        "bound-turn-recover",
        ids.assignmentId,
        "--work",
        held.workId,
        "--evidence-file",
        file,
        "--out",
        join(root, "recovery.json"),
      ]);
    },
    submit: () =>
      runCli(["recovery", "submit", "--file", join(root, "recovery.json")]),
    continue: async () => {
      const ids = JSON.parse(readFileSync(idsFile));
      assert.equal((await runCli(["task", "resume", ids.taskId])).code, 0);
      const project = service.domain().project(ids.projectId);
      command({
        type: "project.configure",
        projectId: ids.projectId,
        expectedVersion: project.version,
        paused: false,
      });
      loseObservation = false;
      // A message after recovery records the recovery continuation; a follow-up never does.
      await feedLead(ids, CONTINUATION_MESSAGE, "continue.txt", "message");
    },
    stop: async () => {
      await service.stop();
      leaving = true;
      process.disconnect();
    },
  };
  process.on("message", async (request) => {
    if (!request?.id || !operations[request.operation]) return;
    try {
      const value = await operations[request.operation]();
      process.send?.({ id: request.id, value });
    } catch (error) {
      process.send?.({
        id: request.id,
        error: "owned-operation-refused",
        reason: reasonOf(error, request.operation),
      });
    }
  });
  const start = service.start.bind(service);
  service.start = async () => {
    await bounded(start, readyDeadline, "service readiness");
    if (harness === "claude") {
      if (service.domain().claudeTokenReference() === null) {
        command({
          type: "claude-token.configure",
          credentialRef: grant.claudeTokenRef,
        });
        log("claude-token-reference-configured");
      }
      // Generation 0: no helper child could inherit the value before its exclusion existed.
      restoreToken("after-reference-configured");
    }
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = probe.address().port;
    assert.notEqual(port, 8787);
    await new Promise((resolve) => probe.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    const authFile = join(root, "operator.auth");
    if (generation === 0) await OperatorAuth.initialize(authFile, randomUUID());
    auth = await OperatorAuth.open({ authFile, origin });
    const bundle = await OperatorWebBundle.open(
      new URL("../../../dist/operator", import.meta.url).pathname,
    );
    http = new LocalOperatorHttp(auth, {
      credentials: service.operatorCredentials(),
      localAccess: service.localAccess(),
      web: new OperatorWebBoundary(bundle, new OperatorApi(service, [root])),
    });
    await bounded(() => http.start(port), readyDeadline, "operator readiness");
    cliToken = service
      .operatorCredentials()
      .issue({ name: "signal-driver", scope: "read-write" }).token;
    const tokenFile = join(root, `cli-token-${generation}`);
    writeFileSync(tokenFile, cliToken, { mode: 0o600 });
    assert.equal(
      (
        await cli([
          "auth",
          "login",
          "--connection",
          "owned",
          "--url",
          origin,
          "--token-file",
          tokenFile,
        ])
      ).code,
      0,
    );
    // A token-file login keeps reading this file; it is removed when the host stops.
    cliTokenFile = tokenFile;
    process.send({ event: "ready", origin });
  };
  const stop = service.stop.bind(service);
  service.stop = async () => {
    log("service-handler");
    await http?.stop();
    await auth?.close();
    await stop();
    if (cliTokenFile) unlinkSync(cliTokenFile);
    log("service-stopped");
  };
  await runServiceEntry(["serve", join(root, "data")], () => service);
  leaving = true;
  if (process.connected) process.disconnect();
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    assert.ok(
      ["--live", "--offline-fixture"].includes(process.argv[2]),
      "explicit child opt-in required",
    );
    await host(
      JSON.parse(readFileSync(process.argv[3], "utf8")),
      process.argv[2] === "--offline-fixture",
    );
  } catch (error) {
    process.send?.({
      event: "failed",
      reason: "owned-host-failed",
      detail: reasonOf(error, "host"),
    });
    process.exitCode = 1;
    leaving = true;
    if (process.connected) process.disconnect();
  }
}
