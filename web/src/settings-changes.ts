/**
 * Pure change lists and command builders for the settings forms. Each form edits current
 * values in place; these functions compare the draft with the loaded read and name every
 * change on one line. Private values (instructions, guidance, queries, filters, paths and
 * reference names) never appear in a line.
 */
import type { z } from "zod";
import type {
  profileConfigurationSchema,
  projectConfigurationSchema,
  runtimeSettingsSchema,
} from "../../src/operator/contracts.js";

import type { ProfileRuntime } from "../../src/operator/contracts.js";
import { runtimeCommand, runtimeSummary } from "./execution-runtime.js";
import { plural } from "./settings-view.js";

export type Values = Record<string, string | boolean | string[]>;
export type ProjectConfigurationData = z.infer<
  typeof projectConfigurationSchema
>["data"];
export type ProfileConfigurationData = z.infer<
  typeof profileConfigurationSchema
>["data"];
export type RuntimeSettingsData = z.infer<typeof runtimeSettingsSchema>["data"];

/** Text compared as a textarea returns it: line breaks are LF whatever they were saved as. */
export const sameText = (a: string, b: string | undefined) =>
  b !== undefined && a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
/**
 * How a private text field differs from the text the operator revealed: `null` when it
 * was never edited or equals the revealed text. A field edited while its revealed
 * baseline is unknown counts as edited, so the save carries it and the version fence
 * decides.
 */
export function privateEdit(
  value: Values[string] | undefined,
  revealed: string | undefined,
) {
  if (typeof value !== "string" || sameText(value, revealed)) return null;
  return value === "" ? "cleared" : "edited";
}
/** The command field for an edited private text; empty when it was not edited. */
export const privateField = (
  name: "instructions" | "guidance",
  value: Values[string] | undefined,
  revealed: string | undefined,
) => (privateEdit(value, revealed) ? { [name]: String(value) } : {});
const nameOf = (
  profiles: { id: string; name: string | null }[],
  id: string | null | undefined,
) =>
  id
    ? (profiles.find((p) => p.id === id)?.name ?? "Name unavailable")
    : "Unconfigured";
const list = (v: Values[string] | undefined) => (Array.isArray(v) ? v : []);

function referenceChange(v: Values) {
  return v.referenceMode === "set"
    ? ["Credential reference: set new environment reference"]
    : v.referenceMode === "clear"
      ? ["Credential reference: cleared"]
      : [];
}

export function projectChanges(
  data: ProjectConfigurationData,
  v: Values,
  revealed?: string,
) {
  const lines: string[] = [];
  const name = data.project.name ?? "";
  if (v.name !== undefined && v.name !== name)
    lines.push(`Project name: ${name || "Name unavailable"} → ${v.name}`);
  const lead = data.project.leadProfileId ?? "";
  if (v.leadProfileId !== undefined && v.leadProfileId !== lead)
    lines.push(
      `Lead profile: ${nameOf(data.profiles, lead)} → ${nameOf(data.profiles, String(v.leadProfileId))}`,
    );
  if (v.paused !== undefined && Boolean(v.paused) !== data.project.paused)
    lines.push(v.paused ? "Pause project" : "Unpause project");
  const instructions = privateEdit(v.instructions, revealed);
  if (instructions) lines.push(`Instructions ${instructions}`);
  return lines;
}

export function profileChanges(
  data: ProfileConfigurationData,
  v: Values,
  revealed?: string,
) {
  const lines: string[] = [];
  const name = data.profile.name ?? "";
  if (v.name !== undefined && v.name !== name)
    lines.push(`Profile name: ${name || "Name unavailable"} → ${v.name}`);
  if (v.summary !== undefined && v.summary !== (data.profile.summary ?? ""))
    lines.push(`Summary: ${v.summary || "cleared"}`);
  if (
    data.capabilities === null
      ? Boolean(v.replaceCapabilities)
      : v.capabilities !== undefined && v.capabilities !== data.capabilities
  )
    lines.push("Capabilities edited");
  const instructions = privateEdit(v.instructions, revealed);
  if (instructions) lines.push(`Instructions ${instructions}`);
  if (v.revoked !== undefined && Boolean(v.revoked) !== data.profile.revoked)
    lines.push(`${v.revoked ? "Revoke" : "Restore"} ${name || "profile"}`);
  if (v.runtimeHarness !== undefined && runtimeChanged(data.runtime, v))
    lines.push(
      `Runtime: ${runtimeSummary(data.runtime)} → ${runtimeSummary(runtimeCommand(v))}`,
    );
  return lines;
}
export const runtimeChanged = (runtime: ProfileRuntime, v: Values) =>
  JSON.stringify(runtimeCommand(v)) !== JSON.stringify(runtime);

/** Candidates a routing save can keep: revoked profiles are not selectable. */
const selectable = (data: ProjectConfigurationData, ids: string[]) =>
  ids.filter((id) => !data.profiles.find((p) => p.id === id)?.revoked);
export const savedCandidates = (data: ProjectConfigurationData) =>
  selectable(data, data.routing.candidateProfileIds);

export function routingChanges(
  data: ProjectConfigurationData,
  v: Values,
  revealed?: string,
) {
  const lines: string[] = [];
  if (v.enabled !== undefined && Boolean(v.enabled) !== data.routing.enabled)
    lines.push(v.enabled ? "Routing enabled" : "Routing disabled");
  // A draft candidate revoked since it was checked is dropped, as the save drops it.
  const saved = savedCandidates(data),
    next = selectable(data, list(v.candidateProfileIds));
  for (const id of next)
    if (!saved.includes(id))
      lines.push(`Candidate added: ${nameOf(data.profiles, id)}`);
  for (const id of saved)
    if (!next.includes(id))
      lines.push(`Candidate removed: ${nameOf(data.profiles, id)}`);
  const guidance = privateEdit(v.guidance, revealed);
  if (guidance) lines.push(`Routing guidance ${guidance}`);
  return [...lines, ...referenceChange(v)];
}

export function routingCommand(
  projectId: string,
  v: Values,
  data: ProjectConfigurationData,
  revealed?: string,
) {
  return {
    type: "routing.configure",
    key: v.key,
    projectId,
    expectedVersion: Number(v.expectedVersion),
    enabled: Boolean(v.enabled),
    candidateProfileIds: selectable(data, list(v.candidateProfileIds)),
    ...privateField("guidance", v.guidance, revealed),
    ...reference(v),
  };
}

export function reference(v: Values) {
  return v.referenceMode === "clear"
    ? { credentialRef: null }
    : v.referenceMode === "set"
      ? { credentialRef: v.credentialRef }
      : {};
}

/**
 * One row of the GitHub source form. A saved row carries no private definition until the
 * operator edits it: `query` (search) and `path` (repository link) then hold the edit.
 */
export type SourceRow = Record<string, string | boolean>;
type Source = ProjectConfigurationData["source"];
/** What the session-only read returned for this source version: the baseline of any edit. */
export interface SourcePrivate {
  searches: { id: string; query: string }[];
  repositories: { repositoryId: string; path: string }[];
}
/** A saved search row whose query the operator changed from the loaded one. */
const queryEdited = (r: SourceRow, known?: SourcePrivate) =>
  Boolean(r.keep) &&
  typeof r.query === "string" &&
  r.query !== known?.searches.find((s) => s.id === r.id)?.query;
/** A saved repository link whose local path the operator changed from the loaded one. */
const pathEdited = (r: SourceRow, known?: SourcePrivate) =>
  Boolean(r.keep) &&
  typeof r.path === "string" &&
  r.path !==
    known?.repositories.find((x) => x.repositoryId === r.repositoryId)?.path;

export function parseRows(value: Values[string] | undefined): SourceRow[] {
  try {
    const rows = JSON.parse(String(value ?? "[]"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Draft values for the GitHub source form from the saved read. `incomplete` is true when a
 * saved selection or link cannot be named, so an in-place save could not keep it.
 */
export function sourceRowsFrom(source: Source) {
  return {
    selections: source.selections.map((s) => ({
      id: s.id ?? "",
      kind: s.kind,
      descriptor: s.descriptor ?? "",
      active: s.active,
      keep: true,
    })),
    // `savedRef` remembers the loaded ref, so adoption can tell an edited ref from a stale one.
    repositories: source.repositories.map((r) => ({
      repositoryId: r.repositoryId ?? "",
      ref: r.ref ?? "",
      savedRef: r.ref ?? "",
      keep: true,
    })),
    // No rule and an unavailable rule both load no condition; nothing is prefilled.
    conditions:
      source.readiness.kind === "rule"
        ? source.readiness.conditions.map((c) => ({ ...c }))
        : [],
    mode: source.readiness.kind === "rule" ? source.readiness.mode : "all",
    closedIssues: source.closedIssues,
    incomplete:
      source.selections.some((s) => s.id === null) ||
      source.repositories.some(
        (r) => r.repositoryId === null || r.ref === null,
      ),
  };
}

/** The next free `S-<n>` above every saved or drafted id, so no removed id is reused. */
export function nextSelectionId(saved: string[], drafted: string[]) {
  const highest = Math.max(
    0,
    ...[...saved, ...drafted].map((id) =>
      Number(/^S-(\d+)$/.exec(id)?.[1] ?? 0),
    ),
  );
  return `S-${highest + 1}`;
}

const strip = ({ rowKey: _rowKey, ...row }: SourceRow) => row;
const live = (rows: SourceRow[]) => rows.filter((r) => !r.removed);

/** Whether the draft removes every saved repository link. */
export function removesAllAccess(source: Source, v: Values) {
  return (
    source.repositories.length > 0 &&
    live(parseRows(v.repositories)).length === 0
  );
}

function newSelectionLine(r: SourceRow) {
  const what =
    r.kind === "repository"
      ? `Repository ${r.owner}/${r.name}`
      : r.kind === "project"
        ? `GitHub Project ${r.projectNodeId} · filter private`
        : "Search";
  return `+ ${r.id} · ${what} · added inactive`;
}

/** The drafted rule; no condition rows is no readiness rule, sent as `null`. */
const draftedRule = (v: Values) => {
  const conditions = parseRows(v.conditions).map(strip);
  return conditions.length ? { mode: v.mode, conditions } : null;
};

export function sourceChanges(
  source: Source,
  v: Values,
  known?: SourcePrivate,
) {
  const lines: string[] = [];
  const selections = parseRows(v.selections),
    repositories = parseRows(v.repositories),
    conditions = parseRows(v.conditions);
  for (const r of selections)
    if (r.keep && r.removed)
      lines.push(
        `− ${r.id} · ${kindLabel(r.kind)}${r.descriptor ? ` ${r.descriptor}` : ""}`,
      );
    else if (!r.keep && !r.removed) lines.push(newSelectionLine(r));
    else if (!r.removed && queryEdited(r, known))
      lines.push(`Search query edited for ${r.id}`);
  // Saved rows the form does not hold (saved elsewhere since it loaded) are removed by a save.
  for (const s of source.selections)
    if (s.id !== null && !selections.some((r) => r.id === s.id))
      lines.push(
        `− ${s.id} · ${kindLabel(s.kind)} (saved since this form loaded)`,
      );
  const saved = source.readiness;
  const unavailable = saved.kind === "unavailable";
  if (
    unavailable ||
    JSON.stringify(draftedRule(v)) !==
      JSON.stringify(
        saved.kind === "rule"
          ? { mode: saved.mode, conditions: saved.conditions }
          : null,
      )
  )
    lines.push(
      `Readiness: ${conditions.length ? `${v.mode === "any" ? "any" : "all"} of ${plural(conditions.length, "condition")}` : "no readiness rule"}${unavailable ? " (replaces unavailable readiness)" : ""}`,
    );
  // A draft without the field keeps the saved mode.
  if (v.closedIssues !== undefined && v.closedIssues !== source.closedIssues)
    lines.push(`Closed issues: ${closedIssueLabels[String(v.closedIssues)]}`);
  for (const r of repositories) {
    if (r.keep && r.removed)
      lines.push(`− Repository access: ${r.repositoryId}`);
    else if (!r.keep && !r.removed)
      lines.push(`+ Repository access: ${r.repositoryId} · ${r.ref}`);
    else if (r.keep) {
      const saved = source.repositories.find(
        (s) => s.repositoryId === r.repositoryId,
      );
      if (saved && saved.ref !== r.ref)
        lines.push(`Ref for ${r.repositoryId}: ${saved.ref} → ${r.ref}`);
      if (pathEdited(r, known))
        lines.push(`Local path changed for ${r.repositoryId}`);
    }
  }
  for (const s of source.repositories)
    if (
      s.repositoryId !== null &&
      !repositories.some((r) => r.repositoryId === s.repositoryId)
    )
      lines.push(
        `− Repository access: ${s.repositoryId} (saved since this form loaded)`,
      );
  return [
    ...lines,
    ...(v.referenceMode === "gh"
      ? ["Credential reference: use GitHub CLI login"]
      : referenceChange(v)),
  ];
}

/**
 * Kept rows that are no longer saved (removed elsewhere). A save cannot keep them, so the
 * form blocks Save until the latest revision is reviewed.
 */
export function staleSourceRows(source: Source, v: Values) {
  return [
    ...parseRows(v.selections).filter(
      (r) =>
        r.keep && !r.removed && !source.selections.some((s) => s.id === r.id),
    ),
    ...parseRows(v.repositories).filter(
      (r) =>
        r.keep &&
        !r.removed &&
        !source.repositories.some((s) => s.repositoryId === r.repositoryId),
    ),
  ].map((r) => String(r.id ?? r.repositoryId));
}

/**
 * Rows for a newly adopted revision. Kept rows take the latest saved definition (and the
 * latest ref unless the operator edited it); rows saved elsewhere join as kept rows; kept
 * rows removed elsewhere are dropped; a new selection whose id was saved elsewhere takes the
 * next free id. A new repository link whose id was saved elsewhere stays beside the saved
 * link, and `duplicateSourceIds` blocks Save until the operator removes one of them.
 */
export function adoptSourceRows(source: Source, v: Values) {
  const loaded = sourceRowsFrom(source);
  const merge = (
    draft: SourceRow[],
    saved: SourceRow[],
    id: (r: SourceRow) => unknown,
    refresh: (draft: SourceRow, saved: SourceRow) => SourceRow,
  ) => [
    ...draft.flatMap((r) => {
      if (!r.keep) return [r];
      const latest = saved.find((s) => id(s) === id(r));
      return latest ? [refresh(r, latest)] : [];
    }),
    ...saved
      .filter((s) => !draft.some((r) => r.keep && id(r) === id(s)))
      .map((s) => ({ ...s, rowKey: crypto.randomUUID() })),
  ];
  const saved = source.selections.flatMap((x) => (x.id ? [x.id] : []));
  const taken = parseRows(v.selections).map((x) => String(x.id));
  const selections = parseRows(v.selections).map((r) => {
    if (r.keep || !saved.includes(String(r.id))) return r;
    const id = nextSelectionId(saved, taken);
    taken.push(id);
    return { ...r, id };
  });
  // Kept links the operator edited but that were removed elsewhere; adoption drops them.
  const dropped = parseRows(v.repositories)
    .filter(
      (r) =>
        r.keep &&
        !r.removed &&
        (r.ref !== r.savedRef || typeof r.path === "string") &&
        !loaded.repositories.some((s) => s.repositoryId === r.repositoryId),
    )
    .map((r) => String(r.repositoryId));
  // Saved search queries the operator edited but that were removed elsewhere.
  const droppedQueries = parseRows(v.selections)
    .filter(
      (r) =>
        r.keep &&
        !r.removed &&
        typeof r.query === "string" &&
        !loaded.selections.some((s) => s.id === r.id),
    )
    .map((r) => String(r.id));
  return {
    dropped: [...droppedQueries, ...dropped],
    selections: JSON.stringify(
      merge(
        selections,
        loaded.selections,
        (r) => r.id,
        (r, latest) => ({
          ...latest,
          rowKey: r.rowKey ?? crypto.randomUUID(),
          ...(r.removed ? { removed: true } : {}),
          // An edited query stays until the operator saves or discards it, with its baseline.
          ...(typeof r.query === "string"
            ? { query: r.query, queryBase: String(r.queryBase ?? "") }
            : {}),
        }),
      ),
    ),
    repositories: JSON.stringify(
      merge(
        parseRows(v.repositories),
        loaded.repositories,
        (r) => r.repositoryId,
        (r, latest) => ({
          ...r,
          ref: String(r.ref === r.savedRef ? latest.ref : r.ref),
          savedRef: String(latest.ref),
        }),
      ),
    ),
  };
}

/** Selection or repository ids held by more than one live row; Save is blocked until one goes. */
export function duplicateSourceIds(v: Values) {
  const ids = (rows: SourceRow[], id: (r: SourceRow) => unknown) =>
    rows
      .filter((r) => !r.removed)
      .map((r) => String(id(r)))
      .filter((x, i, all) => x !== "" && all.indexOf(x) !== i);
  return [
    ...new Set([
      ...ids(parseRows(v.selections), (r) => r.id),
      ...ids(parseRows(v.repositories), (r) => r.repositoryId),
    ]),
  ];
}

export const kindLabel = (kind: unknown) =>
  kind === "repository"
    ? "Repository"
    : kind === "project"
      ? "GitHub Project"
      : "Search";

export const closedIssueLabels: Record<string, string> = {
  skip: "Skip closed issues",
  done: "Treat closure as Done",
};

export function sourceCommand(
  projectId: string,
  v: Values,
  known?: SourcePrivate,
) {
  return {
    type: "github.configure",
    key: v.key,
    projectId,
    expectedVersion: Number(v.expectedVersion),
    selections: live(parseRows(v.selections)).map((r) => {
      if (r.keep)
        return queryEdited(r, known)
          ? { id: r.id, kind: "search", query: r.query }
          : { id: r.id, keep: true };
      const { rowKey: _k, ...row } = r;
      return row;
    }),
    readiness: draftedRule(v),
    closedIssues: v.closedIssues,
    repositories: live(parseRows(v.repositories)).map((r) =>
      r.keep
        ? {
            repositoryId: r.repositoryId,
            ref: r.ref,
            ...(pathEdited(r, known) ? { path: r.path } : {}),
          }
        : { repositoryId: r.repositoryId, path: r.path, ref: r.ref },
    ),
    ...(v.referenceMode === "gh"
      ? { credentialRef: "gh:github.com" }
      : reference(v)),
  };
}

export function capacityChanges(data: RuntimeSettingsData, v: Values) {
  const lines: string[] = [];
  if (v.globalLimit !== undefined && Number(v.globalLimit) !== data.globalLimit)
    lines.push(
      `Global active-turn cap: ${data.globalLimit} → ${v.globalLimit}`,
    );
  for (const r of data.projects) {
    const name = r.project.name ?? "Project";
    const set = Boolean(v[`override-${r.project.id}`]),
      limit = Number(v[`limit-${r.project.id}`]);
    if (set && r.override === null)
      lines.push(`${name}: override set to ${limit}`);
    else if (!set && r.override !== null)
      lines.push(`${name}: override cleared`);
    else if (set && r.override !== limit)
      lines.push(`${name} override: ${r.override} → ${limit}`);
  }
  return lines;
}
