import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  type Event,
  events,
  record,
  until,
} from "./signal-qualification/trace.js";

function identity(pid: number) {
  const row = execFileSync(
    "ps",
    ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="],
    { encoding: "utf8", timeout: 3000 },
  ).trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(row);
  assert.ok(match, `Missing identity for owned PID ${pid}`);
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    birth: match[4],
    boot: execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim(),
  };
}
function absent(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

function signalOwned(
  owned: ReturnType<typeof identity>,
  signal: NodeJS.Signals,
) {
  if (absent(owned.pid)) return false;
  try {
    const current = identity(owned.pid);
    // A child can be reparented after the service exits; birth/boot/group stay exact.
    assert.deepEqual({ ...current, ppid: owned.ppid }, owned);
    process.kill(owned.pid, signal);
    return true;
  } catch (error) {
    if (absent(owned.pid)) return false;
    throw error;
  }
}

function calibratedSignal(log: Event[]) {
  assert.ok(
    log.some((e) => e.event === "bound-ready"),
    "Calibration: no bound turn",
  );
  const active = log.find((e) => e.event === "child-active");
  assert.ok(active, "Calibration: no active child");
}

async function restartTwice(
  root: string,
  harness: string,
  trace: string,
  owned: ReturnType<typeof identity>[],
) {
  let firstInbox: string[] | undefined;
  for (let generation = 1; generation <= 2; generation++) {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./signal-qualification/service.js", import.meta.url),
        ),
        root,
        harness,
        "restart",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    assert.ok(child.pid);
    const service = identity(child.pid);
    owned.push(service);
    assert.equal(service.pgid, service.pid);
    await until(
      () =>
        events(trace).some(
          (e) => e.pid === child.pid && e.event === "restart-settled",
        ),
      `restart ${generation}: ${output}`,
    );
    const childStart = events(trace).find(
      (e) =>
        e.event === "child-start" &&
        (e.detail as { ppid: number }).ppid === service.pid,
    );
    if (childStart) {
      const detail = childStart.detail as Omit<
        ReturnType<typeof identity>,
        "pid"
      >;
      owned.push({ pid: childStart.pid, ...detail });
      assert.equal(detail.pgid, childStart.pid);
    }
    assert.ok(signalOwned(service, "SIGTERM"));
    await Promise.race([
      exit,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Restart exit: ${output}`)),
          8000,
        ).unref(),
      ),
    ]);
    assert.equal(child.exitCode, 0, output);
    const log = events(trace);
    const durable = log.findLast((e) => e.event === "durable-resolution")
      ?.detail as {
      resolutions: { threadId: string }[];
      intents: {
        workId: string;
        state: string;
        workspace: string;
        threadId: string;
      }[];
    };
    assert.equal(durable.resolutions.length, 1);
    const original = durable.intents.find(
      (i) => !i.workId.startsWith("shutdown:"),
    );
    const successors = durable.intents.filter((i) =>
      i.workId.startsWith("shutdown:"),
    );
    assert.equal(successors.length, 1);
    assert.equal(successors[0]?.state, "completed");
    const conversations = log
      .filter((e) => e.event === "conversation-open")
      .map((e) => e.detail as { method: string; threadId: string });
    assert.deepEqual(
      conversations.map((c) => c.method),
      ["thread/start", "thread/resume"],
    );
    assert.ok(conversations.every((c) => c.threadId === original?.threadId));
    const inbox = durable.intents
      .filter((i) => i.workId.includes(":inbox:"))
      .map((i) => i.workId)
      .sort();
    if (firstInbox)
      assert.deepEqual(inbox, firstInbox, "pending inbox identities preserved");
    firstInbox = inbox;
    assert.equal(
      log.filter((e) => e.event === "result-saved").length,
      1,
      "one result callback across both restarts",
    );
    assert.equal(successors[0]?.threadId, original?.threadId);
    assert.equal(successors[0]?.workspace, original?.workspace);
    assert.equal(
      log.filter((e) => e.event === "child-active").length,
      2,
      "one original and one successor dispatch across two restarts",
    );
    for (const e of log.filter(
      (e) =>
        ["child-start", "probe-start"].includes(e.event) &&
        (e.detail as { ppid: number }).ppid === service.pid,
    ))
      assert.ok(absent(e.pid), "restart runtime/probes exited");
    writeFileSync(join(root, `restart-${generation}.log`), output);
  }
}

// Missing terminal evidence stays held; ordinary signals must coordinate cleanly.
for (const [harness, signal, mode] of [
  ["codex", "SIGINT", "baseline"],
  ["codex", "SIGINT", "fault"],
  ["codex", "SIGTERM", "baseline"],
  ["claude", "SIGINT", "baseline"],
  ["claude", "SIGINT", "fault"],
  ["claude", "SIGTERM", "baseline"],
  ["codex", "SIGTERM", "silent"],
  ["codex", "SIGTERM", "startup"],
  ["codex", "SIGINT", "startup"],
  ["claude", "SIGTERM", "startup"],
  ["codex", "SIGTERM", "repeat"],
] as const) {
  test(`${harness} ${signal} ${mode}: calibrated owned-process shutdown`, {
    timeout: 30000,
    skip: process.platform !== "darwin",
  }, async (t) => {
    const evidence =
      process.env.SIGNAL_EVIDENCE_DIR ?? join(tmpdir(), "cab-signal-evidence");
    mkdirSync(evidence, { recursive: true });
    const root = mkdtempSync(join(evidence, `${harness}-${signal}-${mode}-`));
    const trace = join(root, "trace.jsonl");
    writeFileSync(trace, "");
    t.diagnostic(root);
    const driver = identity(process.pid);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./signal-qualification/service.js", import.meta.url),
        ),
        root,
        harness,
        mode,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const owned: ReturnType<typeof identity>[] = [];
    try {
      assert.ok(child.pid);
      const service = identity(child.pid);
      owned.push(service);
      assert.equal(service.pgid, service.pid);
      assert.notEqual(driver.pgid, service.pgid);
      await until(
        () =>
          events(trace).some(
            (e) =>
              e.event ===
              (mode === "startup" ? "startup-barrier" : "bound-ready"),
          ),
        `ready barrier; ${root}`,
      );
      if (mode !== "startup") {
        const start = events(trace).find((e) => e.event === "child-active");
        assert.ok(start, "Calibration requires a spawned runtime");
        const runtime = identity(start.pid);
        owned.push(runtime);
        const binding = events(trace).find((e) => e.event === "bound-identity")
          ?.detail as {
          processId: string;
          processStartedAt: string;
          bootId: string;
          threadId: string;
          turnId: string;
          workRevision: number;
          requestSequence: number;
        };
        assert.ok(binding);
        assert.equal(String(binding.processId), String(runtime.pid));
        assert.equal(binding.processStartedAt, runtime.birth);
        assert.equal(binding.bootId, runtime.boot);
        assert.ok(
          binding.threadId &&
            binding.turnId &&
            binding.workRevision > 0 &&
            binding.requestSequence > 0,
        );
        assert.equal(runtime.ppid, service.pid);
        if (process.env.SIGNAL_INHERITED_FAULT !== "1") {
          assert.equal(
            runtime.pgid,
            runtime.pid,
            "runtime owns its isolated group",
          );
          assert.notEqual(runtime.pgid, service.pgid);
          assert.notEqual(runtime.pgid, driver.pgid);
        }
      }
      const members = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
        encoding: "utf8",
        timeout: 3000,
      })
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/).map(Number))
        .filter((row) => row[2] === service.pgid)
        .map((row) => row[0]);
      assert.deepEqual(
        members.sort(),
        owned
          .filter((p) => p.pgid === service.pgid)
          .map((p) => p.pid)
          .sort(),
        "signal group contains only owned processes",
      );
      record(trace, "ownership-proof", { driver, owned, members });
      if (mode === "fault") {
        const runtime = owned[1];
        assert.ok(runtime);
        record(trace, "intentional-runtime-signal", runtime);
        assert.ok(signalOwned(runtime, "SIGINT"));
        await until(
          () => events(trace).some((e) => e.event === "child-SIGINT"),
          "intentional fault receipt",
        );
      }
      record(trace, "driver-signal", {
        signal,
        target: signal === "SIGINT" ? -service.pgid : service.pid,
      });
      process.kill(signal === "SIGINT" ? -service.pgid : service.pid, signal);
      if (mode === "repeat") {
        await until(
          () => events(trace).some((e) => e.event === "service-stop-entry"),
          "first stop",
        );
        assert.ok(
          signalOwned(service, signal),
          "repeat control must reach a live service",
        );
        record(trace, "driver-repeat");
      }
      await Promise.race([
        exit,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Service exit timeout: ${output}`)),
            8000,
          ).unref(),
        ),
      ]);
      if (mode === "repeat") {
        assert.equal(
          events(trace).filter((e) => e.event === "service-stop-entry").length,
          1,
        );
        return;
      }
      assert.equal(child.exitCode, 0, output);
      const log = events(trace);
      assert.equal(
        log.filter((e) => e.event === "service-stop-entry").length,
        1,
      );
      if (signal === "SIGINT" && mode !== "startup") {
        calibratedSignal(log);
        assert.throws(
          () => calibratedSignal(log.filter((e) => e.event !== "child-active")),
          /Calibration/,
        );
        assert.throws(
          () => calibratedSignal(log.filter((e) => e.event !== "bound-ready")),
          /Calibration/,
        );
      }
      const durable = log.find((e) => e.event === "durable-resolution")
        ?.detail as {
        resolutions: unknown[];
        writers: unknown[];
        capacity: unknown[];
        intents: { state: string }[];
      };
      assert.ok(durable);
      const probes = log.filter((e) => e.event === "probe-start");
      assert.ok(
        (mode === "startup" && harness === "claude") || probes.length > 0,
        "model/version probe ran through the real spawn seam",
      );
      for (const probe of probes) {
        assert.equal(
          (probe.detail as { pgid: number }).pgid,
          probe.pid,
          "probe group isolated",
        );
        assert.ok(absent(probe.pid), "probe cleanup awaited");
      }
      if (mode === "startup") {
        assert.equal(durable.intents.length, 0);
        return;
      }
      assert.ok(log.some((e) => e.event === "child-active"));
      const receipt = log.findIndex((e) => e.event === "child-SIGINT");
      const interrupt = log.findIndex((e) => e.event === "adapter-interrupt");
      if (mode === "fault") {
        assert.ok(receipt >= 0, "intentional fault reached active runtime");
        assert.ok(log.some((e) => e.event === "delayed-effect"));
        assert.ok(interrupt === -1 || receipt < interrupt);
        assert.equal(durable.resolutions.length, 0);
        assert.equal(durable.writers.length, 1);
        assert.equal(durable.capacity.length, 1);
        assert.equal(durable.intents[0]?.state, "held");
      } else if (mode === "silent") {
        assert.equal(durable.resolutions.length, 0);
        assert.equal(durable.writers.length, 1);
      } else {
        assert.equal(
          receipt,
          -1,
          "isolated runtime must not receive inherited SIGINT",
        );
        assert.equal(durable.resolutions.length, 1);
        assert.equal(durable.writers.length, 0);
        assert.equal(durable.capacity.length, 0);
        assert.ok(log.some((e) => e.event === "adapter-terminal"));
        await restartTwice(root, harness, trace, owned);
      }
    } finally {
      // Creation handles plus a fresh exact birth/boot identity guard every cleanup signal.
      for (const processIdentity of owned.reverse()) {
        if (!absent(processIdentity.pid)) {
          signalOwned(processIdentity, "SIGTERM");
          await until(
            () => absent(processIdentity.pid),
            `cleanup exit ${processIdentity.pid}`,
            4000,
          );
        }
        record(trace, "cleanup-exit-proof", processIdentity);
      }
      await exit;
      writeFileSync(join(root, "stdio.log"), output);
    }
  });
}
