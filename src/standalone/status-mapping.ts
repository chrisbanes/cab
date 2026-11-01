import { randomUUID } from "node:crypto";
import type { DeliveryStore } from "../core/delivery.js";
import type { DomainStore } from "../core/domain.js";
import type { GitHubSourceStore } from "../core/github-source.js";
import type {
  StatusMappingStore,
  StatusMappingTaskState,
} from "../core/status-mapping.js";
import {
  isJiraMapping,
  type StatusMapping,
  type StatusMappingEvent,
} from "../core/status-mapping-contracts.js";
import type { DeliveryCoordinator } from "./delivery.js";
import type { ExecutionState } from "./state.js";

/** What the mapping last read of a task's status: the item (the issue itself for Jira) and the value, with when. */
interface ObservedStatus {
  itemNodeId: string;
  value: string | null;
  readAt: number | null;
}

export interface StatusMappingFacts {
  domain: DomainStore;
  state: ExecutionState;
  deliveryStore: DeliveryStore;
  mappings: StatusMappingStore;
}

type Binding = ReturnType<DeliveryStore["delivery"]>;
const isHandedBack = (binding: Binding) =>
  binding?.mode === "reviewable-pr" && !binding.observation.draft;
/** The operator settled the handback as closed, or the PR closed without merging. */
const isSentBack = (binding: Binding) =>
  binding?.settlement?.decision === "closed" ||
  (binding?.observation.state === "CLOSED" && !binding.observation.merged);

/**
 * The event a task is in now, from durable facts, in precedence `done > held > handedBack >
 * turnStarted`. A pure read, so a missed trigger is caught by the next pass. `previous` is the event
 * last recorded: an unknown dependency read (a partial read) keeps a held task held instead of
 * flapping, and is not itself a block.
 */
export function statusMappingEvent(
  { domain, state, deliveryStore, mappings }: StatusMappingFacts,
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
  // settles as closed, or a PR that closes without merging, is sent back; the next turn after it
  // moves the card back, so it stays handed back until a turn starts.
  if (isHandedBack(binding)) {
    const baseline = mappings.taskState(taskId).sentBackTurns;
    return isSentBack(binding) &&
      baseline !== null &&
      state.taskStartedTurnCount(taskId) > baseline
      ? "turnStarted"
      : "handedBack";
  }
  return state.taskStartedTurnCount(taskId) > 0 ? "turnStarted" : "none";
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
      if (!mapping || this.mappings.availability(projectId) !== "available") {
        // Tasks that finish while the mapping cannot write were not worked on under it when it returns.
        this.mappings.forget(projectId);
        continue;
      }
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
            this.sources.forTracker({
              provider: String(imported.provider),
              instance: String(imported.instance),
            }),
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
    sources: GitHubSourceStore,
  ): Promise<void> {
    const { domain, deliveryStore, state: execution } = this.facts;
    // The mapping changed while this pass waited: its tasks are left to the next pass, under the new one.
    if (this.mappings.current(projectId).version !== version) return;
    // Read now, with the item below: the pass may have waited on the network since it listed tasks.
    const fresh = domain.task(taskId);
    if (fresh.state === "cancelled") return;
    const ready = fresh.ready === 1;
    let state = this.mappings.taskState(taskId);
    // A handback sent back waits for the next turn: note how many turns had started when it was.
    const binding = deliveryStore.delivery(taskId);
    const sentBack = isHandedBack(binding) && isSentBack(binding);
    if (sentBack && state.sentBackTurns === null) {
      this.mappings.setSentBack(taskId, execution.taskStartedTurnCount(taskId));
      state = this.mappings.taskState(taskId);
    } else if (!sentBack && state.sentBackTurns !== null) {
      this.mappings.setSentBack(taskId, null);
      state = this.mappings.taskState(taskId);
    }
    const event = statusMappingEvent(this.facts, taskId, state.lastEvent);
    if (event !== "done" && !state.watched) {
      this.mappings.watch(taskId);
      state = this.mappings.taskState(taskId);
    }
    const option = event === "none" ? null : mapping.events[event];
    const issue = sources.issue(nodeId);
    const item = issue
      ? this.observation(sources, projectId, mapping, nodeId)
      : null;
    // While the task is Ready, a newer read of the item is what cab last observed.
    if (ready && item && (item.readAt ?? 0) > (state.observedAt ?? 0)) {
      this.mappings.observed(taskId, item.value, item.readAt ?? Date.now());
      state = this.mappings.taskState(taskId);
    }
    // Done on closure: a done task whose issue is observed closed is not Ready but may still be
    // written, against the Status cab last observed or wrote, never one a human set since.
    const closing =
      !ready &&
      event === "done" &&
      issue?.observedState === "closed" &&
      state.watched &&
      state.observedAt !== null;
    // A task first seen done was not worked on under the mapping: no Done write, Ready or not.
    const writable = (ready && (event !== "done" || state.watched)) || closing;
    const request = (operationId: string) => {
      const target = {
        repositoryId: String(issue?.repositoryId),
        number: Number(issue?.issueNumber),
        nodeId,
      };
      const expected = closing
        ? state.observedOptionNodeId
        : this.lastObserved(state, item);
      return {
        operationId,
        action: isJiraMapping(mapping)
          ? {
              kind: "issue.status" as const,
              target,
              statusId: option ?? "",
              expected: { statusId: expected },
            }
          : {
              kind: "project.field" as const,
              target,
              projectNodeId: mapping.projectNodeId,
              itemNodeId: item?.itemNodeId ?? "",
              fieldNodeId: mapping.fieldNodeId,
              optionNodeId: option ?? "",
              expected: { optionNodeId: expected },
            },
      };
    };
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
      // Persisted before its write, but the write was never prepared (a crash between): resume it,
      // once an older status write still in flight has settled.
      if (
        !deliveryStore.serviceActionBlockers(taskId).length &&
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

  /** The task's status as the mapping's tracker last read it, or `null` when the issue has no item to write. */
  private observation(
    sources: GitHubSourceStore,
    projectId: string,
    mapping: StatusMapping,
    nodeId: string,
  ): ObservedStatus | null {
    if (isJiraMapping(mapping)) {
      const read = sources.membershipRead(projectId, nodeId);
      return (
        read && {
          itemNodeId: nodeId,
          value: read.statusId,
          readAt: read.readAt,
        }
      );
    }
    const item = sources.membershipItem(projectId, mapping.selectionId, nodeId);
    return (
      item && {
        itemNodeId: item.itemNodeId,
        readAt: item.readAt,
        value:
          item.projectFields.find(
            (f) =>
              f.projectNodeId === mapping.projectNodeId &&
              f.fieldNodeId === mapping.fieldNodeId,
          )?.optionNodeId ?? null,
      }
    );
  }

  /**
   * The Status cab last observed on the item: its last confirmed write, unless this item
   * was read after it (a partial read leaves an unread item's fields alone), else the stored
   * membership value (`null` is no value).
   */
  private lastObserved(
    state: StatusMappingTaskState,
    item: ObservedStatus | null,
  ): string | null {
    if (state.observedAt !== null && !((item?.readAt ?? 0) > state.observedAt))
      return state.observedOptionNodeId;
    return item?.value ?? null;
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
