/** Pure rules for the readiness Project-field picker; no React. */

import type { z } from "zod";
import type {
  discoveryProjectFieldsSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
} from "../../src/operator/contracts.js";
import { discoveryReasonCopy, typedRepositoryId } from "./setup-model.js";

type Data<T extends z.ZodType> =
  z.infer<T> extends { data: infer D } ? D : never;
/** A discovery read; `undefined` while it is pending. */
export type RepositoriesRead = Data<typeof discoveryRepositoriesSchema>;
export type ProjectsRead = Data<typeof discoveryProjectsSchema>;
export type FieldsRead = Data<typeof discoveryProjectFieldsSchema>;
type ReadyFields = Extract<FieldsRead, { state: "ready" }>["fields"];

export interface ProjectChoice {
  projectNodeId: string;
  /** The title, with owner and number added when another listed Project shares it. */
  label: string;
}
export type ConditionIds = {
  projectNodeId: string;
  fieldNodeId: string;
  optionNodeId: string;
};
/** `loading` waits on a read; `typed` falls back to node-ID inputs with a note, if any. */
export type PickerState =
  | { state: "loading"; projects?: ProjectChoice[] }
  | { state: "typed"; note: string }
  | { state: "picker"; projects: ProjectChoice[]; fields: ReadyFields };

const typeIds = " Type the node IDs.";
const unavailableNote = (
  read: Extract<
    RepositoriesRead | ProjectsRead | FieldsRead,
    { state: "unavailable" }
  >,
) =>
  (read.reason === "unconfigured"
    ? "GitHub discovery is unavailable: no discovery credential is configured, so Projects and fields can't be listed."
    : discoveryReasonCopy(read.reason)) + typeIds;
const truncatedNote =
  "GitHub discovery is unavailable: there are too many results to list in full." +
  typeIds;
const noProjectNote =
  "No GitHub Project is linked to a repository of this source, so none can be listed." +
  typeIds;
const unlistedNote =
  "These IDs are not in the discovered lists, so they stay as typed node IDs.";

/** `owner/name` of each saved link discovery can resolve: by node ID, typed id or `owner/name`. */
export function linkedRepositoryNames(
  saved: { repositoryId: string }[],
  repositories: Extract<RepositoriesRead, { state: "ready" }>["repositories"],
) {
  const names = new Set<string>();
  for (const { repositoryId } of saved) {
    const wanted = repositoryId.toLowerCase();
    const match = repositories.find(
      (r) =>
        r.repositoryId === repositoryId ||
        typedRepositoryId(r.owner, r.name) === wanted ||
        `${r.owner}/${r.name}`.toLowerCase() === wanted,
    );
    if (match) names.add(`${match.owner}/${match.name}`);
  }
  return [...names];
}

/** The linked Projects, or why the picker cannot list them. */
export function projectChoices(
  repositories: RepositoriesRead | undefined,
  saved: { repositoryId: string }[],
  projectReads: Record<string, ProjectsRead | undefined>,
):
  | { state: "loading" }
  | { state: "typed"; note: string }
  | { state: "ready"; projects: ProjectChoice[] } {
  if (!repositories) return { state: "loading" };
  if (repositories.state === "unavailable")
    return { state: "typed", note: unavailableNote(repositories) };
  if (repositories.truncated) return { state: "typed", note: truncatedNote };
  const found = new Map<
    string,
    { title: string; owner: string; number: number }
  >();
  const names = linkedRepositoryNames(saved, repositories.repositories);
  for (const name of names) {
    const read = projectReads[name];
    if (!read) return { state: "loading" };
    if (read.state === "unavailable")
      return { state: "typed", note: unavailableNote(read) };
    if (read.truncated) return { state: "typed", note: truncatedNote };
    for (const p of read.linked)
      found.set(p.projectNodeId, {
        title: p.title || "Untitled Project",
        owner: read.ownerLogin,
        number: p.number,
      });
  }
  if (!found.size) return { state: "typed", note: noProjectNote };
  const titles = [...found.values()].map((p) => p.title);
  return {
    state: "ready",
    // An owner and number identify a Project, so they tell apart Projects that share a title.
    projects: [...found].map(([projectNodeId, p]) => ({
      projectNodeId,
      label:
        titles.filter((t) => t === p.title).length > 1
          ? `${p.title} (${p.owner} #${p.number})`
          : p.title,
    })),
  };
}

/** Whether a condition row shows name selects, waits, or keeps typed node IDs. */
export function rowState(
  ids: ConditionIds,
  choices: ReturnType<typeof projectChoices>,
  fieldReads: Record<string, FieldsRead | undefined>,
): PickerState {
  if (choices.state !== "ready") return choices;
  const { projectNodeId, fieldNodeId, optionNodeId } = ids;
  if (!projectNodeId)
    return fieldNodeId || optionNodeId
      ? { state: "typed", note: unlistedNote }
      : { state: "picker", projects: choices.projects, fields: [] };
  if (!choices.projects.some((p) => p.projectNodeId === projectNodeId))
    return { state: "typed", note: unlistedNote };
  const read = fieldReads[projectNodeId];
  // The Project list is known, so its select stays usable while the fields load.
  if (!read) return { state: "loading", projects: choices.projects };
  if (read.state === "unavailable")
    return { state: "typed", note: unavailableNote(read) };
  if (read.truncated) return { state: "typed", note: truncatedNote };
  const field = read.fields.find((f) => f.fieldNodeId === fieldNodeId);
  if (
    (fieldNodeId && !field) ||
    (optionNodeId &&
      !field?.options.some((o) => o.optionNodeId === optionNodeId))
  )
    return { state: "typed", note: unlistedNote };
  return { state: "picker", projects: choices.projects, fields: read.fields };
}

/** Choosing a Project clears field and option; choosing a field clears the option. */
export const selectProject = (projectNodeId: string): ConditionIds => ({
  projectNodeId,
  fieldNodeId: "",
  optionNodeId: "",
});
export const selectField = (
  ids: ConditionIds,
  fieldNodeId: string,
): ConditionIds => ({ ...ids, fieldNodeId, optionNodeId: "" });
