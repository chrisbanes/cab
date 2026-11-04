import { materialDigest } from "../core/delivery.js";
import {
  RedactionLimitError,
  redactionExclusionLimits,
} from "../core/redaction-limits.js";
import type { Database } from "../core/store.js";
import type { ProjectOwnership } from "./project-deletion-ownership.js";

export interface DeletionPrivateInputs {
  live: readonly string[];
  retiring: readonly string[];
  /** A synchronous snapshot of the same private input sources, never a provider operation. */
  fence: () => string;
  fingerprint: string;
}
type Row = Record<string, unknown>;
function read(db: Database, sql: string): Row[] {
  const rows = db.prepare(sql).all() as Row[];
  if (rows.length > 100_000)
    throw new Error("Private deletion inputs unavailable");
  return rows;
}
function reference(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^(?:env:[A-Z][A-Z0-9_]*|gh:github\.com|glab:[a-zA-Z0-9.-]+)$/.test(value)
  )
    throw new Error("Private credential reference unavailable");
  return value;
}
function refValues(ref: string | null, required = false): string[] {
  if (!ref) return [];
  if (!ref.startsWith("env:")) return [ref];
  const value = process.env[ref.slice(4)];
  if (required && !value)
    throw new Error("Private credential resolution unavailable");
  return [ref, ref.slice(4), ...(value ? [value] : [])];
}
function repositoryPaths(value: unknown): string[] {
  if (typeof value !== "string")
    throw new Error("Private repository inputs unavailable");
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows) || rows.length > 128)
    throw new Error("Private repository inputs unavailable");
  return rows.flatMap((input: unknown) => {
    if (!input || typeof input !== "object")
      throw new Error("Private repository inputs unavailable");
    const row = input as Record<string, unknown>;
    const values = [
      row.path,
      row.gitCommonDirectory,
      row.sourcePath,
      row.workspacePath,
      row.gitCommonDir,
    ].filter((v) => v !== undefined && v !== null);
    if (values.some((v) => typeof v !== "string"))
      throw new Error("Private repository inputs unavailable");
    return values as string[];
  });
}
function rowsPrivate(rows: Record<string, readonly Row[]>): string[] {
  const values: string[] = [];
  for (const row of rows.project_instruction_revisions ?? []) {
    if (typeof row.instructions !== "string")
      throw new Error("Private instruction inputs unavailable");
    values.push(row.instructions);
  }
  for (const row of rows.project_repository_links ?? [])
    values.push(...repositoryPaths(row.links));
  for (const table of [
    "task_workspace_bindings",
    "drafting_workspace_bindings",
  ])
    for (const row of rows[table] ?? []) {
      if (typeof row.path !== "string")
        throw new Error("Private workspace inputs unavailable");
      values.push(row.path, ...repositoryPaths(row.repositories));
    }
  for (const table of [
    "execution_intents",
    "turn_requests",
    "task_writer_admissions",
  ])
    for (const row of rows[table] ?? []) {
      if (row.workspace !== null && row.workspace !== undefined) {
        if (typeof row.workspace !== "string")
          throw new Error("Private workspace inputs unavailable");
        values.push(row.workspace);
      }
    }
  return values;
}
function retiringReferences(rows: Record<string, readonly Row[]>): string[] {
  return [
    ...new Set(
      [
        ...(rows.project_routing ?? []).map((r) => reference(r.credentialRef)),
        ...(rows.project_task_sources ?? []).map((r) =>
          reference(r.credentialRef),
        ),
        ...(rows.delivery_policies ?? []).map((r) =>
          reference((JSON.parse(String(r.policyJson)) as Row).credentialRef),
        ),
      ].filter((r): r is string => r !== null),
    ),
  ];
}

/** Resolve retiring credentials before the transaction. Only exclusion strings are retained. */
export async function prepareDeletionPrivateInputs(
  db: Database,
  owner: ProjectOwnership,
  paths: readonly string[],
  options: {
    extra: () => readonly string[];
    resolveReference: (reference: string) => Promise<string>;
  },
): Promise<DeletionPrivateInputs> {
  const refs = retiringReferences(owner.rows);
  const resolved: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("env:")) resolved.push(...refValues(ref, true));
    else {
      const value = await options.resolveReference(ref);
      if (typeof value !== "string" || !value.length)
        throw new Error("Private credential resolution unavailable");
      resolved.push(ref, value);
    }
  }
  const snapshot = () => {
    const instructions = read(
      db,
      "SELECT instructions FROM project_instruction_revisions UNION ALL SELECT instructions FROM profile_revisions",
    );
    const values = instructions.map((r) => {
      if (typeof r.instructions !== "string")
        throw new Error("Private instruction inputs unavailable");
      return r.instructions;
    });
    const liveRows: Record<string, Row[]> = {
      project_repository_links: read(
        db,
        "SELECT links FROM project_repository_links",
      ),
      task_workspace_bindings: read(
        db,
        "SELECT path,repositories FROM task_workspace_bindings",
      ),
      drafting_workspace_bindings: read(
        db,
        "SELECT path,repositories FROM drafting_workspace_bindings",
      ),
      execution_intents: read(db, "SELECT workspace FROM execution_intents"),
      turn_requests: read(db, "SELECT workspace FROM turn_requests"),
      task_writer_admissions: read(
        db,
        "SELECT workspace FROM task_writer_admissions",
      ),
    };
    values.push(...rowsPrivate(liveRows), ...options.extra());
    const liveRefs = [
      ...read(db, "SELECT credentialRef FROM project_routing"),
      ...read(db, "SELECT credentialRef FROM project_task_sources"),
      ...read(db, "SELECT policyJson FROM delivery_policies").map((r) => ({
        credentialRef: (JSON.parse(String(r.policyJson)) as Row).credentialRef,
      })),
    ];
    for (const row of liveRefs)
      values.push(...refValues(reference(row.credentialRef)));
    const retiring = [
      ...rowsPrivate(owner.rows),
      ...paths,
      ...resolved,
      ...refs.flatMap((ref) => refValues(ref, true)),
    ];
    if (
      [...values, ...retiring].some(
        (v) =>
          typeof v !== "string" ||
          Buffer.byteLength(v) > redactionExclusionLimits.valueBytes,
      )
    )
      throw new RedactionLimitError();
    return {
      live: [...new Set(values.filter(Boolean))].sort(),
      retiring: [...new Set(retiring.filter(Boolean))].sort(),
    };
  };
  const value = snapshot();
  return {
    ...value,
    fingerprint: materialDigest(value),
    fence: () => materialDigest(snapshot()),
  };
}
