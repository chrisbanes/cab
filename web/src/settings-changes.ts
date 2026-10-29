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

import {
  type ProfileRuntime,
  readinessCommandValue,
} from "../../src/operator/contracts.js";
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
  if (
    v.commandNetworkAccess !== undefined &&
    data.commandNetworkAccess !== undefined &&
    Boolean(v.commandNetworkAccess) !== data.commandNetworkAccess
  )
    lines.push(
      `Command network access ${v.commandNetworkAccess ? "enabled" : "disabled"}`,
    );
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
 * One row of the GitHub source or repository form. A saved row carries no private definition
 * until the operator edits it: `query` (search) and `path` (repository link) then hold the edit.
 */
export type SourceRow = Record<string, string | boolean>;
type Source = ProjectConfigurationData["source"];
type Repositories = ProjectConfigurationData["repositories"];
/** What the session-only read returned for this source version: the baseline of any edit. */
export interface SourcePrivate {
  searches: { id: string; query: string }[];
}
/** What the session-only read returned for this repository-link version. */
export interface RepositoryPrivate {
  links: { repositoryId: string; path: string }[];
}
/** A saved search row whose query the operator changed from the loaded one. */
const queryEdited = (r: SourceRow, known?: SourcePrivate) =>
  Boolean(r.keep) &&
  typeof r.query === "string" &&
  r.query !== known?.searches.find((s) => s.id === r.id)?.query;
/** A saved repository link whose local path the operator changed from the loaded one. */
const pathEdited = (r: SourceRow, known?: RepositoryPrivate) =>
  Boolean(r.keep) &&
  typeof r.path === "string" &&
  r.path !== known?.links.find((x) => x.repositoryId === r.repositoryId)?.path;

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
    // No rule and an unavailable rule both load no condition; nothing is prefilled.
    conditions: (readinessCommandValue(source.readiness)?.conditions ?? []).map(
      (c) => ({ ...c }),
    ),
    mode: source.readiness.kind === "rule" ? source.readiness.mode : "all",
    closedIssues: source.closedIssues,
    incomplete: source.selections.some((s) => s.id === null),
  };
}

/**
 * Draft values for the repository form from the saved read. `incomplete` is true when a
 * saved link cannot be named, so an in-place save could not keep it.
 */
export function repositoryRowsFrom(saved: Repositories) {
  return {
    // `savedRef` remembers the loaded ref, so adoption can tell an edited ref from a stale one.
    repositories: saved.links.map((r) => ({
      codeHost: r.codeHost,
      host: r.host,
      repositoryId: r.repositoryId ?? "",
      ref: r.ref ?? "",
      savedRef: r.ref ?? "",
      keep: true,
    })),
    incomplete: saved.links.some(
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
export function removesAllAccess(saved: Repositories, v: Values) {
  return saved.links.length > 0 && live(parseRows(v.repositories)).length === 0;
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
      JSON.stringify(readinessCommandValue(saved))
  )
    lines.push(
      `Readiness: ${conditions.length ? `${v.mode === "any" ? "any" : "all"} of ${plural(conditions.length, "condition")}` : "no readiness rule"}${unavailable ? " (replaces unavailable readiness)" : ""}`,
    );
  // A draft without the field keeps the saved mode.
  if (v.closedIssues !== undefined && v.closedIssues !== source.closedIssues)
    lines.push(`Closed issues: ${closedIssueLabels[String(v.closedIssues)]}`);
  return [
    ...lines,
    ...(v.referenceMode === "gh"
      ? ["Credential reference: use GitHub CLI login"]
      : referenceChange(v)),
  ];
}

export function repositoryChanges(
  saved: Repositories,
  v: Values,
  known?: RepositoryPrivate,
) {
  const lines: string[] = [];
  const repositories = parseRows(v.repositories);
  for (const r of repositories) {
    if (r.keep && r.removed)
      lines.push(`− Repository access: ${r.repositoryId}`);
    else if (!r.keep && !r.removed)
      lines.push(`+ Repository access: ${r.repositoryId} · ${r.ref}`);
    else if (r.keep) {
      const current = saved.links.find(
        (s) => s.repositoryId === r.repositoryId,
      );
      if (current && current.ref !== r.ref)
        lines.push(`Ref for ${r.repositoryId}: ${current.ref} → ${r.ref}`);
      if (pathEdited(r, known))
        lines.push(`Local path changed for ${r.repositoryId}`);
    }
  }
  for (const s of saved.links)
    if (
      s.repositoryId !== null &&
      !repositories.some((r) => r.repositoryId === s.repositoryId)
    )
      lines.push(
        `− Repository access: ${s.repositoryId} (saved since this form loaded)`,
      );
  return lines;
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
  ].map((r) => String(r.id));
}

/** Kept links that are no longer saved (removed elsewhere); Save is blocked until reviewed. */
export function staleRepositoryRows(saved: Repositories, v: Values) {
  return parseRows(v.repositories)
    .filter(
      (r) =>
        r.keep &&
        !r.removed &&
        !saved.links.some((s) => s.repositoryId === r.repositoryId),
    )
    .map((r) => String(r.repositoryId));
}

/**
 * Merges the draft rows with the latest saved rows: kept rows take the latest saved
 * definition, rows saved elsewhere join as kept rows, and kept rows removed elsewhere drop.
 */
const mergeRows = (
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

/**
 * Rows for a newly adopted revision. Kept rows take the latest saved definition; rows saved
 * elsewhere join as kept rows; kept rows removed elsewhere are dropped; a new selection whose
 * id was saved elsewhere takes the next free id.
 */
export function adoptSourceRows(source: Source, v: Values) {
  const loaded = sourceRowsFrom(source);
  const saved = source.selections.flatMap((x) => (x.id ? [x.id] : []));
  const taken = parseRows(v.selections).map((x) => String(x.id));
  const selections = parseRows(v.selections).map((r) => {
    if (r.keep || !saved.includes(String(r.id))) return r;
    const id = nextSelectionId(saved, taken);
    taken.push(id);
    return { ...r, id };
  });
  // Saved sources the operator edited or marked for removal that were removed elsewhere, or
  // replaced by a source of another kind under the same id: the edit does not fit the new
  // source, so it is dropped rather than carried onto it.
  const droppedSelections = parseRows(v.selections)
    .filter((r) => {
      if (!r.keep) return false;
      const latest = loaded.selections.find((s) => s.id === r.id);
      return latest
        ? (latest.kind !== r.kind || latest.descriptor !== r.descriptor) &&
            (Boolean(r.removed) || typeof r.query === "string")
        : !r.removed && typeof r.query === "string";
    })
    .map((r) => String(r.id));
  return {
    dropped: droppedSelections,
    selections: JSON.stringify(
      mergeRows(
        selections,
        loaded.selections,
        (r) => r.id,
        (r, latest) =>
          latest.kind !== r.kind || latest.descriptor !== r.descriptor
            ? { ...latest, rowKey: r.rowKey ?? crypto.randomUUID() }
            : {
                ...latest,
                rowKey: r.rowKey ?? crypto.randomUUID(),
                ...(r.removed ? { removed: true } : {}),
                // An edited query stays until the operator saves or discards it, with its baseline.
                ...(typeof r.query === "string"
                  ? { query: r.query, queryBase: String(r.queryBase ?? "") }
                  : {}),
              },
      ),
    ),
  };
}

/**
 * Rows for a newly adopted link revision. A new link whose id was saved elsewhere stays
 * beside the saved link, and `duplicateRepositoryIds` blocks Save until one is removed.
 */
export function adoptRepositoryRows(saved: Repositories, v: Values) {
  const loaded = repositoryRowsFrom(saved);
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
  return {
    dropped,
    repositories: JSON.stringify(
      mergeRows(
        parseRows(v.repositories),
        loaded.repositories,
        (r) => r.repositoryId,
        (r, latest) => ({
          ...r,
          codeHost: String(latest.codeHost),
          host: String(latest.host),
          ref: String(r.ref === r.savedRef ? latest.ref : r.ref),
          savedRef: String(latest.ref),
        }),
      ),
    ),
  };
}

/** Selection ids held by more than one live row; Save is blocked until one goes. */
export function duplicateSourceIds(v: Values) {
  return duplicateIds(parseRows(v.selections), (r) => r.id);
}

/** Repository ids held by more than one live row; Save is blocked until one goes. */
export function duplicateRepositoryIds(v: Values) {
  return duplicateIds(parseRows(v.repositories), (r) => r.repositoryId);
}

const duplicateIds = (rows: SourceRow[], id: (r: SourceRow) => unknown) => [
  ...new Set(
    rows
      .filter((r) => !r.removed)
      .map((r) => String(id(r)))
      .filter((x, i, all) => x !== "" && all.indexOf(x) !== i),
  ),
];

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
    ...(v.referenceMode === "gh"
      ? { credentialRef: "gh:github.com" }
      : reference(v)),
  };
}

export function repositoryCommand(
  projectId: string,
  v: Values,
  known?: RepositoryPrivate,
) {
  return {
    type: "repositories.configure",
    key: v.key,
    projectId,
    expectedVersion: Number(v.expectedVersion),
    // A saved row keeps its code host and host; a row added in the form is GitHub.
    repositories: live(parseRows(v.repositories)).map((r) => ({
      codeHost: r.codeHost ?? "github",
      host: r.host ?? "github.com",
      repositoryId: r.repositoryId,
      ref: r.ref,
      ...(r.keep
        ? pathEdited(r, known)
          ? { path: r.path }
          : {}
        : { path: r.path }),
    })),
  };
}

export function capacityChanges(
  data: RuntimeSettingsData,
  v: Values,
  /** The project's displayed label, which tells same-named projects apart. */
  labelOf: (r: RuntimeSettingsData["projects"][number]) => string = (r) =>
    r.project.name ?? "Project",
) {
  const lines: string[] = [];
  if (v.globalLimit !== undefined && Number(v.globalLimit) !== data.globalLimit)
    lines.push(
      `Global active-turn cap: ${data.globalLimit} → ${v.globalLimit}`,
    );
  for (const r of data.projects) {
    const name = labelOf(r);
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
