import { credentialFreeEnvironment } from "../core/child-environment.js";
import {
  isOperatorAction,
  isRecoveryAction,
  isOperatorDeliveryCaller,
  isOperatorPublicationCaller,
  isRuntimeDeliveryCaller,
  isServiceDeliveryCaller,
} from "../core/delivery.js";
import { DomainPolicyError } from "../core/domain.js";
import { DomainConflictError } from "../core/domain-errors.js";
import type { z } from "zod";
import {
  type DeliveryStore,
  externalActionArgumentsSchema,
  registerPrArgumentsSchema,
  handbackSettlementSchema,
  HandbackSettlementRefusedError,
  materialDigest,
  type DeliveryActionRecord,
  type DeliveryCaller,
  type ExternalActionArguments,
  type DeliveryPolicy,
  type PrDeliveryBinding,
  type PrDeliveryObservation,
  type ProviderActionObservation,
} from "../core/delivery.js";
import type { PushWorkspace } from "./push-verification.js";
import {
  type AdoptFunction,
  type AdoptionContext,
  type GitHubDeliveryProvider,
  GitHubHttpDeliveryProvider,
  IssueChangedRefusal,
  ProjectFieldChangedRefusal,
  PublicationRefusal,
  type PublicationContext,
  type PushFunction,
  type PushVerification,
} from "./github-delivery.js";

/** The unresolved review threads a lead can reply to or resolve, capped with an omitted count. */
export function unresolvedThreadSummary(
  observation: PrDeliveryObservation,
): string {
  const open = (observation.reviewThreads ?? []).filter((t) => !t.isResolved);
  return [
    ...open
      .slice(0, 20)
      .map(
        (t) =>
          `review-thread ${t.nodeId} latest ${t.latestCommentNodeId ?? "none"}`,
      ),
    ...(open.length > 20
      ? [`${open.length - 20} more unresolved review threads omitted`]
      : []),
  ].join("\n");
}

/** Only provider inspection failures are recoverable per-binding read holds. */
class DeliveryReadUnavailable extends Error {
  constructor() {
    super("Delivery provider inspection unavailable");
  }
}

export interface DeliveryCoordinatorOptions {
  fetcher?: typeof fetch;
  providerFactory?: (
    projectId: string,
    policy: DeliveryPolicy,
  ) => GitHubDeliveryProvider;
  authorize: (
    caller: DeliveryCaller,
    exceptOperationId?: string,
    request?: ExternalActionArguments,
  ) => void;
  approved: (
    request: ExternalActionArguments,
    caller: DeliveryCaller,
  ) => boolean;
  taskVersion?: (taskId: string) => number;
  leadAssignmentId?: (taskId: string) => string;
  feedback?: (taskId: string, reason: string, identity: string) => void;
  /** Offline check of a push's commit in the task worktree; null when it cannot be verified. */
  verifyPush?: (input: {
    taskId: string;
    repositoryId: string;
    commitSha: string;
    lastPushedSha: string | null;
  }) => Promise<PushVerification | null>;
  /** The repository's task worktree and the base it was provisioned at; null when unavailable. */
  taskWorkspace?: (
    taskId: string,
    repositoryId: string,
  ) => Promise<PushWorkspace | null>;
  /** Test seam for the HTTPS push; production uses `pushTaskCommit`. */
  push?: PushFunction;
  /** Test seam for the HTTPS fetch of an adopted head; production uses `adoptOutsideHead`. */
  adopt?: AdoptFunction;
  activationAllowed?: (policy: DeliveryPolicy) => boolean;
  /** How long a status-mapping write's provider call may take before it is given up as unproved. */
  statusWriteTimeoutMs?: number;
}
function actionKeys(record: {
  binding: DeliveryCaller;
  request: ExternalActionArguments;
}): string[] {
  // A status-mapping write has its own queue, so a slow provider never delays the task's work.
  if (isServiceDeliveryCaller(record.binding))
    return [`status:${record.binding.taskId}`];
  const target = record.request.action.target;
  return [
    `task:${record.binding.taskId}`,
    `target:${target.repositoryId}:${"number" in target ? target.number : "headRef" in target ? target.headRef : "branch"}`,
  ];
}
/** A confirmed no-effect failure the provider allows retrying, once its resume time has passed. */
function retryDue(record: DeliveryActionRecord): boolean {
  return (
    record.state === "confirmed-failure" &&
    record.observation?.retryable === true &&
    record.attempts < 3 &&
    (record.observation.resumeAt ?? 0) <= Date.now()
  );
}
/** Serializes a task and exact target; awaits provider I/O outside SQLite transactions. */
export class DeliveryCoordinator {
  private readonly tails = new Map<string, Promise<unknown>>();
  private stopped = false;
  constructor(
    private readonly store: DeliveryStore,
    private readonly options: DeliveryCoordinatorOptions,
  ) {}
  private provider(
    projectId: string,
    policy = this.store.configuration(projectId),
  ): GitHubDeliveryProvider {
    if (this.options.providerFactory)
      return this.options.providerFactory(projectId, policy);
    const credential = policy.credentialRef
      ? process.env[policy.credentialRef.slice(4)]
      : undefined;
    return new GitHubHttpDeliveryProvider(
      credential ?? "",
      this.options.fetcher,
      this.options.push,
      this.options.adopt,
    );
  }
  /**
   * A status-mapping write's provider call gives up after a time; other callers wait as before. The
   * limit exceeds the provider's 15 s request limit, so the mutation, the first request of a write,
   * has finished or been aborted before the write is given up and the next one can start. The timer
   * stays referenced: it is the only handle that can settle a call that never does.
   */
  private bounded<T>(caller: DeliveryCaller, call: Promise<T>): Promise<T> {
    if (!isServiceDeliveryCaller(caller)) return call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("status-write-timeout")),
          this.options.statusWriteTimeoutMs ?? 30_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
  /** Wakes the lead when a push found, or the PR shows, a branch head Ensemble did not push. */
  private outsidePush(
    taskId: string,
    repositoryId: string,
    sha: string | null,
  ) {
    try {
      this.options.feedback?.(
        taskId,
        `The task branch changed outside Ensemble (head ${sha ?? "deleted"}). Review the branch before publishing again.`,
        `outside-push:${repositoryId}:${sha ?? "absent"}`,
      );
    } catch {
      // The outside head is already recorded; a task without a lead has nobody to wake.
    }
  }
  private serialize<T>(keys: string[], run: () => Promise<T>): Promise<T> {
    const prior = [
      ...new Set(
        keys
          .map((k) => this.tails.get(k))
          .filter((p): p is Promise<unknown> => p !== undefined),
      ),
    ];
    const promise = Promise.allSettled(prior).then(run);
    for (const key of keys) this.tails.set(key, promise);
    void promise
      .finally(() => {
        for (const key of keys)
          if (this.tails.get(key) === promise) this.tails.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  submit(
    input: unknown,
    caller: DeliveryCaller,
  ): Promise<DeliveryActionRecord> {
    const request = externalActionArgumentsSchema.parse(input);
    if (
      isOperatorDeliveryCaller(caller) &&
      (!isOperatorAction(request.action) || request.approval)
    )
      throw new DomainPolicyError(
        "forbidden",
        "Operator delivery only permits issue.comment",
      );
    if (
      isOperatorPublicationCaller(caller) &&
      (request.approval || request.operatorReviewId)
    )
      throw new DomainPolicyError(
        "forbidden",
        "A publication is approved by its own confirmed review",
      );
    return this.serialize(
      actionKeys({ binding: caller, request }),
      async () => {
        if (this.stopped) throw new Error("Delivery coordinator stopped");
        const prior = this.store
          .actions(caller.taskId)
          .find((r) => r.operationId === request.operationId);

        const record = this.store.prepareAction(
          request,
          caller,
          this.options.approved(request, caller),
          () => {
            // An operator edit is authorized by its own gate, so that gate needs the action.
            if (!prior)
              this.options.authorize(
                caller,
                undefined,
                isOperatorDeliveryCaller(caller) ||
                  isOperatorPublicationCaller(caller)
                  ? request
                  : undefined,
              );
          },
        );
        if (record.state !== "prepared") return record;
        return this.attempt(record);
      },
    );
  }
  /**
   * Records the operator's resolution of an unproved action under the action's own queue, so a
   * read-back already in flight cannot overwrite it; refused unless the action is still unproved.
   */
  resolveUnproved(
    operationId: string,
    observation: ProviderActionObservation,
    within?: (record: DeliveryActionRecord) => void,
  ): Promise<DeliveryActionRecord> {
    return this.serialize(
      actionKeys(this.store.action(operationId)),
      async () => {
        if (this.store.action(operationId).state !== "uncertain")
          throw new DomainConflictError(
            "The action does not have an unknown outcome",
          );
        return this.store.recordObservation(operationId, observation, within);
      },
    );
  }
  /** What GitHub shows for an issue named to Link a publication; the caller judges it. */
  inspectPublishedIssue(
    projectId: string,
    target: { repositoryId: string; number: number },
    operationId: string,
  ) {
    return this.serialize([`task:${projectId}:${operationId}`], async () => {
      const provider = this.provider(projectId);
      if (!provider.inspectPublishedIssue)
        throw new Error("Published issue inspection unavailable");
      return provider.inspectPublishedIssue(target, operationId);
    });
  }
  private async attempt(
    record: DeliveryActionRecord,
  ): Promise<DeliveryActionRecord> {
    const caller = record.binding,
      policy = this.store.configuration(caller.projectId);
    const provider = this.provider(caller.projectId, policy);
    const action = record.request.action;
    let publication: PublicationContext | undefined;
    let adoption: AdoptionContext | undefined;
    const assigned = action.kind.startsWith("branch.")
      ? this.store.taskBranch(caller.taskId, action.target.repositoryId)
      : null;
    if (action.kind === "branch.adopt" && assigned) {
      const workspace = await this.options
        .taskWorkspace?.(caller.taskId, action.target.repositoryId)
        .catch(() => null);
      if (!workspace?.baseCommit)
        return this.store.recordObservation(record.operationId, {
          state: "confirmed-failure",
          reason: "branch-adopt-workspace-unavailable",
          receipt: null,
        });
      adoption = {
        branch: assigned.branch,
        lastPushedSha: assigned.lastPushedSha,
        workspacePath: workspace.workspacePath,
        baseCommit: workspace.baseCommit,
      };
    }
    if (
      (action.kind === "branch.push" || action.kind === "branch.force-push") &&
      assigned
    ) {
      // A retry of an older operation must not rewrite a branch a newer push has moved on.
      const first =
        record.attempts > 0
          ? this.store.firstAttemptLastPushed(record.operationId)
          : undefined;
      if (first !== undefined && first !== assigned.lastPushedSha)
        return this.store.recordObservation(record.operationId, {
          state: "confirmed-failure",
          reason: "push-superseded",
          receipt: null,
        });
      // Offline first: a commit that is not the task's own work never reaches a provider.
      const verified = await this.options
        .verifyPush?.({
          taskId: caller.taskId,
          repositoryId: action.target.repositoryId,
          commitSha: action.commitSha,
          lastPushedSha: assigned.lastPushedSha,
        })
        .catch(() => null);
      if (!verified)
        return this.store.recordObservation(record.operationId, {
          state: "confirmed-failure",
          reason: "push-commit-not-verified",
          receipt: null,
        });
      publication = {
        ...verified,
        branch: assigned.branch,
        lastPushedSha: assigned.lastPushedSha,
        ...(action.kind === "branch.force-push" &&
        action.outsideHeadSha !== undefined
          ? { outsideHeadSha: action.outsideHeadSha }
          : {}),
        // Only an earlier attempt that may have pushed can have landed late.
        retry: this.store.mayHaveLanded(record.operationId),
      };
    }
    let before: Record<string, z.output<ReturnType<typeof z.json>>>;
    try {
      before = await this.bounded(
        caller,
        provider.preflight(action, policy, publication, adoption),
      );
    } catch (error) {
      // The issue no longer shows the text the operator edit replaces, or the item the Status
      // the mapped write expected: nothing is written.
      if (
        error instanceof IssueChangedRefusal ||
        error instanceof ProjectFieldChangedRefusal
      )
        return this.store.recordObservation(record.operationId, {
          state: "confirmed-failure",
          reason: error.reason,
          receipt: null,
        });
      if (error instanceof PublicationRefusal) {
        const outside = error.reason === "branch-outside-change";
        if (error.reason === "branch-outside-cleared" && assigned)
          // The remote is back at Ensemble's own push: only the head this recovery named is obsolete.
          return this.store.recordObservation(
            record.operationId,
            {
              state: "confirmed-failure",
              reason: error.reason,
              receipt: null,
            },
            () => {
              if (
                this.store.taskBranch(caller.taskId, assigned.repositoryId)
                  ?.outsideHeadSha ===
                (isRecoveryAction(action) ? action.outsideHeadSha : null)
              )
                this.store.clearOutsideHead(
                  caller.taskId,
                  assigned.repositoryId,
                );
            },
          );
        return this.store.recordObservation(
          record.operationId,
          {
            state: "confirmed-failure",
            reason: error.reason,
            receipt:
              outside && error.outsideHeadSha && assigned
                ? {
                    nodeId: action.target.repositoryId,
                    ref: assigned.branch,
                    headSha: error.outsideHeadSha,
                  }
                : null,
          },
          () =>
            outside &&
            this.outsidePush(
              caller.taskId,
              action.target.repositoryId,
              error.outsideHeadSha,
            ),
        );
      }
      return this.store.recordObservation(record.operationId, {
        state: "confirmed-failure",
        reason: "provider-preflight-held",
        receipt: null,
      });
    }
    if (
      assigned?.outsideHeadSha &&
      !isRecoveryAction(action) &&
      before.beforeHead !== undefined &&
      before.beforeHead === assigned.lastPushedSha
    )
      this.store.clearOutsideHead(caller.taskId, assigned.repositoryId);
    // Reuse final-completion evidence under the already-held task serialization.
    // The action's own prepared intent is the only delivery effect excluded.
    const closureGuard =
      record.request.action.kind === "issue.close"
        ? await this.qualifyCompletionWithinTask(
            caller.taskId,
            record.operationId,
          )
        : undefined;
    // All new authority is checked synchronously after the final provider await.
    let attempting: DeliveryActionRecord;
    try {
      attempting = this.store.beginAttempt(record.operationId, before, () => {
        if (closureGuard?.().length)
          throw new Error("PR delivery boundary held");
        if (assigned) {
          // The branch and the last push must be what preflight saw after the final await.
          const current = this.store.taskBranch(
            caller.taskId,
            assigned.repositoryId,
          );
          if (
            current?.branch !== assigned.branch ||
            current.lastPushedSha !== assigned.lastPushedSha
          )
            throw new Error("Task branch changed during publication");
        }
        if (this.stopped || this.options.activationAllowed?.(policy) === false)
          throw new Error(
            "Delivery credential activation requires safe runtime restart",
          );
        this.options.authorize(caller, record.operationId, record.request);
        this.store.authorize(
          record.request,
          caller,
          this.options.approved(record.request, caller),
          record.policyVersion,
        );
      });
    } catch {
      return this.store.recordObservation(record.operationId, {
        state: "confirmed-failure",
        reason: "delivery-authority-stale-or-held",
        receipt: null,
      });
    }
    let observation: ProviderActionObservation;
    try {
      observation = await this.bounded(
        caller,
        provider.performAction(attempting),
      );
    } catch {
      observation = {
        state: "uncertain" as const,
        reason: "provider-effect-unproved",
        receipt: null,
      };
    }
    // A retryable failure waits for reconcile() once its resume time passes.
    const recorded = this.recordPublicationAware(record, observation);
    // The PR head moved with the push: observe it now, under the task's serialization.
    if (
      assigned &&
      recorded.state === "confirmed-success" &&
      this.store.delivery(caller.taskId)
    )
      await this.inspectBinding(caller.taskId).catch(() => {});
    return recorded;
  }
  private recordPublicationAware(
    record: DeliveryActionRecord,
    observation: ProviderActionObservation,
  ): DeliveryActionRecord {
    const action = record.request.action,
      outside =
        observation.outsideHeadSha ??
        (observation.reason === "branch-outside-change"
          ? (observation.receipt?.headSha ?? null)
          : observation.outsideDeleted
            ? null
            : undefined);
    return this.store.recordObservation(
      record.operationId,
      observation,
      () =>
        action.kind.startsWith("branch.") &&
        outside !== undefined &&
        this.outsidePush(
          record.binding.taskId,
          action.target.repositoryId,
          outside,
        ),
    );
  }
  async registerPr(input: unknown, caller: DeliveryCaller) {
    if (!isRuntimeDeliveryCaller(caller))
      throw Error("Only an agent caller can register a PR");
    const identity = registerPrArgumentsSchema.parse(input);
    return this.serialize([`task:${caller.taskId}`], async () => {
      this.options.authorize(caller);
      const policy = this.store.configuration(caller.projectId),
        taskVersion =
          this.options.taskVersion?.(caller.taskId) ?? caller.taskVersion;
      const observation = await this.provider(
        caller.projectId,
        policy,
      ).inspectPr(identity, policy);
      return this.store.transaction(() => {
        this.options.authorize(caller);
        if (
          policy.version !==
            this.store.configuration(caller.projectId).version ||
          taskVersion !==
            (this.options.taskVersion?.(caller.taskId) ?? caller.taskVersion) ||
          observation.headSha !== identity.expectedHeadSha
        )
          throw new Error("PR registration material changed");
        const lead =
          this.options.leadAssignmentId?.(caller.taskId) ?? caller.assignmentId;
        if (lead !== caller.assignmentId)
          throw new Error("Only the task lead registers PR delivery");
        // Recorded before registration so an existing binding's own observation cannot swallow it.
        const outside = this.store.outsideHeadWithinTransaction(
          caller.taskId,
          observation,
        );
        const registered = this.store.registerPrWithinTransaction(
          caller,
          observation,
          lead,
        );
        if (outside)
          this.outsidePush(
            caller.taskId,
            observation.repositoryId,
            observation.headSha,
          );
        return registered;
      });
    });
  }
  /**
   * Classifies a fresh read of an issue the task's confirmed delivery closed: `reopened`
   * supersedes that own closure, `proved` pins its ClosedEvent, and `attribution-unproved`
   * is a deterministic mismatch. A read failure throws.
   */
  async inspectOwnClosure(
    taskId: string,
    target: { repositoryId: string; nodeId: string; number: number },
    stored?: { operationId: string; closedEventId: string | null },
  ): Promise<
    | { kind: "reopened"; operationId: string }
    | { kind: "attribution-unproved"; operationId: string }
    | {
        kind: "proved";
        operationId: string;
        snapshot: import("../core/github-source.js").IssueSnapshot;
        closerPrNodeId: string | null;
        closedEventId: string;
      }
  > {
    const record = this.store.ownClosureOperation(taskId, target.nodeId);
    if (!record) throw new Error("Closure is not attributed to this task");
    const { operationId } = record;
    return this.serialize(
      [`task:${taskId}`, `target:${target.repositoryId}:${target.number}`],
      async () => {
        const provider = this.provider(record.binding.projectId);
        if (!provider.inspectClosedIssue)
          throw new Error("Fresh closure inspection unavailable");
        const closerPrNodeId =
          record.request.action.kind === "pr.merge"
            ? record.request.action.target.nodeId
            : null;
        const inspection = await provider.inspectClosedIssue(target);
        if (inspection.state === "open")
          return { kind: "reopened", operationId };
        const event = inspection.closedEvent;
        const pinned =
          stored?.operationId === operationId ? stored.closedEventId : null;
        // A different later ClosedEvent exists only after a reopen.
        if (pinned !== null && event !== null && event.id !== pinned)
          return { kind: "reopened", operationId };
        const attributed =
          event !== null &&
          (pinned !== null ||
            (closerPrNodeId
              ? event.closerPrNodeId === closerPrNodeId
              : event.closerKind === "none"));
        return attributed
          ? {
              kind: "proved",
              operationId,
              snapshot: inspection.snapshot,
              closerPrNodeId,
              closedEventId: event.id,
            }
          : { kind: "attribution-unproved", operationId };
      },
    );
  }
  async refresh(): Promise<void> {
    await this.reconcile();
    for (const binding of this.store.deliveries())
      await this.serialize([`task:${binding.taskId}`], async () => {
        if (this.stopped) return;
        try {
          await this.inspectBinding(binding.taskId);
        } catch (error) {
          if (!(error instanceof DeliveryReadUnavailable)) throw error;
        }
      });
  }
  private async inspectBinding(taskId: string) {
    const binding = this.store.delivery(taskId);
    if (!binding) throw new Error("Unknown PR delivery");
    const policy = this.store.configuration(binding.projectId),
      p = binding.observation,
      provider = this.provider(binding.projectId, policy);
    let observation: PrDeliveryObservation;
    try {
      observation = await provider.inspectPr(
        {
          repositoryId: p.repositoryId,
          prNumber: p.number,
          expectedPrNodeId: p.nodeId,
          expectedHeadSha: p.headSha,
        },
        policy,
      );
    } catch {
      this.store.recordPrReadFailure(taskId);
      throw new DeliveryReadUnavailable();
    }
    return this.store.transaction(() => {
      const current = this.store.delivery(taskId);
      if (!current || current.revision !== binding.revision)
        throw new Error("PR delivery changed during inspection");
      const result = this.store.observePrWithinTransaction(taskId, observation);
      // One event: an outside head is the more specific notice for a changed PR.
      if (result.outsideHead)
        this.outsidePush(taskId, observation.repositoryId, observation.headSha);
      else if (result.changed)
        this.options.feedback?.(
          taskId,
          `PR delivery feedback changed: ${observation.checks.map((c) => `${c.name}: ${c.status}`).join("; ")}. ${(
            observation.feedback ?? []
          )
            .slice(-10)
            .map((f) => `${f.kind} ${f.nodeId} (${f.state}): ${f.body}`)
            .join("\n")}\n${unresolvedThreadSummary(observation)}`.trimEnd(),
          `${result.binding.revision}:${result.binding.observationDigest}`,
        );
      return result.binding;
    });
  }
  async settleHandback(input: unknown) {
    const command = handbackSettlementSchema.parse(input);
    return this.serialize([`task:${command.taskId}`], async () => {
      const receipt = this.store.settlementReceipt(command);
      if (receipt) return receipt;
      const prior = this.store.delivery(command.taskId);
      if (!prior)
        throw new HandbackSettlementRefusedError("Unknown PR delivery");
      const taskVersion =
          this.options.taskVersion?.(command.taskId) ??
          command.expectedTaskVersion,
        policy = this.store.configuration(prior.projectId);
      if (
        prior.observation.repositoryId !== command.repositoryId ||
        prior.observation.nodeId !== command.expectedPrNodeId ||
        prior.observation.number !== command.prNumber
      )
        throw new HandbackSettlementRefusedError("Handback target changed");
      const observed = await this.inspectBinding(command.taskId);
      // Changed observations and their durable feedback survive a rejected command.
      return this.store.transaction(() => {
        if (
          taskVersion !== command.expectedTaskVersion ||
          (this.options.taskVersion?.(command.taskId) ?? taskVersion) !==
            taskVersion ||
          policy.version !== command.expectedPolicyVersion ||
          this.store.configuration(prior.projectId).version !==
            policy.version ||
          prior.revision !== command.expectedDeliveryRevision ||
          observed.revision !== prior.revision ||
          observed.observation.headSha !== command.expectedHeadSha
        )
          throw new HandbackSettlementRefusedError(
            "Handback material changed during fresh inspection",
          );
        const result = this.store.settleHandbackWithinTransaction(command);
        this.options.feedback?.(
          command.taskId,
          "Operator handback settled",
          `settlement:${command.key}`,
        );
        return result;
      });
    });
  }
  async qualifyCompletion(taskId: string): Promise<() => string[]> {
    return this.serialize([`task:${taskId}`], () =>
      this.qualifyCompletionWithinTask(taskId),
    );
  }
  private async qualifyCompletionWithinTask(
    taskId: string,
    exceptOperationId?: string,
  ): Promise<() => string[]> {
    const binding = this.store.delivery(taskId),
      taskVersion = this.options.taskVersion?.(taskId);
    if (!binding)
      return () =>
        this.store.delivery(taskId)
          ? ["delivery-completion-evidence-changed"]
          : this.store.completionBlockers(
              taskId,
              taskVersion,
              exceptOperationId,
            );
    const policyVersion = this.store.configuration(binding.projectId).version;
    let observed: PrDeliveryBinding;
    try {
      observed = await this.inspectBinding(taskId);
    } catch (error) {
      if (!(error instanceof DeliveryReadUnavailable)) throw error;
      return () => ["delivery-provider-read-unavailable"];
    }
    const revision = observed.revision,
      digest = materialDigest(observed.observation);
    return () => {
      const current = this.store.delivery(taskId);
      if (
        !current ||
        current.revision !== revision ||
        materialDigest(current.observation) !== digest ||
        this.store.configuration(binding.projectId).version !== policyVersion ||
        this.options.taskVersion?.(taskId) !== taskVersion
      )
        return ["delivery-completion-evidence-changed"];
      if (revision !== binding.revision)
        return ["delivery-changed-before-completion"];
      return this.store.completionBlockers(
        taskId,
        taskVersion,
        exceptOperationId,
      );
    };
  }
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    for (const record of this.store.actions()) {
      if (
        !["prepared", "attempting", "uncertain"].includes(record.state) &&
        !retryDue(record)
      )
        continue;
      await this.serialize(actionKeys(record), async () => {
        const current = this.store.action(record.operationId);
        if (current.state === "prepared" || retryDue(current)) {
          await this.attempt(current);
          return;
        }
        if (!["attempting", "uncertain"].includes(current.state)) return;
        // An older unproved status write is not inspected again once a newer one has been sent: the
        // newer write re-read the Status, and re-inspecting history would grow without end. It stays
        // uncertain, since its effect may have landed.
        if (
          current.state === "uncertain" &&
          isServiceDeliveryCaller(current.binding) &&
          this.store.latestSentServiceOperation(current.binding.taskId) !==
            current.operationId
        ) {
          return;
        }
        let observation: ProviderActionObservation;
        try {
          observation = await this.bounded(
            current.binding,
            this.provider(current.binding.projectId).inspectAction(current),
          );
        } catch {
          observation = {
            state: "uncertain" as const,
            reason: "provider-readback-unavailable",
            receipt: null,
            ...(current.observation?.pushed ? { pushed: true } : {}),
            ...(current.observation?.rejected ? { rejected: true } : {}),
            ...(current.observation?.ambiguous ? { ambiguous: true } : {}),
          };
        }
        this.recordPublicationAware(current, observation);
      });
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...new Set(this.tails.values())]);
  }
}

/** Spawn snapshot only: accepted host reads and ordinary Codex login remain available. */
export function deliveryRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  policies: readonly DeliveryPolicy[],
): NodeJS.ProcessEnv {
  return credentialFreeEnvironment(
    environment,
    policies.flatMap((p) =>
      p.credentialRef ? [p.credentialRef.slice(4)] : [],
    ),
  );
}
