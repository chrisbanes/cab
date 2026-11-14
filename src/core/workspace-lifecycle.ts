import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainConflictError } from "./domain-errors.js";
import { type Database, transaction } from "./store.js";

const identity = z.string().min(1).max(512);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const path = z.string().min(1).max(16384);
const repositorySchema = z.looseObject({
  repositoryId: identity,
  sourcePath: path,
  workspacePath: path,
  ref: identity,
  gitCommonDir: path.nullable(),
  commit: z.string().min(1).nullable(),
  sourceGitCommonDir: path.nullable().optional(),
  gitDirectory: path.nullable().optional(),
  base: z
    .strictObject({
      mode: z.enum(["remote-branch", "remote-default"]),
      fetch: z.boolean(),
    })
    .optional(),
  baseBranch: identity.optional(),
});
const generationInputSchema = z.strictObject({
  taskId: identity,
  workspaceId: z.uuid(),
  path,
  repositories: z.array(repositorySchema),
  createdAt: z.iso.datetime().nullable(),
});
const repositoryClockSchema = z.strictObject({
  repositoryId: identity,
  pushedCommit: commit.nullable(),
  pushedAt: time.nullable(),
  changeRequestId: identity.nullable(),
  merged: z.boolean().nullable(),
});
export const workspaceGenerationSchema = generationInputSchema.extend({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastObservedAt: time.nullable(),
  lastTurnEndedAt: time.nullable(),
  lastTurnEndedEventId: identity.nullable().default(null),
  terminal: z
    .strictObject({
      episodeId: identity,
      status: z.enum(["done", "cancelled"]),
      at: time,
    })
    .nullable(),
  lastPushAt: time.nullable(),
  allMergedAt: time.nullable(),
  repositoryClocks: z.array(repositoryClockSchema),
});
export type WorkspaceGeneration = z.infer<typeof workspaceGenerationSchema>;
export type WorkspaceGenerationInput = z.infer<typeof generationInputSchema>;
type GenerationIdentity = Pick<WorkspaceGeneration, "taskId" | "workspaceId">;

export const workspaceLifecycleEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("turn-ended"),
    eventId: identity,
    at: time,
    workId: identity,
    turnId: identity,
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    eventId: identity,
    at: time,
    status: z.enum(["done", "cancelled"]).nullable(),
  }),
  z.strictObject({
    kind: z.literal("push"),
    eventId: identity,
    at: time,
    repositoryId: identity,
    commit,
    removalOperationId: z.uuid().nullable(),
  }),
  z.strictObject({
    kind: z.literal("merge"),
    eventId: identity,
    at: time,
    repositoryId: identity,
    changeRequestId: identity,
    merged: z.boolean(),
  }),
]);
type LifecycleEvent = z.infer<typeof workspaceLifecycleEventSchema>;
const removalProofSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pushed"),
    repositoryId: identity,
    branch: identity,
    commit,
  }),
  z.strictObject({
    kind: z.literal("base"),
    repositoryId: identity,
    branch: identity,
    commit,
    noTaskCommits: z.literal(true),
  }),
]);
const effectSchema = z.strictObject({
  effectId: z.uuid(),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("repository"), repositoryId: identity }),
    z.strictObject({ kind: z.enum(["root", "scratch", "claude-base"]) }),
  ]),
  startedAt: time,
  settledAt: time.nullable(),
  outcome: z.enum(["succeeded", "failed"]).nullable(),
});
const operationInputSchema = z.strictObject({
  operationId: z.uuid(),
  kind: z.enum(["trim", "remove"]),
  trigger: z.enum(["manual", "idle", "delivered", "merged", "disk"]),
  startedAt: time,
});
export const workspaceOperationSchema = operationInputSchema
  .extend({
    taskId: identity,
    workspaceId: z.uuid(),
    state: z.enum(["active", "held", "completed"]),
    reason: z.string().min(1).max(4096).nullable(),
    effects: z.array(effectSchema).max(1024),
    completedAt: time.nullable(),
    repositories: z.array(removalProofSchema).nullable(),
  })
  .superRefine((operation, context) => {
    const completed = operation.state === "completed";
    if (
      (operation.completedAt !== null) !== completed ||
      (operation.completedAt !== null &&
        operation.completedAt < operation.startedAt) ||
      new Set(operation.effects.map((effect) => effect.effectId)).size !==
        operation.effects.length ||
      (operation.repositories !== null) !==
        (completed && operation.kind === "remove") ||
      (operation.reason !== null) !== (operation.state === "held") ||
      operation.effects.some(
        (effect) =>
          effect.startedAt < operation.startedAt ||
          (effect.settledAt === null) !== (effect.outcome === null) ||
          (effect.settledAt !== null && effect.settledAt < effect.startedAt) ||
          (completed &&
            (effect.outcome !== "succeeded" ||
              effect.settledAt! > operation.completedAt!)),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent maintenance journal phase",
      });
  });
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;

/** Stores facts only; callers retain ownership, safety checks and physical readback. */
export class WorkspaceLifecycleStore {
  constructor(private readonly db: Database) {}

  /** Called by the domain migration owner, never implicitly by service readers. */
  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_generations (
      workspaceId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workspace_generations_task ON workspace_generations(taskId);
    CREATE TABLE IF NOT EXISTS workspace_lifecycle_events (
      workspaceId TEXT NOT NULL REFERENCES workspace_generations(workspaceId),
      eventId TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(workspaceId,eventId)
    );
    CREATE TABLE IF NOT EXISTS workspace_maintenance_operations (
      operationId TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL REFERENCES workspace_generations(workspaceId),
      data TEXT NOT NULL
    );`);
  }

  recordBinding(input: WorkspaceGenerationInput): WorkspaceGeneration {
    return this.write(() => {
      const parsed = generationInputSchema.parse(input);
      const prior = this.get(parsed.workspaceId);
      if (!prior) return this.retain(parsed);
      if (
        prior.taskId !== parsed.taskId ||
        prior.path !== parsed.path ||
        prior.createdAt !== parsed.createdAt ||
        JSON.stringify(
          prior.repositories.map((r) => [
            r.repositoryId,
            r.sourcePath,
            r.workspacePath,
            r.ref,
          ]),
        ) !==
          JSON.stringify(
            parsed.repositories.map((r) => [
              r.repositoryId,
              r.sourcePath,
              r.workspacePath,
              r.ref,
            ]),
          )
      )
        this.conflict("Workspace generation binding identity changed");
      if (
        JSON.stringify(prior.repositories) !==
        JSON.stringify(parsed.repositories)
      ) {
        prior.repositories = parsed.repositories;
        this.saveGeneration(prior);
      }
      return prior;
    });
  }

  current(taskId: string): WorkspaceGeneration | undefined {
    if (!this.hasTable("task_workspace_bindings")) return undefined;
    const row = this.db
      .prepare("SELECT workspaceId FROM task_workspace_bindings WHERE taskId=?")
      .get(taskId);
    if (!row) return undefined;
    const generation = this.get(
      z.object({ workspaceId: z.uuid() }).parse(row).workspaceId,
    );
    if (generation && generation.taskId !== taskId)
      this.conflict("Current workspace owner mismatch");
    return generation;
  }

  taskStateChanged(
    taskId: string,
    status: "open" | "done" | "cancelled",
    at = Date.now(),
  ): void {
    const generation = this.current(taskId);
    const terminal = status === "open" ? null : status;
    if (!generation || (generation.terminal?.status ?? null) === terminal)
      return;
    const row = z
      .object({ version: z.number().int().positive() })
      .parse(
        this.db
          .prepare("SELECT version FROM domain_tasks WHERE id=?")
          .get(taskId),
      );
    this.observe(generation, {
      kind: "terminal",
      eventId: `task-state:${row.version}`,
      at,
      status: terminal,
    });
  }

  recordTurnEnd(
    workId: string,
    threadId: string,
    turnId: string,
    at: number,
  ): void {
    const row = this.db
      .prepare(`SELECT b.taskId,i.workspace FROM task_execution_bindings b
      JOIN execution_intents i ON i.workId=b.workId
      WHERE b.workId=? AND i.threadId=? AND i.turnId=?`)
      .get(workId, threadId, turnId);
    if (!row) return;
    const binding = z.object({ taskId: identity, workspace: path }).parse(row);
    const matches = this.forTask(binding.taskId).filter(
      (g) => g.path === binding.workspace,
    );
    const generation = matches.length === 1 ? matches[0] : undefined;
    if (!generation) return;
    const eventId = `turn-ended:${createHash("sha256")
      .update(JSON.stringify([threadId, turnId]))
      .digest("hex")}`;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM workspace_lifecycle_events WHERE workspaceId=? AND eventId=?",
        )
        .get(generation.workspaceId, eventId)
    )
      return;
    this.observe(generation, {
      kind: "turn-ended",
      eventId,
      at,
      workId,
      turnId,
    });
  }

  recordPush(
    taskId: string,
    workId: string,
    repositoryId: string,
    operationId: string,
    sha: string,
    at: number,
  ): void {
    const generation = this.forWork(taskId, workId);
    if (!generation?.repositories.some((r) => r.repositoryId === repositoryId))
      return;
    this.observe(generation, {
      kind: "push",
      eventId: `push:${operationId}`,
      at,
      repositoryId,
      commit: sha,
      removalOperationId: null,
    });
  }

  recordMerge(
    taskId: string,
    workId: string,
    repositoryId: string,
    changeRequestId: string,
    merged: boolean,
    observationId: string,
    at: number,
  ): void {
    const generation = this.forWork(taskId, workId);
    if (!generation?.repositories.some((r) => r.repositoryId === repositoryId))
      return;
    const eventId = `merge:${observationId}`;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM workspace_lifecycle_events WHERE workspaceId=? AND eventId=?",
        )
        .get(generation.workspaceId, eventId)
    )
      return;
    this.observe(generation, {
      kind: "merge",
      eventId,
      at,
      repositoryId,
      changeRequestId,
      merged,
    });
  }

  importBindings(): void {
    if (!this.hasTable("task_workspace_bindings")) return;
    this.write(() => {
      for (const raw of this.db
        .prepare(
          "SELECT taskId,workspaceId,path,repositories,createdAt FROM task_workspace_bindings WHERE state<>'provisioning'",
        )
        .all()) {
        const row = z
          .object({
            taskId: identity,
            workspaceId: z.uuid(),
            path,
            repositories: z.string(),
            createdAt: z.iso.datetime(),
          })
          .parse(raw);
        this.recordBinding({
          ...row,
          repositories: JSON.parse(row.repositories),
        });
      }
    });
  }

  importLegacyFacts(): void {
    this.write(() => {
      if (
        this.hasTable("runtime_terminal_evidence") &&
        this.hasTable("task_execution_bindings")
      ) {
        const rows = this.db
          .prepare(`SELECT e.workId,e.threadId,e.turnId,e.firstObservedAt FROM runtime_terminal_evidence e
          WHERE e.workId IS NOT NULL AND e.firstStatus IS NOT NULL AND e.conflicted=0
          ORDER BY e.firstObservedAt,e.threadId,e.turnId`)
          .all();
        const schema = z.object({
          workId: identity,
          threadId: identity,
          turnId: identity,
          firstObservedAt: time,
        });
        for (const raw of rows) {
          const row = schema.safeParse(raw);
          if (row.success)
            this.recordTurnEnd(
              row.data.workId,
              row.data.threadId,
              row.data.turnId,
              row.data.firstObservedAt,
            );
        }
      }
      if (this.hasTable("source_completions")) {
        const rows = this.db
          .prepare(
            "SELECT c.taskId,c.completedAt FROM source_completions c JOIN domain_tasks t ON t.id=c.taskId WHERE t.state='done'",
          )
          .all();
        for (const raw of rows) {
          const row = z
            .object({ taskId: identity, completedAt: z.iso.datetime() })
            .safeParse(raw);
          if (!row.success) continue;
          const generation = this.current(row.data.taskId),
            at = Date.parse(row.data.completedAt);
          if (
            generation &&
            generation.terminal === null &&
            Number.isSafeInteger(at) &&
            at >= 0
          )
            this.observe(generation, {
              kind: "terminal",
              eventId: `source-terminal:${at}`,
              at,
              status: "done",
            });
        }
      }
      // Legacy delivery updatedAt is mutable, so it cannot backfill a confirmed-push clock.
    });
  }

  recoverInterruptedOperations(): void {
    this.write(() => {
      for (const raw of this.db
        .prepare("SELECT operationId FROM workspace_maintenance_operations")
        .all()) {
        const { operationId } = z.object({ operationId: z.uuid() }).parse(raw);
        const operation = this.findOperation(operationId)!;
        if (operation.state === "active")
          this.holdOperation(
            operation,
            operationId,
            "Maintenance interrupted; settlement and final ownership require reconciliation",
          );
      }
    });
  }

  private forWork(
    taskId: string,
    workId: string,
  ): WorkspaceGeneration | undefined {
    if (
      !this.hasTable("execution_intents") ||
      !this.hasTable("task_execution_bindings")
    )
      return undefined;
    const row = this.db
      .prepare(
        `SELECT i.workspace FROM execution_intents i JOIN task_execution_bindings b ON b.workId=i.workId WHERE i.workId=? AND b.taskId=?`,
      )
      .get(workId, taskId);
    if (!row) return undefined;
    const { workspace } = z.object({ workspace: path }).parse(row);
    const matches = this.forTask(taskId).filter((g) => g.path === workspace);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private hasTable(name: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }

  retain(input: WorkspaceGenerationInput): WorkspaceGeneration {
    const parsed = generationInputSchema.parse(input);
    this.uniqueRepositories(parsed.repositories);
    return this.write(() => {
      const existing = this.get(parsed.workspaceId);
      if (existing) {
        const original = generationInputSchema.strip().parse(existing);
        if (JSON.stringify(original) !== JSON.stringify(parsed))
          this.conflict("Workspace generation identity changed");
        return existing;
      }
      const generation = workspaceGenerationSchema.parse({
        ...parsed,
        revision: 1,
        lastObservedAt: null,
        lastTurnEndedAt: null,
        lastTurnEndedEventId: null,
        terminal: null,
        lastPushAt: null,
        allMergedAt: null,
        repositoryClocks: parsed.repositories.map(({ repositoryId }) => ({
          repositoryId,
          pushedCommit: null,
          pushedAt: null,
          changeRequestId: null,
          merged: null,
        })),
      });
      this.db
        .prepare("INSERT INTO workspace_generations VALUES (?,?,?)")
        .run(
          generation.workspaceId,
          generation.taskId,
          JSON.stringify(generation),
        );
      return generation;
    });
  }

  get(workspaceId: string): WorkspaceGeneration | undefined {
    const row = this.db
      .prepare(
        "SELECT workspaceId,taskId,data FROM workspace_generations WHERE workspaceId=?",
      )
      .get(workspaceId);
    if (!row) return undefined;
    const stored = z
      .object({ workspaceId: z.uuid(), taskId: identity, data: z.string() })
      .parse(row);
    const result = workspaceGenerationSchema.parse(JSON.parse(stored.data));
    if (
      result.workspaceId !== stored.workspaceId ||
      result.taskId !== stored.taskId
    )
      this.conflict("Stored workspace generation identity mismatch");
    this.uniqueRepositories(result.repositories);
    if (
      JSON.stringify(result.repositories.map((r) => r.repositoryId)) !==
      JSON.stringify(result.repositoryClocks.map((r) => r.repositoryId))
    )
      this.conflict("Stored workspace repository clock identities changed");
    return result;
  }

  forTask(taskId: string): WorkspaceGeneration[] {
    return this.db
      .prepare(
        "SELECT workspaceId FROM workspace_generations WHERE taskId=? ORDER BY workspaceId",
      )
      .all(taskId)
      .map(
        (row) =>
          this.get(z.object({ workspaceId: z.uuid() }).parse(row).workspaceId)!,
      );
  }

  observe(
    owner: GenerationIdentity,
    input: LifecycleEvent,
  ): WorkspaceGeneration {
    const event = workspaceLifecycleEventSchema.parse(input);
    return this.write(() => {
      const generation = this.owned(owner);
      const previous = this.db
        .prepare(
          "SELECT data FROM workspace_lifecycle_events WHERE workspaceId=? AND eventId=?",
        )
        .get(owner.workspaceId, event.eventId);
      if (previous) {
        if (
          z.object({ data: z.string() }).parse(previous).data !==
          JSON.stringify(event)
        )
          this.conflict("Lifecycle event identity reused");
        return generation;
      }
      const at = Math.max(event.at, generation.lastObservedAt ?? 0);
      if (event.kind === "turn-ended") {
        generation.lastTurnEndedAt = at;
        generation.lastTurnEndedEventId = event.eventId;
      } else if (event.kind === "terminal") {
        if ((generation.terminal?.status ?? null) !== event.status) {
          generation.terminal =
            event.status === null
              ? null
              : {
                  episodeId: event.eventId,
                  status: event.status,
                  at,
                };
          if (event.status === null) {
            generation.allMergedAt = null;
            for (const repository of generation.repositoryClocks) {
              repository.changeRequestId = null;
              repository.merged = null;
            }
          }
        }
      } else {
        const repository = generation.repositoryClocks.find(
          (r) => r.repositoryId === event.repositoryId,
        );
        if (!repository)
          this.conflict("Repository is outside workspace generation");
        if (event.kind === "push") {
          if (event.removalOperationId !== null) {
            const operation = this.operation(owner, event.removalOperationId);
            if (operation.kind !== "remove" || operation.state !== "active")
              this.conflict("Removal push requires its active operation");
          } else {
            generation.lastPushAt = at;
            if (repository.pushedCommit !== event.commit) {
              repository.changeRequestId = null;
              repository.merged = null;
              generation.allMergedAt = null;
            }
          }
          repository.pushedCommit = event.commit;
          repository.pushedAt = at;
        } else {
          if (
            repository.changeRequestId !== event.changeRequestId ||
            !event.merged
          )
            generation.allMergedAt = null;
          repository.changeRequestId = event.changeRequestId;
          repository.merged = event.merged;
          if (generation.repositoryClocks.every((r) => r.merged === true))
            generation.allMergedAt ??= at;
        }
      }
      generation.lastObservedAt = at;
      this.saveGeneration(generation);
      this.db
        .prepare("INSERT INTO workspace_lifecycle_events VALUES (?,?,?)")
        .run(owner.workspaceId, event.eventId, JSON.stringify(event));
      return generation;
    });
  }

  beginOperation(
    owner: GenerationIdentity,
    input: z.infer<typeof operationInputSchema>,
  ): WorkspaceOperation {
    const parsed = operationInputSchema.parse(input);
    if (
      (parsed.kind === "remove" && parsed.trigger === "idle") ||
      (parsed.kind === "trim" &&
        ["delivered", "merged"].includes(parsed.trigger))
    )
      this.conflict("Invalid maintenance trigger");
    return this.write(() => {
      this.owned(owner);
      const existing = this.findOperation(parsed.operationId);
      if (existing) {
        this.operation(owner, parsed.operationId);
        if (
          JSON.stringify(operationInputSchema.strip().parse(existing)) !==
          JSON.stringify(parsed)
        )
          this.conflict("Maintenance operation identity reused");
        return existing;
      }
      if (
        this.operations(owner).some(
          (operation) => operation.state !== "completed",
        )
      )
        this.conflict("Workspace has unfinished maintenance");
      const operation: WorkspaceOperation = {
        ...parsed,
        taskId: owner.taskId,
        workspaceId: owner.workspaceId,
        state: "active",
        reason: null,
        effects: [],
        completedAt: null,
        repositories: null,
      };
      this.db
        .prepare("INSERT INTO workspace_maintenance_operations VALUES (?,?,?)")
        .run(
          operation.operationId,
          operation.workspaceId,
          JSON.stringify(operation),
        );
      return operation;
    });
  }

  operations(owner: GenerationIdentity): WorkspaceOperation[] {
    this.owned(owner);
    return this.db
      .prepare(
        "SELECT operationId FROM workspace_maintenance_operations WHERE workspaceId=? ORDER BY operationId",
      )
      .all(owner.workspaceId)
      .map((row) =>
        this.operation(
          owner,
          z.object({ operationId: z.uuid() }).parse(row).operationId,
        ),
      );
  }

  operation(
    owner: GenerationIdentity,
    operationId: string,
  ): WorkspaceOperation {
    this.owned(owner);
    const operation = this.findOperation(operationId);
    if (
      !operation ||
      operation.taskId !== owner.taskId ||
      operation.workspaceId !== owner.workspaceId
    )
      this.conflict("Maintenance operation belongs to another generation");
    return operation;
  }

  startEffect(
    owner: GenerationIdentity,
    operationId: string,
    input: Pick<
      z.infer<typeof effectSchema>,
      "effectId" | "target" | "startedAt"
    >,
  ): void {
    const effect = effectSchema.parse({
      ...input,
      settledAt: null,
      outcome: null,
    });
    this.write(() => {
      const operation = this.operation(owner, operationId);
      this.active(operation);
      const target = effect.target;
      if (
        target.kind === "repository" &&
        !this.owned(owner).repositories.some(
          (r) => r.repositoryId === target.repositoryId,
        )
      )
        this.conflict("Effect repository is outside workspace generation");
      const existing = operation.effects.find(
        (e) => e.effectId === effect.effectId,
      );
      if (existing) {
        if (
          JSON.stringify({ ...existing, settledAt: null, outcome: null }) !==
          JSON.stringify(effect)
        )
          this.conflict("Effect identity reused");
        return;
      }
      if (
        operation.effects.some(
          (e) => e.settledAt === null || e.outcome !== "succeeded",
        )
      )
        this.conflict("Prior destructive effect has not succeeded");
      if (effect.startedAt < operation.startedAt)
        this.conflict("Effect predates operation");
      operation.effects.push(effect);
      this.saveOperation(operation);
    });
  }

  settleEffect(
    owner: GenerationIdentity,
    operationId: string,
    effectId: string,
    outcome: "succeeded" | "failed",
    at: number,
  ): void {
    time.parse(at);
    z.enum(["succeeded", "failed"]).parse(outcome);
    this.write(() => {
      const operation = this.operation(owner, operationId);
      this.active(operation);
      const effect = operation.effects.find((e) => e.effectId === effectId);
      if (!effect || at < effect.startedAt)
        this.conflict("Invalid effect settlement");
      if (effect.settledAt !== null) {
        if (effect.outcome !== outcome || effect.settledAt !== at)
          this.conflict("Effect settlement changed");
        return;
      }
      effect.outcome = outcome;
      effect.settledAt = at;
      this.saveOperation(operation);
    });
  }

  holdOperation(
    owner: GenerationIdentity,
    operationId: string,
    reason: string,
  ): void {
    this.write(() => {
      const operation = this.operation(owner, operationId);
      if (operation.state === "completed")
        this.conflict("Maintenance already completed");
      operation.state = "held";
      operation.reason = z.string().min(1).max(4096).parse(reason);
      this.saveOperation(operation);
    });
  }

  completeOperation(
    owner: GenerationIdentity,
    operationId: string,
    expectedRevision: number,
    at: number,
    repositories: z.infer<typeof removalProofSchema>[] | null,
  ): WorkspaceOperation {
    time.parse(at);
    return this.write(() => {
      const generation = this.owned(owner);
      const operation = this.operation(owner, operationId);
      this.active(operation);
      if (generation.revision !== expectedRevision)
        this.conflict("Workspace generation changed");
      if (
        at < operation.startedAt ||
        operation.effects.some(
          (e) =>
            e.settledAt === null ||
            e.settledAt > at ||
            e.outcome !== "succeeded",
        )
      )
        this.conflict("Maintenance effects are not settled successfully");
      const proofs = z.array(removalProofSchema).nullable().parse(repositories);
      if (operation.kind === "remove") {
        if (!proofs)
          this.conflict("Removal requires repository preservation records");
        this.uniqueRepositories(proofs);
        if (
          proofs.length !== generation.repositories.length ||
          proofs.some(
            (proof) =>
              !generation.repositories.some(
                (r) => r.repositoryId === proof.repositoryId,
              ),
          )
        )
          this.conflict("Removal repository identities changed");
      } else if (proofs !== null)
        this.conflict("Trim cannot record workspace removal");
      operation.state = "completed";
      operation.completedAt = at;
      operation.repositories = proofs;
      this.saveOperation(operation);
      this.saveGeneration(generation);
      return operation;
    });
  }

  private owned(owner: GenerationIdentity): WorkspaceGeneration {
    const generation = this.get(owner.workspaceId);
    if (!generation || generation.taskId !== owner.taskId)
      this.conflict("Workspace generation owner mismatch");
    return generation;
  }

  private findOperation(operationId: string): WorkspaceOperation | undefined {
    const row = this.db
      .prepare(
        "SELECT operationId,workspaceId,data FROM workspace_maintenance_operations WHERE operationId=?",
      )
      .get(operationId);
    if (!row) return undefined;
    const stored = z
      .object({
        operationId: z.uuid(),
        workspaceId: z.uuid(),
        data: z.string(),
      })
      .parse(row);
    const operation = workspaceOperationSchema.parse(JSON.parse(stored.data));
    if (
      operation.operationId !== stored.operationId ||
      operation.workspaceId !== stored.workspaceId
    )
      this.conflict("Stored maintenance operation identity mismatch");
    return operation;
  }

  private saveGeneration(generation: WorkspaceGeneration): void {
    generation.revision++;
    workspaceGenerationSchema.parse(generation);
    this.db
      .prepare("UPDATE workspace_generations SET data=? WHERE workspaceId=?")
      .run(JSON.stringify(generation), generation.workspaceId);
  }

  private saveOperation(operation: WorkspaceOperation): void {
    workspaceOperationSchema.parse(operation);
    this.db
      .prepare(
        "UPDATE workspace_maintenance_operations SET data=? WHERE operationId=?",
      )
      .run(JSON.stringify(operation), operation.operationId);
  }

  private active(operation: WorkspaceOperation): void {
    if (operation.state !== "active")
      this.conflict("Maintenance operation is not active");
  }

  private uniqueRepositories(repositories: { repositoryId: string }[]): void {
    if (
      new Set(repositories.map((r) => r.repositoryId)).size !==
      repositories.length
    )
      this.conflict("Duplicate repository identity");
  }

  private write<T>(action: () => T): T {
    return this.db.isTransaction ? action() : transaction(this.db, action);
  }

  private conflict(message: string): never {
    throw new DomainConflictError(message);
  }
}

/** Primitive store fixtures may not install the domain schema; production migration always does. */
export function initializedWorkspaceLifecycle(
  db: Database,
): WorkspaceLifecycleStore | undefined {
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_generations'",
    )
    .get()
    ? new WorkspaceLifecycleStore(db)
    : undefined;
}
