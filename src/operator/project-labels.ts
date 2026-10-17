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

type Suffix = NonNullable<ProjectLabel["suffix"]>;

/**
 * Labels that tell projects apart, derived from the current workspace read on every call;
 * nothing is stored. Compute it over all projects, never a filtered subset, so a project
 * reads the same on every surface.
 *
 * Invariant: no two projects in the workspace render the same label under `projectNameKey`,
 * and a name that no other project shares has no suffix. Projects that share a name start
 * with the lead's name (when no other project in the group has that lead name) or the first
 * eight ID characters. Then, in rounds, every label that equals another project's label
 * moves to its next rung: a generated label always moves before a plain name does, because
 * a unique name keeps its plain form unless a generated label at its last rung (the full
 * ID) still equals it. Rungs are the lead name, ID prefixes of growing length, the full ID,
 * and for a plain name only the full ID. Each round moves at least one project one rung
 * and rungs end. When labels still clash and nothing can move (IDs that differ only in
 * letter case fold to the same key), the clashing projects get " #1", " #2" ... by raw
 * code-unit ID order, once each. Every round moves a project to a strictly later rung or
 * numbers it, and both happen finitely often, so it terminates; two labels that end in
 * different full IDs, or in different numbers after the same full ID, never match, so it
 * ends distinct. The result does not depend on input order.
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
  const leadOf = (project: (typeof projects)[number]) =>
    profiles.find((p) => p.id === project.leadProfileId)?.name ?? null;
  type Entry = {
    project: (typeof projects)[number];
    /** Plain name only for a unique name, then the rungs. */
    rungs: (Suffix | null)[];
    level: number;
    /** 1-based place among IDs that still clash at the full-ID rung; 0 until needed. */
    ordinal: number;
    shared: boolean;
  };
  const entries: Entry[] = [];
  for (const members of groups.values()) {
    const group = [...members].sort((a, b) => (a.id < b.id ? -1 : 1));
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
      const ids = [...idRungs, project.id.length]
        .filter((length, index, all) => all.indexOf(length) === index)
        .filter((length) => length <= project.id.length)
        .map(
          (length): Suffix => ({
            kind: "id",
            text: project.id.slice(0, length),
          }),
        );
      const full = ids.slice(-1)[0] as Suffix;
      entries.push({
        project,
        // An unavailable name is generated like a shared one, so a project literally named
        // "Name unavailable" keeps its plain name.
        shared: group.length > 1 || project.name === null,
        level: 0,
        ordinal: 0,
        rungs:
          group.length === 1
            ? [null, ...(project.name === null ? ids : [full])]
            : lead !== null && leadCounts.get(projectNameKey(lead)) === 1
              ? [{ kind: "lead", text: lead }, ...ids]
              : ids,
      });
    }
  }
  const suffixOf = (entry: Entry): Suffix | null => {
    const suffix = entry.rungs[entry.level] ?? null;
    return suffix && entry.ordinal
      ? { kind: "id", text: `${suffix.text} #${entry.ordinal}` }
      : suffix;
  };
  const textOf = (entry: Entry) => {
    const suffix = suffixOf(entry);
    return `${entry.project.name ?? unavailable}${suffix ? ` · ${suffix.text}` : ""}`;
  };
  const canMove = (entry: Entry) =>
    entry.level < entry.rungs.length - 1 && !entry.ordinal;
  for (;;) {
    const byKey = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = projectNameKey(textOf(entry));
      byKey.set(key, [...(byKey.get(key) ?? []), entry]);
    }
    let moved = false;
    for (const clash of byKey.values()) {
      if (clash.length < 2) continue;
      const generated = clash.filter((entry) => entry.shared && canMove(entry));
      const movers = generated.length ? generated : clash.filter(canMove);
      for (const entry of movers) {
        entry.level++;
        moved = true;
      }
      // Last rung: IDs that differ only in letter case still clash under the key, so they
      // are numbered by raw (code unit) ID order.
      if (!movers.length) {
        const unnumbered = clash
          .filter((entry) => !entry.ordinal)
          .sort((a, b) => (a.project.id < b.project.id ? -1 : 1));
        unnumbered.forEach((entry, index) => {
          entry.ordinal = index + 1;
          moved = true;
        });
      }
    }
    if (!moved) break;
  }
  const labels = new Map<string, ProjectLabel>();
  for (const entry of entries)
    labels.set(entry.project.id, {
      name: entry.project.name,
      suffix: suffixOf(entry),
      text: textOf(entry),
    });
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
