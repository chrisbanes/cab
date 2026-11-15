import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const planDigest =
  "5d2a4fa84fc5ecab2a0d0e8f27181e43dc10aefa7ca8e4ddfeefa72dda81a245";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const grantDigest = (grant) => sha256(JSON.stringify(grant));
/** The granted runtimes, in qualification order. */
const grantedHarnesses = (grant) =>
  ["codex", "claude"].filter((harness) =>
    Object.hasOwn(grant.runtimes, harness),
  );

/** The digest is supplied separately by the controller after authorization, never minted here. */
export function validateGrant(input, grant, authorizedDigest) {
  assert.equal(input.live, true, "--live required");
  assert.equal(input.oneAttempt, true, "--one-attempt required");
  assert.ok(grant && typeof grant === "object", "controller grant required");
  assert.match(
    authorizedDigest ?? "",
    /^[0-9a-f]{64}$/,
    "separate authorized grant digest required",
  );
  assert.equal(
    grantDigest(grant),
    authorizedDigest,
    "grant differs from authorized bytes",
  );
  assert.deepEqual(
    Object.keys(grant).sort(),
    [
      "auth",
      "deadlineMs",
      "evidenceDir",
      "expiresAt",
      "grantId",
      "maxTurns",
      "planDigest",
      "root",
      "runtimes",
      "schema",
    ].sort(),
  );
  assert.equal(grant.schema, "cab.workspace-environment-grant/v1");
  assert.equal(grant.planDigest, planDigest);
  // Controller grant identifiers are opaque short slugs, such as `1727-t1-20261115-a`.
  assert.match(grant.grantId, /^[0-9a-z][0-9a-z-]{0,63}$/);
  assert.ok(grant.runtimes && typeof grant.runtimes === "object");
  const harnesses = grantedHarnesses(grant);
  // Both runtimes, or Claude alone when an earlier attempt's Codex pass is reused.
  assert.ok(
    harnesses.join() === "codex,claude" || harnesses.join() === "claude",
    "grant must name both runtimes or Claude alone",
  );
  // Four phases per granted runtime: eight turns for both, four for Claude alone.
  assert.equal(grant.maxTurns, 4 * harnesses.length);
  assert.equal(grant.deadlineMs, 900_000);
  assert.ok(
    Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > Date.now(),
    "grant expired",
  );
  assert.equal(grant.auth, "native-disposable-homes");
  assert.ok(
    isAbsolute(grant.root) &&
      resolve(grant.root) === grant.root &&
      dirname(grant.root) === realpathSync("/tmp") &&
      basename(grant.root).startsWith("cab-1727-runtime-") &&
      basename(grant.root).length > "cab-1727-runtime-".length &&
      !grant.root.includes("\0"),
  );
  assert.ok(
    isAbsolute(grant.evidenceDir) &&
      resolve(grant.evidenceDir) === grant.evidenceDir,
  );
  assert.deepEqual(Object.keys(grant.runtimes).sort(), [...harnesses].sort());
  for (const [harness, runtime] of Object.entries(grant.runtimes)) {
    assert.deepEqual(
      Object.keys(runtime).sort(),
      ["binary", "configHome", "effort", "model", "sha256", "version"].sort(),
    );
    assert.ok(isAbsolute(runtime.binary));
    assert.match(runtime.sha256, /^[0-9a-f]{64}$/);
    assert.ok(
      typeof runtime.version === "string" && runtime.version.length > 0,
    );
    // null selects the installed runtime's own default, as a profile without overrides does.
    for (const value of [runtime.model, runtime.effort])
      assert.ok(
        value === null || (typeof value === "string" && value.length > 0),
      );
    assert.equal(runtime.configHome, join(grant.root, `${harness}-home`));
  }
  return grant;
}

export function assertMeasurement(observed, expected) {
  assert.equal(observed.cwd, expected.workspace);
  assert.equal(observed.scratch, join(expected.workspace, "scratch"));
  assert.equal(observed.nonce, expected.nonce);
  assert.equal(observed.sentinel, expected.nonce);
  if (expected.harness === "codex")
    assert.equal(observed.tmp, observed.scratch);
  else {
    // cab sets CLAUDE_CODE_TMPDIR to the managed base; the CLI moves both to its per-user child.
    const shell = join(expected.claudeBase, `claude-${process.getuid()}`);
    assert.equal(observed.claudeBase, shell);
    assert.equal(observed.tmp, shell);
  }
}

async function bounded(promise, milliseconds) {
  assert.ok(milliseconds > 0, "qualification deadline exhausted");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("qualification deadline exhausted")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Imports of runtime, SDK, native auth and production stores occur only after the grant gate. */
export async function runQualification(input, dependencies = {}) {
  const grant = validateGrant(input, input.grant, input.authorizedDigest);
  const initialize = dependencies.initialize ?? initializeProduction;
  const started = performance.now();
  const deadline = Math.min(Date.now() + grant.deadlineMs, grant.expiresAt);
  const remaining = () =>
    Math.min(
      deadline - Date.now(),
      grant.deadlineMs - (performance.now() - started),
    );
  const allowDispatch = () =>
    assert.ok(
      remaining() > 120_000,
      "dispatch window ended; preserve reconciliation reserve",
    );
  const checkpointPath = join(grant.evidenceDir, "checkpoint.json");
  const io = dependencies.io ?? {
    exists: existsSync,
    save: (value) => {
      const temporary = `${checkpointPath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, checkpointPath);
    },
  };
  assert.equal(
    io.exists(checkpointPath),
    false,
    "attempt already exists; reconcile without redispatch",
  );
  const checkpoint = {
    grantId: grant.grantId,
    authorizedDigest: input.authorizedDigest,
    planDigest,
    startedAt: Date.now(),
    deadline,
    turnsUsed: 0,
    remainingTurns: grant.maxTurns,
    records: [],
    active: null,
    pass: false,
    settlement: "not-started",
    cleanup: "retained",
    elapsedMs: 0,
  };
  io.save(checkpoint);
  let backend;
  try {
    backend = await bounded(
      initialize(grant),
      Math.max(1, remaining() - 120_000),
    );
    for (const harness of grantedHarnesses(grant)) {
      let threadA;
      for (const phase of ["A-old", "B", "A-follow-up", "A-new"]) {
        allowDispatch();
        const workspace = join(
          grant.root,
          harness,
          phase === "A-follow-up" ? "A-old" : phase,
        );
        const nonce = randomUUID();
        checkpoint.turnsUsed++;
        checkpoint.remainingTurns--;
        assert.ok(checkpoint.turnsUsed <= grant.maxTurns);
        const record = {
          harness,
          phase,
          workspace,
          nonce,
          threadId: phase === "B" ? null : (threadA ?? null),
          workId: randomUUID(),
          turnId: null,
          callbacks: { active: 0, ended: 0 },
          state: "reserved",
        };
        checkpoint.active = record;
        io.save(checkpoint); // Consume before any model dispatch, including a lost start response.
        const result = await bounded(
          backend.turn(
            record,
            (identity) => {
              Object.assign(record, identity);
              io.save(checkpoint);
            },
            allowDispatch,
          ),
          Math.max(1, remaining() - 120_000),
        );
        assertMeasurement(result.measurement, {
          ...record,
          claudeBase: result.claudeBase,
        });
        assert.equal(result.status, "completed");
        assert.equal(record.callbacks.active, 0);
        assert.ok(record.threadId && record.turnId);
        if (phase === "A-old") threadA = record.threadId;
        if (phase === "A-follow-up" || phase === "A-new")
          assert.equal(record.threadId, threadA);
        record.state = "ended";
        checkpoint.records.push(record);
        checkpoint.active = null;
        io.save(checkpoint);
        if (phase === "A-follow-up") {
          checkpoint.runtimeOperation = {
            kind: "restart",
            harness,
            state: "pending",
          };
          io.save(checkpoint);
          await bounded(
            backend.restart(harness),
            Math.max(1, remaining() - 120_000),
          );
          checkpoint.runtimeOperation = null;
          io.save(checkpoint);
        }
      }
    }
    checkpoint.settlement = "ended";
    checkpoint.pass = true;
  } catch (error) {
    checkpoint.failure =
      error instanceof Error ? error.message : "qualification failed";
    checkpoint.settlement =
      checkpoint.active || checkpoint.runtimeOperation ? "unknown" : "ended";
    io.save(checkpoint);
    if (backend && checkpoint.active) {
      try {
        const settled = await bounded(
          backend.reconcile(checkpoint.active, {
            deadline,
            remaining,
            maxReads: 12,
            onRead: (observation) => {
              checkpoint.active.reconciliationReads ??= [];
              checkpoint.active.reconciliationReads.push(observation);
              io.save(checkpoint);
            },
          }),
          Math.max(1, remaining()),
        );
        checkpoint.settlement =
          settled && checkpoint.active.callbacks.active === 0
            ? "ended"
            : "unknown";
      } catch {
        checkpoint.settlement = "unknown";
      }
    }
  } finally {
    checkpoint.elapsedMs = Math.round(performance.now() - started);
    io.save(checkpoint);
    if (backend && checkpoint.settlement === "ended") {
      try {
        checkpoint.cleanup = await bounded(
          backend.stop(),
          Math.max(1, remaining()),
        );
      } catch {
        checkpoint.cleanup =
          "stop-unconfirmed; retain fixture and process identities";
        checkpoint.pass = false;
        checkpoint.failure ??=
          "runtime shutdown did not settle within the attempt";
      }
      io.save(checkpoint);
    }
  }
  return checkpoint;
}

export async function initializeProduction(grant, overrides = {}) {
  // No file here is an installed credential/config path; the controller prepares native fixture homes.
  const privateDirectory = (path) => {
    const state = lstatSync(path);
    assert.ok(
      state.isDirectory() &&
        !state.isSymbolicLink() &&
        state.uid === process.getuid() &&
        (state.mode & 0o077) === 0,
    );
    assert.equal(realpathSync(path), path);
  };
  privateDirectory(grant.root);
  privateDirectory(grant.evidenceDir);
  for (const runtime of Object.values(grant.runtimes)) {
    assert.equal(
      sha256(readFileSync(runtime.binary)),
      runtime.sha256,
      "runtime binary changed",
    );
    privateDirectory(runtime.configHome);
  }
  const [
    { DatabaseSync },
    { Store },
    { DomainStore },
    { CoordinationStore },
    { ExecutionState },
    { CodexRuntime },
    { ClaudeRuntime, claudeTemporaryBase },
    { SchedulerStore },
  ] = await Promise.all([
    import("node:sqlite"),
    import("../../../dist/src/core/store.js"),
    import("../../../dist/src/core/domain.js"),
    import("../../../dist/src/core/coordination.js"),
    import("../../../dist/src/standalone/state.js"),
    import("../../../dist/src/standalone/codex.js"),
    import("../../../dist/src/standalone/claude.js"),
    import("../../../dist/src/standalone/scheduler.js"),
  ]);
  mkdirSync(join(grant.root, "native-tmp"), { mode: 0o700 });
  const database = join(grant.root, "qualification.sqlite");
  assert.equal(existsSync(database), false, "fixture database already exists");
  let db = new DatabaseSync(database);
  let domain, state, coordination, scheduler;
  const openStores = () => {
    db.exec("PRAGMA foreign_keys=ON");
    new Store(db).ensureHost("workspace-environment-qualification");
    domain = new DomainStore(db);
    domain.migrate();
    scheduler = new SchedulerStore(db);
    state = new ExecutionState(db);
    coordination = new CoordinationStore(db);
    coordination.migrate();
  };
  try {
    openStores();
    const projectId = randomUUID(),
      profileId = randomUUID(),
      claudeProfileId = randomUUID();
    const execute = (command) =>
      domain.execute({ key: randomUUID(), actor: "operator", ...command });
    if (grant.runtimes.codex)
      execute({
        type: "profile.create",
        profileId,
        name: "Environment qualification",
        instructions: "Synthetic sentinel only",
        capabilities: "shell",
        runtime: {
          harness: "codex",
          model: grant.runtimes.codex.model,
          reasoningEffort: grant.runtimes.codex.effort,
        },
      });
    execute({
      type: "profile.create",
      profileId: claudeProfileId,
      name: "Claude environment qualification",
      instructions: "Synthetic sentinel only",
      capabilities: "shell",
      runtime: {
        harness: "claude",
        model: grant.runtimes.claude.model,
        reasoningEffort: grant.runtimes.claude.effort,
      },
    });
    execute({
      type: "project.create",
      projectId,
      name: "Environment qualification",
      leadProfileId: grant.runtimes.codex ? profileId : claudeProfileId,
    });
    execute({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    const tasks = new Map(),
      runtimes = new Map(),
      activeRecords = new Map();
    const environment = (harness) => {
      const env = {
        PATH: process.env.PATH,
        HOME: grant.runtimes[harness].configHome,
        USER: process.env.USER,
        TMPDIR: join(grant.root, "native-tmp"),
      };
      if (harness === "codex") env.CODEX_HOME = grant.runtimes.codex.configHome;
      else {
        env.CLAUDE_CONFIG_DIR = grant.runtimes.claude.configHome;
        // Claude Code 2.1.325 suffixes its Keychain item with a hash of CLAUDE_CONFIG_DIR unless
        // this is empty, which selects the native login; HOME stays the service user's, as in cab.
        env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
        env.HOME = userInfo().homedir;
      }
      return env;
    };
    const safety = (harness) => ({
      recordTerminal: (input) => state.recordRuntimeTerminal(input, harness),
      terminal: (...args) => state.runtimeTerminal(...args),
      terminalForWait: (...args) => state.runtimeTerminalForWait(...args),
      registerThreadTools: (...args) =>
        state.registerRuntimeThreadTools(...args),
      threadQualification: (...args) =>
        state.runtimeThreadQualification(...args),
      recordThreadQualification: (input) =>
        state.recordRuntimeThreadQualification(input),
      nativeEndpointHistory: (identity) =>
        coordination.runtimeNativeEndpointHistory(identity),
      recordTurnProcess: ({ threadId, processIdentity }) =>
        state.recordTurnProcess(threadId, processIdentity),
    });
    const startRuntime = async (harness) => {
      const definition = grant.runtimes[harness];
      const runtime = overrides.createRuntime
        ? overrides.createRuntime({
            harness,
            definition,
            safety: safety(harness),
            environment: environment(harness),
          })
        : harness === "codex"
          ? new CodexRuntime(definition.binary, {
              safety: safety(harness),
              spawnEnvironment: () => environment(harness),
            })
          : new ClaudeRuntime({
              safety: safety(harness),
              claude: {
                turnEnvironment: () => ({ env: environment(harness) }),
              },
              resolveExecutable: async () => definition.binary,
            });
      runtime.onUnexpectedRequest(() => {
        const active = activeRecords.get(harness);
        if (active) {
          active.record.unexpected = true;
          active.save({ unexpected: true });
        }
      });
      runtime.onToolCall?.(async () => {
        const active = activeRecords.get(harness);
        if (!active) throw Error("Callback outside qualification turn");
        active.record.callbacks.active++;
        active.save({ callbacks: active.record.callbacks });
        try {
          return {
            success: false,
            text: "No cab callback is authorized by the environment probe",
          };
        } finally {
          active.record.callbacks.active--;
          active.record.callbacks.ended++;
          active.save({ callbacks: active.record.callbacks });
        }
      });
      runtimes.set(harness, runtime);
      try {
        await runtime.start();
      } finally {
        activeRecords.get(harness)?.save({
          processIdentity: runtime.processIdentity?.() ?? null,
          runtimeGeneration: runtime.currentUserInputGeneration?.() ?? null,
        });
      }
      return runtime;
    };
    return {
      async turn(record, save, allowDispatch = () => {}) {
        allowDispatch();
        activeRecords.set(record.harness, { record, save });
        let runtime = runtimes.get(record.harness);
        if (!runtime) runtime = await startRuntime(record.harness);
        const key = `${record.harness}:${record.phase === "B" ? "B" : "A"}`;
        let task = tasks.get(key);
        if (!task) {
          const taskId = randomUUID();
          execute({
            type: "task.create",
            projectId,
            taskId,
            title: key,
            outcome: "Observe directory variables",
            ready: true,
          });
          if (record.harness === "claude")
            execute({
              type: "project.configure",
              projectId,
              expectedVersion: domain.project(projectId).version,
              leadProfileId: claudeProfileId,
            });
          const assignment = domain.ensureLeadAssignment(taskId);
          task = { taskId, assignmentId: assignment.id };
          tasks.set(key, task);
        }
        if (record.phase !== "A-follow-up") {
          const parent = dirname(record.workspace);
          if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
          mkdirSync(record.workspace, { mode: 0o700 });
          mkdirSync(join(record.workspace, "scratch"), { mode: 0o700 });
        }
        const definition = grant.runtimes[record.harness];
        const settings = {
          model: definition.model,
          reasoningEffort: definition.effort,
          scratchDirectory: join(record.workspace, "scratch"),
        };
        save({ processIdentity: runtime.processIdentity?.() ?? null });
        let unavailable;
        for (let attempt = 0; attempt < 120; attempt++) {
          allowDispatch();
          unavailable = await runtime.preflightTurn?.({
            workspace: record.workspace,
            settings,
          });
          if (!unavailable) break;
          await new Promise((ready) => setTimeout(ready, 250));
        }
        assert.equal(unavailable, undefined, unavailable);
        if (!record.threadId)
          record.threadId = await runtime.startThread(
            record.workspace,
            [],
            settings,
          );
        else
          await runtime.resumeThread(
            record.threadId,
            [],
            settings,
            record.workspace,
          );
        save({
          taskId: task.taskId,
          assignmentId: task.assignmentId,
          threadId: record.threadId,
        });
        const command = `node -e 'const f=require("node:fs"),p=require("node:path"); const n=${JSON.stringify(record.nonce)}; f.writeFileSync(p.join(process.env.TMPDIR,n),n); f.writeFileSync("observation.json",JSON.stringify({cwd:process.cwd(),scratch:process.env.CAB_SCRATCH_DIR,tmp:process.env.TMPDIR,claudeBase:process.env.CLAUDE_CODE_TMPDIR,nonce:n,sentinel:f.readFileSync(p.join(process.env.TMPDIR,n),"utf8")}));'`;
        const prompt = `Run this exact synthetic shell command once, then finish. No other file, network, agent or tool action. ${command}`;
        const assignment = domain.assignment(task.assignmentId);
        const intent = state.create(record.workId, prompt, record.workspace);
        state.bindTask(
          record.workId,
          {
            taskId: task.taskId,
            assignmentId: assignment.id,
            assignmentVersion: assignment.version,
            instructionsRevision: assignment.instructionsRevision,
            profileRevision: assignment.profileRevision,
          },
          record.harness,
        );
        const request = scheduler.ensure({
          requestKey: record.workId,
          workId: record.workId,
          kind: "assignment",
          taskId: task.taskId,
          projectId,
          assignmentId: assignment.id,
          taskVersion: domain.task(task.taskId).version,
          assignmentVersion: assignment.version,
          instructionsRevision: assignment.instructionsRevision,
          profileRevision: assignment.profileRevision,
          prompt,
          workspace: record.workspace,
          previousWorkId: null,
        });
        save({ requestSequence: request.sequence });
        assert.equal(
          state.begin(intent.id, {
            projectId,
            requestSequence: request.sequence,
            processIdentity: runtime.processIdentity?.() ?? null,
          }),
          true,
        );
        assert.equal(state.bindThread(intent.id, record.threadId), true);
        save({ intentId: intent.id, state: "submitting" });
        allowDispatch();
        record.turnId = await runtime.startTurn(
          record.threadId,
          record.workspace,
          prompt,
          settings,
          { networkAccess: false },
        );
        const generation = runtime.currentUserInputGeneration();
        assert.ok(generation);
        assert.equal(
          state.bindTurn(intent.id, record.turnId, generation),
          true,
        );
        save({
          turnId: record.turnId,
          runtimeGeneration: generation,
          state: "running",
        });
        const status = await runtime.waitForTurn(
          record.threadId,
          record.turnId,
        );
        assert.notEqual(
          record.unexpected,
          true,
          "Unexpected runtime approval or callback",
        );
        assert.equal(record.callbacks.active, 0);
        assert.equal(record.callbacks.ended, 0);
        if (status === "completed")
          state.complete(intent.id, record.threadId, record.turnId);
        else state.hold(intent.id, "Environment qualification turn failed");
        const measurement = JSON.parse(
          readFileSync(join(record.workspace, "observation.json"), "utf8"),
        );
        activeRecords.delete(record.harness);
        return {
          status,
          measurement,
          claudeBase: claudeTemporaryBase(record.workspace),
        };
      },
      async restart(harness) {
        await runtimes.get(harness).stop();
        runtimes.delete(harness);
        db.close();
        db = new DatabaseSync(database);
        openStores();
      },
      async reconcile(
        record,
        { deadline, remaining = () => deadline - Date.now(), maxReads, onRead },
      ) {
        if (!record.threadId || !record.turnId || !record.runtimeGeneration)
          return false;
        const runtime = runtimes.get(record.harness);
        try {
          await bounded(
            runtime.interruptTurn(record.threadId, record.turnId),
            Math.min(30_000, remaining()),
          );
        } catch {
          /* Preserve uncertainty until exact evidence says otherwise. */
        }
        for (let reads = 0; reads < maxReads && remaining() > 0; reads++) {
          const evidence = state.runtimeTerminal(
            record.threadId,
            record.turnId,
            record.runtimeGeneration,
          );
          onRead?.({
            at: Date.now(),
            status: evidence?.firstStatus ?? null,
            conflicted: evidence?.conflicted ?? null,
          });
          if (
            evidence?.firstStatus &&
            !evidence.conflicted &&
            record.callbacks.active === 0
          ) {
            if (record.intentId)
              state.hold(
                record.intentId,
                "Qualification failed; exact terminal observed, result retained",
              );
            return true;
          }
          await new Promise((resolveWait) =>
            setTimeout(resolveWait, Math.min(1000, Math.max(1, remaining()))),
          );
        }
        if (record.intentId)
          state.hold(
            record.intentId,
            "Qualification settlement unknown; preserve runtime and workspace",
          );
        return false;
      },
      async stop() {
        for (const runtime of runtimes.values()) await runtime.stop();
        db.close();
        return "runtimes-stopped; disposable database, homes and synthetic files retained for controller inspection";
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { parseArgs } = await import("node:util");
  try {
    const { values } = parseArgs({
      options: {
        live: { type: "boolean" },
        "one-attempt": { type: "boolean" },
        "grant-file": { type: "string" },
      },
      strict: true,
    });
    // Loading the non-secret grant is not credential access. No runtime module is imported yet.
    const grant = values["grant-file"]
      ? JSON.parse(readFileSync(values["grant-file"], "utf8"))
      : undefined;
    const result = await runQualification({
      live: values.live,
      oneAttempt: values["one-attempt"],
      grant,
      authorizedDigest:
        process.env.CAB_WORKSPACE_QUALIFICATION_AUTHORIZED_GRANT_SHA256,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.pass ? 0 : 1;
  } catch (error) {
    console.error(
      `Refusing workspace environment qualification: ${error.message}`,
    );
    process.exitCode = 2;
  }
}
