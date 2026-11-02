import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

export function trace(file, event, detail = {}) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const row = JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    event,
    detail,
  });
  assert.ok(row.length <= 8192 && size + row.length <= 1048576, "trace limit");
  const fd = openSync(file, "a", 0o600);
  try {
    writeFileSync(fd, `${row}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** A driver-authored error whose message is fixed text, safe for private evidence. */
export function fixed(message) {
  return Object.assign(Error(message), { fixed: true });
}
/**
 * Bounded failure detail for the private 0600 evidence file only: stage, error name/code
 * and the driver's own fixed text. Messages from SDKs/CLIs (which carry stderr) are dropped.
 */
export function reasonOf(error, stage) {
  const own = error?.fixed === true || error instanceof assert.AssertionError;
  return {
    ...(stage ? { stage: String(stage).slice(0, 64) } : {}),
    name: typeof error?.name === "string" ? error.name.slice(0, 64) : "unknown",
    ...(typeof error?.code === "string"
      ? { code: error.code.slice(0, 64) }
      : {}),
    // Node appends actual/expected to assertion text; keep only the fixed first line.
    ...(own
      ? { message: String(error.message).split("\n")[0].slice(0, 240) }
      : {}),
  };
}
export const LIMITS = Object.freeze({
  turns: 20,
  expected: 14,
  settings: 6,
  attempts: 1,
  sessionMs: 1800000,
  turnMs: 120000,
  readyMs: 60000,
  observeMs: 30000,
  cleanupMs: 20000,
});
export function parseArgs(args) {
  assert.equal(args[0], "--live", "explicit --live required");
  const expected = new Map([
    ["--max-turns", "20"],
    ["--max-attempts", "1"],
    ["--deadline-ms", "1800000"],
  ]);
  let grant;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    assert.ok(value && !value.startsWith("--"), "missing option value");
    if (flag === "--grant") {
      assert.equal(grant, undefined);
      grant = value;
    } else {
      assert.equal(
        value,
        expected.get(flag),
        "unknown, duplicate or unsafe option",
      );
      expected.delete(flag);
    }
  }
  assert.equal(expected.size, 0, "exact limits required");
  assert.ok(grant, "root live grant required");
  return { grant };
}
export async function bounded(action, deadline, label, now = Date.now) {
  if (now() >= deadline) throw fixed(`${label}: deadline`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(action)
        .then((value) => {
          if (now() > deadline) throw fixed(`${label}: deadline`);
          return value;
        }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(fixed(`${label}: deadline`)),
          Math.max(1, deadline - now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** One append-only, fsynced journal shared by driver and child services. Lock contention fails closed. */
export class Journal {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
  }
  static create(file, identity, now = Date.now) {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({ kind: "attempt", at: now(), identity, limits: LIMITS })}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return new Journal(file, now);
  }
  entries() {
    return readFileSync(this.file, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  }
  get deadline() {
    return this.entries()[0].at + LIMITS.sessionMs;
  }
  event(kind, body = {}) {
    const lock = openSync(`${this.file}.lock`, "wx", 0o600);
    try {
      const rows = this.entries();
      assert.equal(rows[0].kind, "attempt");
      assert.deepEqual(rows[0].limits, LIMITS);
      assert.ok(this.now() < rows[0].at + LIMITS.sessionMs, "session deadline");
      assert.ok(
        !rows.some((r) => r.kind === "failed" || r.kind === "finished"),
        "attempt closed",
      );
      const entry = { ...body, kind, at: this.now() };
      if (kind === "reserve")
        assert.ok(
          rows.filter((r) => r.kind === "reserve").length < LIMITS.turns,
          "turn cap",
        );
      if (kind === "consume") {
        const original = rows.find(
          (r) => r.kind === "reserve" && r.token === body.token,
        );
        assert.ok(
          original &&
            JSON.stringify(original.binding) === JSON.stringify(body.binding),
          "missing or wrong reservation",
        );
        assert.ok(
          !rows.some((r) => r.kind === "consume" && r.token === body.token),
          "reused reservation",
        );
        assert.ok(this.now() <= original.at + LIMITS.turnMs, "turn deadline");
      }
      if (kind === "settings") {
        assert.ok(
          rows.filter((r) => r.kind === "settings").length < LIMITS.settings,
          "settings cap",
        );
        assert.ok(
          !rows.some((r) => r.kind === "settings-failed"),
          "failed settings query cannot retry",
        );
        assert.ok(
          !rows.some(
            (r) =>
              r.kind === "settings" &&
              r.caseId === body.caseId &&
              r.generation === body.generation,
          ),
          "settings case generation reused",
        );
      }
      const fd = openSync(this.file, "a");
      try {
        writeFileSync(fd, `${JSON.stringify(entry)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return entry;
    } finally {
      closeSync(lock);
      unlinkSync(`${this.file}.lock`);
    }
  }
  reserve(binding) {
    return this.event("reserve", { token: randomUUID(), binding });
  }
  consume(reservation, binding) {
    assert.ok(reservation?.token, "unreserved query");
    return this.event("consume", { token: reservation.token, binding });
  }
}
/** The owner retains every resource, including creations whose bounded handoff is rejected. */
export class Owner {
  constructor(now = Date.now) {
    this.now = now;
    this.resources = [];
    this.pending = [];
    this.creations = [];
    this.closing = false;
  }
  acquire(action, deadline, label, close) {
    assert.ok(!this.closing, "owner closing");
    assert.ok(this.now() < deadline, `${label}: deadline`);
    const receipt = { label, state: "pending" };
    this.creations.push(receipt);
    const creation = Promise.resolve()
      .then(() => {
        assert.ok(this.now() < deadline, `${label}: deadline`);
        return action();
      })
      .then((value) => {
        receipt.state = "created";
        const entry = { label, state: "owned" };
        Object.defineProperties(entry, {
          value: { value },
          close: { value: close },
          closing: { writable: true, value: null },
        });
        this.resources.push(entry);
        if (this.closing) void this.close(entry);
        return value;
      });
    this.pending.push(creation);
    void creation.catch(() => {
      receipt.state = "failed";
    });
    return bounded(() => creation, deadline, label, this.now);
  }
  close(entry) {
    if (!entry.closing)
      entry.closing = Promise.resolve()
        .then(() => entry.close(entry.value))
        .then(
          (proof) => {
            entry.proof = proof;
            entry.endedAt = this.now();
            entry.state = proof === true ? "exited" : "unresolved";
          },
          () => {
            entry.state = "unresolved";
            entry.endedAt = this.now();
          },
        );
    return entry.closing;
  }
  async cleanup(deadline) {
    this.closing = true;
    let timely = true;
    for (const resource of this.resources) void this.close(resource);
    const joining = Promise.allSettled(this.pending).then(() =>
      Promise.all(this.resources.map((r) => this.close(r))),
    );
    try {
      await bounded(() => joining, deadline, "cleanup", this.now);
    } catch {
      timely = false;
    }
    return {
      verified:
        timely &&
        this.resources.every(
          (r) => r.state === "exited" && r.endedAt <= deadline,
        ),
      resources: this.resources,
      creations: this.creations,
    };
  }
}

/** Private call scopes originate only at the actual runtime methods, never from a query label. */
export function fenceAdapters(journal, bindingBase) {
  const now = journal.now;
  const scope = new AsyncLocalStorage();
  const settingsGenerations = new Set();
  let fatal;
  const fail = (kind) => {
    fatal ??= fixed(kind);
    try {
      journal.event("failed", { reason: kind });
    } catch {}
    return fatal;
  };
  const check = () => {
    if (fatal) throw fatal;
    if (now() >= journal.deadline) throw fail("session-deadline");
  };
  const protectPrompt = (prompt, consumed, settings) =>
    (async function* () {
      for await (const item of prompt) {
        if (settings || !consumed())
          throw fail("prompt-release-without-model-reservation");
        check();
        yield item;
      }
    })();
  return {
    check,
    sdk(sdk) {
      return {
        ...sdk,
        query(input) {
          check();
          const call = scope.getStore();
          assert.ok(call, "unreserved query");
          let settings = false;
          if (call.kind === "model") {
            journal.consume(call.reservation, call.binding);
            call.consumed = true;
          } else {
            const o = input.options;
            assert.ok(
              call.kind === "preflight" &&
                !settingsGenerations.has(call.generation) &&
                o.permissionMode === "dontAsk" &&
                Array.isArray(o.tools) &&
                o.tools.length === 0 &&
                o.settingSources?.length === 0 &&
                o.strictMcpConfig === true &&
                input.prompt?.[Symbol.asyncIterator],
              "unclassified settings query",
            );
            journal.event("settings", {
              caseId: bindingBase.caseId,
              generation: call.generation,
            });
            settingsGenerations.add(call.generation);
            settings = true;
          }
          const abort = input.options.abortController;
          const deadline = Math.min(journal.deadline, call.deadline);
          const timer = setTimeout(
            () => {
              abort?.abort();
              fail("query-deadline");
            },
            Math.max(1, deadline - now()),
          );
          // Enforces the deadline without itself keeping a process alive.
          timer.unref();
          let query,
            settingsResolved = false,
            settingsFailed = false;
          const settingsFailure = () => {
            if (settingsFailed) return;
            settingsFailed = true;
            try {
              journal.event("settings-failed", {
                caseId: bindingBase.caseId,
                generation: call.generation,
              });
            } catch {}
          };
          // Only fence violations close the attempt; ordinary SDK failures belong to the runtime.
          const classify = (error, label) => {
            if (fatal) return fatal;
            if (now() >= deadline) return fail(`${label}-deadline`);
            if (settings) settingsFailure();
            return error;
          };
          try {
            query = sdk.query({
              ...input,
              prompt: protectPrompt(
                input.prompt,
                () => call.consumed,
                settings,
              ),
            });
          } catch (error) {
            clearTimeout(timer);
            throw classify(error, "query");
          }
          // Keep only prompt-free controls; anything that could carry a prompt is a violation.
          return new Proxy(query, {
            get(target, property) {
              if (property === Symbol.asyncIterator)
                return async function* () {
                  try {
                    for await (const message of target) {
                      check();
                      yield message;
                    }
                  } catch (error) {
                    // SDK rethrows its stored exit error after an abort or child signal.
                    if (settings && settingsResolved && abort?.signal.aborted)
                      return;
                    throw classify(error, "query");
                  } finally {
                    clearTimeout(timer);
                  }
                };
              if (property === "supportedModels")
                return () =>
                  bounded(
                    () => target.supportedModels(),
                    deadline,
                    "settings",
                    now,
                  ).then(
                    (value) => {
                      if (settings) settingsResolved = true;
                      return value;
                    },
                    (error) => {
                      throw classify(error, "settings");
                    },
                  );
              if (property === "then") return undefined;
              const value = Reflect.get(target, property, target);
              if (typeof value !== "function") return value;
              if (property === "interrupt" || property === "return")
                return value.bind(target);
              return () => {
                throw fail("unfenced-query-method");
              };
            },
          });
        },
      };
    },
    runtime(runtime, harness, generation, readyDeadline) {
      if (runtime.preflightTurn) {
        const preflight = runtime.preflightTurn.bind(runtime);
        runtime.preflightTurn = async (...args) => {
          check();
          return scope.run(
            { kind: "preflight", generation, deadline: readyDeadline },
            () => preflight(...args),
          );
        };
      }
      const turnDeadlines = new Map();
      const wait = runtime.waitForTurn?.bind(runtime);
      if (wait)
        runtime.waitForTurn = (thread, turn) => {
          const deadline = turnDeadlines.get(`${thread}:${turn}`);
          assert.ok(deadline, "unreserved terminal wait");
          return bounded(() => wait(thread, turn), deadline, "terminal", now);
        };
      const start = runtime.startTurn.bind(runtime);
      runtime.startTurn = async (thread, workspace, ...args) => {
        check();
        const binding = {
          ...bindingBase,
          harness,
          generation,
          thread,
          workspace,
        };
        assert.ok(
          now() + LIMITS.turnMs + LIMITS.cleanupMs <= journal.deadline,
          "insufficient session budget",
        );
        const reservation = journal.reserve(binding);
        const call = {
          kind: "model",
          binding,
          reservation,
          consumed: false,
          deadline: Math.min(journal.deadline, reservation.at + LIMITS.turnMs),
        };
        return scope.run(call, async () => {
          // Codex's wrapper is immediately before its adapter's turn/start request.
          if (harness === "codex") {
            journal.consume(reservation, binding);
            call.consumed = true;
          }
          const value = await bounded(
            () => start(thread, workspace, ...args),
            call.deadline,
            "startTurn",
            now,
          );
          assert.equal(
            call.consumed,
            true,
            "adapter started without consuming reservation",
          );
          turnDeadlines.set(`${thread}:${value}`, call.deadline);
          return value;
        });
      };
      return runtime;
    },
  };
}
