import type {
  InboxItem,
  QuestionRead,
  TaskListSummary,
  Workspace,
} from "../../src/operator/contracts.js";
import {
  projectLabel,
  projectLabels,
} from "../../src/operator/project-labels.js";
import { inboxSummaryOf } from "./request-presentation.js";
import {
  columnCounts,
  columns,
  isActiveColumn,
  isUncertain,
  taskColumn,
  taskReasons,
} from "./tasks.js";

/**
 * The Overview stat strip, installation-wide (the Project filter does not apply). A figure the
 * reads cannot support is null and shows as "—": Needs you without a complete, current whole-Inbox
 * read, the task figures before the task list loads, Running turns with no task to carry capacity.
 */
export function overviewStats(
  tasks: readonly TaskListSummary[] | undefined,
  requests: Parameters<typeof inboxSummaryOf>[0],
) {
  const active = tasks?.filter((t) => isActiveColumn(taskColumn(t))),
    capacity = tasks?.[0]?.capacity;
  return {
    needsYou: inboxSummaryOf(requests)?.count ?? null,
    uncertain: active ? active.filter(isUncertain).length : null,
    active: active ? active.length : null,
    running: capacity
      ? { used: capacity.globalUsage, limit: capacity.globalLimit }
      : null,
  };
}

/**
 * Inbox order (interventions first, then oldest) with interventions on an uncertain execution ahead
 * of other interventions. A task the list does not hold counts as not uncertain.
 */
export function orderAttention(
  items: readonly InboxItem[],
  tasks: readonly TaskListSummary[] | undefined,
) {
  const uncertain = new Set(tasks?.filter(isUncertain).map((t) => t.id));
  const rank = (item: InboxItem) =>
    item.kind !== "intervention" ? 2 : uncertain.has(item.taskId) ? 0 : 1;
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.createdAt ?? Number.MAX_SAFE_INTEGER) -
        (b.createdAt ?? Number.MAX_SAFE_INTEGER),
  );
}

export const requestPlace = (item: InboxItem) =>
  `${item.projectName ?? "Unavailable project"} / ${item.taskTitle ?? "Unavailable task"}`;

/** The dashed row after the cards: how many requests remain and the first two by name. */
export function furtherRequests(items: readonly InboxItem[], shown: number) {
  if (items.length <= shown) return null;
  const rest = items.slice(shown);
  return { count: rest.length, names: rest.slice(0, 2).map(requestPlace) };
}

/** An intervention card's evidence: recorded list facts only, never an invented observation. */
export function interventionEvidence(task: TaskListSummary) {
  return {
    lead: task.lead
      ? `${task.lead.name ?? "Name unavailable"} · lead`
      : "No lead configured",
    reasons: taskReasons(task),
    ownershipHeld: isUncertain(task),
  };
}

const activityOrder = [
  "Uncertain",
  ...columns.filter((c) => c !== "Uncertain"),
] as const;

/** Projects panel rows: lead, active work by state (uncertain first) and imported task count. */
export function projectRows(
  workspace: Workspace["data"] | null | undefined,
  tasks: readonly TaskListSummary[] | undefined,
) {
  const labels = projectLabels(
    workspace?.projects ?? [],
    workspace?.profiles ?? [],
  );
  return (workspace?.projects ?? []).map((project) => {
    const own = tasks?.filter((t) => t.projectId === project.id) ?? [],
      counts = columnCounts(own.filter((t) => isActiveColumn(taskColumn(t))));
    return {
      id: project.id,
      label: projectLabel(labels, project.id, project.name),
      paused: project.paused,
      lead: project.leadProfileId
        ? (workspace?.profiles.find((p) => p.id === project.leadProfileId)
            ?.name ?? "Name unavailable")
        : null,
      activity: activityOrder
        .filter((c) => counts[c])
        .map((c) => `${counts[c]} ${c.toLowerCase()}`),
      imported: own.filter((t) => t.source).length,
    };
  });
}

/** Completed work: how many Done tasks (in the filtered project) and the first three to open. */
export function completedWork(
  tasks: readonly TaskListSummary[],
  project: string,
) {
  const done = tasks.filter(
    (t) => taskColumn(t) === "Done" && (!project || t.projectId === project),
  );
  return { count: done.length, tasks: done.slice(0, 3) };
}

/** Only a pending request with one single-choice question is answered in its Overview card. */
export function inlineAnswerable(read: QuestionRead["data"]) {
  const questions = read.form?.questions ?? [];
  return (
    read.status === "pending" &&
    questions.length === 1 &&
    questions[0]?.kind === "single-choice"
  );
}
