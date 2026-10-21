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

type StatusMappingFields = {
  projectNodeId: string;
  fieldNodeId: string;
  optionNodeId: string;
}[];

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
  // Handed back until the task is Done, merged or accepted included. A handback the operator
  // settles as closed, or a PR that closes without merging, is sent back: work resumes.
  if (
    binding?.mode === "reviewable-pr" &&
    !binding.observation.draft &&
    binding.settlement?.decision !== "closed" &&
    !(binding.observation.state === "CLOSED" && !binding.observation.merged)
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
          // Done and settled: written, or never worked on under the mapping.
          (task.state === "done" && this.doneSettled(taskId))
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

  private doneSettled(taskId: string): boolean {
    const state = this.mappings.taskState(taskId);
    return (
      state.lastEvent === "done" &&
      (state.operationId === null
        ? !state.watched
        : // An operation id stored before a crash may never have been persisted.
          this.facts.deliveryStore.hasAction(state.operationId))
    );
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
    let state = this.mappings.taskState(taskId);
    const event = statusMappingEvent(this.facts, taskId, state.lastEvent);
    if (event !== "done" && !state.watched) {
      this.mappings.watch(taskId);
      state = this.mappings.taskState(taskId);
    }
    const option = event === "none" ? null : mapping.events[event];
    const issue = this.sources.issue(nodeId);
    const item = issue
      ? this.sources.membershipItem(projectId, mapping.selectionId, nodeId)
      : null;
    // While the task is Ready, a newer read of the item is what Ensemble last observed.
    if (ready && item && (item.readAt ?? 0) > (state.observedAt ?? 0)) {
      this.mappings.observed(
        taskId,
        item.projectFields.find(
          (f) =>
            f.projectNodeId === mapping.projectNodeId &&
            f.fieldNodeId === mapping.fieldNodeId,
        )?.optionNodeId ?? null,
        item.readAt ?? Date.now(),
      );
      state = this.mappings.taskState(taskId);
    }
    // Done on closure: a done task whose issue is observed closed is not Ready but may still be
    // written, against the Status Ensemble last observed or wrote, never one a human set since.
    const closing =
      !ready &&
      event === "done" &&
      issue?.observedState === "closed" &&
      state.watched &&
      state.observedAt !== null;
    const writable = ready || closing;
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
          optionNodeId: closing
            ? state.observedOptionNodeId
            : this.lastObserved(mapping, state, item),
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
    // Done recorded while the task was not writable (issue still open): written once it closes.
    const lateDone =
      event === "done" &&
      state.lastEvent === "done" &&
      state.operationId === null &&
      writable &&
      option &&
      item;
    if (event === state.lastEvent && !lateDone) {
      // Persisted before its write, but the write was never prepared (a crash between): resume it.
      if (
        event !== "none" &&
        option &&
        item &&
        writable &&
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
    if (event === "none" || !option || !item || !writable) {
      this.mappings.enter(taskId, event, null);
      return;
    }
    const operationId = randomUUID();
    this.mappings.enter(taskId, event, operationId);
    await this.submit(request(operationId), caller(event));
  }

  /**
   * The Status Ensemble last observed on the item: its last confirmed write, unless this item
   * was read after it (a partial read leaves an unread item's fields alone), else the stored
   * membership value (`null` is no value).
   */
  private lastObserved(
    mapping: StatusMapping,
    state: StatusMappingTaskState,
    item: { projectFields: StatusMappingFields; readAt: number | null } | null,
  ): string | null {
    if (state.observedAt !== null && !((item?.readAt ?? 0) > state.observedAt))
      return state.observedOptionNodeId;
    return (
      item?.projectFields.find(
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
