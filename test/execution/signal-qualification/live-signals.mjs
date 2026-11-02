import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  Journal,
  Owner,
  LIMITS,
  bounded,
  fixed,
  parseArgs,
  reasonOf,
  trace,
} from "./live-control.mjs";

export const CASES = Object.freeze(
  ["codex", "claude"].flatMap((harness) => [
    {
      id: `${harness}-group-SIGINT`,
      harness,
      kind: "clean",
      signal: "group-SIGINT",
      turns: 2,
    },
    {
      id: `${harness}-PID-SIGTERM`,
      harness,
      kind: "clean",
      signal: "PID-SIGTERM",
      turns: 2,
    },
    { id: `${harness}-uncertain`, harness, kind: "uncertain", turns: 3 },
  ]),
);
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function identity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const row = execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="],
    { encoding: "utf8", timeout: 3000 },
  ).trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(row);
  assert.ok(match, "owned identity missing");
  const boot = execFileSync(
    "/usr/sbin/sysctl",
    ["-n", "kern.bootsessionuuid"],
    { encoding: "utf8", timeout: 3000 },
  ).trim();
  return {
    pid: +match[1],
    ppid: +match[2],
    pgid: +match[3],
    birth: match[4],
    boot,
  };
}
export function groupRows(pgid) {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    timeout: 3000,
  })
    .trim()
    .split("\n")
    .map((line) => {
      const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim());
      return m && { pid: +m[1], ppid: +m[2], pgid: +m[3], birth: m[4] };
    })
    .filter((row) => row && row.pgid === pgid);
}
export function verifySignalTarget(owned, current, members, driver) {
  assert.deepEqual(current, owned, "reused or changed process identity");
  assert.notEqual(owned.pgid, driver.pgid, "driver in target group");
  assert.equal(owned.pid, owned.pgid, "service is not isolated group leader");
  assert.equal(owned.ppid, driver.pid, "not an exclusively owned child");
  assert.deepEqual(
    members,
    [
      {
        pid: owned.pid,
        ppid: owned.ppid,
        pgid: owned.pgid,
        birth: owned.birth,
      },
    ],
    "foreign group member",
  );
}
export function safeEndpoint(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(
    url.port &&
      url.port !== "8787" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "production or unsafe endpoint",
  );
  return url.origin;
}
export function ownedRoot(root, marker) {
  const canonical = realpathSync(root);
  assert.equal(canonical, root);
  assert.ok(canonical.startsWith(`${realpathSync(tmpdir())}/cab-signal-live-`));
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.equal(
    readFileSync(join(root, "owner"), "utf8"),
    marker,
    "non-disposable root",
  );
  return canonical;
}
const sameProcess = (a, b) =>
  a.pid === b.pid &&
  a.pgid === b.pgid &&
  a.birth === b.birth &&
  a.boot === b.boot;
function absent(owned) {
  const boot = execFileSync(
    "/usr/sbin/sysctl",
    ["-n", "kern.bootsessionuuid"],
    { encoding: "utf8", timeout: 3000 },
  ).trim();
  assert.equal(boot, owned.boot, "boot changed");
  try {
    process.kill(owned.pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}
export async function endExact(owned, deadline) {
  if (absent(owned)) return true;
  assert.ok(
    sameProcess(identity(owned.pid), owned),
    "cleanup identity conflict",
  );
  process.kill(owned.pid, "SIGTERM");
  const graceful = Math.min(deadline - 1000, Date.now() + 10000);
  while (Date.now() < graceful && !absent(owned)) await pause(25);
  if (absent(owned)) return true;
  assert.ok(
    sameProcess(identity(owned.pid), owned),
    "cleanup identity conflict",
  );
  process.kill(owned.pid, "SIGKILL");
  while (Date.now() < deadline && !absent(owned)) await pause(25);
  return absent(owned);
}
/** Independent read-only durable oracle; no runtime/service private fields and no database writes. */
export function snapshot(root) {
  const db = new DatabaseSync(join(root, "data", "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = (table) =>
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...row }));
    return {
      intents: rows("execution_intents"),
      resolutions: rows("execution_shutdown_resolutions"),
      identities: rows("execution_recovery_identities"),
      inbox: db
        .prepare(
          "SELECT eventId, recipientAssignmentId, sequence FROM coordination_inbox_events ORDER BY sequence",
        )
        .all(),
      writers: rows("task_writer_admissions"),
      capacity: rows("execution_capacity_reservations"),
      receipts: rows("execution_recovery_receipts"),
      results: rows("coordination_results"),
    };
  } finally {
    db.close();
  }
}
function stableBinding(before, after, workId) {
  const original = before.intents.find((r) => r.workId === workId);
  assert.ok(original?.threadId && original.workspace);
  const successors = after.resolutions.filter(
    (r) => r.interruptedWorkId === workId,
  );
  assert.equal(
    successors.length,
    1,
    "one durable shutdown resolution required",
  );
  const successor = after.intents.find(
    (r) => r.workId === successors[0].requeueWorkId,
  );
  assert.equal(successor?.state, "completed");
  assert.equal(successor.threadId, original.threadId);
  assert.equal(successor.workspace, original.workspace);
  return successor;
}
const inboxSame = (before, after) => {
  assert.ok(before.inbox.length, "pending inbox calibration missing");
  for (const item of before.inbox)
    assert.deepEqual(
      after.inbox.find((r) => r.eventId === item.eventId),
      item,
    );
  assert.equal(
    new Set(after.inbox.map((r) => r.eventId)).size,
    after.inbox.length,
  );
};
export function cleanProof(before, after, final, workId) {
  const successor = stableBinding(before, after, workId);
  inboxSame(before, after);
  inboxSame(after, final);
  assert.deepEqual(
    final.intents.map((r) => [r.workId, r.state]),
    after.intents.map((r) => [r.workId, r.state]),
  );
  assert.deepEqual(final.resolutions, after.resolutions);
  assert.deepEqual(final.results, after.results);
  assert.equal(
    final.intents.filter((r) => r.workId === successor.workId).length,
    1,
  );
}
/** Each stage deadline begins before the backend is allowed to spawn or call an adapter. */
export async function runCases(backend, journal, cases = CASES) {
  const results = [];
  for (const testCase of cases) {
    const owner = new Owner(backend.now ?? Date.now);
    const startCount = journal
      .entries()
      .filter((r) => r.kind === "reserve").length;
    let failure,
      stage = "start";
    try {
      const deadline = () =>
        Math.min(
          journal.deadline - LIMITS.cleanupMs,
          (backend.now ?? Date.now)() + LIMITS.readyMs,
        );
      const start = (generation, label) => {
        const readyDeadline = deadline();
        return owner.acquire(
          () => backend.start(testCase, generation, readyDeadline),
          readyDeadline,
          label,
          (host) => backend.close(host),
        );
      };
      let host = await start(0, testCase.id);
      stage = "seed";
      const ids = await backend.call(host, "seed");
      stage = "inbox";
      await backend.call(host, "inbox");
      if (testCase.kind === "clean") {
        stage = "active-bound";
        await backend.active(host, ids.workId, deadline());
        const before = await backend.snapshot(host);
        stage = "signal";
        await backend.signal(host, testCase.signal);
        await backend.close(host);
        stage = "restart1";
        host = await start(1, `${testCase.id}-restart1`);
        stage = "successor-completed";
        await backend.completed(host, deadline(), 2);
        const after = await backend.snapshot(host);
        await backend.close(host);
        stage = "restart2";
        host = await start(2, `${testCase.id}-restart2`);
        stage = "no-duplicate";
        await backend.observe(host, LIMITS.observeMs);
        const final = await backend.snapshot(host);
        stage = "clean-proof";
        cleanProof(before, after, final, ids.workId);
      } else {
        stage = "seed-completed";
        await backend.completed(host, deadline(), 1);
        stage = "followup";
        await backend.call(host, "followup");
        stage = "bound-held";
        await backend.held(host, deadline());
        const before = await backend.snapshot(host);
        stage = "get-ineligible";
        const get = await backend.call(host, "get");
        assert.equal(get.code, 0);
        assert.ok(
          JSON.stringify(get.data).includes("termination-live"),
          "live process must be ineligible",
        );
        assert.equal(
          (await backend.call(host, "prepare")).code,
          4,
          "prepare before exit refused",
        );
        stage = "end-runtime";
        await backend.endRuntime(host);
        // Independent holds come after the exact end: a Stop interrupt would otherwise end a
        // per-turn Claude CLI itself, leaving no live process for get to refuse.
        stage = "holds";
        await backend.call(host, "holds");
        await backend.close(host);
        stage = "recovery-restart";
        host = await start(1, `${testCase.id}-recovery`);
        stage = "prepare-submit-replay";
        assert.equal((await backend.call(host, "prepare")).code, 0);
        const recovered = await backend.call(host, "submit");
        assert.equal(recovered.code, 0);
        const replay = await backend.call(host, "submit");
        assert.equal(replay.code, 0);
        assert.deepEqual(replay.data.data.receipt, recovered.data.data.receipt);
        const held = await backend.call(host, "inspect");
        assert.equal(held.stopped, true);
        assert.equal(held.paused, true);
        const settled = await backend.snapshot(host);
        inboxSame(before, settled);
        assert.equal(
          journal.entries().filter((r) => r.kind === "reserve").length -
            startCount,
          2,
          "recovery dispatched work",
        );
        stage = "continue";
        await backend.call(host, "continue");
        await backend.completed(host, deadline(), 3);
        stage = "uncertain-proof";
        const final = await backend.snapshot(host);
        inboxSame(before, final);
        const original = before.intents.find((r) => r.workId === ids.workId);
        const continued = final.intents.filter(
          (r) => r.threadId === original.threadId && r.state === "completed",
        );
        assert.ok(continued.length >= 2, "existing conversation not continued");
        assert.equal(
          final.receipts.length,
          before.receipts.length + 1,
          "one recovery receipt",
        );
      }
      stage = "turn-count";
      assert.equal(
        journal.entries().filter((r) => r.kind === "reserve").length -
          startCount,
        testCase.turns,
        "unexpected model start count",
      );
    } catch (error) {
      failure = reasonOf(error, stage);
      // Private, capped store reasons explain e.g. a turn that never became active.
      const store = backend.diagnostics?.(testCase.id);
      if (store?.length) failure.store = store;
      // Durable first: no further model start may follow an ordinary case failure.
      try {
        journal.event("failed", {
          reason: "case-failed",
          caseId: testCase.id,
          stage,
        });
      } catch {}
    }
    const cleanup = await owner.cleanup(
      Math.min(
        journal.deadline,
        (backend.now ?? Date.now)() + LIMITS.cleanupMs,
      ),
    );
    if (!failure && !cleanup.verified)
      try {
        journal.event("failed", {
          reason: "cleanup-unverified",
          caseId: testCase.id,
        });
      } catch {}
    results.push({ caseId: testCase.id, failure, cleanup });
    if (failure || !cleanup.verified)
      throw Object.assign(Error("qualification stopped; no automatic retry"), {
        results,
      });
  }
  return results;
}

/** `options.entry`/`options.offline` select the model-free fixture host for offline tests only. */
export function realBackend(root, marker, journalFile, grant, options = {}) {
  const journal = new Journal(journalFile),
    driver = identity(process.pid),
    roots = new Map(),
    open = new Set(),
    storeReasons = new Map(),
    entry = options.entry ?? "--live";
  let shuttingDown = false;
  const tokenName = grant.claudeTokenRef?.startsWith("env:")
    ? grant.claudeTokenRef.slice(4)
    : undefined;
  const call = (host, operation) =>
    bounded(
      () =>
        new Promise((resolve, reject) => {
          const id = randomUUID();
          const listener = (message) => {
            if (message.id !== id) return;
            host.child.off("message", listener);
            if (message.error) {
              host.failures.push(message.reason ?? { stage: operation });
              reject(fixed("host operation refused"));
            } else resolve(message.value);
          };
          host.child.on("message", listener);
          host.child.send({ id, operation }, (error) => {
            if (error) {
              host.child.off("message", listener);
              reject(fixed("host unavailable"));
            }
          });
        }),
      Math.min(
        journal.deadline - LIMITS.cleanupMs,
        Date.now() + LIMITS.readyMs,
      ),
      operation,
    );
  const wait = (host, predicate, deadline, label) =>
    bounded(
      async () => {
        while (true) {
          if (host.failed) throw fixed("host failed");
          const value = await call(host, "inspect");
          storeReasons.set(host.caseId, listReasons(value.list));
          if (predicate(value)) return value;
          await pause(25);
        }
      },
      deadline,
      label,
    );
  return {
    async start(testCase, generation, readyDeadline) {
      // A host forked after shutdown began would miss closeAll().
      if (shuttingDown) throw fixed("driver shutting down");
      ownedRoot(root, marker);
      let caseRoot = roots.get(testCase.id);
      if (!caseRoot) {
        caseRoot = mkdtempSync(join(root, `${testCase.id}-`));
        roots.set(testCase.id, caseRoot);
      }
      const config = join(caseRoot, `host-${generation}.json`);
      writeFileSync(
        config,
        JSON.stringify({
          root: caseRoot,
          ...testCase,
          generation,
          journalFile,
          grant,
          readyDeadline,
          caseId: testCase.id,
          sessionRoot: root,
          marker,
          ...(options.offline
            ? {
                offline: {
                  executable: options.offline.executable,
                  // Fake turn script for this case generation (offline fixtures only).
                  turns: options.offline.script?.(testCase, generation),
                },
              }
            : {}),
        }),
        { mode: 0o600 },
      );
      const env = { ...process.env };
      if (testCase.harness !== "claude" && tokenName) delete env[tokenName];
      const spawnedAt = Date.now();
      const child = fork(
        fileURLToPath(new URL("./live-host.mjs", import.meta.url)),
        [entry, config],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env,
        },
      );
      // Retain creation handle immediately, even if readiness rejects.
      const host = {
        child,
        root: caseRoot,
        caseId: testCase.id,
        harness: testCase.harness,
        generation,
        runtimes: [],
        failures: [],
        failed: false,
        exited: false,
        spawnedAt,
      };
      open.add(host);
      host.closed = new Promise((resolve) => child.once("close", resolve));
      child.once("exit", () => {
        host.exited = true;
      });
      child.on("message", (message) => {
        if (
          message.event === "owned-runtime" &&
          !host.runtimes.some((r) => sameProcess(r, message.identity))
        )
          host.runtimes.push(message.identity);
        if (message.event === "failed") {
          host.failed = true;
          host.failures.push(message.detail ?? { stage: message.reason });
          if (message.reason === "spawn-identity-unavailable")
            host.identityIncomplete = true;
        }
      });
      const captured = new Promise((resolve, reject) => {
        child.once("spawn", () => {
          try {
            host.owned = identity(child.pid);
            resolve();
          } catch {
            reject(fixed("child identity unavailable"));
          }
        });
        child.once("error", () => reject(fixed("spawn failed")));
      });
      host.ready = bounded(
        () =>
          Promise.all([
            captured,
            new Promise((resolve, reject) => {
              child.on("message", (message) => {
                if (message.event === "ready") {
                  try {
                    safeEndpoint(message.origin);
                    resolve();
                  } catch {
                    reject(fixed("unsafe host endpoint"));
                  }
                }
                if (message.event === "failed")
                  reject(fixed("readiness failed"));
              });
              child.once("error", () => reject(fixed("spawn failed")));
              child.once("exit", () =>
                reject(fixed("host exited before readiness")),
              );
            }),
          ]),
        readyDeadline,
        "readiness",
      );
      void host.ready.catch(() => {});
      // Return the owned handle before readiness; acquire() can therefore never lose it.
      return host;
    },
    async call(host, op) {
      await host.ready;
      return call(host, op);
    },
    async active(host, workId, deadline) {
      await host.ready;
      if (host.harness !== "claude")
        return wait(
          host,
          (s) =>
            s.list.some(
              (r) =>
                r.workId === workId &&
                r.state === "running" &&
                s.active.includes(`${r.threadId}:${r.turnId}`),
            ),
          deadline,
          "active-bound",
        );
      // Claude emits text events only per complete block, so its barrier is the durable
      // binding (running turn, recorded process identity, consumed reservation, live
      // process) plus the CLI's saved prompt in its session file.
      let proof;
      const reads = {};
      const value = await wait(
        host,
        (s) => {
          const durable = pollRead(() => snapshot(host.root), reads);
          if (!durable) return false;
          proof = boundTurn({
            intents: s.list,
            identities: durable.identities,
            entries: journal.entries(),
            owned: [
              ...host.runtimes,
              ...(host.owned ? adapterRows(host.root, host.owned) : []),
            ],
            caseId: host.caseId,
            generation: host.generation,
            workId,
            live: (p) => {
              try {
                return sameProcess(identity(p.pid), p);
              } catch {
                return false;
              }
            },
            // A signal before the CLI saves the prompt leaves nothing to resume.
            saved: (thread) => savedPrompt(host.root, thread),
          });
          return Boolean(proof);
        },
        deadline,
        "active-bound",
      );
      trace(join(host.root, "trace.jsonl"), "active-bound-durable", {
        ...proof,
        textEvents: value.active.length,
      });
      return value;
    },
    async completed(host, deadline, expected) {
      await host.ready;
      return wait(
        host,
        (s) =>
          journal
            .entries()
            .filter(
              (r) => r.kind === "reserve" && r.binding.caseId === host.caseId,
            ).length >= expected &&
          s.list.some((r) => r.state === "completed") &&
          !s.list.some(
            (r) => r.state === "running" || r.state === "submitting",
          ),
        Math.min(journal.deadline, deadline + LIMITS.turnMs - LIMITS.readyMs),
        "completed",
      );
    },
    async held(host, deadline) {
      return wait(
        host,
        (s) =>
          s.recovery.some(
            (r) =>
              r.intent.state === "held" &&
              r.intent.threadId &&
              r.intent.turnId &&
              r.processIdentity,
          ),
        deadline,
        "bound-held",
      );
    },
    async snapshot(host) {
      // After a spent turn (e.g. right after the active barrier) a transient BUSY retries.
      const durable = await readDurable(
        host.root,
        Math.min(journal.deadline, Date.now() + LIMITS.readyMs),
      );
      trace(join(host.root, "trace.jsonl"), "durable-snapshot", {
        resolutions: durable.resolutions.length,
        receipts: durable.receipts.length,
        inbox: durable.inbox.map((r) => r.eventId),
        intents: durable.intents.map((r) => ({
          workId: r.workId,
          state: r.state,
          threadId: r.threadId,
          turnId: r.turnId,
        })),
      });
      return durable;
    },
    async signal(host, signal) {
      const members = groupRows(host.owned.pgid);
      verifySignalTarget(host.owned, identity(host.child.pid), members, driver);
      trace(join(host.root, "trace.jsonl"), "signal-proof", {
        target: host.owned,
        members,
        driver,
        signal,
      });
      process.kill(
        signal === "group-SIGINT" ? -host.owned.pgid : host.owned.pid,
        signal === "group-SIGINT" ? "SIGINT" : "SIGTERM",
      );
      await bounded(
        async () => {
          while (!host.exited) await pause(20);
        },
        Math.min(journal.deadline, Date.now() + LIMITS.cleanupMs),
        "signal shutdown",
      );
    },
    async endRuntime(host) {
      const held = await call(host, "inspect");
      const target = held.recovery.find(
        (r) => r.intent.state === "held",
      )?.processIdentity;
      assert.ok(target);
      const owned = host.runtimes.find(
        (r) => String(r.pid) === target.processId,
      );
      assert.ok(owned, "unowned bound runtime");
      assert.equal(await endExact(owned, Date.now() + LIMITS.cleanupMs), true);
    },
    async observe(host, ms) {
      await host.ready;
      const before = journal
        .entries()
        .filter((r) => r.kind === "reserve").length;
      await bounded(
        () => pause(ms),
        Math.min(journal.deadline, Date.now() + ms + 1000),
        "no duplicate",
      );
      assert.equal(
        journal.entries().filter((r) => r.kind === "reserve").length,
        before,
      );
    },
    async close(host) {
      if (host.closing) return host.closing;
      host.closing = (async () => {
        const deadline = Math.min(
          journal.deadline,
          Date.now() + LIMITS.cleanupMs,
        );
        const record = { servicePid: host.child.pid, failures: host.failures };
        try {
          if (!host.owned) {
            record.identity = "unknown";
            if (!host.exited) {
              // Signal only our own child of this boot, born no earlier than this fork.
              try {
                const now = identity(host.child.pid);
                assert.equal(now.ppid, driver.pid);
                assert.equal(now.boot, driver.boot);
                assert.ok(
                  Date.parse(now.birth) >=
                    Math.floor(host.spawnedAt / 1000) * 1000 - 1000,
                );
                record.observed = now;
                host.child.kill("SIGTERM");
                try {
                  await bounded(
                    () => host.closed,
                    Math.min(deadline, Date.now() + 10000),
                    "unknown-identity-child-stop",
                  );
                } catch {
                  assert.ok(
                    sameProcess(identity(host.child.pid), now),
                    "cleanup identity conflict",
                  );
                  host.child.kill("SIGKILL");
                  await bounded(
                    () => host.closed,
                    deadline,
                    "unknown-identity-child-exit",
                  );
                }
              } catch (error) {
                record.unresolved = reasonOf(error, "unknown-identity-close");
              }
            }
            record.handleExitObserved = host.exited;
            record.verified = false;
            return false;
          }
          record.service = host.owned;
          let ended = false;
          try {
            ended = await endExact(host.owned, deadline);
            await bounded(() => host.closed, deadline, "owned-child-close");
          } catch (error) {
            ended = false;
            record.serviceError = reasonOf(error, "service-close");
          }
          // IPC can be lost; fsynced adapter rows are the durable identity source.
          for (const row of adapterRows(host.root, host.owned))
            if (!host.runtimes.some((r) => sameProcess(r, row)))
              host.runtimes.push(row);
          record.runtimes = [];
          for (const child of host.runtimes) {
            let absent = false;
            try {
              absent = await endExact(child, deadline);
            } catch (error) {
              record.runtimeErrors ??= [];
              record.runtimeErrors.push(reasonOf(error, "runtime-close"));
            }
            record.runtimes.push({ ...child, absent });
            ended = ended && absent;
          }
          record.absent = ended;
          return ended && host.exited && !host.identityIncomplete;
        } finally {
          open.delete(host);
          host.cleanup = record;
          writeFileSync(
            join(host.root, `cleanup-${host.child.pid}.json`),
            JSON.stringify(record),
            { mode: 0o600 },
          );
        }
      })();
      return host.closing;
    },
    /** Exact-identity cleanup of every host still open, for driver signal/crash paths. */
    /** Last private, capped store reasons seen for a case. */
    diagnostics(caseId) {
      return storeReasons.get(caseId);
    },
    closeAll() {
      shuttingDown = true;
      return Promise.allSettled([...open].map((host) => this.close(host)));
    },
  };
}
/** At most ten store work states and reasons, each capped, for private evidence only. */
export function listReasons(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((r) => ({
    workId: String(r?.workId ?? "").slice(0, 120),
    state: String(r?.state ?? "").slice(0, 40),
    ...(typeof r?.reason === "string"
      ? { reason: r.reason.slice(0, 240) }
      : {}),
  }));
}
/**
 * Durable bound-turn proof: a running intent whose recovery identity names a process that
 * this host owns (same pid, start time, boot), is still alive, and whose reservation for this
 * case generation and thread was consumed. Undefined until all hold.
 */
export function boundTurn({
  intents,
  identities,
  entries,
  owned,
  caseId,
  generation,
  workId,
  live,
  saved,
}) {
  const intent = intents.find(
    (r) =>
      r.workId === workId && r.state === "running" && r.threadId && r.turnId,
  );
  if (!intent) return undefined;
  const bound = identities.find(
    (r) =>
      r.workId === workId &&
      r.threadId === intent.threadId &&
      r.turnId === intent.turnId &&
      r.processId,
  );
  if (!bound) return undefined;
  const consumed = entries.find(
    (r) =>
      r.kind === "consume" &&
      r.binding?.caseId === caseId &&
      r.binding.generation === generation &&
      r.binding.thread === intent.threadId,
  );
  if (!consumed) return undefined;
  const process = owned.find(
    (p) =>
      String(p.pid) === String(bound.processId) &&
      p.birth === bound.processStartedAt &&
      p.boot === bound.bootId,
  );
  if (!process || !live(process)) return undefined;
  const session = saved?.(intent.threadId);
  if (saved && !session) return undefined;
  return {
    workId,
    threadId: intent.threadId,
    turnId: intent.turnId,
    process,
    reservation: consumed.token,
    ...(session ? { session } : {}),
  };
}
/** Complete JSONL rows; a torn final line (no newline yet) is skipped, other damage throws. */
export function jsonlRows(text) {
  const lines = text.split("\n");
  lines.pop(); // "" after a complete final row, or a partial row still being written
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
/**
 * Read-only proof that the Claude CLI saved this session's prompt: a "user" row in
 * <case>/data/claude/config/projects/<project>/<threadId>.jsonl. Resume needs this file.
 */
export function savedPrompt(caseRoot, threadId) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(threadId)) return undefined;
  const projects = join(caseRoot, "data", "claude", "config", "projects");
  if (!existsSync(projects)) return undefined;
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${threadId}.jsonl`);
    if (!existsSync(file)) continue;
    // CLI-owned file: only complete lines, and any unparsable one is not a user row.
    const lines = readFileSync(file, "utf8").split("\n");
    lines.pop();
    const row = lines.findIndex((line) => {
      try {
        return JSON.parse(line)?.type === "user";
      } catch {
        return false;
      }
    });
    if (row >= 0) return { file: relative(caseRoot, file), row };
  }
  return undefined;
}
/** SQLite BUSY/LOCKED on a read-only snapshot is transient; anything else is not. */
const transientRead = (error) =>
  error?.code === "ERR_SQLITE_ERROR" &&
  [5, 6].includes((error.errcode ?? 0) & 0xff);
/**
 * One polling read: a transient failure counts as "not yet" up to `limit` consecutive times;
 * the caller's stage deadline is unchanged.
 */
export function pollRead(read, state, limit = 20) {
  try {
    const value = read();
    state.failures = 0;
    return value;
  } catch (error) {
    state.failures = (state.failures ?? 0) + 1;
    if (!transientRead(error) || state.failures > limit) throw error;
    return undefined;
  }
}
/** A read-only snapshot through pollRead, retried until it succeeds or `deadline` passes. */
export async function readDurable(root, deadline, read = snapshot) {
  const state = {};
  while (true) {
    const value = pollRead(() => read(root), state);
    if (value) return value;
    if (Date.now() >= deadline) throw fixed("durable snapshot: deadline");
    await pause(25);
  }
}
/** Fsynced adapter-process rows written by this host before its IPC notice. */
export function adapterRows(caseRoot, owner) {
  const file = join(caseRoot, "trace.jsonl");
  if (!existsSync(file)) return [];
  return jsonlRows(readFileSync(file, "utf8"))
    .filter(
      (row) =>
        row.event === "adapter-process" &&
        row.pid === owner.pid &&
        row.detail?.ppid === owner.pid &&
        row.detail.boot === owner.boot,
    )
    .map(({ detail: { pid, ppid, pgid, birth, boot } }) => ({
      pid,
      ppid,
      pgid,
      birth,
      boot,
    }));
}
/** Driver SIGINT/SIGTERM/SIGHUP/crash paths run the same exact-identity cleanup once. */
export function guardDriver(backend, journal, exit = process.exit) {
  let stopping;
  const stop = (reason, code) => {
    stopping ??= (async () => {
      try {
        journal.event("failed", { reason });
      } catch {}
      await Promise.race([backend.closeAll(), pause(LIMITS.cleanupMs + 1000)]);
      exit(code);
    })();
    return stopping;
  };
  const handlers = [
    ["SIGINT", () => stop("driver-SIGINT", 130)],
    ["SIGTERM", () => stop("driver-SIGTERM", 143)],
    ["SIGHUP", () => stop("driver-SIGHUP", 129)],
    ["uncaughtException", () => stop("driver-uncaught", 70)],
    ["unhandledRejection", () => stop("driver-unhandled", 70)],
  ];
  for (const [event, handler] of handlers) process.on(event, handler);
  return () => {
    for (const [event, handler] of handlers) process.off(event, handler);
  };
}
const repository = fileURLToPath(new URL("../../../", import.meta.url));
/** One-use marker keyed by grant id, outside any session root or grant file location. */
export function grantMarker(grantId, home = userInfo().homedir) {
  assert.match(grantId, /^[A-Za-z0-9._:-]{1,128}$/, "invalid grant id");
  const dir = join(home, ".cab-signal-qualification");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(
    dir,
    `${createHash("sha256").update(grantId).digest("hex")}.consumed`,
  );
}
/** Rebuild from the clean HEAD the grant names, so the running dist/ is that source. */
export function prepareBuild(run = execFileSync, env = process.env) {
  const commands = [
    ["node_modules/typescript/bin/tsc"],
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      "web/vite.config.ts",
    ],
  ];
  for (const args of commands)
    run(process.execPath, args, {
      cwd: repository,
      env,
      stdio: "ignore",
      timeout: 300000,
    });
  const hash = createHash("sha256");
  for (const dir of ["dist/src", "dist/operator"]) {
    const base = join(repository, dir);
    for (const file of readdirSync(base, { recursive: true }).sort()) {
      const path = join(base, file);
      if (lstatSync(path).isFile())
        hash.update(relative(repository, path)).update(readFileSync(path));
    }
  }
  return { commands, distSha256: hash.digest("hex") };
}
/** Version prints only: no model, provider or auth request. */
export function runtimeVersions(
  codexExecutable,
  run = execFileSync,
  env = process.env,
) {
  const version = (command) =>
    run(command, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .slice(0, 120);
  return {
    node: process.version,
    claudeAgentSdk: JSON.parse(
      readFileSync(
        join(
          repository,
          "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        ),
        "utf8",
      ),
    ).version,
    codexCli: version(codexExecutable),
    claudeCli: version("claude"),
  };
}

/** Build and version children never see the Claude token value. */
export function childEnvironment(grant, env = process.env) {
  const copy = { ...env };
  if (grant.claudeTokenRef?.startsWith("env:"))
    delete copy[grant.claudeTokenRef.slice(4)];
  return copy;
}
/** The grant's source identity, always checked in the repository whose dist/ runs. */
export function verifySource(grant, run = execFileSync) {
  const git = (args) =>
    String(
      run("git", args, { cwd: repository, encoding: "utf8", timeout: 3000 }),
    ).trim();
  assert.equal(grant.sourceHead, git(["rev-parse", "HEAD"]), "source head");
  assert.equal(grant.sourceTree, git(["rev-parse", "HEAD^{tree}"]), "tree");
  git(["diff", "--quiet", "HEAD"]);
  git([
    "ls-files",
    "--error-unmatch",
    "test/execution/signal-qualification/live-control.mjs",
    "test/execution/signal-qualification/live-host.mjs",
    "test/execution/signal-qualification/live-signals.mjs",
  ]);
}

export async function main(args) {
  const options = parseArgs(args);
  const grant = JSON.parse(readFileSync(options.grant, "utf8"));
  assert.equal(
    grant.authorizedLive,
    true,
    "separate root live allowance missing",
  );
  assert.deepEqual(grant.limits, LIMITS);
  const allowed = new Set([
    "authorizedLive",
    "sourceHead",
    "sourceTree",
    "limits",
    "grantId",
    "codexExecutable",
    "claudeModel",
    "claudeTokenRef",
    "capabilitiesVerified",
  ]);
  assert.ok(
    Object.keys(grant).every((key) => allowed.has(key)),
    "unexpected grant field",
  );
  verifySource(grant);
  const childEnv = childEnvironment(grant);
  const build = prepareBuild(execFileSync, childEnv);
  verifySource(grant);
  assert.ok(
    grant.grantId &&
      grant.codexExecutable?.startsWith("/") &&
      grant.claudeModel &&
      /^env:[A-Z_][A-Z0-9_]*$/.test(grant.claudeTokenRef),
  );
  assert.equal(
    grant.capabilitiesVerified,
    true,
    "root capability receipt missing",
  );
  const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "cab-signal-live-")),
    ),
    marker = randomUUID();
  writeFileSync(join(root, "owner"), marker, { mode: 0o600 });
  ownedRoot(root, marker);
  const versions = runtimeVersions(
    grant.codexExecutable,
    execFileSync,
    childEnv,
  );
  // Exclusive one-use marker keyed by grant id: copying the grant file or restarting cannot reset it.
  const fs = await import("node:fs");
  const fd = fs.openSync(grantMarker(grant.grantId), "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ grantId: grant.grantId, root }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const journalFile = join(root, "session.jsonl");
  const journal = Journal.create(journalFile, {
    sourceHead: grant.sourceHead,
    grantId: grant.grantId,
  });
  const backend = realBackend(root, marker, journalFile, grant);
  const unguard = guardDriver(backend, journal);
  let evidence;
  try {
    evidence = {
      passed: true,
      results: await runCases(backend, journal),
    };
    journal.event("finished");
  } catch (error) {
    evidence = {
      passed: false,
      failure: reasonOf(error, "qualification"),
      results: error.results ?? [],
    };
  } finally {
    await backend.closeAll();
    unguard();
  }
  evidence.root = root;
  evidence.build = build;
  evidence.versions = versions;
  evidence.turns = journal.entries().filter((r) => r.kind === "reserve").length;
  evidence.settings = journal
    .entries()
    .filter((r) => r.kind === "settings").length;
  evidence.journalSha256 = createHash("sha256")
    .update(readFileSync(journalFile))
    .digest("hex");
  writeFileSync(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  // Only sanitized outcome and private artifact location reach stdout; credentials never do.
  process.stdout.write(
    `${JSON.stringify({ passed: evidence.passed, turns: evidence.turns, settings: evidence.settings, evidencePath: join(root, "evidence.json") })}\n`,
  );
  return evidence.passed ? 0 : 1;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Signal qualification refused before launch; verify the explicit grant and capabilities.\n",
    );
    process.exitCode = 2;
  }
}
