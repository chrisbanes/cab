import type { TaskRead } from "../../src/operator/contracts.js";
import { unmetText } from "../../src/operator/readiness-text.js";
import { waitLabels } from "../../src/operator/wait-reasons.js";
import { executionSummary } from "./execution-runtime.js";
import { nextActor, type TaskColumn } from "./tasks.js";

type Data = TaskRead["data"];
type Source = NonNullable<Data["review"]>["sources"][number];
type Assignment = Data["assignments"][number];

export const criterionLabel = (index: number) => `C${index + 1}`;

/**
 * The supplied brief split into prose and its retained checklist criteria. Only lines
 * recorded as criteria (by `position`) leave the prose; omitted overflow stays literal.
 */
export function briefParts(
  source: Pick<Source, "body" | "criteria" | "criteriaOmittedCount">,
) {
  const criteria = source.criteria.map((c, i) => ({
    label: criterionLabel(i),
    criterionId: c.criterionId,
    text: c.text,
  }));
  // Unknown coverage: no retained body, or an unknown count of omitted checklist lines.
  const known = source.body !== null && source.criteriaOmittedCount !== null;
  if (source.body === null) return { prose: "", criteria, known };
  const dropped = new Set(source.criteria.map((c) => c.position));
  const prose = source.body
    .split("\n")
    .filter((_, i) => !dropped.has(i))
    .join("\n")
    .replace(/\n\s*\n(\s*\n)+/g, "\n\n")
    .trim();
  return { prose, criteria, known };
}

const outcomeWords = {
  supported: "Supported by recorded evidence",
  failed: "Failed recorded check",
  unverified: "Unverified",
} as const;

/** One row per supplied criterion with the result's recorded outcome; never an overall pass. */
export function criterionRows(
  data: Pick<Data, "review">,
  resultId: string,
  sourceId: string | undefined,
) {
  const metadata = data.review?.results.find(
      (r) => r.resultId === resultId,
    )?.metadata,
    source = data.review?.sources.find((s) => s.sourceId === sourceId),
    latest = data.review?.sources.at(-1);
  if (!metadata || !source) return [];
  return source.criteria.map((c, i) => {
    const records = metadata.criteria.filter(
      (x) => x.criterionId === c.criterionId,
    );
    const record = records.length === 1 ? records[0] : undefined;
    return {
      label: criterionLabel(i),
      criterionId: c.criterionId,
      text: c.text,
      position: c.position,
      revision: source.revision,
      status:
        records.length > 1
          ? "Unknown"
          : outcomeWords[record?.outcome ?? "unverified"],
      record,
      records,
      stale: latest?.sourceId !== source.sourceId,
    };
  });
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

type StatusData = Pick<
  Data,
  "task" | "execution" | "admission" | "waits" | "source" | "lead"
>;

/**
 * The recorded state and wait, as the strip's readiness text. Execution facts take the
 * service's precedence (Stop, uncertain, active) over the task's terminal state, as the
 * Board columns do.
 */
export function taskReadiness(data: Omit<StatusData, "lead">) {
  const { task, execution } = data;
  // The first wait in the flow's order is the one the header names.
  const reason = data.waits[0]?.code;
  const blocker =
    reason === "imported-blockers-blocked"
      ? data.source?.nativeBlockers.find((b) => b.state === "open")
      : undefined;
  const terminal =
    task.state === "done"
      ? "Done"
      : task.state === "cancelled"
        ? "Cancelled"
        : null;
  const active =
    execution.state === "running" || execution.state === "starting";
  const unmet = unmetText(data.source?.readiness);
  // The Board puts a paused project's tasks under Paused before Draft or Ready.
  const paused =
    execution.state === "paused" ||
    data.admission.reasons.includes("project-paused");
  return execution.holds.stop || execution.state === "stopping"
    ? "Stopping; effects may continue"
    : execution.holds.uncertainty || execution.state === "uncertain"
      ? "Execution uncertain"
      : terminal
        ? active
          ? `${terminal} · ${execution.state}`
          : data.source?.closure === "completed"
            ? `${terminal} · closed on GitHub`
            : terminal
        : data.source?.closure === "held"
          ? `Held · closed on GitHub${active ? ` · ${execution.state}` : ""}`
          : paused
            ? `${task.ready ? "Ready" : "Draft"} · project paused`
            : !task.ready
              ? unmet
                ? `Draft · ${unmet}`
                : "Draft"
              : blocker
                ? `Ready · waiting on ${blocker.repositoryName}#${blocker.number}`
                : reason
                  ? `Ready · ${lowerFirst(waitLabels[reason])}`
                  : execution.state === "idle"
                    ? "Ready"
                    : `Ready · ${execution.state}`;
}

/** The readiness text, then the accountable lead. */
export function taskStatusLine(data: StatusData) {
  return `${taskReadiness(data)} / Accountable project lead: ${data.lead?.name ?? "Unconfigured"}`;
}

/** The task's Board column from its own read, in `taskColumn`'s precedence. */
export function taskColumnOf(
  data: Pick<Data, "task" | "execution" | "admission" | "source">,
): TaskColumn {
  const { task, execution } = data,
    s = execution.state;
  if (execution.holds.stop || s === "stopping") return "Stopping";
  if (execution.holds.uncertainty || s === "uncertain") return "Uncertain";
  if (s === "running" || s === "starting") return "Running";
  if (task.state === "done") return "Done";
  if (task.state === "cancelled") return "Cancelled";
  if (
    s === "paused" ||
    data.source?.closure === "held" ||
    data.admission.reasons.includes("project-paused")
  )
    return "Paused";
  if (!task.ready) return "Draft";
  if (!data.admission.eligible || s === "waiting" || execution.holds.task)
    return "Waiting";
  return "Ready";
}

/** Who acts next, from the task read's attention codes by the List's rule (`nextActor`). */
export const taskNextActor = (
  data: Pick<Data, "task" | "execution" | "admission" | "source" | "attention">,
) => nextActor(data.attention.codes, taskColumnOf(data));

/** The ID slot: `repository#number` for an imported task, otherwise "Local task". */
export function taskIdentity(data: Pick<Data, "source">) {
  const s = data.source;
  return s
    ? {
        label: `${s.repositoryName ?? "repository unavailable"}#${s.number ?? "?"}`,
        url: s.url,
      }
    : { label: "Local task", url: null };
}

const syncProblems = {
  "sync-unavailable": "sync unavailable",
  "partial-sync": "partial sync",
} as const;

/**
 * The source's issue state, latest successful sync across every selection and any sync
 * failure or incomplete observation (the worst across selections), or null when complete.
 */
export function sourceFacts(source: NonNullable<Data["source"]>) {
  const synced =
    source.memberships
      .map((m) => m.sync.lastSuccessfulAt)
      .filter((t): t is string => t !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1) ?? null;
  const codes = source.memberships.map((m) => m.sync.reasonCode);
  const problem = codes.includes("sync-unavailable")
    ? syncProblems["sync-unavailable"]
    : codes.includes("partial-sync")
      ? syncProblems["partial-sync"]
      : !source.memberships.length ||
          source.memberships.some((m) => m.sync.complete !== true)
        ? "sync incomplete"
        : null;
  return { state: source.state, synced, problem };
}

const deliveryModes = {
  "reviewable-pr": "Reviewable PR",
  "through-merge": "Through merge",
} as const;

/** The inspector's execution facts: running assignments, lead runtime and delivery. */
export function executionFacts(
  data: Pick<Data, "assignments" | "leadAssignmentId" | "delivery">,
) {
  const lead = data.assignments.find(
      (a) => a.assignmentId === data.leadAssignmentId,
    ),
    delivery = data.delivery,
    binding = delivery?.binding;
  return {
    running: data.assignments.filter((a) => a.state === "running").length,
    lead: lead ? executionSummary(lead).line : null,
    delivery: !delivery
      ? "Delivery not recorded"
      : binding
        ? `${deliveryModes[delivery.mode]} · ${binding.repositoryName}#${binding.number} · ${binding.state.toLowerCase()}`
        : `${deliveryModes[delivery.mode]} · no PR yet`,
  };
}

/** Who a Stop affects, for the confirmation's first line. */
export function stopConsequences(
  data: Pick<Data, "lead" | "leadAssignmentId" | "assignments" | "execution">,
) {
  const delegated = data.assignments.filter(
    (a) =>
      a.assignmentId !== data.leadAssignmentId &&
      a.state !== "completed" &&
      a.state !== "cancelled",
  ).length;
  const affected = data.lead
    ? `${data.lead.name ?? "Project lead"} (lead) and ${delegated} delegated ${delegated === 1 ? "assignment is" : "assignments are"} affected.`
    : "This task's assignments are affected.";
  return { affected, held: data.execution.holds.stop };
}

/** A compact delegation row: responsibility, short id, requester → result destination, wait. */
export function assignmentRow(a: Assignment, all: readonly Assignment[]) {
  const name = (id: string) =>
    all.find((x) => x.assignmentId === id)?.name ?? "Assignment";
  const brief = a.brief?.trim().split("\n")[0] ?? "";
  const excerpt = brief.length > 80 ? `${brief.slice(0, 80)}…` : brief;
  return {
    title: [a.name ?? "Assignment", excerpt].filter(Boolean).join(" · "),
    id: a.assignmentId.slice(0, 8),
    flow: `${
      a.requesterAssignmentId === undefined
        ? "Requester unknown"
        : a.requesterAssignmentId === null
          ? "Operator"
          : name(a.requesterAssignmentId)
    } → ${
      a.resultRecipientAssignmentId
        ? name(a.resultRecipientAssignmentId)
        : (a.resultDestination ?? "Destination unknown")
    }`,
    wait: a.waitReason ?? "Waiting reason unknown",
    runtime: executionSummary(a).line,
  };
}

/** The task's source identity and its latest successful sync across every selection. */
export function sourceLine(source: Data["source"]) {
  if (!source) return "Local task";
  const { state, synced } = sourceFacts(source);
  return `GitHub · ${source.repositoryName ?? "repository unavailable"}#${source.number ?? "?"} · ${state ?? "state unknown"} · ${synced ? `last successful sync ${synced}` : "no successful sync"} · read-only requirements`;
}

/** The view a task was opened from, for the header Back label. */
export function originLabel(origin: string) {
  const [pathname, search = ""] = origin.split("?");
  if (pathname === "/app") return "Overview";
  if (pathname === "/app/inbox") return "Inbox";
  if (pathname === "/app/search") return "Search";
  if (pathname === "/app/tasks")
    return new URLSearchParams(search).get("view") === "board"
      ? "Board"
      : "Tasks";
  return null;
}
