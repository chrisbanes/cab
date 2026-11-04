import assert from "node:assert/strict";
import { test } from "node:test";
import { offlineStackResources } from "./github-qualification/stack-offline-resources.js";
import { createRealStackAdapter } from "./github-qualification/stack-real-adapter.js";
import { runRealStackJourney } from "./github-qualification/stack-real-journey.js";
import { unstackReadSchema } from "../../src/operator/unstack-contracts.js";

// Native runtime startup is disabled in the prepared DB and has no granted call.
// Credential resolution and every HTTP response remain injected/in-process.
test("concrete stack adapter constructs the actual service and previews through OperatorApi with fake HTTP", async (t) => {
  const f = await offlineStackResources(t);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.fakeLogin;
  const envName = f.credentialRef.slice(4);
  assert.equal(process.env[envName], undefined);
  // API exclusion readback sees only this known inert marker, never an operator credential.
  process.env[envName] = "offline-injected-marker";
  let lookups = 0,
    dispatches = 0;
  let adapter: Awaited<ReturnType<typeof createRealStackAdapter>> | undefined;
  try {
    adapter = await createRealStackAdapter(
      f.guard,
      async (reference) => {
        assert.equal(reference, f.credentialRef);
        lookups++;
        return "offline-injected-marker";
      },
      async (...args) => {
        dispatches++;
        return f.transport(...args);
      },
    );
    assert.equal(lookups, 1);
    assert.equal(dispatches, 3);
    await adapter.start();
    const preview = unstackReadSchema.parse(
      await adapter.preview(f.resource.upperTask),
    );
    assert.equal(preview.data.preview?.taskId, f.resource.upperTask);
    assert.equal(preview.data.preview?.selectedPr, f.resource.upperPr);
    assert.equal(preview.data.preview?.stackNumber, f.resource.stackNumber);
    assert.equal(preview.data.preview?.targetBase, f.resource.base);
    const audit = await adapter.audit();
    assert.equal(audit.selectedEdgeActive, true);
    assert.equal(audit.eventCount, 0);
    assert.equal(audit.operation, null);
    assert.equal(f.guard.snapshot().counts.turns, undefined);
    assert.equal(f.guard.snapshot().counts.writes, undefined);
    assert.equal(
      f.guard.snapshot().counts.credentialResolverInvocations,
      lookups,
    );
    assert.equal(
      f.guard.snapshot().counts.readTransportInvocations,
      dispatches,
    );
    assert.equal(f.guard.snapshot().process, null);
    assert.equal(f.guard.snapshot().counts["invocations:service.start"], 1);
    assert.equal(f.guard.snapshot().counts["invocations:service.observe"], 1);
    assert.equal(preview.data.preview?.materialHash, f.command.materialHash);
    await adapter.unstack(f.command);
    const original = await adapter.reconcile(f.resource.operationKey);
    assert.equal(original.operationId, f.resource.operationKey);
    assert.equal(original.phase, "confirmed");
    const completed = await adapter.audit();
    assert.equal(completed.selectedEdgeActive, false);
    assert.equal(completed.eventCount, 1);
    assert.equal(completed.edge?.restackSeq, 1);
    const receipt = await adapter.receipt();
    assert.equal(receipt.data.state, "recorded");
    if (receipt.data.state === "recorded")
      assert.equal(receipt.data.receipt.key, f.resource.operationKey);
    assert.equal(f.guard.snapshot().counts.writeTransportInvocations, 2);
    await assert.rejects(
      adapter.unstack(f.command),
      /v2-original-unstack-readback-only/,
    );
    assert.equal(f.guard.snapshot().counts.writeTransportInvocations, 2);
    await assert.rejects(
      adapter.unstack({ type: "task.cancel", taskId: f.resource.upperTask }),
      /v2-unstack-command|Invalid input/,
    );
  } catch (error) {
    t.diagnostic(JSON.stringify(f.preparedSummary));
    throw error;
  } finally {
    try {
      if (adapter) await adapter.stop();
    } finally {
      try {
        await f.guard.close();
      } finally {
        delete process.env[envName];
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    }
  }
  assert.equal(f.guard.snapshot().closed, true);
  assert.equal(f.guard.snapshot().processExit, false); // An offline adapter prefix cannot establish T6.
});

test("preaborted concrete journey never invokes factory, credential or provider", async (t) => {
  const f = await offlineStackResources(t);
  const controller = new AbortController();
  controller.abort(new Error("offline-preabort"));
  let factories = 0,
    credentials = 0,
    providers = 0;
  await assert.rejects(
    runRealStackJourney({
      authority: f.guard,
      signal: controller.signal,
      factory: async (...args) => {
        factories++;
        return createRealStackAdapter(...args);
      },
      credential: async () => {
        credentials++;
        return "offline-injected-marker";
      },
      transport: async (...args) => {
        providers++;
        return f.transport(...args);
      },
    }),
    /offline-preabort/,
  );
  assert.deepEqual(
    { factories, credentials, providers },
    { factories: 0, credentials: 0, providers: 0 },
  );
  assert.throws(() => f.guard.current(), /v2-authority-closed/);
});

for (const phase of ["credential", "provider", "constructed"] as const)
  test(`abort during deferred concrete ${phase} bootstrap holds before service construction and further effects`, async (t) => {
    const f = await offlineStackResources(t);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = f.fakeLogin;
    const envName = f.credentialRef.slice(4);
    assert.equal(process.env[envName], undefined);
    process.env[envName] = "offline-injected-marker";
    const controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let credentials = 0,
      providers = 0,
      constructed = 0;
    try {
      const running = runRealStackJourney({
        authority: f.guard,
        signal: controller.signal,
        factory: async (...args) => {
          const adapter = await createRealStackAdapter(...args);
          constructed++;
          if (phase === "constructed") {
            entered();
            await paused;
          }
          return adapter;
        },
        credential: async () => {
          credentials++;
          if (phase === "credential") {
            entered();
            await paused;
          }
          return "offline-injected-marker";
        },
        transport: async (...args) => {
          providers++;
          if (phase === "provider") {
            entered();
            await paused;
          }
          return f.transport(...args);
        },
      });
      void running.catch(() => {});
      await Promise.race([
        reached,
        running.then(() => {
          throw Error("offline-bootstrap-did-not-pause");
        }),
      ]);
      controller.abort(new Error("offline-bootstrap-abort"));
      release();
      await assert.rejects(
        running,
        /v2-authority-closed|offline-bootstrap-abort/,
      );
      assert.equal(credentials, 1);
      assert.equal(
        providers,
        phase === "constructed" ? 3 : phase === "provider" ? 1 : 0,
      );
      assert.equal(constructed, phase === "constructed" ? 1 : 0);
      const journal = f.guard.snapshot();
      assert.equal(journal.closed, true);
      assert.equal(journal.counts.credentials, 1);
      assert.equal(journal.counts.credentialResolverInvocations, 1);
      assert.equal(journal.counts["invocations:service.start"], undefined);
      assert.equal(journal.process, null);
      assert.equal(journal.processExit, false);
      assert.equal(
        journal.httpRequests.length,
        phase === "constructed" ? 3 : 1,
      );
      assert.equal(
        journal.httpRequests[0]?.phase,
        phase === "constructed"
          ? "responded"
          : phase === "provider"
            ? "invoked"
            : "reserved",
      );
      assert.equal(
        journal.counts["invocations:service.stop"],
        phase === "constructed" ? 1 : undefined,
      );
      await assert.rejects(
        f.guard.beforeCredentialLookup(),
        /v2-authority-closed/,
      );
    } finally {
      release();
      await f.guard.close();
      delete process.env[envName];
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
