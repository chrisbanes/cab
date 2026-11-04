/** Presentation only; the service rechecks lifecycle, drain and confirmation on every write. */
export function projectLifecyclePresentation(archived: boolean) {
  return {
    label: archived ? "Archived" : "Active",
    readOnly: archived,
    notice: archived
      ? "This project is archived. Its tasks and history are available to read. Restore keeps it paused."
      : null,
    rename: true,
    configure: !archived,
    archive: !archived,
    restore: archived,
    deletePreview: archived,
  } as const;
}

/** Project pickers default to live projects; history can explicitly include archived projects. */
export function visibleProjects<T extends { archived: boolean }>(
  projects: readonly T[],
  includeArchived = false,
): readonly T[] {
  return includeArchived
    ? projects
    : projects.filter((project) => !project.archived);
}

export function deletionConfirmationReady(input: {
  archived: boolean;
  projectId: string;
  version: number;
  name: string | null;
  preview: {
    projectId: string;
    version: number;
    name: string | null;
    previewDigest: string;
  } | null;
  typedName: string;
  phase: string;
}) {
  return (
    input.archived &&
    input.preview !== null &&
    input.preview.projectId === input.projectId &&
    input.preview.version === input.version &&
    input.preview.name !== null &&
    input.preview.name === input.name &&
    input.typedName === input.preview.name &&
    ["editing", "editable"].includes(input.phase)
  );
}

/** Direct-ID lifecycle only: filtered lists never establish that a task accepts writes. */
export function taskProjectReadOnly(
  projectId: string | undefined,
  project: { id: string; archived: boolean } | undefined,
): boolean {
  return (
    !projectId ||
    !project ||
    project.id !== projectId ||
    project.archived !== false
  );
}

/** Public consequences have no private item IDs. Combine identical rows without losing their count. */
export function groupProjectConsequences<T>(rows: readonly T[]) {
  const groups = new Map<string, { key: string; row: T; count: number }>();
  for (const row of rows) {
    const key = JSON.stringify(row),
      existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { key, row, count: 1 });
  }
  return [...groups.values()];
}
