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
