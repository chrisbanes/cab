import { randomUUID } from "node:crypto";
import type { DeliveryStore } from "../core/delivery.js";
import type { DomainStore } from "../core/domain.js";
import type { GitHubSourceStore } from "../core/github-source.js";
import type {
  StatusMappingStore,
  StatusMappingTaskState,
} from "../core/status-mapping.js";
import type {
  StatusMapping,
  StatusMappingEvent,
} from "../core/status-mapping-contracts.js";
import type { DeliveryCoordinator } from "./delivery.js";
import type { ExecutionState } from "./state.js";

export interface StatusMappingFacts {
  domain: DomainStore;
  state: ExecutionState;
  deliveryStore: DeliveryStore;
}

/**
 * The event a task is in now, from durable facts, in precedence `done > held > handedBack >
 * turnStarted`. A pure read, so a missed trigger is caught by the next pass. `previous` is the event
 * last recorded: an unknown dependency read (a partial read) keeps a held task held instead of
 * flapping, and is not itself a block.
 */
export function statusMappingEvent(
  { domain, state, deliveryStore }: StatusMappingFacts,
  taskId: string,
  previous: StatusMappingEvent | "none" = "none",
): StatusMappingEvent | "none" {
  const task = domain.task(taskId);
  if (task.state === "done") return "done";
  // Stopped, ambiguous or archived work, an uncertain agent or operator action, or a dependency
  // known to block.
  if (
    state.taskHold(taskId) !== undefined ||
    deliveryStore
      .actionBlockers(taskId)
      .includes("external-action-uncertain") ||
    task.importedBlockers === "blocked" ||
    (task.importedBlockers === "unknown" && previous === "held") ||
    domain.blockingDependencies(taskId).length
  )
    return "held";
  const binding = deliveryStore.delivery(taskId);
  // Handed back until the task is Done: a merged PR or an accepted settlement stays handed back.
  if (
    binding?.mode === "reviewable-pr" &&
    binding.observation.state !== "CLOSED" &&
    !binding.observation.draft &&
    binding.settlement?.decision !== "closed"
  )
    return "handedBack";
  return state.taskHasStartedTurn(taskId) ? "turnStarted" : "none";
}

/**
 * Writes each mapped event to the Project Status of a Ready imported task, as the service
 * caller, through the delivery coordinator. Every transition into a mapped event becomes one
 * operation; its id is stored before the write so a restart resumes it rather than minting another.
 */
export class StatusMappingWriter {
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  constructor(
    private readonly facts: StatusMappingFacts,
    private readonly mappings: StatusMappingStore,
    private readonly sources: GitHubSourceStore,
    private readonly coordinator: DeliveryCoordinator,
  ) {}

  /** One pass at a time; a request that arrives during a pass runs one more pass after it. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const pass = (async () => {
      do {
        this.again = false;
        await this.pass().catch(() => {
          // A failed pass leaves its tasks to the next one; it never stops the service.
        });
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = undefined;
    });
    this.running = pass;
    return pass;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async pass(): Promise<void> {
    const { domain } = this.facts;
    for (const project of domain.projects()) {
      const projectId = String(project.id);
      const { version, mapping } = this.mappings.current(projectId);
      if (!mapping || this.mappings.availability(projectId) !== "available")
        continue;
      for (const task of domain.tasks(projectId)) {
        if (this.stopped) return;
        const taskId = String(task.id);
        if (
          task.state === "cancelled" ||
          // Done and recorded: nothing more to write.
          (task.state === "done" &&
            this.mappings.taskState(taskId).lastEvent === "done")
        )
          continue;
        const imported = domain.importedTask(taskId);
        if (!imported) continue;
        try {
          await this.task(
            projectId,
            version,
            mapping,
            taskId,
            String(imported.nodeId),
            task.ready === 1,
          );
        } catch {
          // One task's failure leaves it to the next pass and does not stop the others.
        }
      }
    }
  }

  private async task(
    projectId: string,
    version: number,
    mapping: StatusMapping,
    taskId: string,
    nodeId: string,
    ready: boolean,
  ): Promise<void> {
    const { deliveryStore } = this.facts;
    const state = this.mappings.taskState(taskId);
    const event = statusMappingEvent(this.facts, taskId, state.lastEvent);
    const option = event === "none" ? null : mapping.events[event];
    const issue = this.sources.issue(nodeId);
    const item = issue
      ? this.sources.membershipItem(projectId, mapping.selectionId, nodeId)
      : null;
    const request = (operationId: string) => ({
      operationId,
      action: {
        kind: "project.field" as const,
        target: {
          repositoryId: String(issue?.repositoryId),
          number: Number(issue?.issueNumber),
          nodeId,
        },
        projectNodeId: mapping.projectNodeId,
        itemNodeId: item?.itemNodeId ?? "",
        fieldNodeId: mapping.fieldNodeId,
        optionNodeId: option ?? "",
        expected: {
          optionNodeId: this.lastObserved(
            projectId,
            mapping,
            state,
            item?.projectFields,
          ),
        },
      },
    });
    const caller = (event: StatusMappingEvent) => ({
      actor: "service" as const,
      purpose: "status-mapping" as const,
      projectId,
      taskId,
      mappingVersion: version,
      event,
    });
    if (event === state.lastEvent) {
      // Persisted before its write, but the write was never prepared (a crash between): resume it.
      if (
        event !== "none" &&
        option &&
        item &&
        ready &&
        state.operationId &&
        !deliveryStore
          .actions(taskId)
          .some((a) => a.operationId === state.operationId)
      )
        await this.submit(request(state.operationId), caller(event));
      return;
    }
    // A status write still in flight serializes the next one: the event is left to a later pass.
    if (deliveryStore.serviceActionBlockers(taskId).length) return;
    if (event === "none" || !option || !item || !ready) {
      this.mappings.enter(taskId, event, null);
      return;
    }
    const operationId = randomUUID();
    this.mappings.enter(taskId, event, operationId);
    await this.submit(request(operationId), caller(event));
  }

  /**
   * The Status Ensemble last observed on the item: its last confirmed write, unless a later
   * source read replaced it, else the stored membership value (`null` is no value).
   */
  private lastObserved(
    projectId: string,
    mapping: StatusMapping,
    state: StatusMappingTaskState,
    fields: {
      projectNodeId: string;
      fieldNodeId: string;
      optionNodeId: string;
    }[] = [],
  ): string | null {
    const refreshed = Date.parse(
      String(
        this.sources.syncState(projectId, mapping.selectionId)?.refreshedAt,
      ),
    );
    if (state.observedAt !== null && !(state.observedAt < refreshed))
      return state.observedOptionNodeId;
    return (
      fields.find(
        (f) =>
          f.projectNodeId === mapping.projectNodeId &&
          f.fieldNodeId === mapping.fieldNodeId,
      )?.optionNodeId ?? null
    );
  }

  private async submit(
    request: Parameters<DeliveryCoordinator["submit"]>[0],
    caller: Parameters<DeliveryCoordinator["submit"]>[1],
  ): Promise<void> {
    try {
      await this.coordinator.submit(request, caller);
    } catch {
      // The operation is stored; the coordinator's reconcile or the next pass resumes it.
    }
  }
}
