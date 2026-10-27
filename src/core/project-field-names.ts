import { z } from "zod";
import type { Database } from "./store.js";

/** A single-select Project field and its options, as a complete Project read listed them. */
export interface ProjectFieldName {
  projectNodeId: string;
  fieldNodeId: string;
  name: string;
  options: { optionNodeId: string; name: string }[];
}

/** A readiness condition or Project field value; only a Project field one carries node IDs. */
export interface ProjectFieldIds {
  kind?: string;
  projectNodeId?: string;
  fieldNodeId?: string;
  optionNodeId?: string;
}

const optionsSchema = z.array(
  z.object({ optionNodeId: z.string(), name: z.string() }).strict(),
);

/** Replaces one Project's stored field names; a field or option no longer listed loses its name. */
export function replaceProjectFieldNames(
  db: Database,
  projectNodeId: string,
  fields: readonly ProjectFieldName[],
): void {
  db.prepare("DELETE FROM github_project_fields WHERE projectNodeId = ?").run(
    projectNodeId,
  );
  const insert = db.prepare(
    "INSERT INTO github_project_fields (projectNodeId, fieldNodeId, name, options) VALUES (?, ?, ?, ?)",
  );
  for (const f of fields)
    insert.run(projectNodeId, f.fieldNodeId, f.name, JSON.stringify(f.options));
}

/** The stored field names of these Projects, in the order GitHub listed their options. */
export function projectFieldNames(
  db: Database,
  projectNodeIds: readonly string[],
): ProjectFieldName[] {
  const ids = [...new Set(projectNodeIds)];
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT projectNodeId, fieldNodeId, name, options FROM github_project_fields WHERE projectNodeId IN (${ids.map(() => "?").join(", ")}) ORDER BY rowid`,
    )
    .all(...ids) as Record<string, unknown>[];
  return rows.map((r) => ({
    projectNodeId: String(r.projectNodeId),
    fieldNodeId: String(r.fieldNodeId),
    name: String(r.name),
    options: optionsSchema.parse(JSON.parse(String(r.options)) as unknown),
  }));
}

type Named<T> = T & { fieldName?: string; optionName?: string };

/**
 * Conditions or field values with the field and option names the last complete read of
 * their Project listed. One unknown to that read, or a name `disclose` withholds, keeps only
 * its node IDs.
 */
export function withProjectFieldNames<T extends ProjectFieldIds>(
  db: Database,
  items: readonly T[],
  disclose: (name: string) => boolean = () => true,
): Named<T>[] {
  const fields = new Map(
    projectFieldNames(
      db,
      items.flatMap((i) => (i.projectNodeId ? [i.projectNodeId] : [])),
    ).map((f) => [`${f.projectNodeId}\0${f.fieldNodeId}`, f]),
  );
  return items.map((item) => {
    const field = fields.get(`${item.projectNodeId}\0${item.fieldNodeId}`);
    const option = field?.options.find(
      (o) => o.optionNodeId === item.optionNodeId,
    );
    return {
      ...item,
      ...(field && disclose(field.name) ? { fieldName: field.name } : {}),
      ...(option && disclose(option.name) ? { optionName: option.name } : {}),
    };
  });
}
