import { projectNameKey } from "../core/project-names.js";
import type { Workspace } from "./contracts.js";

export interface ProjectLabel {
  name: string | null;
  /** Set only where projects share a name: the lead's name, else the ID's first characters. */
  suffix: { kind: "lead" | "id"; text: string } | null;
  /** Name and suffix as one string, for options and accessible names. */
  text: string;
}

const unavailable = "Name unavailable";

/** ID prefix lengths tried in order; the full ID is the last rung. */
const idRungs = [8, 12, 16, 20, 24, 28, 32] as const;

/**
 * Tells projects that share a name apart, derived from the current workspace read on every
 * call; nothing is stored. Compute it over all projects, never a filtered subset, so a
 * project reads the same on every surface.
 *
 * Invariant: within a group of projects whose names match (ignoring case, spacing and Unicode
 * composition) every label is distinct under that same comparison, and a unique name has no
 * suffix. A lead's name is the suffix when it is unique in the group; every other project
 * gets an ID prefix, and the prefix grows by rungs until the whole group is distinct (a lead
 * named like another project's ID prefix included), ending at the full ID.
 */
export function projectLabels(
  projects: readonly {
    id: string;
    name: string | null;
    leadProfileId: string | null;
  }[],
  profiles: readonly { id: string; name: string | null }[],
): Map<string, ProjectLabel> {
  const groups = new Map<string | null, typeof projects>();
  for (const project of projects) {
    const key = project.name === null ? null : projectNameKey(project.name);
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  const labels = new Map<string, ProjectLabel>();
  for (const members of groups.values()) {
    const group = [...members].sort((a, b) => (a.id < b.id ? -1 : 1));
    const leadOf = (project: (typeof projects)[number]) =>
      profiles.find((p) => p.id === project.leadProfileId)?.name ?? null;
    const leadCounts = new Map<string, number>();
    for (const project of group) {
      const lead = leadOf(project);
      if (lead !== null)
        leadCounts.set(
          projectNameKey(lead),
          (leadCounts.get(projectNameKey(lead)) ?? 0) + 1,
        );
    }
    const build = (idLength: number, leads = true) =>
      group.map((project): ProjectLabel => {
        const lead = leadOf(project);
        const suffix: ProjectLabel["suffix"] =
          group.length === 1
            ? null
            : leads &&
                lead !== null &&
                leadCounts.get(projectNameKey(lead)) === 1
              ? { kind: "lead", text: lead }
              : { kind: "id", text: project.id.slice(0, idLength) };
        return {
          name: project.name,
          suffix,
          text: `${project.name ?? unavailable}${suffix ? ` · ${suffix.text}` : ""}`,
        };
      });
    const distinct = (built: ProjectLabel[]) =>
      new Set(built.map((label) => projectNameKey(label.text))).size ===
      built.length;
    const maxLength = Math.max(...group.map((project) => project.id.length));
    // Last resort, only for a lead named exactly like another project's full ID: IDs alone.
    const built =
      [...idRungs, maxLength].map((length) => build(length)).find(distinct) ??
      build(maxLength, false);
    group.forEach((project, index) => {
      labels.set(project.id, built[index] as ProjectLabel);
    });
  }
  return labels;
}

/** The labels for a workspace read; empty before the first read. */
export function workspaceLabels(workspace: Workspace | null | undefined) {
  return projectLabels(
    workspace?.data.projects ?? [],
    workspace?.data.profiles ?? [],
  );
}

/** A project's label, or its bare name when the workspace read does not list it. */
export function projectLabel(
  labels: ReadonlyMap<string, ProjectLabel>,
  id: string,
  name: string | null,
): ProjectLabel {
  return labels.get(id) ?? { name, suffix: null, text: name ?? unavailable };
}
