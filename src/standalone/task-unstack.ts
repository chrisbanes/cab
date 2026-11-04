import {
  acceptableBaseRefs,
  materialDigest,
  type DeliveryStore,
} from "../core/delivery.js";
import { DomainConflictError } from "../core/domain-errors.js";
import type { DomainStore } from "../core/domain.js";
import type { CoordinationStore } from "../core/coordination.js";
import { assertTaskProjectWritable } from "../core/project-lifecycle.js";
import { transaction, type Database } from "../core/store.js";
import {
  UnstackStore,
  unstackCommandSchema,
  unstackIdentitySchema,
  type UnstackCommand,
  type UnstackIdentity,
  type UnstackRecord,
} from "../core/unstack.js";
import type { CodeHostDeliveryProvider } from "./code-host.js";
import { UnstackAuthorityChangedError, UnstackCoordinator } from "./unstack.js";
import type { SqliteWorkspaceBindingStore } from "./workspaces.js";

type Options = {
  db: Database;
  domain: DomainStore;
  delivery: DeliveryStore;
  coordination: CoordinationStore;
  workspaces: SqliteWorkspaceBindingStore;
  provider: (taskId: string) => CodeHostDeliveryProvider;
  projectWrite: <T>(taskId: string, run: () => Promise<T>) => Promise<T>;
};
/** Service-owned operator continuation, sharing the real lifecycle registry and durable stores. */
export class TaskUnstack {
  private readonly journal: UnstackStore;
  private readonly coordinators = new Map<string, UnstackCoordinator>();
  private readonly running = new Map<
    string,
    { hash: string; result: Promise<UnstackRecord> }
  >();
  private stopped = false;
  private readonly reads = new Set<Promise<UnstackIdentity>>();
  constructor(private readonly options: Options) {
    this.journal = new UnstackStore(options.db);
  }
  private local(taskId: string, except?: string) {
    const { db, domain, delivery, workspaces } = this.options;
    const task = domain.task(taskId),
      projectId = String(task.projectId);
    const lifecycle = assertTaskProjectWritable(db, taskId),
      edge = domain.activeStackedDependency(taskId);
    if (task.state !== "open" || !edge)
      throw new UnstackAuthorityChangedError(
        "Task no longer has an active selected stack edge",
      );
    const binding = delivery.delivery(taskId),
      branch = delivery.taskBranch(taskId, edge.repositoryId);
    const link = domain
      .repositoryLinks(projectId)
      .links.find((r) => r.repositoryId === edge.repositoryId);
    const targetBaseRef = acceptableBaseRefs(link?.ref)[0];
    if (
      link?.codeHost !== "github" ||
      !targetBaseRef ||
      !binding ||
      binding.readError ||
      binding.observation.repositoryId !== edge.repositoryId ||
      binding.observation.state !== "OPEN" ||
      binding.observation.merged ||
      !branch?.lastPushedSha ||
      branch.outsideHeadSha !== null ||
      binding.observation.headRef !== branch.branch ||
      binding.observation.headSha !== branch.lastPushedSha ||
      delivery.actionBlockers(taskId, undefined, except).length
    )
      throw new UnstackAuthorityChangedError(
        "Unstack delivery authority is not current",
      );
    if (domain.task(edge.blockerTaskId).projectId !== projectId)
      throw new UnstackAuthorityChangedError(
        "Selected blocker project changed",
      );
    const lower = delivery.delivery(edge.blockerTaskId),
      lowerBranch = delivery.taskBranch(edge.blockerTaskId, edge.repositoryId);
    if (
      !lower ||
      lower.readError ||
      lower.projectId !== projectId ||
      !lowerBranch ||
      lower.observation.repositoryId !== edge.repositoryId ||
      lower.observation.headRef !== lowerBranch.branch ||
      lower.observation.headSha !== lowerBranch.lastPushedSha ||
      lowerBranch.outsideHeadSha !== null ||
      binding.acceptedBaseRef !== lowerBranch.branch ||
      binding.observation.baseRef !== lowerBranch.branch
    )
      throw new UnstackAuthorityChangedError(
        "Selected lower PR identity is unproved",
      );
    const raw = db
      .prepare(`SELECT s.*,d.seq FROM stacked_dependencies s JOIN task_dependency_records d
      ON d.taskId=s.taskId AND d.blockerTaskId=s.blockerTaskId WHERE s.taskId=?`)
      .get(taskId) as Record<string, unknown> | undefined;
    if (!raw)
      throw new UnstackAuthorityChangedError(
        "Selected dependency generation unavailable",
      );
    const policy = delivery.configuration(projectId);
    const snapshot = {
      task,
      lifecycle,
      links: domain.repositoryLinks(projectId),
      policy,
      binding: {
        revision: binding.revision,
        observationDigest: binding.observationDigest,
        acceptedBaseRef: binding.acceptedBaseRef,
        baseChange: binding.baseChange,
        readError: binding.readError,
        settlement: binding.settlement,
      },
      branch,
      lower: {
        revision: lower.revision,
        observationDigest: lower.observationDigest,
      },
      lowerBranch,
      edge: raw,
      workspace: workspaces.get(taskId),
      approvals: db
        .prepare(`SELECT b.*,i.status,i.revision FROM delivery_approval_bindings b
        JOIN coordination_interactions i ON i.interactionId=b.interactionId WHERE b.taskId=? ORDER BY b.interactionId`)
        .all(taskId),
      holds: db
        .prepare(
          "SELECT * FROM task_writer_holds WHERE taskId=? ORDER BY rowid",
        )
        .all(taskId),
      ambiguity: db
        .prepare(
          "SELECT * FROM task_writer_ambiguity_holds WHERE taskId=? ORDER BY taskId",
        )
        .all(taskId),
      // Ending a turn on clean shutdown changes history, not the retained ownership holds.
      archival: db
        .prepare(
          "SELECT * FROM task_archival_holds WHERE taskId=? ORDER BY taskId",
        )
        .all(taskId),
    };
    return {
      projectId,
      lifecycle,
      task,
      binding,
      branch,
      policy,
      lower,
      lowerBranch,
      targetBaseRef,
      raw,
      authorityDigest: materialDigest(snapshot),
    };
  }
  preview(taskId: string): Promise<UnstackIdentity> {
    if (this.stopped)
      return Promise.reject(new Error("Unstack service stopped"));
    const result = this.options.projectWrite(taskId, async () => {
      const before = this.local(taskId),
        provider = this.options.provider(taskId);
      if (!provider.prepareUnstack || !provider.unstackProvider)
        throw new DomainConflictError("GitHub Unstack unavailable");
      const material = await provider.prepareUnstack(
        before.binding.observation.repositoryId,
        before.binding.observation.number,
      );
      const after = this.local(taskId);
      if (before.authorityDigest !== after.authorityDigest)
        throw new UnstackAuthorityChangedError(
          "Unstack preview changed during read",
        );
      const ownIndex = material.stack.members.findIndex(
        (m) => m.nodeId === before.binding.observation.nodeId,
      );
      const lower = material.stack.members[ownIndex - 1];
      if (
        lower?.nodeId !== before.lower.observation.nodeId ||
        lower.number !== before.lower.observation.number ||
        lower.headRef !== before.lowerBranch.branch ||
        lower.headSha !== before.lowerBranch.lastPushedSha ||
        material.pr.nodeId !== before.binding.observation.nodeId ||
        material.pr.number !== before.binding.observation.number ||
        material.pr.headRef !== before.branch.branch ||
        material.pr.headSha !== before.branch.lastPushedSha ||
        material.pr.baseRef !== before.lowerBranch.branch
      )
        throw new UnstackAuthorityChangedError(
          "Provider stack does not prove the selected edge",
        );
      const r = before.raw;
      return unstackIdentitySchema.parse({
        ...material,
        projectId: before.projectId,
        taskId,
        projectVersion: before.lifecycle.version,
        taskVersion: before.task.version,
        policyVersion: before.policy.version,
        deliveryRevision: before.binding.revision,
        authorityDigest: before.authorityDigest,
        repositoryId: before.binding.observation.repositoryId,
        targetBaseRef: before.targetBaseRef,
        edge: {
          blockerTaskId: r.blockerTaskId,
          repositoryId: r.repositoryId,
          parentHead: r.parentHead,
          settledHead: r.settledHead,
          restack: r.restack,
          restackFromSha: r.restackFromSha,
          restackSeq: r.restackSeq,
          recordedAt: r.recordedAt,
          seq: r.seq,
        },
      });
    });
    this.reads.add(result);
    void result.finally(() => this.reads.delete(result)).catch(() => {});
    return result;
  }
  private validate(identity: UnstackIdentity, operationId: string) {
    const current = this.local(identity.taskId, operationId);
    if (
      current.projectId !== identity.projectId ||
      current.authorityDigest !== identity.authorityDigest ||
      current.lifecycle.version !== identity.projectVersion ||
      Number(current.task.version) !== identity.taskVersion ||
      current.policy.version !== identity.policyVersion ||
      current.binding.revision !== identity.deliveryRevision ||
      current.targetBaseRef !== identity.targetBaseRef
    )
      throw new UnstackAuthorityChangedError(
        "Captured Unstack authority changed",
      );
  }
  private coordinator(
    record: Pick<UnstackRecord, "operationId" | "identity">,
  ): UnstackCoordinator {
    let coordinator = this.coordinators.get(record.operationId);
    if (coordinator) return coordinator;
    const { db, delivery, coordination } = this.options;
    const provider = this.options
      .provider(record.identity.taskId)
      .unstackProvider?.(delivery.configuration(record.identity.projectId));
    if (!provider) throw new DomainConflictError("GitHub Unstack unavailable");
    coordinator = new UnstackCoordinator(this.journal, provider, {
      projectWrite: this.options.projectWrite,
      validate: (i) => this.validate(i, record.operationId),
      confirm: (r) =>
        transaction(db, () => {
          this.validate(r.identity, r.operationId);
          delivery.acceptUnstackWithinTransaction(r);
          const i = r.identity;
          db.prepare(
            `UPDATE stacked_dependencies SET parentHead=?,restack='pending',restackFromSha=?,restackSeq=restackSeq+1 WHERE taskId=?`,
          ).run(r.newBaseSha, i.pr.headSha, i.taskId);
          coordination.ensureDeliveryEventWithinTransaction(
            i.taskId,
            `The provider stack membership was removed and this pull request now targets ${i.targetBaseRef}. Rebase this task's branch onto ${r.newBaseSha} and publish under the existing branch policy. Merged layers are unaffected.`,
            `unstack-restack:${r.operationId}`,
          );
          return this.journal.updateWithinTransaction(r, {
            phase: "confirmed",
            reason: "confirmed",
          });
        }),
    });
    this.coordinators.set(record.operationId, coordinator);
    return coordinator;
  }
  async execute(value: UnstackCommand): Promise<UnstackRecord> {
    const command = unstackCommandSchema.parse(value),
      prior = this.journal.replay(command);
    if (prior) {
      if (["confirmed", "failed"].includes(prior.phase)) return prior;
      return this.reconcile(prior.operationId);
    }
    return this.track(
      command.key,
      async () => {
        if (this.stopped) throw new Error("Unstack service stopped");
        const identity = await this.preview(command.taskId);
        if (this.stopped) throw new Error("Unstack service stopped");
        if (
          identity.taskVersion !== command.expectedVersion ||
          materialDigest(identity) !== command.materialHash
        )
          throw new UnstackAuthorityChangedError(
            "Unstack confirmation material changed",
          );
        return this.coordinator({ operationId: command.key, identity }).execute(
          command,
          identity,
        );
      },
      command,
    );
  }

  reconcile(operationId: string): Promise<UnstackRecord> {
    const prior = this.journal.get(operationId);
    if (!prior)
      return Promise.reject(
        new DomainConflictError("Unstack operation unavailable"),
      );
    if (["confirmed", "failed"].includes(prior.phase))
      return Promise.resolve(prior);
    return this.track(
      operationId,
      () => this.coordinator(prior).reconcile(operationId),
      prior.command,
    );
  }
  private track(
    operationId: string,
    run: () => Promise<UnstackRecord>,
    command: UnstackCommand,
  ): Promise<UnstackRecord> {
    const hash = materialDigest(command),
      active = this.running.get(operationId);
    if (active)
      return active.hash === hash
        ? active.result
        : Promise.reject(
            new DomainConflictError("Unstack key has different material"),
          );
    if (this.stopped)
      return Promise.reject(new Error("Unstack service stopped"));
    const result = run();
    this.running.set(operationId, { hash, result });
    void result
      .finally(() => {
        if (this.running.get(operationId)?.result === result)
          this.running.delete(operationId);
      })
      .catch(() => {});
    return result;
  }
  hasPending(): boolean {
    return this.journal
      .records()
      .some((r) => !["confirmed", "failed"].includes(r.phase));
  }
  async reconcileAll(): Promise<void> {
    if (this.stopped) return;
    for (const record of this.journal.records()) {
      if (["confirmed", "failed"].includes(record.phase)) continue;
      // Known per-action authority/capability conflicts retain the journal; storage/parser faults are not hidden.
      try {
        await this.reconcile(record.operationId);
      } catch (error) {
        if (!(error instanceof DomainConflictError)) throw error;
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([
      ...this.reads,
      ...[...this.running.values()].map((r) => r.result),
    ]);
  }
}
