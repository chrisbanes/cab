import { z } from "zod";
import { nonempty, readinessSchema } from "./github-source-contracts.js";
import type { Database } from "./store.js";

/** The readiness conditions as stored before operators; the only place these shapes remain. */
const legacyRuleSchema = z
  .object({
    mode: z.enum(["all", "any"]),
    conditions: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("label"), name: nonempty }).strict(),
          z
            .object({
              kind: z.literal("project-field"),
              projectNodeId: nonempty,
              fieldNodeId: nonempty,
              optionNodeId: nonempty,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(20),
  })
  .strict();

/** The operator-shape text of a legacy rule's text, or `undefined` for any other text. */
function upgradedText(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const legacy = legacyRuleSchema.safeParse(json);
  if (!legacy.success) return undefined;
  // Serialised by the current schema, so it equals the text a later save of the same rule writes.
  return JSON.stringify(
    readinessSchema.parse({
      mode: legacy.data.mode,
      conditions: legacy.data.conditions.map((c) =>
        c.kind === "label"
          ? { kind: c.kind, operator: "has", name: c.name }
          : {
              kind: c.kind,
              projectNodeId: c.projectNodeId,
              fieldNodeId: c.fieldNodeId,
              operator: "in",
              optionNodeIds: [c.optionNodeId],
            },
      ),
    }),
  );
}

/**
 * Re-encodes the saved source rule and every task's rule snapshot from the previous condition
 * shapes (a label; one exact option) to operators (`has`; `in` one option). Each text maps to one
 * text, so equal texts stay equal and rule identity, Ready, versions and holds are untouched. Text
 * that is not a legacy rule (no rule, an operator rule, unreadable text) is left as it is, which
 * also makes the rewrite idempotent. Runs inside the caller's transaction.
 */
export function upgradeReadinessConditions(db: Database): void {
  const texts = db
    .prepare(
      "SELECT readiness AS text FROM project_task_sources UNION SELECT readinessRule FROM domain_tasks WHERE readinessRule IS NOT NULL",
    )
    .all() as { text: string }[];
  const sources = db.prepare(
    "UPDATE project_task_sources SET readiness = ? WHERE readiness = ?",
  );
  const tasks = db.prepare(
    "UPDATE domain_tasks SET readinessRule = ? WHERE readinessRule = ?",
  );
  for (const { text } of texts) {
    const next = upgradedText(text);
    if (next === undefined) continue;
    sources.run(next, text);
    tasks.run(next, text);
  }
}
