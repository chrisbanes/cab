import { browserTest } from "../fixtures/browser-engines.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const harness = await import(
  pathToFileURL(
    resolve("test/operator/journey-qualification/runtime-contract.mjs"),
  ).href
);
// The harness reserves 2 s of every fixture total for cleanup.
const harnessCleanupMs = 2000;
// Deadline cases end only at the total deadline, so setup must reach the
// stalled step first; with 20 concurrent copies it took up to about 5 s.
const deadlineTotalMs = 10_000;
browserTest(
  "production browser creates task, persists native answer before reply, consumes exact map and inspects result without prompt override",
  async () => {
    const r = await harness.runQualification({
      fixture: { mode: "delayed-native" },
    });
    assert.equal(r.status, "passed", JSON.stringify(r.failure));
    assert.deepEqual(r.counts, {
      threads: 1,
      turns: 1,
      requests: 1,
      replies: 1,
      reports: 1,
    });
    assert.equal(r.prompt.overridden, false);
    assert.equal(r.persistence.committedBeforeEffect, true);
    assert.equal(r.persistence.independentReadOnlyConnection, true);
    assert.equal(r.persistence.zeroReplies, true);
    assert.equal(r.settlement.exactBoundSuccessfulTerminal, true);
    assert.equal(r.callbackEnded, true);
    assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
    assert.equal(r.screenshots.length, 1);
    assert.deepEqual(r.closedQuestionProjection, {
      taskReload: true,
      inboxReload: true,
      retainedExactAnswer: true,
      readOnly: true,
      zeroCommands: true,
    });
  },
);
browserTest(
  "setup deadline closes late browser and records failed cleanup without losing primary assertion",
  async () => {
    const r = await harness.runQualification({
      fixture: {
        delayBrowserCreation: true,
        lateCleanupFailure: true,
        totalMs: deadlineTotalMs,
      },
    });
    assert.equal(r.status, "failed");
    assert.match(r.failure.reason, /browser-start-deadline/);
    assert.equal(r.cleanup.verified, false);
    assert.equal(r.cleanup.lateResources[0].state, "failed");
    assert.equal(r.counts.turns, 0);
  },
);

test("timed-out service startup keeps its late service-stop owner without racing runtime shutdown", async () => {
  const totalMs = 4500;
  const serviceStartDeadline = Date.now() + totalMs - harnessCleanupMs;
  const r = await harness.runQualification({
    fixture: {
      totalMs,
      // Release runtime start just after its deadline, however long service
      // setup took, so the late stop gets the whole cleanup window.
      get delayRuntimeStart() {
        return Math.max(1, serviceStartDeadline + 100 - Date.now());
      },
    },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /service-start-deadline/);
  assert.equal(r.counts.threads, 0);
  assert.equal(r.counts.turns, 0);
  assert.equal(r.cleanup.operations["pending-setup-settlement"], "settled");
  assert.equal(r.cleanup.operations["exact-runtime-stop"], undefined);
  assert.equal(r.cleanup.operations["service-close"], undefined);
  assert.deepEqual(
    r.cleanup.lateResources.map(
      ({
        identity,
        state,
        settledWithinCleanupDeadline,
      }: {
        identity: string;
        state: string;
        settledWithinCleanupDeadline: boolean;
      }) => ({
        identity,
        state,
        settledWithinCleanupDeadline,
      }),
    ),
    [
      {
        identity: "service-start:1",
        state: "settled",
        settledWithinCleanupDeadline: true,
      },
    ],
  );
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
});
browserTest(
  "delayed HTTP setup and shutdown failure retain incomplete cleanup evidence",
  async () => {
    const r = await harness.runQualification({
      fixture: {
        delayHttp: true,
        shutdownFailure: true,
        totalMs: deadlineTotalMs,
      },
    });
    assert.equal(r.status, "failed");
    assert.match(r.failure.reason, /browser-create-task-deadline/);
    assert.equal(r.cleanup.operations["service-close"], "unresolved");
    assert.equal(r.cleanup.verified, false);
    assert.equal(r.counts.turns, 0);
  },
);
test("missing and malformed grants reject before creating any resources", async () => {
  await assert.rejects(
    harness.runQualification(),
    /exact-clean-grant-required/,
  );
  await assert.rejects(
    harness.runQualification({ grant: { issue: 745 } }),
    /exact-clean-grant-required/,
  );
});
test("grant marker has immutable exclusive 0600 durable consumption and rejects replay", () => {
  const consumedMarker = join(
    mkdtempSync(join(tmpdir(), "ui07-grant-")),
    "consumed",
  );
  const grant = {
    issue: 745,
    resource: harness.resource,
    grantId: "fixture-only",
    consumedMarker,
  };
  harness.consumeGrantMarker(grant, 1000);
  const original = readFileSync(consumedMarker, "utf8");
  assert.equal(statSync(consumedMarker).mode & 0o777, 0o600);
  assert.equal(JSON.parse(original).consumedAt, new Date(1000).toISOString());
  assert.throws(() => harness.consumeGrantMarker(grant, 2000), {
    code: "EEXIST",
  });
  assert.equal(readFileSync(consumedMarker, "utf8"), original);
});
