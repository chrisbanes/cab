import { browserTest } from "../fixtures/browser-engines.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const module = await import(
  pathToFileURL(
    resolve("test/workspaces/review-qualification/runtime-contract.mjs"),
  ).href
);
browserTest(
  "timed-out browser creation settles and closes its late resource within reserved cleanup without another turn",
  async () => {
    const r = await module.runQualification({
      fixture: { delayBrowserCreation: true },
    });
    assert.equal(r.status, "failed");
    assert.match(r.failure.reason, /browser-start-deadline/);
    assert.deepEqual(r.counts, { threads: 1, turns: 1, reports: 1 });
    assert.equal(r.cleanup.operations["pending-setup-settlement"], "settled");
    assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
  },
);

test("timed-out service startup keeps its late service-stop owner without racing runtime shutdown", async () => {
  const r = await module.runQualification({
    fixture: { delayRuntimeStart: 4200 },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /service-start-deadline/);
  assert.equal(r.counts.threads, 0);
  assert.equal(r.counts.turns, 0);
  assert.equal(r.cleanup.operations["pending-setup-settlement"], "unresolved");
  assert.equal(
    r.cleanup.stages.find(
      ({ operation }: { operation: string }) =>
        operation === "pending-setup-settlement",
    )?.state,
    "unresolved",
  );
  assert.equal(r.cleanup.operations["exact-runtime-stop"], undefined);
  assert.equal(r.cleanup.operations["service-close"], undefined);
  assert.equal(r.cleanup.verified, false);
  const observationDeadline = Date.now() + 1000;
  while (
    (!r.cleanup.lateResources[0] || !r.cleanup.lateVerification) &&
    Date.now() < observationDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(r.cleanup.lateResources[0]?.state, "settled");
  assert.equal(r.cleanup.lateResources[0]?.settledWithinCleanupDeadline, false);
  assert.equal(r.cleanup.lateVerification?.kind, "verified");
  assert.equal(r.cleanup.verified, false);
});

test("grant consumption atomically rejects replay and retains immutable scoped marker", () => {
  const consumedMarker = join(
    mkdtempSync(join(tmpdir(), "ui04-grant-test-")),
    "grant.consumed",
  );
  const grant = {
    issue: 742,
    holder: "ui04_worker",
    grantId: "fixture-grant",
    resource: module.resource,
    sourceHead: "fixture-head",
    sourceTree: "fixture-tree",
    harnessSha256: "fixture-hash",
    totalMs: 240000,
    cleanupMs: 10000,
    maxThreads: 1,
    maxTurns: 1,
    maxReports: 1,
    retries: 0,
    consumedMarker,
  };
  module.consumeGrantMarker(grant, 1000);
  const original = readFileSync(consumedMarker, "utf8");
  assert.deepEqual(JSON.parse(original), {
    ...grant,
    consumedAt: new Date(1000).toISOString(),
  });
  assert.equal(statSync(consumedMarker).mode & 0o777, 0o600);
  assert.throws(() => module.consumeGrantMarker(grant, 2000), {
    code: "EEXIST",
  });
  assert.equal(readFileSync(consumedMarker, "utf8"), original);
});

browserTest(
  "failed late-resource cleanup remains unresolved even after tracked setup promise settles",
  async () => {
    const r = await module.runQualification({
      fixture: { delayBrowserCreation: true, lateCleanupFailure: true },
    });
    assert.equal(r.status, "failed");
    assert.equal(r.cleanup.operations["pending-setup-settlement"], "settled");
    assert.equal(r.cleanup.lateResources.length, 1);
    assert.equal(r.cleanup.lateResources[0].state, "failed");
    assert.match(
      r.cleanup.lateResources[0].reason,
      /injected-late-cleanup-failure/,
    );
    assert.equal(r.cleanup.verified, false);
  },
);

test("portable fixture proof requires observed exit of its exact owned child and rejects still-present or previously-unobserved exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const proof = module.observeFixtureChild(child);
  try {
    await once(child, "spawn");
    assert.equal(proof.verify().kind, "unknown");
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGTERM"), true);
    await exited;
    const verified = proof.verify();
    assert.equal(verified.kind, "verified");
    assert.equal(verified.method, "fixture-owned-child-exit");
    assert.equal(verified.identity.processId, child.pid);
    assert.equal(verified.exit.signal, "SIGTERM");
    assert.equal(module.observeFixtureChild(child).verify().kind, "unknown");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
});
