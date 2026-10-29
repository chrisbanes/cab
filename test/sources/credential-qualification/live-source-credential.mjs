import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { OperatorAuth } from "../../../dist/src/standalone/operator-auth.js";
import { writeLaunchAgent } from "../../../dist/src/standalone/launchd.js";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value);

function compiledDigest(path) {
  const hash = createHash("sha256");
  const visit = (directory, relative = "") => {
    for (const name of readdirSync(directory).sort()) {
      const entry = join(directory, name),
        key = join(relative, name),
        state = lstatSync(entry);
      assert.equal(state.isSymbolicLink(), false);
      if (state.isDirectory()) visit(entry, key);
      else {
        assert.equal(state.isFile(), true);
        hash.update(key).update("\0").update(readFileSync(entry));
      }
    }
  };
  visit(path);
  return hash.digest("hex");
}

/** Root supplies already-read metadata; this function never discovers or reads a provider. */
export function validateMetadata(input) {
  assert.match(input.candidateSha, /^[a-f0-9]{40}$/);
  assert.ok(safeId(input.projectNodeId));
  assert.ok(safeId(input.issue.nodeId) && safeId(input.issue.repositoryId));
  assert.match(
    input.issue.repositoryName,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  assert.ok(Number.isSafeInteger(input.issue.number) && input.issue.number > 0);
  assert.equal(input.hasNextPage, false);
  assert.equal(input.returnedCount, 1);
  assert.deepEqual(input.returnedIssueIds, [input.issue.nodeId]);
  assert.equal(input.readinessLabel, "ready-for-agent");
  assert.ok(input.issue.labels.includes(input.readinessLabel));
  assert.ok(
    typeof input.filter === "string" &&
      input.filter.length > 0 &&
      input.filter.length <= 512,
  );
  assert.ok(
    !/[\r\n*]/.test(input.filter) &&
      !input.filter.includes(String.fromCharCode(0)) &&
      !/\bOR\b/i.test(input.filter),
  );
  assert.ok(input.filter.includes(`repo:${input.issue.repositoryName}`));
  assert.ok(
    input.filter.includes("label:ready-for-agent") ||
      input.filter.includes('label:"ready-for-agent"'),
  );
  assert.ok(/(?:^|\s)is:issue(?:\s|$)/.test(input.filter));
  return {
    candidateSha: input.candidateSha,
    projectNodeId: input.projectNodeId,
    filter: input.filter,
    issue: {
      nodeId: input.issue.nodeId,
      repositoryId: input.issue.repositoryId,
      repositoryName: input.issue.repositoryName,
      number: input.issue.number,
    },
    readinessLabel: input.readinessLabel,
  };
}

export function deadlineBudget(
  maxSeconds = 300,
  now = () => performance.now(),
) {
  assert.ok(
    Number.isFinite(maxSeconds) && maxSeconds > 30 && maxSeconds <= 300,
  );
  const end = now() + maxSeconds * 1000;
  return {
    remaining(cleanup = false) {
      return Math.max(0, end - now() - (cleanup ? 0 : 30_000));
    },
    timeout(limit, cleanup = false) {
      const remaining = this.remaining(cleanup);
      if (remaining <= 0) throw new Error("qualification-deadline");
      return Math.min(limit, remaining);
    },
  };
}

/** Same command sequence for production SQLite offline and the disposable live service. */
export async function qualifySource(
  transport,
  metadata,
  { lostPreviewReply = false } = {},
) {
  const projectId = randomUUID(),
    selectionId = "qualification-944";
  const created = await transport.command({
    type: "project.create",
    key: randomUUID(),
    projectId,
    name: "Source qualification",
    leadProfileId: null,
  });
  const configured = await transport.command({
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "gh:github.com",
    selections: [
      {
        id: selectionId,
        kind: "project",
        projectNodeId: metadata.projectNodeId,
        filter: metadata.filter,
      },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: metadata.readinessLabel }],
    },
  });
  const before = await transport.configuration(projectId);
  assert.equal(before.project.paused, true);
  assert.equal(before.routing.enabled, false);
  assert.deepEqual(before.repositories.links, []);
  assert.equal(before.source.selections[0].active, false);
  const preview = {
    type: "github.preview",
    key: randomUUID(),
    projectId,
    expectedVersion: configured.result.version,
    selectionId,
  };
  let activated;
  try {
    activated = await transport.command(preview, 60_000);
    if (lostPreviewReply) {
      const error = new Error("lost-preview-reply");
      error.code = "command-outcome-unknown";
      throw error;
    }
  } catch (error) {
    if (error.code !== "command-outcome-unknown") throw error;
    activated = await transport.command(preview, 30_000);
  }
  const after = await transport.configuration(projectId);
  assert.equal(after.source.version, configured.result.version);
  assert.equal(after.source.selections[0].active, true);
  assert.equal(
    await transport.importedCount(projectId),
    0,
    "activation is distinct from import",
  );
  await transport.refresh(90_000);
  assert.equal(
    await transport.importedCount(projectId),
    1,
    "bounded selection imports exactly the captured issue",
  );
  const imported = await transport.imported(metadata.issue.nodeId);
  assert.ok(
    imported &&
      imported.projectId === projectId &&
      imported.repositoryId === metadata.issue.repositoryId &&
      imported.issueNumber === metadata.issue.number,
  );
  assert.equal(imported.ready, true);
  const observations = await transport.observations();
  assert.equal(
    observations.projects
      .find((p) => p.projectId === projectId)
      ?.selections.find((s) => s.selectionId === selectionId)?.state,
    "complete",
  );
  return {
    projectId,
    selectionId,
    created,
    configured,
    preview,
    activated,
    imported: {
      nodeId: metadata.issue.nodeId,
      repositoryId: imported.repositoryId,
      issueNumber: imported.issueNumber,
    },
    observationsComplete: true,
  };
}

/** Inspect only the two owned terminal logs; matched bytes never leave this function. */
export function inspectPrivateLogs(paths) {
  try {
    for (const path of paths) {
      const state = lstatSync(path);
      if (!state.isFile() || state.isSymbolicLink())
        return { safe: false, reason: "log-unavailable" };
      if (state.size > 2 * 1024 * 1024)
        return { safe: false, reason: "log-too-large" };
      if (
        /(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|gho_fake-canary-942|offline-recovery-canary)/.test(
          readFileSync(path, "utf8"),
        )
      )
        return { safe: false, reason: "credential-pattern" };
    }
    return { safe: true, inspectedFiles: paths.length };
  } catch {
    return { safe: false, reason: "log-unavailable" };
  }
}

/** Exact private plist/program/arguments are required in addition to an observed PID. */
export function ownedJobMetadata(prepared, printed) {
  const field = (name) =>
    printed.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1]?.trim();
  const argumentsBlock = printed.match(
    /^\s*arguments = \{\n([\s\S]*?)^\s*\}/m,
  )?.[1];
  const argumentsList = argumentsBlock
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = [
    prepared.configuration.nodePath,
    prepared.configuration.cliPath,
    "operator",
    prepared.configuration.dataDirectory,
    String(prepared.configuration.port),
  ];
  if (
    field("path") !== prepared.plist ||
    field("program") !== prepared.configuration.nodePath ||
    JSON.stringify(argumentsList) !== JSON.stringify(expected)
  )
    return null;
  const pid = Number(field("pid"));
  return Number.isSafeInteger(pid) && pid > 1
    ? { pid, command: expected.join(" ") }
    : null;
}

/** Reconcile startup failure before any stop; label presence alone is never ownership. */
export async function reconcileJobOwnership(
  prepared,
  { print, commandLine, pidAlive, portClosed },
  known,
) {
  let observed;
  try {
    observed = await print();
  } catch {
    return { ownershipProven: false, ownershipUnknown: true };
  }
  const closed = await portClosed();
  if (observed.labelAbsent) {
    const pidExited = Boolean(
      known.owned && known.pid && !(await pidAlive(known.pid)),
    );
    return {
      labelAbsent: true,
      portClosed: closed,
      pidExited,
      ownershipProven: Boolean(known.owned),
      ownershipUnknown: !known.owned,
    };
  }
  const metadata = ownedJobMetadata(prepared, observed.stdout);
  if (!metadata)
    return {
      labelAbsent: false,
      portClosed: closed,
      pidExited: false,
      ownershipProven: false,
      ownershipUnknown: true,
    };
  let command;
  try {
    command = await commandLine(metadata.pid);
  } catch {
    return { ownershipProven: false, ownershipUnknown: true };
  }
  if (command.trim() !== metadata.command)
    return { ownershipProven: false, ownershipUnknown: true };
  known.pid = metadata.pid;
  known.owned = true;
  return {
    labelAbsent: false,
    portClosed: closed,
    pidExited: !(await pidAlive(metadata.pid)),
    ownershipProven: true,
    ownershipUnknown: false,
  };
}

export async function cleanupOwnedJob(
  {
    bootout,
    inspect,
    remove,
    verifyLogs = async () => ({ safe: true }),
    pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  budget,
) {
  let stopAttempted = false;
  while (budget.remaining(true) > 0) {
    let state;
    try {
      state = await inspect();
    } catch {
      return { disposition: "retained-ownership-unknown" };
    }
    if (!state.ownershipProven || state.ownershipUnknown)
      return { disposition: "retained-ownership-unknown", ...state };
    if (state.labelAbsent && state.portClosed && state.pidExited) {
      const logs = await verifyLogs();
      if (!logs.safe)
        return {
          disposition: "retained-log-inspection-failed",
          reason: logs.reason,
          ...state,
        };
      if (budget.remaining(true) <= 0)
        return { disposition: "retained-deadline" };
      try {
        await remove();
      } catch {
        return {
          disposition: "retained-removal-failed",
          logInspection: logs,
          ...state,
        };
      }
      return { disposition: "removed", logInspection: logs, ...state };
    }
    if (!state.labelAbsent && !stopAttempted) {
      if (budget.remaining(true) <= 0)
        return { disposition: "retained-deadline" };
      stopAttempted = true;
      await bootout().catch(() => {});
    }
    await pause(Math.min(100, budget.remaining(true)));
  }
  return { disposition: "retained-deadline" };
}

/** Exclusive private artifacts only. No gh, provider, model, or launchctl call. */
export async function prepareOnly(
  input,
  {
    lint = async (path) =>
      execute("/usr/bin/plutil", ["-lint", path], { timeout: 5000 }),
  } = {},
) {
  const metadata = validateMetadata(input.metadata);
  assert.ok(isAbsolute(input.root) && resolve(input.root) === input.root);
  assert.equal(realpathSync(dirname(input.root)), dirname(input.root));
  assert.equal(existsSync(input.root), false);
  assert.match(input.label, /^com\.[A-Za-z0-9.-]+944[A-Za-z0-9.-]*$/);
  mkdirSync(input.root, { mode: 0o700 });
  for (const part of ["data", "auth", "logs", "launch-agents"])
    mkdirSync(join(input.root, part), { mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  const configuration = {
    label: input.label,
    nodePath: input.nodePath,
    cliPath: input.cliPath,
    dataDirectory: join(input.root, "data"),
    authFile: join(input.root, "auth", "operator-auth.json"),
    origin: `http://127.0.0.1:${input.port}`,
    port: input.port,
    stdoutPath: join(input.root, "logs", "stdout.log"),
    stderrPath: join(input.root, "logs", "stderr.log"),
  };
  await OperatorAuth.initialize(configuration.authFile, password);
  const passwordFile = join(input.root, "auth", "qualification-password");
  writeFileSync(passwordFile, password, { flag: "wx", mode: 0o600 });
  const plist = join(input.root, "launch-agents", `${input.label}.plist`);
  writeLaunchAgent(configuration, plist);
  await lint(plist);
  const prepared = {
    format: "cab-source-944-v1",
    root: input.root,
    configuration,
    metadata,
    passwordFile,
    plist,
    plistDigest: digest(readFileSync(plist)),
    authDigest: digest(readFileSync(configuration.authFile)),
    cliDigest: digest(readFileSync(configuration.cliPath)),
    buildRoot: dirname(dirname(dirname(configuration.cliPath))),
    buildDigest: compiledDigest(
      dirname(dirname(dirname(configuration.cliPath))),
    ),
    candidateSha: metadata.candidateSha,
  };
  const manifest = join(input.root, "prepared.json");
  writeFileSync(manifest, JSON.stringify(prepared, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    manifest,
    manifestDigest: digest(readFileSync(manifest)),
    label: input.label,
    candidateSha: metadata.candidateSha,
  };
}

export function verifyPrepared(manifest, consumedRecord) {
  assert.equal(lstatSync(manifest).mode & 0o777, 0o600);
  const p = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(p.format, "cab-source-944-v1");
  assert.equal(realpathSync(p.root), p.root);
  assert.equal(digest(readFileSync(p.plist)), p.plistDigest);
  assert.equal(digest(readFileSync(p.configuration.authFile)), p.authDigest);
  assert.equal(digest(readFileSync(p.configuration.cliPath)), p.cliDigest);
  assert.equal(compiledDigest(p.buildRoot), p.buildDigest);
  assert.equal(lstatSync(p.passwordFile).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(consumedRecord, "utf8"));
  assert.equal(record.consumed, true);
  assert.equal(record.attempt, 1);
  assert.equal(record.maxSeconds, 300);
  assert.equal(record.maxModelTurns, 0);
  assert.equal(record.maxGitHubWrites, 0);
  assert.equal(record.root, p.root);
  assert.equal(record.manifest, manifest);
  assert.equal(record.label, p.configuration.label);
  assert.equal(record.candidateSha, p.candidateSha);
  assert.equal(record.manifestDigest, digest(readFileSync(manifest)));
  return p;
}

async function portClosed(port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", (e) => {
      socket.destroy();
      resolve(e.code === "ECONNREFUSED");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Root's durable consumed record is mandatory and checked immediately before bootstrap. */
export async function bootstrapPrepared(
  manifest,
  consumedRecord,
  beforeBootstrap,
  bootstrap,
) {
  assert.equal(typeof beforeBootstrap, "function");
  const prepared = verifyPrepared(manifest, consumedRecord);
  await beforeBootstrap({
    label: prepared.configuration.label,
    candidateSha: prepared.candidateSha,
    root: prepared.root,
  });
  verifyPrepared(manifest, consumedRecord);
  writeFileSync(join(prepared.root, "attempt-started"), "one attempt\n", {
    flag: "wx",
    mode: 0o600,
  });
  return bootstrap(prepared);
}

export async function runPreparedLive(manifest, consumedRecord) {
  const p = verifyPrepared(manifest, consumedRecord),
    budget = deadlineBudget();
  const startupEnd = performance.now() + 60_000;
  const startupTimeout = (limit) => {
    const remaining = Math.min(
      startupEnd - performance.now(),
      budget.remaining(),
    );
    if (remaining <= 0) throw new Error("qualification-startup-deadline");
    return Math.max(1, Math.floor(Math.min(limit, remaining)));
  };
  const job = `gui/${process.getuid()}/${p.configuration.label}`;
  let bootstrapAttempted = false,
    result,
    failure;
  const known = { pid: undefined, owned: false };
  const launch = async (args, limit = 5000) =>
    execute("/bin/launchctl", args, {
      timeout: budget.timeout(limit, true),
      maxBuffer: 64 * 1024,
    });
  try {
    // No asynchronous preparation follows the authority check before the first launch action.
    await bootstrapPrepared(
      manifest,
      consumedRecord,
      async () => verifyPrepared(manifest, consumedRecord),
      async () => {
        bootstrapAttempted = true;
        await launch(
          ["bootstrap", `gui/${process.getuid()}`, p.plist],
          startupTimeout(5000),
        );
      },
    );
    const readinessEnd = startupEnd;
    let ready = false;
    while (performance.now() < readinessEnd) {
      try {
        const r = await fetch(
          `${p.configuration.origin}/api/operator/session`,
          { signal: AbortSignal.timeout(startupTimeout(5000)) },
        );
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error("qualification-startup-deadline");
    const ownership = await reconcileJobOwnership(
      p,
      {
        print: async () => ({
          stdout: (await launch(["print", job], startupTimeout(5000))).stdout,
          labelAbsent: false,
        }),
        commandLine: async (pid) =>
          (
            await execute("/bin/ps", ["-p", String(pid), "-o", "command="], {
              timeout: startupTimeout(5000),
            })
          ).stdout,
        pidAlive: async (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if (error.code === "ESRCH") return false;
            throw error;
          }
        },
        portClosed: () =>
          portClosed(p.configuration.port, startupTimeout(1000)),
      },
      known,
    );
    assert.equal(ownership.ownershipProven, true);
    let cookie = "",
      csrf = "",
      authenticated = false;
    const request = async (path, body, limit = 5000) => {
      let response;
      try {
        response = await fetch(p.configuration.origin + path, {
          method: body ? "POST" : "GET",
          redirect: "error",
          headers: {
            ...(body
              ? {
                  "content-type": "application/json",
                  origin: p.configuration.origin,
                  "x-csrf-token": csrf,
                }
              : {}),
            ...(cookie ? { cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.floor(
                authenticated ? budget.timeout(limit) : startupTimeout(limit),
              ),
            ),
          ),
        });
      } catch {
        const error = new Error("qualification-request-unknown");
        if (body) error.code = "command-outcome-unknown";
        throw error;
      }
      const nextCookie = response.headers.get("set-cookie");
      if (nextCookie) cookie = nextCookie.split(";")[0];
      let value;
      try {
        value = await response.json();
      } catch {
        const error = new Error("qualification-response-unknown");
        if (body) error.code = "command-outcome-unknown";
        throw error;
      }
      if (!response.ok) {
        const error = new Error("qualification-operator-refusal");
        error.code = value.error?.code;
        throw error;
      }
      return value;
    };
    csrf = (await request("/api/operator/session")).csrfToken;
    csrf = (
      await request("/api/operator/login", {
        password: readFileSync(p.passwordFile, "utf8"),
      })
    ).csrfToken;
    startupTimeout(1);
    authenticated = true;
    const db = new DatabaseSync(
      join(p.configuration.dataDirectory, "standalone.sqlite"),
      { readOnly: true },
    );
    try {
      const transport = {
        command: (c, limit) => request("/api/operator/commands", c, limit),
        configuration: async (id) =>
          (
            await request(
              `/api/operator/projects/${id}/configuration`,
              undefined,
              30_000,
            )
          ).data,
        refresh: (limit) => request("/api/operator/source-refresh", {}, limit),
        observations: async () =>
          (await request("/api/operator/source-observations")).data,
        importedCount: async (id) =>
          Number(
            db
              .prepare(
                "SELECT count(*) n FROM external_items e JOIN domain_tasks t ON t.id=e.taskId WHERE t.projectId=?",
              )
              .get(id).n,
          ),
        imported: async (nodeId) => {
          const row = db
            .prepare(
              "SELECT e.containerId AS repositoryId,e.number AS issueNumber,t.projectId,t.ready FROM external_items e JOIN domain_tasks t ON t.id=e.taskId WHERE e.externalId=?",
            )
            .get(nodeId);
          return (
            row && {
              ...row,
              issueNumber: Number(row.issueNumber),
              ready: Boolean(row.ready),
            }
          );
        },
      };
      result = await qualifySource(transport, p.metadata);
      assert.equal(
        Number(db.prepare("SELECT count(*) n FROM domain_assignments").get().n),
        0,
      );
      assert.equal(
        Number(db.prepare("SELECT count(*) n FROM delivery_attempts").get().n),
        0,
      );
    } finally {
      db.close();
    }
  } catch {
    failure = "qualification-failed-or-unknown";
  }
  let cleanup = { disposition: "not-launched" };
  if (bootstrapAttempted)
    cleanup = await cleanupOwnedJob(
      {
        bootout: () => launch(["bootout", job]),
        inspect: () =>
          reconcileJobOwnership(
            p,
            {
              print: async () => {
                try {
                  return {
                    stdout: (await launch(["print", job])).stdout,
                    labelAbsent: false,
                  };
                } catch (error) {
                  if (
                    error.code === 113 &&
                    /Could not find service/.test(error.stderr ?? "")
                  )
                    return { labelAbsent: true };
                  throw error;
                }
              },
              commandLine: async (pid) =>
                (
                  await execute(
                    "/bin/ps",
                    ["-p", String(pid), "-o", "command="],
                    { timeout: budget.timeout(5000, true) },
                  )
                ).stdout,
              pidAlive: async (pid) => {
                try {
                  process.kill(pid, 0);
                  return true;
                } catch (error) {
                  if (error.code === "ESRCH") return false;
                  throw error;
                }
              },
              portClosed: () =>
                portClosed(
                  p.configuration.port,
                  Math.max(1, Math.floor(budget.timeout(1000, true))),
                ),
            },
            known,
          ),
        verifyLogs: async () =>
          inspectPrivateLogs([
            p.configuration.stdoutPath,
            p.configuration.stderrPath,
          ]),
        remove: async () => rmSync(p.root, { recursive: true }),
      },
      budget,
    );
  return {
    candidateSha: p.candidateSha,
    label: p.configuration.label,
    outcome:
      !failure && cleanup.disposition === "removed"
        ? "passed"
        : "failed-or-unknown",
    result: result
      ? {
          projectId: result.projectId,
          selectionId: result.selectionId,
          sourceVersion: result.configured.result.version,
          activated: true,
          imported: result.imported,
          observationsComplete: true,
        }
      : null,
    cleanup,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--prepare-only" && args.length === 2)
      console.log(
        JSON.stringify(
          await prepareOnly(JSON.parse(readFileSync(args[1], "utf8"))),
        ),
      );
    else if (
      args[0] === "--live" &&
      args[1] === "--one-attempt" &&
      args[2] === "--max-seconds" &&
      args[3] === "300" &&
      args[4] === "--prepared" &&
      args[6] === "--consumed-record" &&
      args.length === 8
    ) {
      const outcome = await runPreparedLive(args[5], args[7]);
      console.log(JSON.stringify(outcome));
      if (outcome.outcome !== "passed") process.exitCode = 1;
    } else throw new Error("invalid-interface");
  } catch {
    console.error(
      "Source qualification failed; preserve private preparation or ownership state.",
    );
    process.exitCode = 1;
  }
}
