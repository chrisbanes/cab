import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DaemonFacts,
  daemonDecision,
  type Observed,
  type ProcessIdentity,
  refineObserved,
  type Seen,
} from "../../src/cli/daemon-ownership.js";

const identity = (id: number): ProcessIdentity => ({
  processId: String(id),
  processStartedAt: "start-0",
  bootId: "boot-1",
});

const observations: (Observed | undefined)[] = [
  undefined,
  { processes: [], unidentified: false, identified: false },
  { processes: [], unidentified: true, identified: false },
  { processes: [], unidentified: false, identified: true },
  { processes: [identity(1)], unidentified: false, identified: true },
  { processes: [identity(1)], unidentified: true, identified: true },
];
const jobs: DaemonFacts["job"][] = [
  { state: "absent" },
  { state: "loaded", pid: undefined },
  { state: "loaded", pid: 1 },
];
const booleans = [false, true];
const listeners: DaemonFacts["listener"][] = [
  "ours",
  "foreign",
  "unknown",
  "free",
];

/** Every combination of the facts the decision reads. */
function* allFacts(): Generator<DaemonFacts> {
  for (const operation of ["verify", "uninstall"] as const)
    for (const job of jobs)
      for (const plistPresent of booleans)
        for (const observed of observations)
          for (const processesGone of booleans)
            for (const portBusy of booleans)
              for (const logsPresent of booleans)
                for (const identityRead of booleans)
                  for (const listener of listeners)
                    yield {
                      operation,
                      job,
                      plistPresent,
                      observed,
                      processesGone,
                      portBusy,
                      logsPresent,
                      identityRead,
                      listener,
                    };
}

test("daemon ownership decision: the record is never cleared on anything but confirmed absence", () => {
  let complete = 0;
  let started = 0;
  for (const facts of allFacts()) {
    const decision = daemonDecision(facts);
    const label = JSON.stringify({ facts, decision });
    // Verification never completes an uninstall, and uninstall never reports a start.
    if (facts.operation === "verify")
      assert.notEqual(decision.kind, "complete", label);
    else assert.notEqual(decision.kind, "started", label);
    if (decision.kind === "complete") {
      complete += 1;
      assert.equal(facts.operation, "uninstall", label);
      assert.equal(facts.job.state, "absent", label);
      assert.equal(facts.plistPresent, false, label);
      assert.equal(facts.processesGone, true, label);
      assert.equal(facts.portBusy, false, label);
      assert.notEqual(facts.observed?.unidentified, true, label);
      // A job never seen with a process, or seen without a pid yet, may still have started.
      if (!facts.observed?.identified)
        assert.equal(facts.logsPresent, false, label);
    }
    if (decision.kind === "started") {
      started += 1;
      assert.equal(facts.operation, "verify", label);
      assert.equal(facts.job.state, "loaded", label);
      assert.notEqual(
        facts.job.state === "loaded" ? facts.job.pid : undefined,
        undefined,
        label,
      );
      assert.equal(facts.identityRead, true, label);
      assert.equal(facts.listener, "ours", label);
    }
  }
  // The invariants above would hold vacuously if nothing ever completed or started.
  assert.ok(complete > 0 && started > 0);
});

test("daemon ownership decision: a job seen without a pid is held to the same evidence as one never seen", () => {
  const unseen = undefined;
  const noPid: Observed = {
    processes: [],
    unidentified: false,
    identified: false,
  };
  for (const portBusy of booleans)
    for (const logsPresent of booleans)
      for (const processesGone of booleans) {
        const facts = (observed: Observed | undefined): DaemonFacts => ({
          operation: "uninstall",
          job: { state: "absent" },
          plistPresent: false,
          observed,
          processesGone,
          portBusy,
          logsPresent,
          identityRead: true,
          listener: "free",
        });
        assert.deepEqual(
          daemonDecision(facts(noPid)),
          daemonDecision(facts(unseen)),
        );
      }
});

test("daemon ownership observations only move up and never lose an unconfirmed identity", () => {
  const rank = (observed: Observed | undefined) =>
    observed === undefined
      ? 0
      : 1 + Number(observed.identified) + Number(observed.unidentified);
  const seens: Seen[] = ["no-process", "unreadable", identity(1), identity(2)];
  for (const previous of observations)
    for (const seen of seens) {
      const next = refineObserved(previous, seen);
      const label = JSON.stringify({ previous, seen, next });
      assert.ok(rank(next) >= rank(previous), label);
      assert.ok(next, label);
      // Whatever was unconfirmed before stays recorded, unless the cap turned it unidentified.
      for (const process of previous?.processes ?? [])
        assert.ok(
          next.processes.some((p) => p.processId === process.processId),
          label,
        );
      if (previous?.unidentified) assert.equal(next.unidentified, true, label);
      if (previous?.identified) assert.equal(next.identified, true, label);
      if (seen !== "no-process" && seen !== "unreadable")
        assert.ok(
          next.processes.some((p) => p.processId === seen.processId),
          label,
        );
      if (seen === "unreadable") assert.equal(next.unidentified, true, label);
    }
  // Seen again, the same process is not recorded twice.
  const once = refineObserved(undefined, identity(1));
  assert.deepEqual(refineObserved(once, identity(1)), once);
  // Too many unconfirmed processes cannot all be kept: the record holds forever instead.
  let crowded: Observed | undefined;
  for (let id = 1; id <= 20; id += 1)
    crowded = refineObserved(crowded, identity(id));
  assert.equal(crowded?.unidentified, true);
  assert.ok((crowded?.processes.length ?? 0) <= 8);
});
