import { setTimeout as delay } from "node:timers/promises";
import { operationReadSchema } from "../../../src/operator/contracts.js";
import {
  unstackReceiptSchema,
  unstackReadSchema,
} from "../../../src/operator/unstack-contracts.js";
import { type StackV2Authority, materialHash } from "./stack-authority.js";
import { createRealStackAdapter } from "./stack-real-adapter.js";
import { fullUnstackProof } from "./stack-audit.js";

type Adapter = Awaited<ReturnType<typeof createRealStackAdapter>>;
export interface StackRealJourneyInput {
  authority: StackV2Authority;
  credential(reference: string): Promise<string | undefined>;
  transport?: typeof fetch;
  signal?: AbortSignal;
  /** Deterministic offline qualification uses the same orchestration, visibly labelled. */
  factory?: typeof createRealStackAdapter;
}

/** Finite actual service/API journey. No fixture creation, publication or cleanup fallback. */
export async function runRealStackJourney(input: StackRealJourneyInput) {
  const { authority, signal } = input,
    m = authority.manifest;
  let adapter: Adapter | undefined;
  let stop: Promise<void> | undefined;
  const stopOnce = () => {
    if (!adapter) throw Error("v2-adapter-not-constructed");
    stop ??= adapter.stop();
    return stop;
  };
  const abort = () => {
    authority.hold();
    if (adapter) void stopOnce().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const current = () => {
    signal?.throwIfAborted();
    authority.current();
  };
  let disposition: "recorded" | "held" = "held";
  let stage = "prepared";
  let platformRebase: "observed" | "not-observed" = "not-observed";
  let proofSha256: string | null = null;
  let receiptSha256: string | null = null;
  const settle = async (port: Adapter) => {
    for (let n = 0; n < m.journey.settlePolls; n++) {
      current();
      const executions = port.executions();
      if (executions.some((intent) => ["held"].includes(intent.state)))
        throw Error("v2-execution-held");
      if (
        !executions.some((intent) =>
          ["submitting", "running", "ready", "capacity-waiting"].includes(
            intent.state,
          ),
        )
      )
        return;
      await delay(m.journey.pollIntervalMs);
    }
    throw Error("v2-execution-remains-owned");
  };
  try {
    if (signal?.aborted) abort();
    current();
    stage = "adapter-construction";
    adapter = await (input.factory ?? createRealStackAdapter)(
      authority,
      input.credential,
      input.transport,
    );
    current();
    stage = "service-start";
    await adapter.start();
    current();
    if (m.scenario === "merge-adoption") {
      await settle(adapter);
      const baseline = await adapter.image();
      const initial = await adapter.audit();
      if (
        initial.headSha !== m.resource.upperHead ||
        initial.acceptedBaseRef !== m.resource.lowerRef ||
        initial.eventCount !== 0 ||
        !initial.selectedEdgeActive
      )
        throw Error("v2-adoption-baseline");
      stage = "merge-request";
      await adapter.mergeLower();
      for (let n = 0; n < m.journey.maxObservations; n++) {
        current();
        const observed = await adapter.observeProvider();
        if (!observed.lower.merged) {
          const status = await adapter.pollMerge();
          if (status === "failed") throw Error("v2-original-merge-failed");
          await delay(m.journey.pollIntervalMs);
          continue;
        }
        stage = "post-merge-adoption";
        await adapter.refresh();
        await settle(adapter);
        const audit = await adapter.audit(),
          image = await adapter.image();
        const head = authority.snapshot().captures.upperHead,
          base = authority.snapshot().captures.baseSha;
        platformRebase = head ? "observed" : "not-observed";
        const proof = audit.proofs.find(
          (value) =>
            value.oldHead === m.resource.upperHead &&
            value.oldBase === m.resource.lowerHead &&
            value.newHead === head &&
            value.newBase === base,
        );
        if (
          proof &&
          audit.acceptedBaseRef === m.resource.base &&
          audit.headSha === head &&
          audit.branch?.lastPushedSha === head &&
          audit.branch.outsideHeadSha === null &&
          materialHash(image) === materialHash(baseline)
        ) {
          proofSha256 = materialHash(proof);
          disposition = "recorded";
          break;
        }
        // Absence of a platform rebase grants no equivalent ref update or retained rewrite.
        if (!head) break;
        await delay(m.journey.pollIntervalMs);
      }
    } else {
      if (m.scenario === "unstack-healthy") await settle(adapter);
      stage = "original-unstack";
      const baseline = await adapter.image();
      const before = await adapter.audit();
      if (!before.operation) {
        const command = m.unstackCommand;
        if (command?.type !== "task.unstack")
          throw Error("v2-unstack-command-missing");
        const read = unstackReadSchema.parse(
          await adapter.preview(m.resource.upperTask),
        );
        const preview = read.data.preview;
        if (
          !read.data.available ||
          !preview ||
          preview.taskId !== m.resource.upperTask ||
          preview.expectedVersion !== command.expectedVersion ||
          preview.materialHash !== command.materialHash ||
          preview.selectedPr !== m.resource.upperPr ||
          preview.stackNumber !== m.resource.stackNumber ||
          preview.targetBase !== m.resource.base ||
          preview.repository !== m.resource.repository ||
          read.data.failedBlocker !== (m.scenario === "unstack-failed")
        )
          throw Error("v2-unstack-preview-binding");
        await adapter.unstack(command);
      }
      // Existing journals, including partial removal, only continue under the original key.
      for (let n = 0; n < m.journey.maxObservations; n++) {
        current();
        const audit = await adapter.audit();
        if (fullUnstackProof(audit)) {
          disposition = "recorded";
          proofSha256 = materialHash(audit);
          break;
        }
        if (audit.operation?.phase === "failed") break;
        await adapter.reconcile(m.resource.operationKey);
        await delay(m.journey.pollIntervalMs);
      }
      if (disposition !== "recorded") {
        const finalAudit = await adapter.audit();
        if (fullUnstackProof(finalAudit)) {
          disposition = "recorded";
          proofSha256 = materialHash(finalAudit);
        }
      }
      const receipt = operationReadSchema.parse(await adapter.receipt());
      receiptSha256 = materialHash(receipt);
      if (receipt.data.state !== "recorded") disposition = "held";
      else {
        const original = unstackReceiptSchema.parse(receipt.data.receipt);
        if (
          original.key !== m.resource.operationKey ||
          original.taskId !== m.resource.upperTask
        )
          throw Error("v2-original-receipt-binding");
        if (original.phase !== "confirmed") disposition = "held";
      }
      await settle(adapter);
      if (materialHash(await adapter.image()) !== materialHash(baseline))
        disposition = "held";
    }
    const finalAudit = await adapter.audit();
    if (finalAudit.writerHolds || finalAudit.unfinished) disposition = "held";
    const journal = authority.snapshot();
    const requiredTasks =
      m.scenario === "unstack-failed"
        ? [m.resource.upperTask]
        : [m.resource.lowerTask, m.resource.upperTask];
    const currentTasks = new Set(
      journal.runtimeBindings
        .filter((binding) => journal.terminals[binding.workId] === "completed")
        .map((binding) => binding.taskId),
    );
    if (!requiredTasks.every((task) => currentTasks.has(task)))
      disposition = "held";
    // Historical thread reads and old completed service rows cannot supply this proof.
    if (
      !journal.runtimeBindings.some(
        (binding) => journal.terminals[binding.workId] === "completed",
      ) ||
      journal.callbacks.some(
        (callback) => callback.state !== "ended" || !callback.succeeded,
      ) ||
      Object.values(journal.terminals).some(
        (status) => status !== "completed",
      ) ||
      adapter
        .executions()
        .some((intent) =>
          ["held", "submitting", "running", "capacity-waiting"].includes(
            intent.state,
          ),
        )
    )
      disposition = "held";
  } finally {
    try {
      if (adapter) {
        stage = `${stage}:teardown`;
        await stopOnce();
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await authority.close();
    }
  }
  const journal = authority.snapshot();
  if (
    !journal.processExit ||
    journal.gitChildren.some((child) => child.state !== "exited") ||
    journal.callbacks.some((callback) => callback.state !== "ended")
  )
    disposition = "held";
  return {
    version: 2,
    mode:
      input.factory || input.transport ? "offline-injected" : "real-adapter",
    runId: m.runId,
    manifestSha256: authority.manifestSha256,
    disposition,
    stage,
    platformRebase,
    proofSha256,
    receiptSha256,
    counts: journal.counts,
    processExit: journal.processExit,
  };
}
