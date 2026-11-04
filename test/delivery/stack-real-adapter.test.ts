import assert from "node:assert/strict";
import { test } from "node:test";
import { offlineStackResources } from "./github-qualification/stack-offline-resources.js";
import { createRealStackAdapter } from "./github-qualification/stack-real-adapter.js";
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
