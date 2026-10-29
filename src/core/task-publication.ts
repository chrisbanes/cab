import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type DeliveryCaller,
  type ExternalActionArguments,
  DeliveryStore,
  canonicalMaterial,
  materialDigest,
  operatorPublicationCallerSchema,
  isOperatorPublicationCaller,
} from "./delivery.js";
import { DomainConflictError } from "./domain-errors.js";
import {
  evaluateReadiness,
  type Readiness,
  readinessSchema,
  selectionSchema,
} from "./github-source-contracts.js";
import { GitHubSourceStore } from "./github-source.js";
import { storedRepositoryLinkSchema } from "./repository-links.js";
import { transaction, type Database } from "./store.js";
import {
  type PublicationReasonCode,
  type PublicationTarget,
  type PublicationTargetReasonCode,
  publicationProjectFieldSchema,
  publicationStates,
  publicationTargetSchema,
} from "./task-publication-contracts.js";
import { TaskReviewStore } from "./task-review.js";

type Row = Record<string, unknown>;

/** The frozen material of a publication: what is created, where, and the operation ids of its steps. */
export const publicationReviewSchema = z
  .object({
    publicationId: z.string().uuid(),
    taskId: z.string().uuid(),
    commandHash: z.string().length(64),
    caller: operatorPublicationCallerSchema,
    taskVersion: z.number().int().positive(),
    target: publicationTargetSchema,
    issue: z
      .object({
        title: z.string(),
        body: z.string(),
        labels: z.array(z.string()),
      })
      .strict(),
    /** The Project item add; absent for a repository target. */
    item: z.object({ operationId: z.string().uuid() }).strict().nullable(),
    fields: z.array(
      publicationProjectFieldSchema.extend({
        operationId: z.string().uuid(),
      }),
    ),
    materialHash: z.string().length(64),
    revision: z.number().int().positive(),
    decision: z.enum(["pending", "approved", "denied"]),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type PublicationReview = z.output<typeof publicationReviewSchema>;

/** A publication as stored: its review, where it is, and what the steps have produced so far. */
export interface Publication {
  review: PublicationReview;
  state: (typeof publicationStates)[number];
  issueNodeId: string | null;
  issueNumber: number | null;
  itemNodeId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What the service knows that the store cannot: whether any work has ever started on the task. */
export interface PublicationContext {
  started: boolean;
}

const separator = "~";
export const publicationTargetId = (
  selectionId: string,
  repositoryId: string,
) => `${selectionId}${separator}${repositoryId}`;

export interface PublicationAvailability {
  available: boolean;
  reasonCode: PublicationReasonCode | null;
  targets: PublicationTarget[];
}

export class TaskPublicationStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_publications (
      publicationId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      reviewJson TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reviewed','approved','sending','converted','abandoned','denied','failed')),
      issueNodeId TEXT, issueNumber INTEGER, itemNodeId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS task_publications_open ON task_publications(taskId)
      WHERE state IN ('reviewed','approved','sending');
    CREATE TABLE IF NOT EXISTS task_publication_receipts (
      key TEXT PRIMARY KEY, material TEXT NOT NULL, recordJson TEXT NOT NULL);`);
  }

  private publication(row: Row): Publication {
    return {
      review: publicationReviewSchema.parse(JSON.parse(String(row.reviewJson))),
      state: z.enum(publicationStates).parse(row.state),
      issueNodeId: row.issueNodeId === null ? null : String(row.issueNodeId),
      issueNumber: row.issueNumber === null ? null : Number(row.issueNumber),
      itemNodeId: row.itemNodeId === null ? null : String(row.itemNodeId),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  get(publicationId: string): Publication | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_publications WHERE publicationId=?")
      .get(publicationId) as Row | undefined;
    return row ? this.publication(row) : undefined;
  }

  /** The task's newest publication of any state. */
  latest(taskId: string): Publication | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_publications WHERE taskId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1",
      )
      .get(taskId) as Row | undefined;
    return row ? this.publication(row) : undefined;
  }

  /** Publications whose steps are being sent or whose create is unresolved. */
  sending(): Publication[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_publications WHERE state='sending' ORDER BY rowid",
        )
        .all() as Row[]
    ).map((row) => this.publication(row));
  }

  private save(publication: Publication): void {
    publication.updatedAt = Date.now();
    this.db
      .prepare(
        "UPDATE task_publications SET reviewJson=?,state=?,issueNodeId=?,issueNumber=?,itemNodeId=?,updatedAt=? WHERE publicationId=?",
      )
      .run(
        canonicalMaterial(publication.review),
        publication.state,
        publication.issueNodeId,
        publication.issueNumber,
        publication.itemNodeId,
        publication.updatedAt,
        publication.review.publicationId,
      );
  }

  /** Where a task can be published and why not; the server's one answer for the web and the CLI. */
  availability(
    taskId: string,
    context: PublicationContext,
  ): PublicationAvailability {
    const task = this.db
      .prepare(
        "SELECT t.projectId,t.state,t.ready,(SELECT 1 FROM imported_tasks i WHERE i.taskId=t.id) AS imported,(SELECT 1 FROM local_dependencies d WHERE d.taskId=t.id LIMIT 1) AS edges FROM domain_tasks t WHERE t.id=?",
      )
      .get(taskId) as Row | undefined;
    if (!task) throw new DomainConflictError("Unknown task");
    const projectId = String(task.projectId),
      source = this.db
        .prepare(
          "SELECT provider,selections,readiness FROM project_task_sources WHERE projectId=?",
        )
        .get(projectId) as Row | undefined,
      jira = source !== undefined && source.provider !== "github",
      selections =
        source && !jira
          ? z
              .array(selectionSchema)
              .parse(JSON.parse(String(source.selections)))
          : [],
      readiness = source
        ? readinessSchema.nullable().parse(JSON.parse(String(source.readiness)))
        : null,
      linked = (
        this.db
          .prepare(
            "SELECT links FROM project_repository_links WHERE projectId=?",
          )
          .all(projectId) as Row[]
      ).flatMap((row) =>
        z
          .array(storedRepositoryLinkSchema)
          .parse(JSON.parse(String(row.links)))
          // A GitLab link is never a GitHub issue target.
          .filter((link) => link.codeHost === "github"),
      ),
      policy = new DeliveryStore(this.db).configuration(projectId),
      ready = Number(task.ready) === 1;
    const sending = this.db
      .prepare(
        "SELECT 1 FROM task_publications WHERE taskId=? AND state='sending'",
      )
      .get(taskId);
    const reasonCode: PublicationReasonCode | null = jira
      ? "issue-tracker-unsupported"
      : task.imported
        ? "task-imported"
        : task.state !== "open"
          ? "task-not-open"
          : context.started
            ? "task-started"
            : task.edges
              ? "local-dependencies"
              : sending
                ? "publication-unresolved"
                : !selections.length || !linked.length
                  ? "no-github-source"
                  : policy.credentialRef === null
                    ? "no-delivery-credential"
                    : null;
    const grants = policy.grants;
    const known = (repositoryId: string) =>
      selections.flatMap((s) =>
        s.kind === "repository" && s.repositoryId === repositoryId
          ? [`${s.owner}/${s.name}`]
          : [],
      )[0] ??
      (
        this.db
          .prepare(
            "SELECT containerName FROM external_items WHERE containerId=? LIMIT 1",
          )
          .get(repositoryId) as Row | undefined
      )?.containerName;
    const targets: PublicationTarget[] = [];
    const add = (
      selection: (typeof selections)[number],
      repositoryId: string | null,
    ) => {
      const kind = selection.kind;
      const projectNodeId =
        selection.kind === "project" ? selection.projectNodeId : null;
      const { labels, projectFields, satisfiable } = readinessWrites(
        ready ? readiness : null,
        projectNodeId,
      );
      const reasons: Array<PublicationTargetReasonCode | false> = [
        (kind === "search" ||
          (selection.kind === "project" && selection.filter.trim() !== "")) &&
          "selection-unpredictable",
        repositoryId !== null &&
          !grants.some(
            (g) =>
              g.action === "issue.create" && g.repositoryId === repositoryId,
          ) &&
          "no-create-grant",
        kind === "project" &&
          repositoryId !== null &&
          !grants.some(
            (g) =>
              g.action === "project.item.add" &&
              g.repositoryId === repositoryId &&
              g.projectNodeId === projectNodeId,
          ) &&
          "no-item-grant",
        repositoryId !== null &&
          projectFields.some(
            (f) =>
              !grants.some(
                (g) =>
                  g.action === "project.field" &&
                  g.repositoryId === repositoryId &&
                  g.projectNodeId === f.projectNodeId &&
                  g.fieldNodeId === f.fieldNodeId &&
                  g.optionNodeIds?.includes(f.optionNodeId),
              ),
          ) &&
          "no-field-grant",
        ready && !satisfiable && "readiness-unsatisfiable",
        // A new issue has no labels and a new item no field values: a rule that holds for it (no
        // rule, or one a `lacks` condition satisfies) would make a Draft task Ready on import.
        !ready &&
          evaluateReadiness(readiness, { labels: [], fields: [] }).satisfied &&
          "would-become-ready",
      ];
      const reasonCodeOfTarget = reasons.find((r) => r !== false) ?? null;
      targets.push(
        publicationTargetSchema.parse({
          id: publicationTargetId(selection.id, repositoryId ?? ""),
          selectionId: selection.id,
          repositoryId,
          repository: repositoryId
            ? String(known(repositoryId) ?? repositoryId)
            : "Repository unknown",
          kind,
          projectNodeId,
          enabled: reasonCodeOfTarget === null,
          reasonCode: reasonCodeOfTarget,
          labels: reasonCodeOfTarget === null ? labels : [],
          projectFields: reasonCodeOfTarget === null ? projectFields : [],
          predictedSelected: true,
          predictedReady: ready,
        }),
      );
    };
    for (const selection of selections) {
      if (selection.kind === "repository") {
        if (linked.some((l) => l.repositoryId === selection.repositoryId))
          add(selection, selection.repositoryId);
      } else if (selection.kind === "project" && selection.filter.trim() === "")
        for (const link of linked) add(selection, link.repositoryId);
      else add(selection, null);
    }
    return { available: reasonCode === null, reasonCode, targets };
  }

  /**
   * Freezes what publishing would do and mints the operation ids of its steps. The key is the
   * publication's id and its `issue.create` operation id. Replays answer from the stored review.
   */
  review(
    command: {
      key: string;
      taskId: string;
      targetId: string;
      expectedTaskVersion: number;
    },
    context: PublicationContext,
  ): PublicationReview {
    const commandHash = materialDigest(command),
      prior = this.get(command.key);
    if (prior) {
      if (prior.review.commandHash !== commandHash)
        throw new DomainConflictError(
          "Publication review key reused with different material",
        );
      return prior.review;
    }
    return transaction(this.db, () => {
      const task = this.db
        .prepare(
          "SELECT t.projectId,t.version,t.outcome,b.title FROM domain_tasks t JOIN tasks b ON b.id=t.id WHERE t.id=?",
        )
        .get(command.taskId) as Row | undefined;
      if (!task) throw new DomainConflictError("Unknown task");
      // The key is the create's operation id, so it must not already name a delivery operation.
      if (new DeliveryStore(this.db).hasAction(command.key))
        throw new DomainConflictError("Publication key is already in use");
      if (Number(task.version) !== command.expectedTaskVersion)
        throw new DomainConflictError("Task revision conflict");
      // A review nobody confirmed is replaced; one being sent is not.
      this.db
        .prepare(
          "UPDATE task_publications SET state='denied',updatedAt=? WHERE taskId=? AND state IN ('reviewed','approved')",
        )
        .run(Date.now(), command.taskId);
      const available = this.availability(command.taskId, context);
      if (!available.available)
        throw new DomainConflictError(
          `Task cannot be published: ${available.reasonCode}`,
        );
      const target = available.targets.find((t) => t.id === command.targetId);
      if (!target?.enabled || target.repositoryId === null)
        throw new DomainConflictError(
          `Target cannot take the publication: ${target?.reasonCode ?? "unknown-target"}`,
        );
      const source = new TaskReviewStore(this.db)
        .sources(command.taskId)
        .at(-1);
      if (!source) throw new DomainConflictError("Task text is unavailable");
      const policy = new DeliveryStore(this.db).configuration(
        String(task.projectId),
      );
      const now = Date.now();
      const base = {
        publicationId: command.key,
        taskId: command.taskId,
        commandHash,
        caller: {
          actor: "operator" as const,
          principal: "installation-operator" as const,
          purpose: "task-publication" as const,
          projectId: String(task.projectId),
          taskId: command.taskId,
          publicationId: command.key,
          sourceId: source.sourceId,
          selectionId: target.selectionId,
          repositoryId: target.repositoryId,
          policyVersion: policy.version,
        },
        taskVersion: command.expectedTaskVersion,
        target,
        issue: {
          title: String(task.title),
          body: String(task.outcome),
          labels: target.labels,
        },
        item: target.kind === "project" ? { operationId: randomUUID() } : null,
        fields: target.projectFields.map((f) => ({
          ...f,
          operationId: randomUUID(),
        })),
      };
      const review = publicationReviewSchema.parse({
        ...base,
        materialHash: materialDigest({
          operationId: command.key,
          caller: base.caller,
          target: base.target,
          issue: base.issue,
          item: base.item,
          fields: base.fields,
        }),
        revision: 1,
        decision: "pending",
        createdAt: now,
        updatedAt: now,
      });
      this.db
        .prepare(
          "INSERT INTO task_publications (publicationId,taskId,reviewJson,state,issueNodeId,issueNumber,itemNodeId,createdAt,updatedAt) VALUES (?,?,?,'reviewed',NULL,NULL,NULL,?,?)",
        )
        .run(command.key, command.taskId, canonicalMaterial(review), now, now);
      return review;
    });
  }

  /** Records the operator's decision; `authorize` re-checks that nothing the review relied on changed. */
  confirm(
    command: {
      key: string;
      taskId: string;
      reviewId: string;
      expectedRevision: number;
      materialHash: string;
      decision: "approved" | "denied";
    },
    authorize: () => void,
  ): PublicationReview {
    return transaction(this.db, () => {
      const material = canonicalMaterial(command),
        prior = this.db
          .prepare(
            "SELECT material,recordJson FROM task_publication_receipts WHERE key=?",
          )
          .get(command.key) as Row | undefined;
      if (prior) {
        if (prior.material !== material)
          throw new DomainConflictError(
            "Publication confirmation key reused with different material",
          );
        return publicationReviewSchema.parse(
          JSON.parse(String(prior.recordJson)),
        );
      }
      const publication = this.get(command.reviewId);
      if (
        !publication ||
        publication.review.taskId !== command.taskId ||
        publication.review.revision !== command.expectedRevision ||
        publication.review.materialHash !== command.materialHash ||
        publication.state !== "reviewed"
      )
        throw new DomainConflictError(
          "Publication confirmation revision/material mismatch",
        );
      if (command.decision === "approved") authorize();
      publication.review = {
        ...publication.review,
        revision: publication.review.revision + 1,
        decision: command.decision,
        updatedAt: Date.now(),
      };
      publication.state =
        command.decision === "approved" ? "approved" : "denied";
      this.save(publication);
      this.db
        .prepare("INSERT INTO task_publication_receipts VALUES (?,?,?)")
        .run(command.key, material, canonicalMaterial(publication.review));
      return publication.review;
    });
  }

  /**
   * Starts sending a confirmed review. The task is held from here until the publication ends.
   * Replays after the start are answered without checking again.
   */
  begin(
    command: {
      taskId: string;
      publicationId: string;
      expectedTaskVersion: number;
    },
    context: PublicationContext,
  ): Publication {
    return transaction(this.db, () => {
      const publication = this.get(command.publicationId);
      if (!publication || publication.review.taskId !== command.taskId)
        throw new DomainConflictError("Publication unavailable");
      // A replay of a send answers with where the publication is.
      if (
        ["sending", "converted", "failed", "abandoned"].includes(
          publication.state,
        )
      )
        return publication;
      if (publication.state !== "approved")
        throw new DomainConflictError("Publication is not approved");
      this.assertCurrent(publication, context, command.expectedTaskVersion);
      publication.state = "sending";
      this.save(publication);
      return publication;
    });
  }

  /**
   * Refuses a review whose basis moved: the task's revision, the project's grants, or what the
   * target would write. The service's confirmation and the first send both ask.
   */
  assertCurrent(
    publication: Publication,
    context: PublicationContext,
    expectedTaskVersion = publication.review.taskVersion,
  ): void {
    const { review } = publication,
      task = this.db
        .prepare("SELECT version FROM domain_tasks WHERE id=?")
        .get(review.taskId) as Row | undefined,
      current = this.availability(review.taskId, context),
      target = current.targets.find((t) => t.id === review.target.id);
    if (
      Number(task?.version) !== expectedTaskVersion ||
      expectedTaskVersion !== review.taskVersion ||
      new DeliveryStore(this.db).configuration(review.caller.projectId)
        .version !== review.caller.policyVersion ||
      !current.available ||
      !target?.enabled ||
      canonicalMaterial({
        labels: target.labels,
        fields: target.projectFields,
      }) !==
        canonicalMaterial({
          labels: review.target.labels,
          fields: review.target.projectFields,
        })
    )
      throw new DomainConflictError("Publication material changed");
  }

  /** The create's issue, once known. */
  recordIssue(publicationId: string, nodeId: string, number: number): void {
    this.db
      .prepare(
        "UPDATE task_publications SET issueNodeId=?,issueNumber=?,updatedAt=? WHERE publicationId=? AND issueNodeId IS NULL",
      )
      .run(nodeId, number, Date.now(), publicationId);
  }

  recordItem(publicationId: string, itemNodeId: string): void {
    this.db
      .prepare(
        "UPDATE task_publications SET itemNodeId=?,updatedAt=? WHERE publicationId=? AND itemNodeId IS NULL",
      )
      .run(itemNodeId, Date.now(), publicationId);
  }

  /** Ends a sending publication whose create is provably not on GitHub (`failed`) or was given up on (`abandoned`). */
  end(publicationId: string, state: "failed" | "abandoned"): void {
    const publication = this.get(publicationId);
    if (publication?.state !== "sending") return;
    publication.state = state;
    this.save(publication);
  }

  /**
   * Whether `request` is exactly a step the confirmed review froze: the approval of the
   * publication caller, in either grant mode. The created issue and the item are bound by the
   * recorded receipts.
   */
  actionApproved(
    request: ExternalActionArguments,
    caller: DeliveryCaller,
  ): boolean {
    if (!isOperatorPublicationCaller(caller)) return false;
    const publication = this.get(caller.publicationId);
    if (
      !publication ||
      !["approved", "sending"].includes(publication.state) ||
      publication.review.decision !== "approved" ||
      canonicalMaterial(publication.review.caller) !== canonicalMaterial(caller)
    )
      return false;
    const { review } = publication,
      action = request.action;
    if (request.operationId === review.publicationId)
      return (
        action.kind === "issue.create" &&
        action.target.repositoryId === review.caller.repositoryId &&
        action.title === review.issue.title &&
        action.body === review.issue.body &&
        canonicalMaterial(action.labels) ===
          canonicalMaterial(review.issue.labels)
      );
    if (action.kind === "project.item.add")
      return (
        request.operationId === review.item?.operationId &&
        action.projectNodeId === review.target.projectNodeId
      );
    if (action.kind === "project.field") {
      const field = review.fields.find(
        (f) => f.operationId === request.operationId,
      );
      return (
        field !== undefined &&
        publication.itemNodeId !== null &&
        action.itemNodeId === publication.itemNodeId &&
        action.projectNodeId === field.projectNodeId &&
        action.fieldNodeId === field.fieldNodeId &&
        action.optionNodeId === field.optionNodeId
      );
    }
    return false;
  }

  /**
   * Turns the published local task into the issue's imported task, as the sync would have: in one
   * transaction, with what is confirmed by now. Safe to run once; a later call changes nothing.
   */
  convertWithinTransaction(input: {
    publicationId: string;
    repositoryName: string;
    /** The body as created, marker included. */
    body: string;
    fields: z.output<typeof publicationProjectFieldSchema>[];
  }): void {
    const publication = this.get(input.publicationId);
    if (
      publication?.state !== "sending" ||
      !publication.issueNodeId ||
      publication.issueNumber === null
    )
      return;
    const { review } = publication;
    new GitHubSourceStore(this.db).convertPublishedTaskWithinTransaction({
      taskId: review.taskId,
      projectId: review.caller.projectId,
      selectionId: review.caller.selectionId,
      repositoryId: review.caller.repositoryId,
      repositoryName: input.repositoryName,
      nodeId: publication.issueNodeId,
      number: publication.issueNumber,
      title: review.issue.title,
      body: input.body,
      labels: review.issue.labels,
      itemNodeId: publication.itemNodeId,
      projectFields: input.fields,
    });
    publication.state = "converted";
    this.save(publication);
  }
}

/**
 * The labels and Project fields a Ready task needs on a new issue so that the project's rule holds
 * on import, and whether that is possible from this target. A new issue has no labels or field
 * values, so `lacks` holds without a write. The writes are the `has` labels and the first option of
 * each `in` condition on the target Project (one write per field, since a field holds one value);
 * they are possible only if the rule evaluates as satisfied with exactly those facts, so a write
 * that contradicts another condition, a `not-in` nothing satisfies, or an `in` on another Project
 * disables the target. `all` plans every write. `any` plans the cheapest one that satisfies it:
 * nothing, else the first `has` label, else the first `in` on the Project.
 */
function readinessWrites(
  rule: Readiness | null,
  projectNodeId: string | null,
): {
  labels: string[];
  projectFields: z.output<typeof publicationProjectFieldSchema>[];
  satisfiable: boolean;
} {
  if (!rule) return { labels: [], projectFields: [], satisfiable: true };
  const labels = rule.conditions.flatMap((c) =>
    c.kind === "label" && c.operator === "has" ? [c.name] : [],
  );
  // One write per field of the target Project, since a field holds one value.
  const written = new Map<
    string,
    z.output<typeof publicationProjectFieldSchema>
  >();
  for (const c of rule.conditions) {
    if (
      c.kind !== "project-field" ||
      c.operator !== "in" ||
      c.projectNodeId !== projectNodeId
    )
      continue;
    if (!written.has(c.fieldNodeId))
      written.set(c.fieldNodeId, {
        projectNodeId: c.projectNodeId,
        fieldNodeId: c.fieldNodeId,
        optionNodeId: c.optionNodeIds[0] as string,
      });
  }
  const fields = [...written.values()];
  const plans = (
    rule.mode === "all"
      ? [{ labels, projectFields: fields }]
      : [
          { labels: [], projectFields: [] },
          { labels: labels.slice(0, 1), projectFields: [] },
          { labels: [], projectFields: fields.slice(0, 1) },
        ]
  ).map((plan) => ({
    ...plan,
    satisfiable: evaluateReadiness(rule, {
      labels: plan.labels,
      fields: plan.projectFields,
    }).satisfied,
  }));
  return (
    plans.find((plan) => plan.satisfiable) ?? {
      labels: [],
      projectFields: [],
      satisfiable: false,
    }
  );
}
