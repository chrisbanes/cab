import type { DatabaseSync } from "node:sqlite";

export interface ExternalItemRow {
  provider?: string;
  instance?: string;
  externalId: string;
  taskId: string;
  containerId: string;
  containerName: string;
  number: number;
  observedTitle: string;
  observedBody: string;
  observedState: string;
  labels: string;
  /** Left out of the INSERT when absent, so legacy-schema tables still accept it. */
  observedStatus?: string | null;
  observedFields?: string | null;
}

/** Inserts an `external_items` row by column name, so added columns need no test edits. */
export function insertExternalItem(
  db: DatabaseSync,
  { provider = "github", instance = "github.com", ...item }: ExternalItemRow,
): void {
  const row = { provider, instance, ...item };
  const columns = Object.entries(row).filter(([, v]) => v !== undefined);
  db.prepare(
    `INSERT INTO external_items (${columns.map(([k]) => k).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map(([, v]) => v as string | number | null));
}

export interface SourceMembershipRow {
  projectId: string;
  selectionId: string;
  provider?: string;
  instance?: string;
  externalId: string;
  fields?: string;
}

/** Inserts a `source_memberships` row by column name; `fields` defaults to `[]`. */
export function insertSourceMembership(
  db: DatabaseSync,
  {
    provider = "github",
    instance = "github.com",
    fields = "[]",
    ...row
  }: SourceMembershipRow,
): void {
  const all = { ...row, provider, instance, fields };
  const keys = Object.keys(all);
  db.prepare(
    `INSERT INTO source_memberships (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
  ).run(...Object.values(all));
}
