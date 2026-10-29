import { randomUUID } from "node:crypto";
import {
  taskListSummarySchema,
  type TaskListSummary,
} from "../../src/operator/contracts.js";

export type Overrides = {
  title?: string;
  state?: "open" | "done" | "cancelled";
  ready?: boolean;
  projectId?: string;
  execution?: string;
  codes?: string[];
  paused?: boolean;
  closure?: "held" | "completed" | "unattributed" | null;
  reasons?: string[];
  readiness?: object | undefined;
  lead?: string | null;
  globalUsage?: number;
  projectUsage?: number;
  projectName?: string | null;
  openBlockers?: object[];
};
/** A parsed task-list summary with only the facts a presentation test names. */
export function summary(o: Overrides = {}): TaskListSummary {
  const projectId = o.projectId ?? randomUUID();
  return taskListSummarySchema.parse({
    id: randomUUID(),
    projectId,
    title: o.title ?? "Task",
    version: 1,
    state: o.state ?? "open",
    ready: o.ready ?? true,
    project: {
      id: projectId,
      name: o.projectName === undefined ? "Project" : o.projectName,
      version: 1,
      paused: o.paused ?? false,
      leadProfileId: null,
    },
    lead:
      o.lead === undefined || o.lead === null
        ? null
        : { profileId: randomUUID(), name: o.lead },
    execution: {
      state: o.execution ?? "idle",
      holds: {
        task: false,
        stop: false,
        uncertainty: false,
        writer: false,
        capacity: false,
      },
      reasonCodes: [],
    },
    admission: { eligible: !o.reasons?.length, reasons: o.reasons ?? [] },
    capacity: {
      globalUsage: o.globalUsage ?? 0,
      globalLimit: 10,
      projectUsage: o.projectUsage ?? 0,
      projectLimit: 10,
    },
    source:
      o.closure === undefined
        ? null
        : {
            identity: {
              provider: "github.com",
              nodeId: "I_1",
              repositoryId: "R_1",
            },
            repositoryName: "acme/atlas",
            number: 1,
            url: "https://github.com/acme/atlas/issues/1",
            state: o.readiness ? "open" : "closed",
            closure: o.closure,
            readiness: o.readiness ?? {
              rule: { kind: "none" },
              outcome: "not-evaluated",
              unmet: [],
            },
            openBlockers: o.openBlockers ?? [],
          },
    attention: { codes: o.codes ?? [], count: o.codes?.length ?? 0 },
  });
}
