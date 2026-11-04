import { createHash } from "node:crypto";
import { nativeInputEndpointIdentitySchema } from "../core/structured-questions.js";
import { z } from "zod";
import {
  materialDigest,
  operatorCommentReviewSchema,
  prBindingSchema,
} from "../core/delivery.js";
import { runtimeAnswerReceiptSchema } from "../core/coordination.js";
import {
  taskCommentReceiptSchema,
  taskCommentReceiptScope,
} from "../core/task-comments.js";
import { publicationReviewSchema } from "../core/task-publication.js";
import { commandReceiptSchema } from "../operator/contracts.js";
import {
  historicalNoTurnAdoptionSchema,
  historicalPreTurnAdoptionSchema,
  replaceConversationCommandSchema,
  recoveryReceiptSchema,
} from "./pre-turn-recovery.js";
import { projectDeletionStatements } from "./project-deletion-sql.js";
import { assertProjectDeletionInventory } from "./project-deletion-inventory.js";
import type { Database } from "../core/store.js";

type Row = Record<string, string | number | Uint8Array | null>;
const text = z.string().min(1).max(512);
const uuid = z.string().uuid();
const cap = 100_000;
export type ProjectOwnership = ReturnType<typeof captureDeletionOwnership>;
export type OwnershipParameters = Record<
  string,
  | string
  | readonly string[]
  | readonly { provider: string; instance: string; externalId: string }[]
  | readonly { scope: string; key: string }[]
>;

/** Bind fixed SQL without changing the narrow Database interface or interpolating values. */
export function deletionQuery(sql: string, owner: OwnershipParameters) {
  const parameters: string[] = [];
  const bound = sql.replace(/:([A-Za-z]+)/g, (_all, name: string) => {
    const value = owner[name];
    if (value === undefined)
      throw new Error("Unclassified project deletion identity");
    parameters.push(typeof value === "string" ? value : JSON.stringify(value));
    return "?";
  });
  return { sql: bound, parameters };
}
function all(
  db: Database,
  sql: string,
  values: readonly (string | number)[] = [],
): Row[] {
  const rows = db.prepare(`${sql} LIMIT ${cap + 1}`).all(...values) as Row[];
  if (rows.length > cap)
    throw new Error("Project ownership inspection exceeds its bound");
  return rows;
}
function strings(rows: Row[], column: string): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row[column] === null ? [] : [text.parse(row[column])],
      ),
    ),
  ].sort();
}
function json(value: unknown): unknown {
  if (typeof value !== "string")
    throw new Error("Project receipt material is unavailable");
  return JSON.parse(value);
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
const inSet = (column: string, key: string) =>
  `${column} IN (SELECT value FROM json_each(:${key}))`;
export function ownedRows(
  db: Database,
  table: string,
  where: string,
  owner: OwnershipParameters,
): Row[] {
  const query = deletionQuery(
    `SELECT rowid AS deletionRowId,* FROM ${table} WHERE ${where} ORDER BY rowid`,
    owner,
  );
  return all(db, query.sql, query.parameters);
}
function taskOwner(db: Database, taskId: string): string {
  const rows = all(
    db,
    "SELECT projectId FROM domain_tasks WHERE id=? UNION SELECT projectId FROM tasks WHERE id=? UNION SELECT projectId FROM drafting_runs WHERE runId=?",
    [taskId, taskId, taskId],
  );
  const owners = strings(rows, "projectId");
  if (owners.length !== 1) throw new Error("Task ownership cannot be proved");
  return owners[0]!;
}
function assignmentOwner(db: Database, assignmentId: string): string {
  const row = db
    .prepare("SELECT projectId,taskId FROM domain_assignments WHERE id=?")
    .get(assignmentId) as Row | undefined;
  if (!row || taskOwner(db, text.parse(row.taskId)) !== row.projectId)
    throw new Error("Assignment ownership cannot be proved");
  return uuid.parse(row.projectId);
}
const workRoots = [
  ["turn_requests", "workId"],
  ["task_execution_bindings", "workId"],
  ["execution_capacity_reservations", "workId"],
  ["diagnostic_executions", "workId"],
  ["conversation_history_items", "workId"],
  ["conversation_history_turn_omissions", "workId"],
  ["lead_text_submissions", "workId"],
  ["retained_result_evidence", "workId"],
  ["retained_review_anchor_contexts", "workId"],
  ["coordination_results", "workId"],
  ["task_review_contexts", "workId"],
  ["coordination_completion_requests", "leadWorkId"],
  ["coordination_interactions", "requestingWorkId"],
  ["coordination_reporting_repairs", "missedWorkId"],
  ["coordination_reporting_repairs", "repairWorkId"],
  ["coordination_follow_ups", "priorWorkId"],
  ["delivery_waiting_work", "workId"],
  ["coordination_recovery_continuations", "workId"],
  ["coordination_delivery_batches", "deliveryWorkId"],
] as const;
const workEdges = [
  ["execution_request_predecessors", ["workId", "previousWorkId"]],
  ["execution_retry_resolutions", ["failedWorkId", "retryWorkId", "chainId"]],
  ["execution_shutdown_resolutions", ["interruptedWorkId", "requeueWorkId"]],
  ["execution_retry_generations", ["workId", "chainId"]],
  ["execution_retry_attempts", ["workId", "chainId"]],
  ["turn_request_restarts", ["refusedWorkId", "workId"]],
  ["inbox_request_supersessions", ["oldWorkId", "newWorkId"]],
  ["turn_requests", ["workId", "previousWorkId"]],
] as const;
function independentWorkOwners(db: Database, workId: string): string[] {
  const owners: string[] = [];
  for (const [table, column] of workRoots) {
    for (const row of all(db, `SELECT * FROM ${table} WHERE ${column}=?`, [
      workId,
    ])) {
      if (row.projectId !== undefined && row.projectId !== null)
        owners.push(uuid.parse(row.projectId));
      if (row.taskId !== undefined && row.taskId !== null)
        owners.push(taskOwner(db, text.parse(row.taskId)));
      for (const field of [
        "assignmentId",
        "leadAssignmentId",
        "requestingAssignmentId",
      ])
        if (row[field] !== undefined && row[field] !== null)
          owners.push(assignmentOwner(db, uuid.parse(row[field])));
    }
  }
  return unique(owners);
}
function readReceipts(db: Database, owner: OwnershipParameters) {
  const tasks = new Set(owner.tasks as string[]),
    drafts = new Set(owner.drafts as string[]),
    work = new Set(owner.work as string[]);
  const assignments = new Set(owner.assignments as string[]),
    events = new Set(owner.events as string[]),
    interactions = new Set(owner.interactions as string[]);
  const operatorReceipts: { scope: string; key: string }[] = [],
    preTurnKeys: string[] = [],
    deliveryConfirmKeys: string[] = [],
    settlementKeys: string[] = [],
    publicationKeys: string[] = [],
    draftReceiptKeys: string[] = [],
    viewKeys: string[] = [];
  const eventScopes = new Set([
    "local-review-send",
    "answer-question",
    "answer-question-form",
    "decide-approval",
    "operator-message",
    "reconcile-result-recipient",
  ]);
  for (const row of all(db, "SELECT * FROM coordination_operator_receipts")) {
    const scope = text.parse(row.scope),
      key = uuid.parse(row.commandKey);
    let owned = false;
    if (scope === taskCommentReceiptScope) {
      const result = taskCommentReceiptSchema.parse(json(row.result));
      if (result.key !== key || result.payloadHash !== row.payloadHash)
        throw new Error("Task comment receipt identity mismatch");
      taskOwner(db, result.taskId);
      owned = tasks.has(result.taskId);
      for (const delivery of result.deliveries) {
        const event = db
          .prepare(
            "SELECT taskId FROM coordination_inbox_events WHERE eventId=?",
          )
          .get(delivery.eventId) as Row | undefined;
        if (!event || event.taskId !== result.taskId)
          throw new Error("Task comment receipt parent is unavailable");
      }
    } else if (scope === "answer-runtime-question") {
      const result = runtimeAnswerReceiptSchema.parse(json(row.result));
      if (
        !db
          .prepare(
            "SELECT 1 FROM coordination_interactions WHERE interactionId=?",
          )
          .get(result.interactionId)
      )
        throw new Error("Native receipt parent is unavailable");
      owned = interactions.has(result.interactionId);
    } else if (eventScopes.has(scope)) {
      const result = z
        .object({ eventId: uuid })
        .strict()
        .parse(json(row.result));
      if (
        !db
          .prepare("SELECT 1 FROM coordination_inbox_events WHERE eventId=?")
          .get(result.eventId)
      )
        throw new Error("Operator receipt parent is unavailable");
      owned = events.has(result.eventId);
    } else throw new Error("Unclassified coordination receipt scope");
    if (owned) operatorReceipts.push({ scope, key });
  }
  for (const row of all(db, "SELECT * FROM execution_pre_turn_commands")) {
    const scope = text.parse(row.scope),
      key = uuid.parse(row.commandKey);
    let workId: string | undefined, assignmentId: string | undefined;
    if (scope === "adopt" || scope === "adopt-no-turn") {
      const material = (
        scope === "adopt"
          ? historicalPreTurnAdoptionSchema
          : historicalNoTurnAdoptionSchema
      ).parse(json(row.payloadMaterial));
      const result = z
        .object({ witnessId: uuid, workId: text })
        .strict()
        .parse(json(row.result));
      if (material.key !== key || result.workId !== material.workId)
        throw new Error("Adoption receipt identity mismatch");
      const table =
        scope === "adopt"
          ? "execution_pre_turn_rejections"
          : "execution_no_turn_submissions";
      if (
        !db
          .prepare(`SELECT 1 FROM ${table} WHERE id=? AND workId=?`)
          .get(result.witnessId, result.workId)
      )
        throw new Error("Adoption witness is unavailable");
      workId = result.workId;
    } else if (scope === "replace-conversation") {
      const material = replaceConversationCommandSchema.parse(
        json(row.payloadMaterial),
      );
      z.object({ revision: z.number().int().positive() })
        .strict()
        .parse(json(row.result));
      if (material.key !== key)
        throw new Error("Replacement receipt identity mismatch");
      assignmentId = material.assignmentId;
      assignmentOwner(db, assignmentId);
    } else if (
      ["recover", "recover-bound-turn", "recover-no-turn"].includes(scope)
    ) {
      const material = z
        .object({
          key: uuid,
          receipt: recoveryReceiptSchema,
          assignmentId: uuid.optional(),
        })
        .strict()
        .parse(json(row.payloadMaterial));
      const result = z
        .object({ id: uuid, workId: text, state: z.literal("reconciled") })
        .strict()
        .parse(json(row.result));
      if (material.key !== key || result.workId !== material.receipt.workId)
        throw new Error("Recovery command receipt identity mismatch");
      if (
        !db
          .prepare(
            "SELECT 1 FROM execution_recovery_receipts WHERE id=? AND workId=?",
          )
          .get(result.id, result.workId)
      )
        throw new Error("Recovery receipt parent is unavailable");
      workId = result.workId;
      if (material.assignmentId) {
        assignmentId = material.assignmentId;
        if (
          !independentWorkOwners(db, workId).includes(
            assignmentOwner(db, assignmentId),
          )
        )
          throw new Error("Recovery assignment ownership mismatch");
      }
    } else throw new Error("Unclassified pre-turn receipt scope");
    if (
      (workId && work.has(workId)) ||
      (assignmentId && assignments.has(assignmentId))
    )
      preTurnKeys.push(key);
  }
  for (const [table, witnessTable] of [
    ["execution_pre_turn_receipts", "execution_pre_turn_rejections"],
    ["execution_no_turn_receipts", "execution_no_turn_submissions"],
  ] as const)
    for (const row of all(db, `SELECT * FROM ${table}`)) {
      if (
        !db
          .prepare(
            `SELECT 1 FROM ${witnessTable} w JOIN execution_recovery_receipts r ON r.id=? AND r.workId=w.workId WHERE w.id=? AND w.workId=?`,
          )
          .get(String(row.receiptId), String(row.witnessId), String(row.workId))
      )
        throw new Error("Recovery witness ownership mismatch");
    }
  const confirmation = z
    .object({
      key: uuid,
      taskId: uuid,
      reviewId: uuid,
      expectedRevision: z.number().int().positive(),
      materialHash: z.string().length(64),
      decision: z.enum(["approved", "denied"]),
    })
    .strict();
  for (const row of all(
    db,
    "SELECT * FROM delivery_operator_confirm_receipts",
  )) {
    const material = confirmation.parse(json(row.material)),
      result = operatorCommentReviewSchema.parse(json(row.recordJson));
    if (
      material.key !== row.key ||
      material.taskId !== result.taskId ||
      material.reviewId !== result.reviewId
    )
      throw new Error("Delivery confirmation identity mismatch");
    taskOwner(db, result.taskId);
    if (tasks.has(result.taskId)) deliveryConfirmKeys.push(uuid.parse(row.key));
  }
  for (const row of all(db, "SELECT * FROM delivery_settlement_receipts")) {
    const result = prBindingSchema.parse(json(row.recordJson));
    taskOwner(db, result.taskId);
    const readiness = db
      .prepare(
        "SELECT taskId FROM delivery_settlement_readiness WHERE commandKey=?",
      )
      .get(String(row.commandKey)) as Row | undefined;
    if (readiness && readiness.taskId !== result.taskId)
      throw new Error("Settlement receipt ownership mismatch");
    if (tasks.has(result.taskId))
      settlementKeys.push(uuid.parse(row.commandKey));
  }
  for (const row of all(db, "SELECT * FROM task_publication_receipts")) {
    const material = confirmation.parse(json(row.material)),
      result = publicationReviewSchema.parse(json(row.recordJson));
    if (
      material.key !== row.key ||
      material.taskId !== result.taskId ||
      material.reviewId !== result.publicationId
    )
      throw new Error("Publication receipt identity mismatch");
    taskOwner(db, result.taskId);
    if (tasks.has(result.taskId)) publicationKeys.push(uuid.parse(row.key));
  }
  for (const row of all(db, "SELECT * FROM drafting_command_receipts")) {
    const result = commandReceiptSchema.parse(json(row.receiptJson));
    if (result.kind !== "drafting" || result.key !== row.key)
      throw new Error("Drafting receipt identity is unavailable");
    if (
      !db.prepare("SELECT 1 FROM drafting_runs WHERE runId=?").get(result.runId)
    )
      throw new Error("Drafting receipt parent is unavailable");
    if (drafts.has(result.runId)) draftReceiptKeys.push(uuid.parse(row.key));
  }
  for (const row of all(db, "SELECT * FROM task_review_view_receipts")) {
    const material = z
      .object({
        taskId: uuid,
        sourceId: uuid.nullable(),
        resultIds: z.array(uuid),
      })
      .strict()
      .parse(json(row.material));
    taskOwner(db, material.taskId);
    if (
      material.sourceId &&
      !db
        .prepare(
          "SELECT 1 FROM task_review_sources WHERE sourceId=? AND taskId=?",
        )
        .get(material.sourceId, material.taskId)
    )
      throw new Error("Viewed source ownership mismatch");
    for (const resultId of material.resultIds)
      if (
        !db
          .prepare(
            "SELECT 1 FROM coordination_results WHERE resultId=? AND taskId=?",
          )
          .get(resultId, material.taskId)
      )
        throw new Error("Viewed result ownership mismatch");
    if (tasks.has(material.taskId)) viewKeys.push(uuid.parse(row.key));
  }
  return {
    operatorReceipts,
    preTurnKeys,
    deliveryConfirmKeys,
    settlementKeys,
    publicationKeys,
    draftReceiptKeys,
    viewKeys,
  };
}

/** Fixed identity capture before any row/receipt parent can be removed. */
export function captureDeletionOwnership(db: Database, projectId: string) {
  uuid.parse(projectId);
  if (!db.isTransaction)
    throw new Error("Project ownership capture requires a transaction");
  assertProjectDeletionInventory(db);
  const tasks = strings(
    all(
      db,
      "SELECT id FROM domain_tasks WHERE projectId=? UNION SELECT id FROM tasks WHERE projectId=?",
      [projectId, projectId],
    ),
    "id",
  );
  for (const task of tasks)
    if (taskOwner(db, task) !== projectId)
      throw new Error("Project task mirrors disagree");
  const base: OwnershipParameters = {
    projectId,
    tasks,
    assignments: [],
    drafts: [],
    work: [],
  };
  const assignments = strings(
    ownedRows(
      db,
      "domain_assignments",
      `projectId=:projectId OR ${inSet("taskId", "tasks")}`,
      base,
    ),
    "id",
  );
  for (const assignment of assignments)
    if (assignmentOwner(db, assignment) !== projectId)
      throw new Error("Cross-project assignment ownership");
  base.assignments = assignments;
  const drafts = strings(
    ownedRows(
      db,
      "drafting_runs",
      `projectId=:projectId OR ${inSet("taskId", "tasks")}`,
      base,
    ),
    "runId",
  );
  base.drafts = drafts;
  const work = new Set(drafts.map((run) => `drafting:${run}`));
  for (const [table, column] of workRoots) {
    const predicate = projectDeletionStatements.find(
      (statement) => statement.table === table,
    )?.where;
    if (!predicate) throw new Error("Unclassified project work root");
    for (const value of strings(ownedRows(db, table, predicate, base), column))
      work.add(value);
  }
  const edges = workEdges.map(([table, columns]) => ({
    rows: all(db, `SELECT ${columns.join(",")} FROM ${table}`),
    columns,
  }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { rows, columns } of edges)
      for (const row of rows) {
        const ids = columns.flatMap((column) =>
          row[column] === null ? [] : [text.parse(row[column])],
        );
        if (!ids.some((value) => work.has(value))) continue;
        for (const value of ids)
          if (!work.has(value)) {
            if (
              independentWorkOwners(db, value).some(
                (owner) => owner !== projectId,
              )
            )
              throw new Error("Cross-project execution lineage");
            work.add(value);
            changed = true;
          }
      }
    if (work.size > cap)
      throw new Error("Project execution ownership exceeds its bound");
  }
  for (const value of work)
    if (independentWorkOwners(db, value).some((owner) => owner !== projectId))
      throw new Error("Execution ownership is inconsistent");
  base.work = [...work].sort();
  const intents = strings(
    ownedRows(db, "execution_intents", inSet("workId", "work"), base),
    "id",
  );
  const threads = new Set<string>();
  for (const [table, predicate] of [
    ["execution_intents", inSet("workId", "work")],
    ["execution_recovery_identities", inSet("workId", "work")],
    ["execution_recovery_receipts", inSet("workId", "work")],
    ["execution_stop_targets", inSet("workId", "work")],
    ["lead_text_submissions", inSet("workId", "work")],
    [
      "diagnostic_executions",
      `projectId=:projectId OR ${inSet("workId", "work")}`,
    ],
    [
      "conversation_history_items",
      `${inSet("taskId", "tasks")} OR ${inSet("workId", "work")}`,
    ],
    [
      "conversation_history_turn_omissions",
      `${inSet("taskId", "tasks")} OR ${inSet("workId", "work")}`,
    ],
    [
      "retained_result_evidence",
      `${inSet("taskId", "tasks")} OR ${inSet("workId", "work")}`,
    ],
    [
      "retained_review_anchor_contexts",
      `${inSet("taskId", "tasks")} OR ${inSet("workId", "work")}`,
    ],
    ["runtime_terminal_evidence", inSet("workId", "work")],
    ["coordination_receipts", inSet("workId", "work")],
  ])
    for (const value of strings(
      ownedRows(db, table!, predicate!, base),
      "threadId",
    ))
      threads.add(value);
  const ownedInteractions = strings(
    ownedRows(db, "coordination_interactions", inSet("taskId", "tasks"), base),
    "interactionId",
  );
  base.interactions = ownedInteractions;
  for (const row of ownedRows(
    db,
    "coordination_runtime_questions",
    inSet("interactionId", "interactions"),
    base,
  )) {
    const endpoint = nativeInputEndpointIdentitySchema.parse(
      json(row.identityJson),
    );
    threads.add(endpoint.threadId);
    if (row.threadId !== null && row.threadId !== endpoint.threadId)
      throw new Error("Native question thread identity mismatch");
  }
  base.threads = [...threads].sort();
  // A thread is a cleanup identity only if every surviving execution/evidence owner agrees.
  for (const table of [
    "execution_intents",
    "execution_recovery_identities",
    "diagnostic_executions",
    "conversation_history_items",
    "conversation_history_turn_omissions",
    "retained_result_evidence",
    "retained_review_anchor_contexts",
    "runtime_terminal_evidence",
    "coordination_receipts",
  ])
    for (const row of ownedRows(db, table, inSet("threadId", "threads"), base))
      if (
        row.workId !== null &&
        row.workId !== undefined &&
        !work.has(text.parse(row.workId))
      )
        throw new Error("A captured thread has another execution owner");
  for (const row of ownedRows(
    db,
    "coordination_runtime_questions",
    `${inSet("threadId", "threads")} OR ${inSet("json_extract(identityJson,'$.threadId')", "threads")}`,
    base,
  )) {
    const parent = db
      .prepare(
        "SELECT taskId FROM coordination_interactions WHERE interactionId=?",
      )
      .get(String(row.interactionId)) as Row | undefined;
    if (!parent || taskOwner(db, text.parse(parent.taskId)) !== projectId)
      throw new Error("A captured native thread has another owner");
  }
  const ids = (
    table: string,
    column: string,
    predicate = inSet("taskId", "tasks"),
  ) => strings(ownedRows(db, table, predicate, base), column);
  Object.assign(base, {
    intents,
    results: ids("coordination_results", "resultId"),
    interactions: ids("coordination_interactions", "interactionId"),
    events: ids("coordination_inbox_events", "eventId"),
    batches: ids("coordination_delivery_batches", "batchId"),
    comments: ids("coordination_task_comments", "commentId"),
    deliveryOperations: ids("delivery_actions", "operationId"),
    routingOperations: ids(
      "routing_attempt_operations",
      "operationId",
      `projectId=:projectId OR ${inSet("taskId", "tasks")}`,
    ),
    reviews: ids("coordination_local_review_operations", "reviewId"),
    reviewGroups: ids("coordination_local_review_groups", "groupId"),
    submittedContexts: ids(
      "retained_review_anchor_submitted_contexts",
      "submittedContextId",
    ),
    anchorDrafts: ids("retained_review_anchor_drafts", "draftId"),
    anchors: ids(
      "retained_review_anchor_contexts",
      "anchorId",
      `${inSet("taskId", "tasks")} OR ${inSet("workId", "work")}`,
    ),
    publications: ids("task_publications", "publicationId"),
  });
  Object.assign(base, {
    resultItems: ids("retained_result_evidence_items", "itemId"),
    artifacts: ids("task_review_artifact_ids", "artifactId"),
    sources: ids(
      "task_review_sources",
      "sourceId",
      `projectId=:projectId OR ${inSet("taskId", "tasks")}`,
    ),
    contexts: ids("task_review_contexts", "captureId"),
    comparisons: unique([
      ...ids("workspace_turn_captures", "comparisonId"),
      ...ids("workspace_comparison_current", "comparisonId"),
    ]),
    witnesses: unique([
      ...ids("execution_pre_turn_rejections", "id", inSet("workId", "work")),
      ...ids("execution_no_turn_submissions", "id", inSet("workId", "work")),
    ]),
    recoveryReceipts: ids(
      "execution_recovery_receipts",
      "id",
      inSet("workId", "work"),
    ),
    anchorOperations: ids("retained_review_anchor_operations", "operationId"),
    localOperations: ids("coordination_local_review_operations", "operationId"),
    routingDispositions: ids("routing_operations", "id"),
    followUps: ids("coordination_follow_ups", "followUpId"),
    completionRequests: ids("coordination_completion_requests", "requestId"),
  });
  base.external = ownedRows(
    db,
    "external_items",
    inSet("taskId", "tasks"),
    base,
  ).map((r) =>
    z
      .object({ provider: text, instance: text, externalId: text })
      .strict()
      .parse({
        provider: r.provider,
        instance: r.instance,
        externalId: r.externalId,
      }),
  );
  Object.assign(base, readReceipts(db, base));
  const rows: Record<string, Row[]> = {};
  for (const statement of projectDeletionStatements) {
    rows[statement.table] = ownedRows(
      db,
      statement.table,
      statement.where,
      base,
    );
    for (const row of rows[statement.table]!) {
      // Relation rows are deliberately released across projects; ordinary owner rows cannot disagree.
      if (
        !["source_memberships", "source_placement_decisions"].includes(
          statement.table,
        ) &&
        row.projectId !== undefined &&
        row.projectId !== null &&
        row.projectId !== projectId
      )
        throw new Error("Owned row belongs to another project");
      if (
        ![
          "local_dependencies",
          "stacked_dependencies",
          "task_dependency_records",
        ].includes(statement.table) &&
        row.taskId !== undefined &&
        row.taskId !== null &&
        taskOwner(db, text.parse(row.taskId)) !== projectId
      )
        throw new Error("Owned task row belongs to another project");
      for (const field of [
        "assignmentId",
        "requesterAssignmentId",
        "recipientAssignmentId",
        "requestingAssignmentId",
        "targetAssignmentId",
        "leadAssignmentId",
        "resultRecipientAssignmentId",
      ])
        if (
          row[field] !== undefined &&
          row[field] !== null &&
          assignmentOwner(db, uuid.parse(row[field])) !== projectId
        )
          throw new Error("Owned assignment row belongs to another project");
    }
  }
  const digest = materialDigest({
    identities: base,
    rows: Object.fromEntries(
      Object.entries(rows).map(([table, values]) => [
        table,
        values.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? {
                    sha256: createHash("sha256").update(value).digest("hex"),
                    bytes: value.byteLength,
                  }
                : value,
            ]),
          ),
        ),
      ]),
    ),
  });
  return { parameters: base, rows, digest };
}

/** Calibration and final postcondition use the captured identities, never missing parents. */
export function assertProjectRowsRemoved(
  db: Database,
  owner: ProjectOwnership,
): void {
  for (const statement of projectDeletionStatements)
    if (
      ownedRows(db, statement.table, statement.where, owner.parameters).length
    )
      throw new Error(
        `Project deletion retained owned rows in ${statement.table}`,
      );
}
