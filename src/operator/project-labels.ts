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

/**
 * Tells projects that share a name apart, derived from the current workspace read on every
 * call; nothing is stored. Compute it over all projects, never a filtered subset, so a
 * project reads the same on every surface.
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
  for (const group of groups.values()) {
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
    for (const project of group) {
      const lead = leadOf(project);
      const suffix =
        group.length === 1
          ? null
          : lead !== null && leadCounts.get(projectNameKey(lead)) === 1
            ? ({ kind: "lead", text: lead } as const)
            : // shortcut: id prefix collision is ~2^-32, widen to 12 chars if ever observed
              ({ kind: "id", text: project.id.slice(0, 8) } as const);
      labels.set(project.id, {
        name: project.name,
        suffix,
        text: `${project.name ?? unavailable}${suffix ? ` · ${suffix.text}` : ""}`,
      });
    }
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
