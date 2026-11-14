import type {
  SourceHoldReason,
  TaskRead,
} from "../../src/operator/contracts.js";
import { unmetText } from "../../src/operator/readiness-text.js";
import {
  type ClosureWait,
  closureWaitText,
} from "../../src/operator/closed-issue-copy.js";
import { type WaitCode, waitLabels } from "../../src/operator/wait-reasons.js";
import { executionSummary } from "./execution-runtime.js";
import { pullRequestReference } from "./delivery-presentation.js";
import { clockLabel, midSentence, shortId } from "./presentation.js";
import { taskColumnOf } from "../../src/operator/task-presentation.js";
import { nextActor, reasonLabels } from "./tasks.js";

export { taskColumnOf };

type Data = TaskRead["data"];
type Source = NonNullable<Data["review"]>["sources"][number];
type Assignment = Data["assignments"][number];

/** Names use only the redacted projection; retained order distinguishes repeated reports. */
export function resultLabel(
  result: Data["results"][number],
  assignments: readonly Assignment[],
  results: readonly Data["results"][number][] = [],
) {
  const name =
    assignments.find((a) => a.assignmentId === result.assignmentId)?.name ??
    "Agent unavailable";
  const summary = result.summary?.trim().split("\n")[0];
  const time = clockLabel(
    result.createdAt < 1e12 ? result.createdAt * 1000 : result.createdAt,
  );
  return [
    results.length > 1
      ? `Result ${results.findIndex((r) => r.resultId === result.resultId) + 1}`
      : null,
    name,
    summary
      ? summary.length > 80
        ? `${summary.slice(0, 80)}…`
        : summary
      : null,
    time,
  ]
    .filter(Boolean)
    .join(" · ");
}

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
      symbol:
        records.length > 1
          ? "?"
          : record?.outcome === "supported"
            ? "✓"
            : record?.outcome === "failed"
              ? "×"
              : "–",
      record,
      records,
      stale: latest?.sourceId !== source.sourceId,
    };
  });
}

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
  if (execution.state === "not-started" && !execution.holds.uncertainty)
    return execution.reasonCodes.includes("held-turn-released")
      ? "Released · the held turn was interrupted"
      : "Not started · refused before it ran";
  return execution.holds.stop || execution.state === "stopping"
    ? "Stopping; effects may continue"
    : execution.holds.uncertainty || execution.state === "uncertain"
      ? "Execution uncertain"
      : terminal
        ? active
          ? `${terminal} · ${execution.state}`
          : data.source?.closure === "completed"
            ? `${terminal} · closed at source`
            : terminal
        : data.source?.closure === "held"
          ? `Held · closed at source${active ? ` · ${execution.state}` : ""}`
          : data.source?.closure === "unattributed"
            ? `Held · closure not attributed to cab${active ? ` · ${execution.state}` : ""}`
            : paused
              ? `${task.ready ? "Ready" : "Draft"} · project paused`
              : !task.ready
                ? unmet
                  ? `Draft · ${unmet}`
                  : "Draft"
                : blocker
                  ? `Ready · waiting on ${blocker.label}`
                  : reason
                    ? `Ready · ${reason === "capacity" ? "waiting for capacity" : midSentence(waitLabels[reason])}`
                    : execution.state === "idle"
                      ? "Ready"
                      : `Ready · ${execution.state}`;
}

/** Who acts next, from the task read's attention codes by the List's rule (`nextActor`). */
export const taskNextActor = (
  data: Pick<Data, "task" | "execution" | "admission" | "source" | "attention">,
) => nextActor(data.attention.codes, taskColumnOf(data));

/** Strip repeats the state badge and shows at most one distinct reason. */
export function taskStripReason(data: Omit<StatusData, "lead">) {
  const readiness = taskReadiness(data),
    column = taskColumnOf(data),
    prefix = `${data.task.ready ? "Ready" : "Draft"} · `;
  const reason = readiness.startsWith(`${column} · `)
    ? readiness.slice(column.length + 3)
    : readiness.startsWith(prefix)
      ? readiness.slice(prefix.length)
      : readiness;
  if (reason === data.execution.state) return null;
  if (readiness === column || readiness === "Ready" || readiness === "Draft")
    return null;
  if (readiness === "Stopping; effects may continue")
    return "effects may continue";
  if (readiness === "Execution uncertain") return "ownership uncertain";
  if (
    data.execution.state === "running" &&
    !data.execution.holds.stop &&
    !data.execution.holds.uncertainty &&
    !data.source?.hold?.active &&
    reason === "waiting for capacity"
  )
    return null;
  return reason;
}

/** The ID slot: `repository#number` for an imported task, otherwise "Local task". */
export function taskIdentity(data: {
  source: Pick<
    NonNullable<Data["source"]>,
    "identity" | "key" | "repositoryName" | "number" | "url"
  > | null;
}) {
  const s = data.source;
  return s
    ? {
        label:
          s.identity.tracker === "jira"
            ? (s.key ?? "Jira issue · key unavailable")
            : `${s.repositoryName ?? "repository unavailable"}#${s.number ?? "?"}`,
        url: s.url,
      }
    : { label: "Local task", url: null };
}

/** What only a Jira source reports: its site and the issue's status in Jira. */
export const jiraFacts = (source: NonNullable<Data["source"]>) => ({
  status: source.status?.name ?? null,
  site: source.identity.tracker === "jira" ? source.identity.provider : null,
});

/** The issue tracker a task was imported from, as the operator reads it. */
export const trackerName = (
  source: { identity: { tracker?: "jira" | undefined } } | null,
) => (source?.identity.tracker === "jira" ? "Jira" : "GitHub");

export const sourceStateText = (source: {
  identity: { tracker?: "jira" | undefined };
  state: string | null;
}) => `${trackerName(source)} source: ${source.state ?? "state unavailable"}`;

export const issueCommentNote = (source: Data["source"], approval: boolean) =>
  approval
    ? `You review the exact comment before it posts to the ${trackerName(source)} issue.`
    : `Posts a comment on the ${trackerName(source)} issue.`;

/** The imported issue's Project field values as `field: option`, falling back to the option's ID. */
export const projectFieldRows = (source: NonNullable<Data["source"]>) =>
  source.memberships.flatMap((m) =>
    m.projectFields.map((f, i) => ({
      key: `${m.selectionId}:${i}`,
      text: `${f.fieldName ?? f.fieldNodeId}: ${f.optionName ?? f.optionNodeId}`,
    })),
  );

const sourceHoldReasons: Record<SourceHoldReason, string> = {
  closed:
    "The issue was closed after import. The task completes once its work and delivery settle; reopen the issue to keep working on it.",
  withdrawn:
    "The issue is no longer selected for this project. Select it again first, then resume.",
  "readiness-lost":
    "The issue no longer meets the project's readiness rule. Make it ready again; a complete sync then releases this hold, or resume once it is ready.",
  "closure-read-unavailable":
    "cab could not read whether it closed the issue itself. Reopen the issue first, then resume.",
  "closure-attribution-unproved":
    "The issue was closed and cab could not show that its own delivery closed it. Reopen the issue first, then resume.",
};

/**
 * Why the source holds the task, in provider-neutral words; null is a reason the read does not
 * name. A closure hold also names the delivery it waits on.
 */
export const sourceHoldReasonText = (
  reason: SourceHoldReason | null,
  wait: ClosureWait | null = null,
) =>
  reason
    ? `${sourceHoldReasons[reason]}${reason === "closed" && wait ? ` ${closureWaitText(wait)}` : ""}`
    : "The source holds this task.";

/** What resuming a source hold does and does not mean. */
export const sourceHoldResumeCaveat =
  "Resuming clears only this source hold. Readiness and configuration eligibility do not confirm runtime admission or execution.";

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

/**
 * Delivery belongs to a task with a GitHub source, a linked repository or a bound pull request.
 * A read without `repositoryLinked` counts as unlinked, so these controls need proof to appear.
 */
export const deliveryApplies = (
  data: Pick<Data, "source" | "repositoryLinked" | "delivery">,
) =>
  Boolean(
    data.source ||
      data.repositoryLinked ||
      data.delivery?.binding ||
      data.delivery?.unregisteredPr,
  );

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
        ? `${deliveryModes[delivery.mode]} · ${pullRequestReference(binding)} · ${binding.state.toLowerCase()}${delivery.unregisteredPr ? ` · ${delivery.unregisteredPr}` : ""}`
        : (delivery.unregisteredPr ??
          `${deliveryModes[delivery.mode]} · no PR yet`),
  };
}

/** Stop can hold selected/pending work or interrupt active/recovery-owned work, not an idle task. */
export function taskStopOffered(
  data: Pick<Data, "task" | "execution" | "assignments">,
) {
  const { task, execution, assignments } = data;
  if (task.state !== "open" || execution.holds.stop) return false;
  return (
    [
      "selected",
      "queued",
      "starting",
      "running",
      "stopping",
      "uncertain",
    ].includes(execution.state) ||
    execution.holds.writer ||
    execution.holds.capacity ||
    execution.holds.uncertainty ||
    execution.holds.task ||
    // Pause and admission waiting can hide selected work in the execution state's precedence.
    assignments.some(
      (a) =>
        a.state === "pending" || a.state === "running" || a.state === "held",
    )
  );
}

/** Who a Stop affects, for the confirmation's first line. */
export function stopConsequences(
  data: Pick<Data, "lead" | "leadAssignmentId" | "assignments" | "execution">,
) {
  const delegated = data.assignments.filter(
    (a) =>
      a.assignmentId !== data.leadAssignmentId &&
      a.state !== "completed" &&
      a.state !== "cancelled" &&
      a.state !== "withdrawn",
  ).length;
  const affected = data.lead
    ? `${data.lead.name ?? "Project lead"} (lead) and ${delegated} delegated ${delegated === 1 ? "assignment is" : "assignments are"} affected.`
    : "This task's assignments are affected.";
  return { affected, held: data.execution.holds.stop };
}

const assignmentStates = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  held: "Held",
  cancelled: "Cancelled",
  withdrawn: "Withdrawn",
} satisfies Record<TaskRead["data"]["assignments"][number]["state"], string>;

/**
 * The lead's own delegates that hold it back and that the operator can withdraw now:
 * unfinished, with no live, held or open work of their own.
 */
export function blockedLeadDelegates(
  data: Pick<Data, "leadAssignmentId" | "assignments">,
): Assignment[] {
  return data.assignments.filter(
    (a) =>
      a.assignmentId !== data.leadAssignmentId &&
      a.requesterAssignmentId === data.leadAssignmentId &&
      (a.state === "pending" || a.state === "running") &&
      a.withdrawal?.available === true,
  );
}

/** A compact delegation row: responsibility, short id, requester → result destination, wait. */
export function assignmentRow(a: Assignment, all: readonly Assignment[]) {
  const name = (id: string) =>
    all.find((x) => x.assignmentId === id)?.name ?? "Assignment";
  const brief = a.brief?.trim().split("\n")[0] ?? "";
  const excerpt = brief.length > 80 ? `${brief.slice(0, 80)}…` : brief;
  return {
    title: [a.name ?? "Assignment", excerpt].filter(Boolean).join(" · "),
    id: shortId(a.assignmentId),
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
    // Admission reasons arrive as "; "-joined codes; a runtime intent reason is already prose.
    wait:
      a.waitReason
        ?.split("; ")
        .map(
          (r) =>
            waitLabels[r as WaitCode] ??
            reasonLabels[r as keyof typeof reasonLabels] ??
            r,
        )
        .join("; ") ?? "Waiting reason unknown",
    runtime: executionSummary(a).line,
    state: assignmentStates[a.state],
  };
}

/** The view a task was opened from, for the header Back label. */
export function originLabel(origin: string) {
  const [pathname, search = ""] = origin.split("?");
  if (pathname === "/") return "Overview";
  if (pathname === "/inbox") return "Inbox";
  if (pathname === "/search") return "Search";
  if (pathname === "/tasks")
    return new URLSearchParams(search).get("view") === "board"
      ? "Board"
      : "Tasks";
  return null;
}
