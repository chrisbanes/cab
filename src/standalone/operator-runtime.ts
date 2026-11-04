import type { OperatorApi } from "./operator-api.js";
import { boundTurnRecoveryCommandSchema } from "./pre-turn-recovery.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CapacityConfigureCommand,
  CapacityLimits,
  DomainStore,
} from "../core/domain.js";
import type { OperatorRoute } from "./operator-routes.js";
import type { RecoveryRecord } from "./recovery-types.js";
import type { TurnRequest } from "./scheduler.js";
import type { ExecutionIntent } from "./state.js";
import type { StandaloneService } from "./service.js";
import { escapeHtml, hidden } from "./operator-html.js";
import { unavailableAlert } from "../operator/runtime-restart-copy.js";
import { executionHarnessLabels } from "./execution-harness.js";

const positiveIntegerString = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const uuid = z.string().uuid();
const capacityFields = z
  .object({
    key: z.string().uuid(),
    globalLimit: positiveIntegerString,
    projectId: z.union([z.literal(""), z.string().uuid()]),
    projectLimit: z.union([z.literal(""), positiveIntegerString]),
  })
  .strict()
  .superRefine((fields, context) => {
    if (fields.projectId === "" && fields.projectLimit !== "")
      context.addIssue({ code: "custom", message: "Project is required" });
  });

type RuntimeDomain = Pick<DomainStore, "admission" | "projects" | "tasks">;

export interface RuntimeOperatorApi {
  domain(): RuntimeDomain;
  executionForWork(workId: string): ExecutionIntent | undefined;
  recoveryFor(assignmentId: string, assignmentVersion: number, workId?: string): RecoveryRecord[];
  currentTurnRequest(assignmentId: string, version: number): TurnRequest | undefined;
  powerStatus(): ReturnType<StandaloneService["powerStatus"]>;
  harnessStatuses(): ReturnType<StandaloneService["harnessStatuses"]>;
  capacityLimits(projectIds?: string[]): CapacityLimits;
  configureCapacity(
    command: Omit<CapacityConfigureCommand, "actor" | "type">,
  ): Promise<CapacityLimits>;
  adoptHistoricalPreTurnRejection?: StandaloneService["adoptHistoricalPreTurnRejection"];
  adoptHistoricalNoTurnSubmission?: StandaloneService["adoptHistoricalNoTurnSubmission"];
  recoverPreTurnExecution?: StandaloneService["recoverPreTurnExecution"];
  recoverBoundTurnExecution?: StandaloneService["recoverBoundTurnExecution"];
  recoverNoTurnExecution?: StandaloneService["recoverNoTurnExecution"];
  replaceConversationCommand?: StandaloneService["replaceConversationCommand"];
}

function overview(api: RuntimeOperatorApi, csrfToken: string): string {
  const domain = api.domain();
  const projects = domain.projects();
  const capacity = api.capacityLimits(
    projects.map((project) => String(project.id)),
  );
  const statuses = api.harnessStatuses();
  const unavailable = statuses
    .filter((status) => status.state === "unavailable")
    .map(
      (status) => `<p role="alert">${escapeHtml(unavailableAlert(status))}</p>`,
    )
    .join("");
  return `<main><h1>Runtime</h1>${unavailable}<section><h2>Capacity</h2><p>Global active turns: ${capacity.globalLimit}; currently in use: ${capacity.currentUsage.global}.</p><p>Default project active turns: ${capacity.defaultProjectLimit}.</p>${projects
    .map((project) => {
      const projectId = String(project.id);
      const projectCapacity = capacity.effectiveProjectLimits[projectId] ?? 2;
      const usage = capacity.currentUsage.projects[projectId] ?? 0;
      return `<p>Project ${escapeHtml(project.name)}: ${projectCapacity} active turns; currently in use: ${usage}.</p>`;
    })
    .join(
      "",
    )}${capacityForm(capacity, projects, csrfToken)}</section><section><h2>Project tasks</h2>${projects
    .map((project) => {
      const projectId = String(project.id);
      const tasks = domain.tasks(projectId);
      const rows = tasks
        .map((task) => {
          const taskId = String(task.id);
          const admission = domain.admission(taskId);
          const readiness = `${String(task.state)}; ${task.ready ? "Ready" : "Not ready"}`;
          const gate = admission.eligible
            ? "Task admission gates are clear"
            : `Task admission blocked: ${admission.reasons.map(admissionReason).map(escapeHtml).join(", ")}`;
          return `<li><a href="${taskHref(taskId)}">${escapeHtml(task.title)}</a> — ${escapeHtml(readiness)}; ${gate}.</li>`;
        })
        .join("");
      return `<section><h3>${escapeHtml(project.name)} — ${project.paused ? "Paused" : "Active"}</h3>${rows ? `<ul>${rows}</ul>` : "<p>No tasks.</p>"}</section>`;
    })
    .join("")}</section><section><h2>Effective execution policy</h2>${statuses
    .map(({ harness, policy }) => {
      if (!policy) return "";
      const text = [...policy.lines, ...policy.limits]
        // Element content: apostrophes stay literal so Codex's text is unchanged.
        .map((line) => `<p>${line.replace(/[&<>]/g, (c) => escapeHtml(c))}</p>`)
        .join("");
      // Codex keeps its retained, unheaded paragraphs.
      return harness === "codex"
        ? text
        : `<h3>${executionHarnessLabels[harness]}</h3>${text}`;
    })
    .join("")}</section></main>`;
}

function admissionReason(reason: string): string {
  const labels: Record<string, string> = {
    "project-paused": "Project is paused",
    "project-lead-unconfigured": "Project lead is not configured",
    "project-lead-revoked": "Project lead is revoked",
    "task-unready": "Task is not marked ready",
    "task-not-open": "Task is not open",
    "local-dependency": "A local dependency is incomplete",
    "stacked-blocker-unpublished":
      "The stacked blocker has no open change request at its last push",
    "stacked-blocker-unknown":
      "The stacked blocker's change request is unknown",
  };
  if (reason.startsWith("imported-blockers-"))
    return `Imported blockers are ${reason.slice("imported-blockers-".length)}`;
  return labels[reason] ?? "Admission is blocked";
}

function capacityForm(
  capacity: CapacityLimits,
  projects: ReturnType<RuntimeDomain["projects"]>,
  csrfToken: string,
): string {
  return `<form method="post" action="/runtime/control/capacity">${hidden("key", randomUUID())}${hidden("csrfToken", csrfToken)}<label>Global active turn limit <input name="globalLimit" type="number" min="1" value="${capacity.globalLimit}"></label><label>Project override <select name="projectId"><option value="">No project override</option>${projects
    .map(
      (project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`,
    )
    .join(
      "",
    )}</select></label><label>Project active turn limit; leave blank to remove an override <input name="projectLimit" type="number" min="1"></label><button type="submit">Save capacity</button></form>`;
}

/** The task workspace's Execution tab. */
function taskHref(taskId: string): string {
  return `/app/tasks/${encodeURIComponent(taskId)}?section=execution`;
}

function assignmentHref(assignmentId: string): string {
  return `/app/assignments/${encodeURIComponent(assignmentId)}/recovery`;
}

/** The turn request, recovery record and execution intent that describe an assignment's current execution. */
export function selectAssignmentExecution(
  assignment: { id?: unknown; version?: unknown },
  api: Pick<
    RuntimeOperatorApi,
    "currentTurnRequest" | "recoveryFor" | "executionForWork"
  >,
) {
  const id = String(assignment.id);
  const request = api.currentTurnRequest(id, Number(assignment.version));
  const requestVersion =
    request?.assignmentVersion ?? Number(assignment.version);
  const record = request
    ? api.recoveryFor(id, requestVersion, request.workId)[0]
    : api
        .recoveryFor(id, requestVersion)
        .reduce<RecoveryRecord | undefined>(
          (latest, candidate) =>
            !latest ||
            candidate.generation.requestSequence >
              latest.generation.requestSequence
              ? candidate
              : latest,
          undefined,
        );
  const intent = request ? api.executionForWork(request.workId) : undefined;
  return { request, record, intent };
}

function boundReview(
  command: ReturnType<typeof boundTurnRecoveryCommandSchema.parse>,
  csrfToken: string,
  message: string,
  phase: "review" | "check" | "retry" | "recorded" | "blocked",
): string {
  const payload = JSON.stringify(command);
  const confirm = phase === "review" || phase === "retry";
  return `<main><h1>Bound-turn reconciliation</h1><p role="status">${escapeHtml(message)}</p>${phase === "blocked" ? `<p>Independent assertions retained: exact process exit confirmed; effects and callbacks settled; workspace ${escapeHtml(command.receipt.workspace)}.</p>` : ""}<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(payload)}</pre>${phase === "recorded" || phase === "blocked" ? "" : `<form method="post" action="${confirm ? "/runtime/control/bound-turn/recover" : "/runtime/control/bound-turn/check"}">${hidden("csrfToken", csrfToken)}${hidden("payload", payload)}${confirm ? hidden("confirmed", "yes") : ""}<button>${confirm ? "Confirm reconciliation" : "Check original receipt"}</button></form>`}<p><a ${phase === "review" ? "autofocus" : ""} href="${assignmentHref(command.assignmentId)}">${phase === "review" ? "Cancel and return to evidence" : phase === "recorded" ? "Review remaining holds" : phase === "blocked" ? "Inspect current generation; preserve this original evidence" : "Inspect evidence; keep this original request for readback"}</a></p></main>`;
}

export class RuntimeOperatorRoutes {
  constructor(
    private readonly api: RuntimeOperatorApi,
    private readonly recovery?: Pick<
      OperatorApi,
      "readRecoveryOptions" | "readOperation"
    >,
  ) {}

  get routes(): OperatorRoute[] {
    return [
      {
        method: "GET",
        path: "/runtime",
        handler: ({ csrfToken }) => ({
          kind: "html",
          body: overview(this.api, csrfToken),
        }),
      },
      ...(this.api.recoverBoundTurnExecution && this.recovery
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/bound-turn/review",
              handler: async ({
                fields,
                csrfToken,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const input = z
                  .object({
                    payload: z.string().max(12000),
                    termination: z.literal("confirmed"),
                    effects: z.literal("settled"),
                    workspace: z.enum(["preserved", "reconciled"]),
                  })
                  .strict()
                  .parse(fields);
                const original = boundTurnRecoveryCommandSchema.parse(
                  JSON.parse(input.payload),
                );
                const submitted = boundTurnRecoveryCommandSchema.parse({
                  ...original,
                  receipt: { ...original.receipt, workspace: input.workspace },
                });
                try {
                  const options = await this.recovery!.readRecoveryOptions(
                    original.assignmentId,
                  );
                  const r = options.data.records.find(
                    (r) => r.workId === original.receipt.workId,
                  );
                  if (
                    !r ||
                    options.data.gaps.length ||
                    !r.paths.some(
                      (p) => p.path === "bound-turn-recover" && p.eligible,
                    )
                  )
                    throw new Error(
                      "Bound recovery is not eligible; inspect current recovery options",
                    );
                  const command = boundTurnRecoveryCommandSchema.parse({
                    key: original.key,
                    assignmentId: original.assignmentId,
                    receipt: {
                      kind: "bound-turn",
                      workId: r.workId,
                      workRevision: r.generation.workRevision,
                      requestSequence: r.generation.requestSequence,
                      processIdentity: r.process,
                      threadId: r.threadId,
                      turnId: r.turnId,
                      termination: { kind: "process-exit" },
                      effects: "settled",
                      workspace: input.workspace,
                    },
                  });
                  if (
                    JSON.stringify({
                      ...original.receipt,
                      workspace: input.workspace,
                    }) !== JSON.stringify(command.receipt)
                  )
                    throw new Error(
                      "Recovery identity changed; inspect the current generation before asserting new proof",
                    );
                  return {
                    kind: "html" as const,
                    body: boundReview(
                      command,
                      csrfToken,
                      "Review permanent reconciliation. It cannot be undone. Stop, project pause, approvals and delivery holds remain. No turn will start.",
                      "review",
                    ),
                  };
                } catch {
                  return {
                    kind: "html" as const,
                    body: boundReview(
                      submitted,
                      csrfToken,
                      "Review unavailable: eligibility is blocked, identity changed, or its lookup failed. Original evidence and assertions are retained. Reconciliation is disabled. Inspect the current generation before asserting new proof; never substitute it into this original request.",
                      "blocked",
                    ),
                  };
                }
              },
            },
            {
              method: "POST" as const,
              path: "/runtime/control/bound-turn/recover",
              handler: async ({
                fields,
                csrfToken,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({
                    payload: z.string().max(12000),
                    confirmed: z.literal("yes"),
                  })
                  .strict()
                  .parse(fields);
                const command = boundTurnRecoveryCommandSchema.parse(
                  JSON.parse(payload),
                );
                try {
                  const result =
                    await this.api.recoverBoundTurnExecution!(command);
                  return {
                    kind: "html" as const,
                    body: boundReview(
                      command,
                      csrfToken,
                      `Execution reconciled. Receipt ${result.id}. No work was started. Review remaining holds before an explicit continuation.`,
                      "recorded",
                    ),
                  };
                } catch {
                  return {
                    kind: "html" as const,
                    body: boundReview(
                      command,
                      csrfToken,
                      "Recovery refused or outcome unknown. Original evidence is retained. Check the original receipt before retrying.",
                      "check",
                    ),
                  };
                }
              },
            },
            {
              method: "POST" as const,
              path: "/runtime/control/bound-turn/check",
              handler: async ({
                fields,
                csrfToken,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const command = boundTurnRecoveryCommandSchema.parse(
                  JSON.parse(payload),
                );
                try {
                  const read = await this.recovery!.readOperation(
                    new URLSearchParams({
                      scope: `assignment:${command.assignmentId}`,
                      type: "recovery.bound-turn.recover",
                      key: command.key,
                    }),
                  );
                  if (
                    read.data.state === "recorded" &&
                    read.data.receipt.kind === "recovery-resolution" &&
                    read.data.receipt.path === "bound-turn-recover" &&
                    read.data.receipt.key === command.key &&
                    read.data.receipt.assignmentId === command.assignmentId &&
                    read.data.receipt.workId === command.receipt.workId
                  )
                    return {
                      kind: "html" as const,
                      body: boundReview(
                        command,
                        csrfToken,
                        `Execution reconciled. Receipt ${JSON.stringify(read.data.receipt)}. No work was started. Review remaining holds before an explicit continuation.`,
                        "recorded",
                      ),
                    };
                  if (read.data.state === "recorded")
                    throw new Error(
                      "Receipt does not match the original recovery",
                    );
                  return {
                    kind: "html" as const,
                    body: boundReview(
                      command,
                      csrfToken,
                      "No receipt is recorded. Retry only this exact original command; the service rechecks its proof.",
                      "retry",
                    ),
                  };
                } catch {
                  return {
                    kind: "html" as const,
                    body: boundReview(
                      command,
                      csrfToken,
                      "Readback unavailable. Keep the original evidence; retry remains blocked.",
                      "check",
                    ),
                  };
                }
              },
            },
          ]
        : []),
      ...(this.api.adoptHistoricalPreTurnRejection
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/pre-turn/adopt",
              handler: ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.adoptHistoricalPreTurnRejection;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.recoverPreTurnExecution
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/pre-turn/recover",
              handler: async ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.recoverPreTurnExecution;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                await operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.adoptHistoricalNoTurnSubmission
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/no-turn/adopt",
              handler: ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.adoptHistoricalNoTurnSubmission;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.recoverNoTurnExecution
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/no-turn/recover",
              handler: async ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.recoverNoTurnExecution;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                await operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.replaceConversationCommand
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/conversation-replace",
              handler: ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const input = z
                  .object({
                    key: uuid,
                    assignmentId: uuid,
                    expectedAssignmentVersion: positiveIntegerString,
                    expectedConversationRevision: positiveIntegerString,
                  })
                  .strict()
                  .parse(fields);
                const operation = this.api.replaceConversationCommand;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                operation.call(this.api, input);
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      {
        method: "POST",
        path: "/runtime/control/capacity",
        handler: async ({ fields }) => {
          const input = capacityFields.parse(fields);
          const projectOverrides = input.projectId
            ? {
                [input.projectId]:
                  input.projectLimit === "" ? null : input.projectLimit,
              }
            : {};
          await this.api.configureCapacity({
            key: input.key,
            globalLimit: input.globalLimit,
            projectOverrides,
          });
          return { kind: "redirect", location: "/runtime" };
        },
      },
    ];
  }
}

export function runtimeOperatorRoutes(
  api: RuntimeOperatorApi,
  recovery?: Pick<OperatorApi, "readRecoveryOptions" | "readOperation">,
): OperatorRoute[] {
  return new RuntimeOperatorRoutes(api, recovery).routes;
}
