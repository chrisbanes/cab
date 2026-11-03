import { z } from "zod";
import {
  hasLabelName,
  observedFacts,
  projectFieldsSchema,
  readinessSchema,
} from "./github-source-contracts.js";
import { itemIs } from "./source-storage.js";
import type { Database } from "./store.js";

/**
 * The values an imported task's readiness rule reads, bound to each reviewable-PR settlement.
 * Ready and the task version only change when the rule's result flips, so a label or option
 * moving between two satisfying values is invisible to them; this keeps the values themselves.
 * Internal to delivery: no receipt, command or operator read carries it.
 */
const componentSchema = z
  .object({ id: z.string(), value: z.array(z.string()).nullable() })
  .strict();
const inputsSchema = z
  .object({
    /** `provider|instance|externalId` of the imported item. */
    item: z.string(),
    /** The rule text as stored, so a changed rule never reads as the same inputs. */
    rule: z.string().nullable(),
    /** One entry per referenced input, sorted by `id`; a `null` value is unobserved. */
    components: z.array(componentSchema),
  })
  .strict();
export type ReadinessInputs = z.output<typeof inputsSchema>;

type Row = Record<string, string | number | null>;
const unique = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * The imported task's current inputs, or `null` for a local task. `complete` is false while a
 * selection listing the item has no complete read (a restart, a failed or partial read), which
 * can still show a changed value but cannot vouch for an unchanged one.
 */
export function readinessInputs(
  db: Database,
  taskId: string,
): { inputs: ReadinessInputs; complete: boolean } | null {
  const item = db
    .prepare(
      `SELECT e.provider, e.instance, e.externalId, e.labels, e.observedStatus, e.observedFields, t.projectId
       FROM external_items e JOIN domain_tasks t ON t.id = e.taskId WHERE e.taskId = ?`,
    )
    .get(taskId) as Row | undefined;
  if (!item) return null;
  const key = [item.provider, item.instance, item.externalId] as [
    string,
    string,
    string,
  ];
  const source = db
    .prepare("SELECT readiness FROM project_task_sources WHERE projectId = ?")
    .get(String(item.projectId)) as Row | undefined;
  const ruleText = source ? String(source.readiness) : null;
  const rule = ruleText
    ? readinessSchema.nullable().parse(JSON.parse(ruleText) as unknown)
    : null;
  const memberships = db
    .prepare(
      `SELECT selectionId, fields FROM source_memberships WHERE ${itemIs()} AND projectId = ?`,
    )
    .all(...key, String(item.projectId)) as Row[];
  const facts = observedFacts(item);
  const fields = memberships.flatMap((row) =>
    projectFieldsSchema.parse(JSON.parse(String(row.fields))),
  );
  const coverage = db
    .prepare(
      "SELECT unreadSelectFields FROM delivery_readiness_coverage WHERE taskId = ?",
    )
    .get(taskId) as Row | undefined;
  const unread = new Set(
    z
      .array(z.string())
      .parse(JSON.parse(String(coverage?.unreadSelectFields ?? "[]"))),
  );
  const components = new Map<string, string[] | null>();
  for (const c of rule?.conditions ?? []) {
    if (c.kind === "label")
      components.set(
        `label:${c.name.toLowerCase()}`,
        hasLabelName(facts.labels, c.name) ? ["present"] : [],
      );
    else if (c.kind === "status")
      components.set("status", facts.status === null ? null : [facts.status]);
    else if (c.kind === "select-field")
      components.set(
        `select-field:${c.fieldId}`,
        unread.has(c.fieldId) || item.observedFields == null
          ? null
          : unique(
              facts.selectFields
                .filter((f) => f.fieldId === c.fieldId)
                .map((f) => f.optionId),
            ),
      );
    else
      components.set(
        `project-field:${c.projectNodeId}:${c.fieldNodeId}`,
        // An item outside the Project has no field page to have read.
        memberships.length === 0
          ? null
          : unique(
              fields
                .filter(
                  (f) =>
                    f.projectNodeId === c.projectNodeId &&
                    f.fieldNodeId === c.fieldNodeId,
                )
                .map((f) => f.optionNodeId),
            ),
      );
  }
  const complete =
    components.size === 0 ||
    memberships.every(
      (m) =>
        (
          db
            .prepare(
              "SELECT complete FROM source_sync_state WHERE projectId = ? AND selectionId = ?",
            )
            .get(String(item.projectId), String(m.selectionId)) as
            | Row
            | undefined
        )?.complete === 1,
    );
  return {
    complete,
    inputs: {
      item: key.join("|"),
      rule: ruleText,
      components: [...components]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, value]) => ({ id, value })),
    },
  };
}

/**
 * `changed` is an observed difference; `unknown` is an input the current read does not carry.
 * `exemptStatus` is the one status value an own issue close may have moved the item to.
 */
export function compareInputs(
  frozen: ReadinessInputs,
  current: ReadinessInputs,
  exemptStatus?: string,
): "same" | "unknown" | "changed" {
  if (frozen.item !== current.item || frozen.rule !== current.rule)
    return "changed";
  const now = new Map(current.components.map((c) => [c.id, c.value]));
  let result: "same" | "unknown" = "same";
  for (const { id, value } of frozen.components) {
    const seen = now.get(id);
    if (!seen || !value) result = "unknown";
    else if (seen.join() !== value.join())
      if (
        !(
          id === "status" &&
          exemptStatus !== undefined &&
          seen[0] === exemptStatus
        )
      )
        return "changed";
  }
  return result;
}

export class DeliveryReadinessStore {
  constructor(private readonly db: Database) {}

  /** Freezes the task's current inputs under the settlement; `false` when they are not fully observed. */
  capture(commandKey: string, taskId: string): boolean {
    const now = readinessInputs(this.db, taskId);
    if (!now) return true;
    if (!now.complete || now.inputs.components.some((c) => c.value === null))
      return false;
    // Only the current settlement is consulted; a replayed key returns its receipt without one.
    this.db
      .prepare("DELETE FROM delivery_settlement_readiness WHERE taskId = ?")
      .run(taskId);
    this.db
      .prepare("INSERT INTO delivery_settlement_readiness VALUES (?,?,?,0)")
      .run(commandKey, taskId, JSON.stringify(now.inputs));
    return true;
  }

  /** The inputs as read now, for comparing across an await. */
  material(taskId: string): string | null {
    const now = readinessInputs(this.db, taskId);
    return now && JSON.stringify(now);
  }

  /**
   * Latches a settlement whose inputs a committed source write changed. Once latched it stays
   * so, even if a later read shows the old values again: only a fresh settlement recovers.
   */
  observe(taskId: string, exemptStatus: () => string | undefined): void {
    const rows = this.db
      .prepare(
        "SELECT commandKey, inputsJson FROM delivery_settlement_readiness WHERE taskId = ? AND invalidated = 0",
      )
      .all(taskId) as { commandKey: string; inputsJson: string }[];
    if (!rows.length) return;
    const now = readinessInputs(this.db, taskId);
    if (!now) return;
    const exempt = exemptStatus();
    for (const row of rows)
      if (
        compareInputs(
          inputsSchema.parse(JSON.parse(row.inputsJson)),
          now.inputs,
          exempt,
        ) === "changed"
      )
        this.db
          .prepare(
            "UPDATE delivery_settlement_readiness SET invalidated = 1 WHERE commandKey = ?",
          )
          .run(row.commandKey);
  }

  /** Whether the settlement no longer vouches for the task's current inputs. A settlement made before this record held none. */
  holds(taskId: string, commandKey: string, exemptStatus?: string): boolean {
    const now = readinessInputs(this.db, taskId);
    if (!now) return false;
    const row = this.db
      .prepare(
        "SELECT inputsJson, invalidated FROM delivery_settlement_readiness WHERE commandKey = ? AND taskId = ?",
      )
      .get(commandKey, taskId) as
      | { inputsJson: string; invalidated: number }
      | undefined;
    return (
      !row ||
      row.invalidated === 1 ||
      !now.complete ||
      compareInputs(
        inputsSchema.parse(JSON.parse(row.inputsJson)),
        now.inputs,
        exemptStatus,
      ) !== "same"
    );
  }

  /** The requested Jira select fields the last read of the task's issue did not return as a value or null. */
  recordCoverage(taskId: string, unreadSelectFields: string[]): void {
    this.db
      .prepare(
        `INSERT INTO delivery_readiness_coverage VALUES (?,?)
         ON CONFLICT(taskId) DO UPDATE SET unreadSelectFields = excluded.unreadSelectFields
         WHERE unreadSelectFields != excluded.unreadSelectFields`,
      )
      .run(taskId, JSON.stringify(unique(unreadSelectFields)));
  }
}
